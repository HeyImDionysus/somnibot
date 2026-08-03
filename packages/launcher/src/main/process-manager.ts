/**
 * Process Manager — spawns and manages bot + dashboard child processes.
 *
 * Bot: fork() with env vars, IPC heartbeat monitoring.
 * Dashboard: fork() Next.js standalone server on localhost:3456.
 * Clean shutdown on app close.
 *
 * Phase 6 additions:
 * - checkPortAvailable() — detect port conflicts before starting dashboard
 * - cleanupStaleProcesses() — kill leftover PIDs from a previous crash
 * - Lavalink status included in getStatus()
 */

import { execFile, fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { app, BrowserWindow } from 'electron';
import { getConfig, saveConfig } from './config-store.js';
import {
  PROCESS_RESTART_MAX_ATTEMPTS,
  PROCESS_RESTART_STABLE_WINDOW_MS,
  processRestartDelayMs,
  shouldApplyBotReadyTimeout,
  shouldRecoverManagedProcess,
} from './process-manager-guards.js';

const execFileAsync = promisify(execFile);

/**
 * V7 Audit §10.P3a — Allowlist of parent-process env vars to forward.
 * Only essential system vars (PATH, LANG, TZ, etc.) are passed to child
 * processes; everything else comes from the explicit envVars parameter.
 */
const SAFE_PARENT_ENV_KEYS = [
  'PATH',
  'LANG',
  'LC_ALL',
  'TZ',
  'HOME',
  'USERPROFILE',
  'TMPDIR',
  'TEMP',
  'TMP',
  // Windows-specific
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMFILES',
  'SystemRoot',
  'COMSPEC',
  // macOS / Linux
  'SHELL',
  'XDG_RUNTIME_DIR',
  'XDG_CONFIG_HOME',
  // Platform-specific library paths — required for native modules
  // (@napi-rs/canvas, sharp, etc.) that load shared libraries at runtime.
  'LD_LIBRARY_PATH',           // Linux
  'DYLD_LIBRARY_PATH',         // macOS
  'DYLD_FALLBACK_LIBRARY_PATH', // macOS fallback
] as const;

function safeParentEnv(): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const key of SAFE_PARENT_ENV_KEYS) {
    const val = process.env[key];
    if (val !== undefined) filtered[key] = val;
  }
  return filtered;
}
import {
  getLavalinkStatus,
  getLavalinkPid,
  type LavalinkStatus,
} from './lavalink-manager.js';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type ProcessStatus = 'offline' | 'starting' | 'online' | 'error';

export interface StatusUpdate {
  bot: ProcessStatus;
  dashboard: ProcessStatus;
  lavalink: LavalinkStatus;
  botPid?: number;
  dashboardPid?: number;
  lastHeartbeat?: number;
  error?: string;
}

/* ------------------------------------------------------------------ */
/*  State                                                              */
/* ------------------------------------------------------------------ */

let botProcess: ChildProcess | null = null;
let dashboardProcess: ChildProcess | null = null;
let botStatus: ProcessStatus = 'offline';
let dashboardStatus: ProcessStatus = 'offline';
let lastHeartbeat = 0;
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let botReadyTimeout: ReturnType<typeof setTimeout> | null = null;
let statusCallback: ((status: StatusUpdate) => void) | null = null;
const BOT_READY_TIMEOUT_MS = 60_000;
type ManagedService = 'bot' | 'dashboard';
interface RecoveryState {
  attempts: number;
  restartTimer: ReturnType<typeof setTimeout> | null;
  stableTimer: ReturnType<typeof setTimeout> | null;
}
const recoveryState: Record<ManagedService, RecoveryState> = {
  bot: { attempts: 0, restartTimer: null, stableTimer: null },
  dashboard: { attempts: 0, restartTimer: null, stableTimer: null },
};
let desiredRunning = false;
let lastStartEnv: Record<string, string> | null = null;
let stopPromise: Promise<void> | null = null;

