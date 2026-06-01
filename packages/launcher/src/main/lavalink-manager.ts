/**
 * Lavalink Manager — download, configure, and run Lavalink as a child process.
 *
 * Handles:
 * - Java runtime detection (required for Lavalink)
 * - One-click Lavalink.jar download from GitHub releases
 * - application.yml generation with sensible defaults
 * - Child process lifecycle (start / stop / status)
 * - Status broadcasting to renderer via BrowserWindow IPC
 */

import { type ChildProcess, spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';

const execFileAsync = promisify(execFile);

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const LAVALINK_VERSION = '4.0.8';
const LAVALINK_JAR_URL = `https://github.com/lavalink-devs/Lavalink/releases/download/${LAVALINK_VERSION}/Lavalink.jar`;

/* ------------------------------------------------------------------ */
/*  State                                                              */
/* ------------------------------------------------------------------ */

export type LavalinkStatus = 'offline' | 'starting' | 'online' | 'error' | 'downloading';

let lavalinkProcess: ChildProcess | null = null;
let currentStatus: LavalinkStatus = 'offline';
let lastError = '';

// V7 Audit §9.8: Single source of truth for the managed Lavalink password.
// Resolved once at startup — used in both application.yml and LAVALINK_PASSWORD env var.
let _lavalinkPassword: string | null = null;

/** Get the Lavalink password used for the current managed instance. */
export function getLavalinkPassword(): string {
  if (!_lavalinkPassword) {
    // Prefer explicit env var; otherwise generate a random password for this launch
    _lavalinkPassword = process.env.LAVALINK_PASSWORD || randomBytes(16).toString('hex');
  }
  return _lavalinkPassword;
}

/* ------------------------------------------------------------------ */
/*  Paths                                                              */
/* ------------------------------------------------------------------ */

function getLavalinkDir(): string {
  return path.join(app.getPath('userData'), 'lavalink');
}

function getJarPath(): string {
  return path.join(getLavalinkDir(), 'Lavalink.jar');
}

function getConfigPath(): string {
  return path.join(getLavalinkDir(), 'application.yml');
}

/* ------------------------------------------------------------------ */
/*  Public getters                                                     */
/* ------------------------------------------------------------------ */

export function getLavalinkStatus(): LavalinkStatus {
  return currentStatus;
}

export function getLavalinkError(): string {
  return lastError;
}

export function isLavalinkJarPresent(): boolean {
  return fs.existsSync(getJarPath());
}

export function getLavalinkPid(): number | null {
  return lavalinkProcess?.pid ?? null;
}

/* ------------------------------------------------------------------ */
/*  Java detection                                                     */
/* ------------------------------------------------------------------ */

export async function checkJava(): Promise<{
  available: boolean;
  version?: string;
  error?: string;
}> {
  try {
    // java -version prints to stderr on most JDK implementations
    const { stderr, stdout } = await execFileAsync('java', ['-version'], {
      timeout: 10_000,
    });
    const output = stderr || stdout;
    const match = output.match(/version "(.+?)"/);
    return { available: true, version: match?.[1] ?? 'unknown' };
  } catch {
    return {
      available: false,
      error:
        'Java not found. Install Java 17+ from https://adoptium.net to enable music.',
    };
  }
}

/* ------------------------------------------------------------------ */
/*  Download Lavalink.jar                                              */
/* ------------------------------------------------------------------ */

export async function downloadLavalink(
  onProgress?: (percent: number, downloadedMB: string, totalMB: string) => void,
): Promise<{ ok: boolean; error?: string }> {
  const dir = getLavalinkDir();
  await fsp.mkdir(dir, { recursive: true });

  const jarPath = getJarPath();
  const tempPath = `${jarPath}.downloading`;

  setStatus('downloading');
  broadcastLavalinkStatus();

  try {
    const response = await fetch(LAVALINK_JAR_URL, { redirect: 'follow' });

    if (!response.ok) {
      const msg = `Download failed: HTTP ${response.status}`;
      setStatus('error', msg);
      broadcastLavalinkStatus();
      return { ok: false, error: msg };
    }

    const total = parseInt(response.headers.get('content-length') ?? '0', 10);
    const reader = response.body?.getReader();

    if (!reader) {
      const msg = 'Download failed: no response body';
      setStatus('error', msg);
      broadcastLavalinkStatus();
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

    // Write atomically via temp file
    await fsp.writeFile(tempPath, Buffer.concat(chunks));
    await fsp.rename(tempPath, jarPath);

    // Generate default application.yml
    await writeDefaultConfig();

    setStatus('offline');
    broadcastLavalinkStatus();
    return { ok: true };
  } catch (err) {
    // Clean up partial download
    try {
      await fsp.unlink(tempPath);
    } catch {
      /* ignore */
    }
    const msg = `Download failed: ${err instanceof Error ? err.message : String(err)}`;
    setStatus('error', msg);
    broadcastLavalinkStatus();
    return { ok: false, error: msg };
  }
}

/* ------------------------------------------------------------------ */
/*  application.yml generation                                         */
/* ------------------------------------------------------------------ */

async function writeDefaultConfig(): Promise<void> {
  const yml = [
    'server:',
    '  port: 2333',
    '  address: 127.0.0.1',
    'lavalink:',
    '  server:',
    `    password: "${getLavalinkPassword()}"`,
    '    sources:',
    '      youtube: true',
    '      bandcamp: true',
    '      soundcloud: true',
    '      twitch: true',
    '      vimeo: true',
    '      http: true',
    '      local: false',
    '    bufferDurationMs: 400',
    '    frameBufferDurationMs: 5000',
    '    youtubePlaylistLoadLimit: 6',
    '    playerUpdateInterval: 5',
    '    youtubeSearchEnabled: true',
    '    soundcloudSearchEnabled: true',
    '    gc-warnings: true',
    'logging:',
    '  file:',
    '    path: ./logs/',
    '  level:',
    '    root: INFO',
    '    lavalink: INFO',
    '',
  ].join('\n');
  await fsp.writeFile(getConfigPath(), yml, 'utf-8');
}

/* ------------------------------------------------------------------ */
/*  Start / Stop                                                       */
/* ------------------------------------------------------------------ */

export async function startLavalink(): Promise<{
  ok: boolean;
  error?: string;
}> {
  if (lavalinkProcess) {
    return { ok: true }; // Already running
  }

  const jarPath = getJarPath();
  if (!fs.existsSync(jarPath)) {
    const msg = 'Lavalink.jar not found. Download it first.';
    setStatus('error', msg);
    broadcastLavalinkStatus();
    return { ok: false, error: msg };
  }

  const javaCheck = await checkJava();
  if (!javaCheck.available) {
    setStatus('error', javaCheck.error!);
    broadcastLavalinkStatus();
    return { ok: false, error: javaCheck.error };
  }

  // Ensure config exists
  if (!fs.existsSync(getConfigPath())) {
    await writeDefaultConfig();
  }

  setStatus('starting');
  broadcastLavalinkStatus();

  return new Promise((resolve) => {
    const cwd = getLavalinkDir();
    // Only forward essential system env vars to the Java process.
    // Mirrors the safeParentEnv() approach used for bot/dashboard —
    // avoids leaking Discord tokens, Supabase keys, etc. to Lavalink.
    const safeEnv: Record<string, string> = {};
    for (const key of [
      'PATH', 'JAVA_HOME', 'LANG', 'TZ', 'HOME', 'USERPROFILE',
      'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'APPDATA', 'LOCALAPPDATA',
      'PROGRAMFILES', 'COMSPEC', 'XDG_RUNTIME_DIR',
    ]) {
      if (process.env[key]) safeEnv[key] = process.env[key]!;
    }
    const proc = spawn('java', ['-jar', jarPath], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: safeEnv,
    });

    lavalinkProcess = proc;
    let resolved = false;

    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      broadcastLog(text);

      // Detect ready string from Lavalink 4.x
      if (!resolved && (text.includes('Lavalink is ready') || text.includes('Started Launcher'))) {
        resolved = true;
        setStatus('online');
        broadcastLavalinkStatus();
        resolve({ ok: true });
      }
    };

    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', (chunk: Buffer) => {
      broadcastLog(chunk.toString(), true);
    });

    proc.on('error', (err) => {
      const msg = `Lavalink failed to start: ${err.message}`;
      lavalinkProcess = null;
      setStatus('error', msg);
      broadcastLavalinkStatus();
      if (!resolved) {
        resolved = true;
        resolve({ ok: false, error: msg });
      }
    });

    proc.on('exit', (code) => {
      lavalinkProcess = null;
      if (currentStatus !== 'offline') {
        const msg = code ? `Lavalink exited with code ${code}` : 'Lavalink stopped';
        setStatus(code ? 'error' : 'offline', code ? msg : '');
        broadcastLavalinkStatus();
      }
      if (!resolved) {
        resolved = true;
        resolve({ ok: false, error: `Lavalink exited with code ${code}` });
      }
    });

    // Timeout — if not detected as ready within 30s, assume OK
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        if (currentStatus === 'starting') {
          setStatus('online');
          broadcastLavalinkStatus();
        }
        resolve({ ok: true });
      }
    }, 30_000);
  });
}

export function stopLavalink(): void {
  if (lavalinkProcess) {
    const pid = lavalinkProcess.pid;
    lavalinkProcess.kill('SIGTERM');
    // Force kill after 5s
    if (pid) {
      setTimeout(() => {
        try {
          process.kill(pid, 0); // Check if alive
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already dead — good
        }
      }, 5_000);
    }
    lavalinkProcess = null;
  }
  setStatus('offline');
  broadcastLavalinkStatus();
}

/* ------------------------------------------------------------------ */
/*  Internal helpers                                                   */
/* ------------------------------------------------------------------ */

function setStatus(status: LavalinkStatus, error?: string): void {
  currentStatus = status;
  if (error !== undefined) lastError = error;
  if (status !== 'error') lastError = '';
}

function broadcastLavalinkStatus(): void {
  const payload = {
    status: currentStatus,
    error: lastError,
    jarPresent: isLavalinkJarPresent(),
  };

  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('lavalink-status', payload);
    }
  }
}

function broadcastLog(text: string, isStderr = false): void {
  const line = text.trim();
  if (!line) return;

  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('lavalink-log', { type: isStderr ? 'stderr' : 'stdout', line });
    }
  }
}
