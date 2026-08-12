/**
 * Valkey Manager — download, configure, and run a Redis-compatible server
 * as a child process for the Electron launcher.
 *
 * Handles:
 * - Platform-specific binary download:
 *   · Windows: pre-built Redis from redis-windows/redis-windows
 *   · macOS/Linux: system-installed valkey-server or redis-server
 * - Child process lifecycle (start / stop / status)
 * - Status broadcasting to renderer via BrowserWindow IPC
 *
 * The bot uses Valkey for XP cooldowns, rate limiting, queue state,
 * and caching. Without it the bot still runs, but with degraded
 * functionality (in-memory fallbacks).
 */

import { type ChildProcess, spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';
import {
  PROCESS_RESTART_MAX_ATTEMPTS,
  PROCESS_RESTART_STABLE_WINDOW_MS,
  processRestartDelayMs,
  shouldRecoverManagedProcess,
} from './process-manager-guards.js';
import { probeValkeyReady, waitForServiceReady } from './service-readiness.js';
import { getConfig, saveConfig } from './config-store.js';
import { stopChildProcess } from './managed-child-stop.js';

const execFileAsync = promisify(execFile);

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const VALKEY_PORT = 6379;

/**
 * Windows: pre-built Redis binary from the redis-windows community project.
 * This is a well-maintained port of Redis 7.4.x for Windows x64.
 */
const REDIS_WINDOWS_VERSION = '7.4.2';
const REDIS_WINDOWS_URL = `https://github.com/redis-windows/redis-windows/releases/download/${REDIS_WINDOWS_VERSION}/Redis-${REDIS_WINDOWS_VERSION}-Windows-x64-msys2.zip`;

/* ------------------------------------------------------------------ */
/*  State                                                              */
/* ------------------------------------------------------------------ */

export type ValkeyStatus = 'offline' | 'starting' | 'online' | 'error' | 'downloading';

let valkeyProcess: ChildProcess | null = null;
let currentStatus: ValkeyStatus = 'offline';
let lastError = '';
let desiredRunning = false;
let restartAttempts = 0;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let stableTimer: ReturnType<typeof setTimeout> | null = null;
let stopPromise: Promise<void> | null = null;

function markStable(proc: ChildProcess): void {
  if (stableTimer) clearTimeout(stableTimer);
  stableTimer = setTimeout(() => {
    stableTimer = null;
    if (desiredRunning && valkeyProcess === proc && currentStatus === 'online') {
      restartAttempts = 0;
    }
  }, PROCESS_RESTART_STABLE_WINDOW_MS);
  stableTimer.unref?.();
}

function scheduleRecovery(reason: string): void {
  if (!desiredRunning || restartTimer || valkeyProcess) return;
  if (restartAttempts >= PROCESS_RESTART_MAX_ATTEMPTS) {
    setStatus(
      'error',
      `Valkey/Redis automatic recovery stopped after ${PROCESS_RESTART_MAX_ATTEMPTS} failed attempts. ${reason}`,
    );
    broadcastValkeyStatus();
    return;
  }

  restartAttempts += 1;
  const delayMs = processRestartDelayMs(restartAttempts);
  setStatus(
    'error',
    `Valkey/Redis stopped unexpectedly. Restarting in ${Math.ceil(delayMs / 1_000)}s (attempt ${restartAttempts}/${PROCESS_RESTART_MAX_ATTEMPTS}). ${reason}`,
  );
  broadcastValkeyStatus();
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (!desiredRunning || valkeyProcess) return;
    void startValkey();
  }, delayMs);
  restartTimer.unref?.();
}

/* ------------------------------------------------------------------ */
/*  Paths                                                              */
/* ------------------------------------------------------------------ */

function getValkeyDir(): string {
  return path.join(app.getPath('userData'), 'valkey');
}

function getDataDir(): string {
  return path.join(getValkeyDir(), 'data');
}

/**
 * Get the path to the server binary.
 * On Windows, this is the downloaded redis-server.exe.
 * On macOS/Linux, this is detected from the system PATH.
 */
function getServerBinaryPath(): string {
  if (process.platform === 'win32') {
    return path.join(getValkeyDir(), 'redis-server.exe');
  }
  // macOS/Linux — will be resolved by detectSystemBinary()
  return '';
}