/**
 * Stop a managed child deterministically. SIGTERM is given a bounded grace
 * period, then the child is force-killed and the promise resolves only after
 * the process has exited (or the OS has accepted the force-kill).
 *
 * Keeping the promise in the shutdown path prevents Electron from exiting
 * while a bot/dashboard child is still listening on a port or holding the
 * launcher-owned resources.
 */
function stopManagedChild(child: ChildProcess | null): Promise<void> {
  if (!child) return Promise.resolve();
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();

  // Recovery and log listeners belong to the normal running lifecycle. They
  // must not restart the child or race the shutdown promise once termination
  // has been requested.
  child.removeAllListeners();

  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceKillTimer);
      child.removeListener('close', onClose);
      resolve();
    };
    const onClose = () => finish();
    const forceKillTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // The child may have exited between the liveness check and the kill.
      }
      finish();
    }, 5_000);

    child.once('close', onClose);
    try {
      child.kill('SIGTERM');
    } catch {
      finish();
    }
  });
}

function clearBotReadyTimeout(): void {
  if (botReadyTimeout) {
    clearTimeout(botReadyTimeout);
    botReadyTimeout = null;
  }
}

function activeProcess(service: ManagedService): ChildProcess | null {
  return service === 'bot' ? botProcess : dashboardProcess;
}

function serviceStatus(service: ManagedService): ProcessStatus {
  return service === 'bot' ? botStatus : dashboardStatus;
}

function clearRecoveryState(resetAttempts: boolean): void {
  for (const state of Object.values(recoveryState)) {
    if (state.restartTimer) clearTimeout(state.restartTimer);
    if (state.stableTimer) clearTimeout(state.stableTimer);
    state.restartTimer = null;
    state.stableTimer = null;
    if (resetAttempts) state.attempts = 0;
  }
}

function markServiceStable(service: ManagedService, launchedProcess: ChildProcess): void {
  const state = recoveryState[service];
  if (state.stableTimer) clearTimeout(state.stableTimer);
  state.stableTimer = setTimeout(() => {
    state.stableTimer = null;
    if (
      desiredRunning
      && activeProcess(service) === launchedProcess
      && serviceStatus(service) === 'online'
    ) {
      state.attempts = 0;
    }
  }, PROCESS_RESTART_STABLE_WINDOW_MS);
  state.stableTimer.unref?.();
}

function scheduleRecovery(service: ManagedService, reason: string): void {
  const state = recoveryState[service];
  if (!desiredRunning || !lastStartEnv || state.restartTimer || activeProcess(service)) return;

  if (state.attempts >= PROCESS_RESTART_MAX_ATTEMPTS) {
    if (service === 'bot') botStatus = 'error';
    else dashboardStatus = 'error';
    broadcastStatus({
      error: `${service === 'bot' ? 'Bot' : 'Dashboard'} automatic recovery stopped after ${PROCESS_RESTART_MAX_ATTEMPTS} failed attempts. ${reason}`,
    });
    return;
  }

  state.attempts += 1;
  const attempt = state.attempts;
  const delayMs = processRestartDelayMs(attempt);
  broadcastStatus({
    error: `${service === 'bot' ? 'Bot' : 'Dashboard'} stopped unexpectedly. Restarting in ${Math.ceil(delayMs / 1_000)}s (attempt ${attempt}/${PROCESS_RESTART_MAX_ATTEMPTS}). ${reason}`,
  });

  state.restartTimer = setTimeout(() => {
    state.restartTimer = null;
    if (!desiredRunning || !lastStartEnv || activeProcess(service)) return;
    if (service === 'bot') startBotProcess(lastStartEnv);
    else startDashboardProcess(lastStartEnv);
  }, delayMs);
  state.restartTimer.unref?.();
}

