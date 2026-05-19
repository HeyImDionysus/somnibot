/**
 * Process Manager — spawns and manages bot + dashboard child processes.
 *
 * Bot: fork() with env vars, IPC heartbeat monitoring.
 * Dashboard: fork() Next.js standalone server on localhost:3456.
 * Clean shutdown on app close.
 */

import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type ProcessStatus = 'offline' | 'starting' | 'online' | 'error';

export interface StatusUpdate {
  bot: ProcessStatus;
  dashboard: ProcessStatus;
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
/*  Resource paths                                                     */
/* ------------------------------------------------------------------ */

/**
 * In development, resources are in the repo. In production (packaged),
 * they're in app.getPath('exe')/../resources/.
 */
function getResourcePath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath);
  }
  // Dev mode — resources are at repo root
  return path.join(app.getAppPath(), '..', '..');
}

function getBotEntryPath(): string {
  if (app.isPackaged) {
    return path.join(getResourcePath(), 'bot', 'dist', 'index.js');
  }
  // Dev mode — use the built bot directly
  return path.join(getResourcePath(), 'packages', 'bot', 'dist', 'index.js');
}

function getDashboardEntryPath(): string {
  if (app.isPackaged) {
    // Standalone build with outputFileTracingRoot preserves monorepo structure:
    //   resources/dashboard/packages/dashboard/server.js
    return path.join(getResourcePath(), 'dashboard', 'packages', 'dashboard', 'server.js');
  }
  // Dev mode — use the standalone build
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
    botPid: botProcess?.pid,
    dashboardPid: dashboardProcess?.pid,
    lastHeartbeat: lastHeartbeat || undefined,
    ...extra,
  };

  statusCallback?.(status);

  // Also send to all renderer windows
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
    botPid: botProcess?.pid,
    dashboardPid: dashboardProcess?.pid,
    lastHeartbeat: lastHeartbeat || undefined,
  };
}

/* ------------------------------------------------------------------ */
/*  Bot process                                                        */
/* ------------------------------------------------------------------ */

function startBotProcess(envVars: Record<string, string>): void {
  const entryPath = getBotEntryPath();
  botStatus = 'starting';
  broadcastStatus();

  botProcess = fork(entryPath, [], {
    env: { ...process.env, ...envVars },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    silent: true,
  });

  // Capture stdout/stderr for log display
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

  // IPC heartbeat from bot
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
    broadcastStatus({
      error: wasOnline
        ? `Bot process exited (code: ${code}, signal: ${signal})`
        : undefined,
    });
  });

  botProcess.on('error', (err) => {
    botStatus = 'error';
    broadcastStatus({ error: `Bot process error: ${err.message}` });
  });

  // If no heartbeat within 30s, mark as online anyway (bot might not send IPC)
  // The bot's startup sequence takes time — be patient
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

  dashboardProcess = fork(entryPath, [], {
    env: { ...process.env, ...envVars },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    silent: true,
  });

  dashboardProcess.stdout?.on('data', (data: Buffer) => {
    const line = data.toString().trim();
    if (line) {
      // Detect when Next.js is ready
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
    broadcastStatus({
      error: code !== 0
        ? `Dashboard exited (code: ${code}, signal: ${signal})`
        : undefined,
    });
  });

  dashboardProcess.on('error', (err) => {
    dashboardStatus = 'error';
    broadcastStatus({ error: `Dashboard error: ${err.message}` });
  });

  // Dashboard should be ready within 15s
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
    // If bot was online but no heartbeat in 60s, mark as error
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
    // Force kill after 5s if graceful shutdown doesn't work
    const pid = botProcess.pid;
    setTimeout(() => {
      try {
        if (pid) process.kill(pid, 0); // Check if still alive
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
  broadcastStatus();
}

export function isRunning(): boolean {
  return botProcess !== null || dashboardProcess !== null;
}