/* ------------------------------------------------------------------ */
/*  Public getters                                                     */
/* ------------------------------------------------------------------ */

export function getValkeyStatus(): ValkeyStatus {
  return currentStatus;
}

export function getValkeyError(): string {
  return lastError;
}

export function isValkeyBinaryPresent(): boolean {
  if (process.platform === 'win32') {
    return fs.existsSync(getServerBinaryPath());
  }
  // For macOS/Linux we check at start time
  return true;
}

export function getValkeyPid(): number | null {
  return valkeyProcess?.pid ?? null;
}

function persistValkeyPid(pid: number | null): void {
  const config = getConfig();
  const lastPids = config.lastPids
    ?? { bot: null, dashboard: null, lavalink: null, valkey: null };
  const lastPidStartedAt = config.lastPidStartedAt
    ?? { bot: null, dashboard: null, lavalink: null, valkey: null };
  saveConfig({
    lastPids: { ...lastPids, valkey: pid },
    lastPidStartedAt: { ...lastPidStartedAt, valkey: pid === null ? null : Date.now() },
  });
}

/* ------------------------------------------------------------------ */
/*  System binary detection (macOS / Linux)                            */
/* ------------------------------------------------------------------ */

async function detectSystemBinary(): Promise<{
  available: boolean;
  path?: string;
  error?: string;
}> {
  // Try valkey-server first, fall back to redis-server
  for (const bin of ['valkey-server', 'redis-server']) {
    try {
      const cmd = process.platform === 'win32' ? 'where' : 'which';
      const { stdout } = await execFileAsync(cmd, [bin], { timeout: 5_000 });
      const binPath = stdout.trim().split('\n')[0];
      if (binPath) {
        return { available: true, path: binPath };
      }
    } catch {
      // Not found, try next
    }
  }

  return {
    available: false,
    error: process.platform === 'darwin'
      ? 'Valkey/Redis not found. Install via: brew install valkey'
      : 'Valkey/Redis not found. Install via: sudo apt install valkey-server (or redis-server)',
  };
}

/* ------------------------------------------------------------------ */
/*  Download (Windows only)                                            */
/* ------------------------------------------------------------------ */