function terminateForRecovery(service: ManagedService, child: ChildProcess): void {
  if (!shouldRecoverManagedProcess(desiredRunning, activeProcess(service), child)) return;
  child.kill('SIGTERM');
  const pid = child.pid;
  const forceKillTimer = setTimeout(() => {
    if (!shouldRecoverManagedProcess(desiredRunning, activeProcess(service), child)) return;
    try {
      if (pid) process.kill(pid, 0);
      if (pid) process.kill(pid, 'SIGKILL');
    } catch {
      // The child exited after SIGTERM.
    }
  }, 5_000);
  forceKillTimer.unref?.();
}

/* ------------------------------------------------------------------ */
/*  Phase 6: Port-conflict detection                                   */
/* ------------------------------------------------------------------ */

/**
 * Returns true if the port is free, false if something is already listening.
 */
export function checkPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

/* ------------------------------------------------------------------ */
/*  Phase 6: Stale-process cleanup                                     */
/* ------------------------------------------------------------------ */

/**
 * Kill any leftover processes from a previous launcher crash.
 * Called once on app startup before the user can press Start.
 */
/**
 * Wait until a PID is no longer alive, then force-kill it if the graceful
 * window expires. This is used only for PIDs persisted by this launcher after
 * a previous crash; clearing the record before the process is gone can leave
 * the next instance racing a stale listener/port owner.
 */
