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

import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { app, BrowserWindow } from 'electron';
import { getConfig, saveConfig } from './config-store.js';

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
let statusCallback: ((status: StatusUpdate) => void) | null = null;

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
export function cleanupStaleProcesses(): void {
  const cfg = getConfig();
  const pids = cfg.lastPids ?? { bot: null, dashboard: null, lavalink: null, valkey: null };

  for (const [name, pid] of Object.entries(pids)) {
    if (pid && typeof pid === 'number') {
      try {
        process.kill(pid, 0); // Throws if process doesn't exist
        console.log(`[ProcessMgr] Killing stale ${name} process (PID ${pid})`);
        process.kill(pid, 'SIGTERM');
      } catch {
        // Process doesn't exist — that's fine
      }
    }
  }

  // Clear stored PIDs
  saveConfig({ lastPids: { bot: null, dashboard: null, lavalink: null, valkey: null } });
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
  botStatus = 'starting';
  broadcastStatus();

  // V7 Audit §10.P3a — Only pass explicit env vars + essential system vars.
  // Avoids leaking parent-process env (cloud provider secrets, etc.) to children.
  botProcess = fork(entryPath, [], {
    env: { ...safeParentEnv(), ...envVars, MIGRATIONS_DIR: getMigrationsDir() },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    silent: true,
  });

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
    if (typeof msg === 'object' && msg !== null && 'type' in msg) {
      const typed = msg as { type: string };
      if (typed.type === 'heartbeat') {
        lastHeartbeat = Date.now();
        if (botStatus !== 'online') {
          botStatus = 'online';
          broadcastStatus();
        }
      } else if (typed.type === 'ready') {
        botStatus = 'online';
        lastHeartbeat = Date.now();
        broadcastStatus();
      }
    }
  });

  botProcess.on('exit', (code, signal) => {
    const wasOnline = botStatus === 'online';
    botStatus = 'offline';
    botProcess = null;
    persistPid('bot', null);

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
  });

  botProcess.on('error', (err) => {
    botStatus = 'error';
    botProcess = null;
    persistPid('bot', null);
    broadcastStatus({ error: `Bot process error: ${err.message}` });
  });

  // If no heartbeat within 30s, mark as online anyway
  setTimeout(() => {
    if (botProcess && botStatus === 'starting') {
      botStatus = 'online';
      broadcastStatus();
    }
  }, 30_000);
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

  // Persist PID for stale-process cleanup
  persistPid('dashboard', dashboardProcess.pid ?? null);

  dashboardProcess.stdout?.on('data', (data: Buffer) => {
    const line = data.toString().trim();
    if (line) {
      if (line.includes('Ready') || line.includes('started server') || line.includes('localhost:3456')) {
        dashboardStatus = 'online';
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
    dashboardStatus = 'offline';
    dashboardProcess = null;
    persistPid('dashboard', null);
    broadcastStatus({
      error: code !== 0
        ? `Dashboard exited (code: ${code}, signal: ${signal})`
        : undefined,
    });
  });

  dashboardProcess.on('error', (err) => {
    dashboardStatus = 'error';
    dashboardProcess = null;
    persistPid('dashboard', null);
    broadcastStatus({ error: `Dashboard error: ${err.message}` });
  });

  setTimeout(() => {
    if (dashboardProcess && dashboardStatus === 'starting') {
      dashboardStatus = 'online';
      broadcastStatus();
    }
  }, 15_000);
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

export function startAll(envVars: Record<string, string>): void {
  if (botProcess || dashboardProcess) {
    stopAll();
  }

  startBotProcess(envVars);
  startDashboardProcess(envVars);
  startHeartbeatMonitor();
}

export function stopAll(): void {
  stopHeartbeatMonitor();

  if (botProcess) {
    botProcess.removeAllListeners();
    botProcess.kill('SIGTERM');
    const pid = botProcess.pid;
    setTimeout(() => {
      try {
        if (pid) process.kill(pid, 0);
        if (pid) process.kill(pid, 'SIGKILL');
      } catch {
        // Already dead — good
      }
    }, 5_000);
    botProcess = null;
  }

  if (dashboardProcess) {
    dashboardProcess.removeAllListeners();
    dashboardProcess.kill('SIGTERM');
    const pid = dashboardProcess.pid;
    setTimeout(() => {
      try {
        if (pid) process.kill(pid, 0);
        if (pid) process.kill(pid, 'SIGKILL');
      } catch {
        // Already dead
      }
    }, 5_000);
    dashboardProcess = null;
  }

  botStatus = 'offline';
  dashboardStatus = 'offline';
  lastHeartbeat = 0;

  // Clear stored PIDs
  saveConfig({ lastPids: { bot: null, dashboard: null, lavalink: null, valkey: null } });

  broadcastStatus();
}

export function isRunning(): boolean {
  return botProcess !== null || dashboardProcess !== null;
}