export async function downloadValkey(
  onProgress?: (percent: number, downloadedMB: string, totalMB: string) => void,
): Promise<{ ok: boolean; error?: string }> {
  if (process.platform !== 'win32') {
    return {
      ok: false,
      error: 'Auto-download is only available on Windows. Install valkey-server or redis-server via your package manager.',
    };
  }

  const dir = getValkeyDir();
  await fsp.mkdir(dir, { recursive: true });

  const zipPath = path.join(dir, 'redis-windows.zip');

  setStatus('downloading');
  broadcastValkeyStatus();

  try {
    const response = await fetch(REDIS_WINDOWS_URL, { redirect: 'follow' });

    if (!response.ok) {
      const msg = `Download failed: HTTP ${response.status}`;
      setStatus('error', msg);
      broadcastValkeyStatus();
      return { ok: false, error: msg };
    }

    const total = parseInt(response.headers.get('content-length') ?? '0', 10);
    const reader = response.body?.getReader();

    if (!reader) {
      const msg = 'Download failed: no response body';
      setStatus('error', msg);
      broadcastValkeyStatus();
      return { ok: false, error: msg };
    }

    let downloaded = 0;
    const chunks: Uint8Array[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      downloaded += value.length;
      if (total > 0) {
        const percent = Math.round((downloaded / total) * 100);
        const dlMB = (downloaded / 1_048_576).toFixed(1);
        const totMB = (total / 1_048_576).toFixed(1);
        onProgress?.(percent, dlMB, totMB);
      }
    }

    // Write zip
    await fsp.writeFile(zipPath, Buffer.concat(chunks));

    // Extract using PowerShell (built-in on Windows)
    const extractDir = path.join(dir, '_extract');
    await fsp.rm(extractDir, { recursive: true, force: true });
    await fsp.mkdir(extractDir, { recursive: true });

    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force`,
    ], { timeout: 60_000 });

    // Find redis-server.exe in extracted files (may be in a subdirectory)
    const serverExe = await findFileRecursive(extractDir, 'redis-server.exe');
    if (!serverExe) {
      const msg = 'Extraction failed: redis-server.exe not found in archive';
      setStatus('error', msg);
      broadcastValkeyStatus();
      return { ok: false, error: msg };
    }

    // Copy redis-server.exe and any required DLLs to the valkey directory
    const exeDir = path.dirname(serverExe);
    const filesToCopy = await fsp.readdir(exeDir);
    for (const file of filesToCopy) {
      const ext = path.extname(file).toLowerCase();
      if (ext === '.exe' || ext === '.dll') {
        await fsp.copyFile(path.join(exeDir, file), path.join(dir, file));
      }
    }

    // Clean up
    await fsp.rm(extractDir, { recursive: true, force: true });
    await fsp.rm(zipPath, { force: true });

    setStatus('offline');
    broadcastValkeyStatus();
    return { ok: true };
  } catch (err) {
    // Clean up partial download
    try { await fsp.unlink(zipPath); } catch { /* ignore */ }
    const msg = `Download failed: ${err instanceof Error ? err.message : String(err)}`;
    setStatus('error', msg);
    broadcastValkeyStatus();
    return { ok: false, error: msg };
  }
}

/** Recursively find a file by name in a directory. */
async function findFileRecursive(dir: string, name: string): Promise<string | null> {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findFileRecursive(full, name);
      if (found) return found;
    } else if (entry.name.toLowerCase() === name.toLowerCase()) {
      return full;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  Start / Stop                                                       */
/* ------------------------------------------------------------------ */

export async function startValkey(): Promise<{
  ok: boolean;
  error?: string;
}> {
  if (valkeyProcess) {
    return { ok: true }; // Already running
  }

  let serverBin: string;

  if (process.platform === 'win32') {
    serverBin = getServerBinaryPath();
    if (!fs.existsSync(serverBin)) {
      // Auto-download Redis on first run (Windows only)
      console.log('[Valkey] Redis binary not found — downloading automatically...');
      const dlResult = await downloadValkey((percent, dlMB, totMB) => {
        if (percent % 25 === 0) {
          console.log(`[Valkey] Downloading Redis... ${percent}% (${dlMB}/${totMB} MB)`);
        }
      });
      if (!dlResult.ok) {
        setStatus('error', dlResult.error ?? 'Failed to download Redis');
        broadcastValkeyStatus();
        return { ok: false, error: dlResult.error };
      }
      // Verify binary exists after download
      if (!fs.existsSync(serverBin)) {
        const msg = 'Redis binary missing after download — extraction may have failed';
        setStatus('error', msg);
        broadcastValkeyStatus();
        return { ok: false, error: msg };
      }
    }
  } else {
    // macOS/Linux — detect system binary
    const detection = await detectSystemBinary();
    if (!detection.available || !detection.path) {
      setStatus('error', detection.error!);
      broadcastValkeyStatus();
      return { ok: false, error: detection.error };
    }
    serverBin = detection.path;
  }

  // Ensure data directory exists
  const dataDir = getDataDir();
  await fsp.mkdir(dataDir, { recursive: true });

  setStatus('starting');
  broadcastValkeyStatus();
  desiredRunning = true;

  return new Promise((resolve) => {
    // Start server with minimal, safe configuration:
    // - Bind to localhost only (never expose to network)
    // - Custom port (default 6379)
    // - Persist data in our data directory
    // - No protected mode warning (we bind to localhost)
    const args = [
      '--bind', '127.0.0.1',
      '--port', String(VALKEY_PORT),
      '--dir', dataDir,
      '--protected-mode', 'no',
      '--save', '60', '1',        // Save snapshot every 60s if at least 1 key changed
      '--loglevel', 'warning',    // Reduce noise
      '--daemonize', 'no',        // Run in foreground (we manage the process)
    ];

    const proc = spawn(serverBin, args, {
      cwd: dataDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Don't pass parent env to avoid leaking secrets
      env: (() => {
        const safe: Record<string, string> = {};
        for (const key of [
          'PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP',
          'SystemRoot', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC',
        ]) {
          if (process.env[key]) safe[key] = process.env[key]!;
        }
        return safe;
      })(),
    });

    valkeyProcess = proc;
    persistValkeyPid(proc.pid ?? null);
    let resolved = false;

    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      broadcastLog(text);

      // Detect ready string from Redis/Valkey
      if (!resolved && (
        text.includes('Ready to accept connections') ||
        text.includes('ready to accept connections') ||
        text.includes('The server is now ready')
      )) {
        resolved = true;
        setStatus('online');
        markStable(proc);
        broadcastValkeyStatus();
        resolve({ ok: true });
      }
    };

    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      broadcastLog(text, true);
      // Redis/Valkey logs to stdout, but check stderr too
      if (!resolved && text.includes('Ready to accept connections')) {
        resolved = true;
        setStatus('online');
        markStable(proc);
        broadcastValkeyStatus();
        resolve({ ok: true });
      }
    });

    proc.on('error', (err) => {
      const shouldRecover = shouldRecoverManagedProcess(desiredRunning, valkeyProcess, proc);
      if (valkeyProcess !== proc) return;
      const msg = `Valkey/Redis failed to start: ${err.message}`;
      if (stableTimer) clearTimeout(stableTimer);
      stableTimer = null;
      valkeyProcess = null;
      persistValkeyPid(null);
      setStatus('error', msg);
      broadcastValkeyStatus();
      if (!resolved) {
        resolved = true;
        resolve({ ok: false, error: msg });
      }
      if (shouldRecover) scheduleRecovery(msg);
    });

    proc.on('exit', (code) => {
      const shouldRecover = shouldRecoverManagedProcess(desiredRunning, valkeyProcess, proc);
      if (valkeyProcess !== proc) return;
      if (stableTimer) clearTimeout(stableTimer);
      stableTimer = null;
      valkeyProcess = null;
      persistValkeyPid(null);
      if (currentStatus !== 'offline') {
        const msg = code ? `Valkey/Redis exited with code ${code}` : 'Valkey/Redis stopped';
        setStatus(code ? 'error' : 'offline', code ? msg : '');
        broadcastValkeyStatus();
      }
      if (!resolved) {
        resolved = true;
        resolve({ ok: false, error: `Valkey/Redis exited with code ${code}` });
      }
      if (shouldRecover) scheduleRecovery(`Valkey/Redis exited with code ${code}.`);
    });

    // Prove the Redis protocol is usable; warning-only logging may omit ready text.
    void waitForServiceReady(
      () => probeValkeyReady('127.0.0.1', VALKEY_PORT),
      () => !resolved && valkeyProcess === proc,
      10_000,
    ).then((ready) => {
      if (resolved || valkeyProcess !== proc) return;
      resolved = true;
      if (ready) {
        setStatus('online');
        markStable(proc);
        broadcastValkeyStatus();
        resolve({ ok: true });
      } else {
        resolved = true;
        const msg = 'Valkey/Redis did not report ready within 10s.';
        setStatus('error', msg);
        broadcastValkeyStatus();
        resolve({ ok: false, error: msg });
        proc.kill('SIGTERM');
      }
    });
  });
}

export function stopValkey(): Promise<void> {
  if (stopPromise) return stopPromise;

  desiredRunning = false;
  restartAttempts = 0;
  if (restartTimer) clearTimeout(restartTimer);
  if (stableTimer) clearTimeout(stableTimer);
  restartTimer = null;
  stableTimer = null;
  const processToStop = valkeyProcess;
  setStatus('offline');
  broadcastValkeyStatus();

  if (!processToStop) return Promise.resolve();

  stopPromise = stopChildProcess(processToStop, { serviceName: 'Valkey' }).then(() => {
    if (valkeyProcess === processToStop) valkeyProcess = null;
    persistValkeyPid(null);
  }).finally(() => {
    stopPromise = null;
  });

  return stopPromise;
}

/* ------------------------------------------------------------------ */
/*  Internal helpers                                                   */
/* ------------------------------------------------------------------ */

function setStatus(status: ValkeyStatus, error?: string): void {
  currentStatus = status;
  if (error !== undefined) lastError = error;
  if (status !== 'error') lastError = '';
}

function broadcastValkeyStatus(): void {
  const payload = {
    status: currentStatus,
    error: lastError,
    binaryPresent: isValkeyBinaryPresent(),
  };

  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('valkey-status', payload);
    }
  }
}

function broadcastLog(text: string, isStderr = false): void {
  const line = text.trim();
  if (!line) return;

  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('valkey-log', { type: isStderr ? 'stderr' : 'stdout', line });
    }
  }
}