async function waitForStaleProcessExit(pid: number): Promise<boolean> {
  const graceDeadline = Date.now() + 5_000;
  const isAlive = (): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  while (isAlive() && Date.now() < graceDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (isAlive()) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // It exited between the liveness check and the force-kill.
    }
    const killDeadline = Date.now() + 2_000;
    while (isAlive() && Date.now() < killDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  return !isAlive();
}

type StaleProcessName = 'bot' | 'dashboard' | 'lavalink' | 'valkey';

function normalizeProcessIdentity(value: string): string {
  return value.replaceAll('\\', '/').replaceAll(/\/+/g, '/').toLowerCase();
}

async function readProcessCommandLine(pid: number): Promise<string | null> {
  try {
    if (process.platform === 'win32') {
      const filter = `ProcessId = ${pid}`;
      const { stdout } = await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter '${filter}').CommandLine`,
        ],
        { timeout: 3_000, maxBuffer: 64 * 1024 },
      );
      return String(stdout).trim() || null;
    }

    const procCmdline = await fsp.readFile(`/proc/${pid}/cmdline`, 'utf8');
    return procCmdline.replaceAll('\0', ' ').trim() || null;
  } catch {
    // A process may exit during inspection, or the host may not expose a
    // command-line API. Ambiguous identity is handled fail-closed by caller.
    return null;
  }
}

function expectedProcessIdentityMarker(name: StaleProcessName): string {
  switch (name) {
    case 'bot':
      return getBotEntryPath();
    case 'dashboard':
      return getDashboardEntryPath();
    case 'lavalink':
      return path.join(app.getPath('userData'), 'lavalink', 'Lavalink.jar');
    case 'valkey':
      return path.join(app.getPath('userData'), 'valkey', 'data');
  }
}

async function processMatchesExpectedIdentity(
  name: StaleProcessName,
  pid: number,
): Promise<boolean> {
  const commandLine = await readProcessCommandLine(pid);
  if (!commandLine) return false;

  const normalizedCommand = normalizeProcessIdentity(commandLine);
  const normalizedMarker = normalizeProcessIdentity(expectedProcessIdentityMarker(name));
  if (!normalizedCommand.includes(normalizedMarker)) return false;

  if (name === 'lavalink') return normalizedCommand.includes('lavalink.jar');
  if (name === 'valkey') return /(?:^|\/)redis-server(?:\.exe)?(?:\s|$)/.test(normalizedCommand)
    || /(?:^|\/)valkey-server(?:\.exe)?(?:\s|$)/.test(normalizedCommand);
  return true;
}

export interface StaleProcessCleanupResult {
  ok: boolean;
  unresolved: string[];
}

export async function cleanupStaleProcesses(): Promise<StaleProcessCleanupResult> {
  const cfg = getConfig();
  const pids = cfg.lastPids ?? { bot: null, dashboard: null, lavalink: null, valkey: null };
  const nextPids = { ...pids };

  const stalePids: Array<[StaleProcessName, number]> = [];
  const unresolved: string[] = [];
  for (const [name, pid] of Object.entries(pids)) {
    // Legacy stores may contain sentinel/invalid values (for example -1).
    // Never pass those to process.kill: negative PIDs target process groups.
    if (typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0); // Throws if process doesn't exist
        if (!await processMatchesExpectedIdentity(name as StaleProcessName, pid)) {
          console.warn(`[ProcessMgr] Refusing to signal stale ${name} PID ${pid}: process identity is ambiguous.`);
          unresolved.push(name);
          continue;
        }
        console.log(`[ProcessMgr] Killing stale ${name} process (PID ${pid})`);
        process.kill(pid, 'SIGTERM');
        stalePids.push([name as StaleProcessName, pid]);
      } catch {
        // Process doesn't exist — clear its stale record.
        nextPids[name as StaleProcessName] = null;
      }
    } else if (pid !== null) {
      nextPids[name as StaleProcessName] = null;
    }
  }

  const exited = await Promise.all(stalePids.map(async ([name, pid]) => ({
    name,
    exited: await waitForStaleProcessExit(pid),
  })));
  for (const result of exited) {
    if (result.exited) nextPids[result.name] = null;
    else unresolved.push(result.name);
  }

  // Clear only records proven dead. Ambiguous or unkillable records remain so
  // the next launch cannot silently forget a service it failed to reclaim.
  saveConfig({ lastPids: nextPids });
  return { ok: unresolved.length === 0, unresolved: [...new Set(unresolved)] };
}

/* ------------------------------------------------------------------ */
/*  Resource paths                                                     */
/* ------------------------------------------------------------------ */

function getResourcePath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath);
  }
  return path.join(app.getAppPath(), '..', '..');
}

function getBotEntryPath(): string {
  if (app.isPackaged) {
    return path.join(getResourcePath(), 'bot', 'dist', 'index.js');
  }
  return path.join(getResourcePath(), 'packages', 'bot', 'dist', 'index.js');
}

function getDashboardEntryPath(): string {
  if (app.isPackaged) {
    return path.join(getResourcePath(), 'dashboard', 'packages', 'dashboard', 'server.js');
  }
  return path.join(
    getResourcePath(),
    'packages',
    'dashboard',
    '.next',
    'standalone',
    'packages',
    'dashboard',
    'server.js',
  );
}

/* ------------------------------------------------------------------ */
/*  Status broadcasting                                                */
/* ------------------------------------------------------------------ */

function broadcastStatus(extra?: Partial<StatusUpdate>): void {
  const status: StatusUpdate = {
    bot: botStatus,
    dashboard: dashboardStatus,
    lavalink: getLavalinkStatus(),
    botPid: botProcess?.pid,
    dashboardPid: dashboardProcess?.pid,
    lastHeartbeat: lastHeartbeat || undefined,
    ...extra,
  };

  statusCallback?.(status);

  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('status-update', status);
    }
  }
}

export function onStatusUpdate(cb: (status: StatusUpdate) => void): void {
  statusCallback = cb;
}

export function getStatus(): StatusUpdate {
  return {
    bot: botStatus,
    dashboard: dashboardStatus,
    lavalink: getLavalinkStatus(),
    botPid: botProcess?.pid,
    dashboardPid: dashboardProcess?.pid,
    lastHeartbeat: lastHeartbeat || undefined,
  };
}

/* ------------------------------------------------------------------ */
/*  Bot process                                                        */
/* ------------------------------------------------------------------ */

function getMigrationsDir(): string {
  if (app.isPackaged) {
    return path.join(getResourcePath(), 'supabase', 'migrations');
  }
  return path.join(getResourcePath(), 'packages', 'supabase', 'migrations');
}

function startBotProcess(envVars: Record<string, string>): void {
  const entryPath = getBotEntryPath();
  lastHeartbeat = 0;
  botStatus = 'starting';
  broadcastStatus();

  // V7 Audit §10.P3a — Only pass explicit env vars + essential system vars.
  // Avoids leaking parent-process env (cloud provider secrets, etc.) to children.
  botProcess = fork(entryPath, [], {
    env: { ...safeParentEnv(), ...envVars, MIGRATIONS_DIR: getMigrationsDir() },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    silent: true,
  });
  const launchedBotProcess = botProcess;

  // Persist PID for stale-process cleanup
  persistPid('bot', botProcess.pid ?? null);

  botProcess.stdout?.on('data', (data: Buffer) => {
    const line = data.toString().trim();
    if (line) {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('bot-log', { type: 'stdout', line });
        }
      }
    }
  });

  botProcess.stderr?.on('data', (data: Buffer) => {
    const line = data.toString().trim();
    if (line) {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('bot-log', { type: 'stderr', line });
        }
      }
    }
  });

  botProcess.on('message', (msg: unknown) => {
    if (botProcess !== launchedBotProcess) return;
    if (typeof msg === 'object' && msg !== null && 'type' in msg) {
      const typed = msg as { type: string };
      if (typed.type === 'heartbeat') {
        lastHeartbeat = Date.now();
        if (botStatus !== 'online') {
          botStatus = 'online';
          clearBotReadyTimeout();
          markServiceStable('bot', launchedBotProcess);
          broadcastStatus();
        }
      } else if (typed.type === 'ready') {
        botStatus = 'online';
        lastHeartbeat = Date.now();
        clearBotReadyTimeout();
        markServiceStable('bot', launchedBotProcess);
        broadcastStatus();
      }
    }
  });

  botProcess.on('exit', (code, signal) => {
    const shouldRecover = shouldRecoverManagedProcess(
      desiredRunning,
      botProcess,
      launchedBotProcess,
    );
    if (botProcess !== launchedBotProcess) return;

    clearBotReadyTimeout();
    const state = recoveryState.bot;
    if (state.stableTimer) clearTimeout(state.stableTimer);
    state.stableTimer = null;
    const wasOnline = botStatus === 'online';
    botStatus = 'offline';
    botProcess = null;
    persistPid('bot', null);

    const reason = code && code !== 0
      ? `Bot exited with code ${code}.`
      : `Bot exited (code: ${code}, signal: ${signal}).`;
    if (code && code !== 0) {
      broadcastStatus({
        error: wasOnline
          ? `Bot crashed (exit code ${code}). Check your credentials and try again.`
          : `Bot failed to start (exit code ${code}). Verify your Discord token and other credentials.`,
      });
    } else {
      broadcastStatus({
        error: wasOnline
          ? `Bot process exited (code: ${code}, signal: ${signal})`
          : undefined,
      });
    }
    if (shouldRecover) scheduleRecovery('bot', reason);
  });

  botProcess.on('error', (err) => {
    const shouldRecover = shouldRecoverManagedProcess(
      desiredRunning,
      botProcess,
      launchedBotProcess,
    );
    if (botProcess !== launchedBotProcess) return;

    clearBotReadyTimeout();
    const state = recoveryState.bot;
    if (state.stableTimer) clearTimeout(state.stableTimer);
    state.stableTimer = null;
    botStatus = 'error';
    botProcess = null;
    persistPid('bot', null);
    broadcastStatus({ error: `Bot process error: ${err.message}` });
    if (shouldRecover) scheduleRecovery('bot', `Bot process error: ${err.message}`);
  });

  clearBotReadyTimeout();
  botReadyTimeout = setTimeout(() => {
    if (shouldApplyBotReadyTimeout(botProcess, launchedBotProcess, botStatus)) {
      botStatus = 'error';
      broadcastStatus({
        error: `Bot did not report ready or heartbeat within ${Math.round(BOT_READY_TIMEOUT_MS / 1000)}s. Check the bot log and provider credentials before calling setup complete.`,
      });
      terminateForRecovery('bot', launchedBotProcess);
    }
  }, BOT_READY_TIMEOUT_MS);
  botReadyTimeout.unref?.();
}

/* ------------------------------------------------------------------ */
/*  Dashboard process                                                  */
/* ------------------------------------------------------------------ */

function startDashboardProcess(envVars: Record<string, string>): void {
  const entryPath = getDashboardEntryPath();
  dashboardStatus = 'starting';
  broadcastStatus();

  // V10 Audit §12: Write SESSION_TOKEN to a temp file with restrictive
  // permissions instead of passing it solely via env. The dashboard reads
  // the file path from SESSION_TOKEN_FILE in instrumentation.ts and deletes
  // the file after reading. The env var is still set as a fallback.
  const dashEnv: Record<string, string> = {
    ...safeParentEnv(),
    ...envVars,
    SOMNIBOT_DASHBOARD_LOCAL_MODE: '1',
  };
  if (envVars.SESSION_TOKEN) {
    try {
      const tokenDir = path.join(os.tmpdir(), 'somnibot-launcher');
      fs.mkdirSync(tokenDir, { recursive: true, mode: 0o700 });
      const tokenFile = path.join(tokenDir, `session-${Date.now()}.tok`);
      fs.writeFileSync(tokenFile, envVars.SESSION_TOKEN, { mode: 0o600 });
      dashEnv.SESSION_TOKEN_FILE = tokenFile;
    } catch {
      // Fall back to env-only if temp file fails (e.g., Windows FS quirks)
    }
  }

  // V7 Audit §10.P3a — Only pass explicit env vars + essential system vars.
  dashboardProcess = fork(entryPath, [], {
    env: dashEnv,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    silent: true,
  });
  const launchedDashboardProcess = dashboardProcess;

  // Persist PID for stale-process cleanup
  persistPid('dashboard', dashboardProcess.pid ?? null);

  dashboardProcess.stdout?.on('data', (data: Buffer) => {
    if (dashboardProcess !== launchedDashboardProcess) return;
    const line = data.toString().trim();
    if (line) {
      if (line.includes('Ready') || line.includes('started server') || line.includes('localhost:3456')) {
        dashboardStatus = 'online';
        markServiceStable('dashboard', launchedDashboardProcess);
        broadcastStatus();
      }
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('dashboard-log', { type: 'stdout', line });
        }
      }
    }
  });

  dashboardProcess.stderr?.on('data', (data: Buffer) => {
    if (dashboardProcess !== launchedDashboardProcess) return;
    const line = data.toString().trim();
    if (line) {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('dashboard-log', { type: 'stderr', line });
        }
      }
    }
  });

  dashboardProcess.on('exit', (code, signal) => {
    const shouldRecover = shouldRecoverManagedProcess(
      desiredRunning,
      dashboardProcess,
      launchedDashboardProcess,
    );
    if (dashboardProcess !== launchedDashboardProcess) return;
    const state = recoveryState.dashboard;
    if (state.stableTimer) clearTimeout(state.stableTimer);
    state.stableTimer = null;
    dashboardStatus = 'offline';
    dashboardProcess = null;
    persistPid('dashboard', null);
    broadcastStatus({
      error: code !== 0
        ? `Dashboard exited (code: ${code}, signal: ${signal})`
        : undefined,
    });
    if (shouldRecover) {
      scheduleRecovery('dashboard', `Dashboard exited (code: ${code}, signal: ${signal}).`);
    }
  });

  dashboardProcess.on('error', (err) => {
    const shouldRecover = shouldRecoverManagedProcess(
      desiredRunning,
      dashboardProcess,
      launchedDashboardProcess,
    );
    if (dashboardProcess !== launchedDashboardProcess) return;
    const state = recoveryState.dashboard;
    if (state.stableTimer) clearTimeout(state.stableTimer);
    state.stableTimer = null;
    dashboardStatus = 'error';
    dashboardProcess = null;
    persistPid('dashboard', null);
    broadcastStatus({ error: `Dashboard error: ${err.message}` });
    if (shouldRecover) scheduleRecovery('dashboard', `Dashboard error: ${err.message}`);
  });

  const dashboardReadyTimeout = setTimeout(() => {
    if (dashboardProcess === launchedDashboardProcess && dashboardStatus === 'starting') {
      dashboardStatus = 'error';
      broadcastStatus({
        error: 'Dashboard did not report ready within 60s. Automatic recovery will retry with bounded backoff.',
      });
      terminateForRecovery('dashboard', launchedDashboardProcess);
    }
  }, BOT_READY_TIMEOUT_MS);
  dashboardReadyTimeout.unref?.();
}

/* ------------------------------------------------------------------ */
/*  Heartbeat monitor                                                  */
/* ------------------------------------------------------------------ */

function startHeartbeatMonitor(): void {
  stopHeartbeatMonitor();
  heartbeatInterval = setInterval(() => {
    if (botStatus === 'online' && lastHeartbeat > 0) {
      const elapsed = Date.now() - lastHeartbeat;
      if (elapsed > 60_000) {
        botStatus = 'error';
        broadcastStatus({ error: 'Bot stopped responding (no heartbeat in 60s)' });
        if (botProcess) terminateForRecovery('bot', botProcess);
      }
    }
  }, 10_000);
}

function stopHeartbeatMonitor(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

/* ------------------------------------------------------------------ */
/*  PID persistence (Phase 6: stale-process tracking)                  */
/* ------------------------------------------------------------------ */

function persistPid(name: 'bot' | 'dashboard', pid: number | null): void {
  const cfg = getConfig();
  const pids = cfg.lastPids ?? { bot: null, dashboard: null, lavalink: null, valkey: null };
  pids[name] = pid;
  saveConfig({ lastPids: pids });
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

export async function startAll(envVars: Record<string, string>): Promise<void> {
  if (botProcess || dashboardProcess) {
    await stopAll();
  }

  clearRecoveryState(true);
  desiredRunning = true;
  lastStartEnv = { ...envVars };
  startBotProcess(envVars);
  startDashboardProcess(envVars);
  startHeartbeatMonitor();
}

export function stopAll(): Promise<void> {
  if (stopPromise) return stopPromise;

  desiredRunning = false;
  lastStartEnv = null;
  clearRecoveryState(true);
  stopHeartbeatMonitor();
  clearBotReadyTimeout();

  const botToStop = botProcess;
  const dashboardToStop = dashboardProcess;

  // Stop restart/recovery logic immediately, but keep the child references
  // until their close events arrive so isRunning() remains truthful during
  // the grace period.
  botStatus = 'offline';
  dashboardStatus = 'offline';
  lastHeartbeat = 0;
  broadcastStatus();

  stopPromise = Promise.all([
    stopManagedChild(botToStop),
    stopManagedChild(dashboardToStop),
  ]).then(() => {
    if (botProcess === botToStop) botProcess = null;
    if (dashboardProcess === dashboardToStop) dashboardProcess = null;

    // Clear stored PIDs only after both children have actually stopped.
    saveConfig({ lastPids: { bot: null, dashboard: null, lavalink: null, valkey: null } });
    broadcastStatus();
  }).finally(() => {
    stopPromise = null;
  });

  return stopPromise;
}

export function isRunning(): boolean {
  return desiredRunning || botProcess !== null || dashboardProcess !== null;
}
