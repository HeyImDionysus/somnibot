/**
 * SomniBot Launcher — Main Process.
 *
 * Creates the launcher window, handles IPC from the renderer,
 * manages bot + dashboard child processes, and delegates auto-updates
 * to the updater module.
 */

import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getConfig, saveConfig, buildEnvVars, type LauncherConfig } from './config-store.js';
import { validateAllCredentials } from './validators.js';
import { startAll, stopAll, getStatus, isRunning, checkPortAvailable, cleanupStaleProcesses } from './process-manager.js';
import { pushToSupabase } from './supabase-sync.js';
import { initUpdater } from './updater.js';
import {
  checkJava,
  downloadLavalink,
  startLavalink,
  stopLavalink,
  getLavalinkStatus,
  getLavalinkError,
  isLavalinkJarPresent,
} from './lavalink-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ */
/*  App setup                                                          */
/* ------------------------------------------------------------------ */

// Single instance lock — only one launcher at a time
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let sessionToken: string | null = null;

function createWindow(): void {
  const config = getConfig();
  const bounds = config.windowBounds ?? { width: 760, height: 680 };

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 640,
    minHeight: 560,
    title: 'SomniBot',
    backgroundColor: '#0d0d0d',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // V5 Audit [10.2]: Enable Chromium sandbox. The preload script only uses
      // contextBridge + ipcRenderer, both of which work in sandboxed mode.
      sandbox: true,
    },
  });

  // Load the renderer HTML
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Show when ready to avoid white flash
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  // Save window bounds on move/resize
  const saveBounds = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const [width, height] = mainWindow.getSize();
      const [x, y] = mainWindow.getPosition();
      saveConfig({ windowBounds: { width, height, x, y } });
    }
  };
  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/* ------------------------------------------------------------------ */
/*  IPC Handlers                                                       */
/* ------------------------------------------------------------------ */

function registerIpcHandlers(): void {
  // ── Config ──
  ipcMain.handle('get-config', () => {
    const config = getConfig();
    return {
      discordToken: config.discordToken,
      discordApplicationId: config.discordApplicationId,
      discordClientSecret: config.discordClientSecret,
      discordGuildId: config.discordGuildId,
      supabaseUrl: config.supabaseUrl,
      supabaseSecretKey: config.supabaseSecretKey,
      supabasePublishableKey: config.supabasePublishableKey,
    };
  });

  ipcMain.handle('save-config', (_event, config: Partial<LauncherConfig>) => {
    saveConfig(config);
  });

  // ── Validation ──
  ipcMain.handle('validate-credentials', async (_event, config) => {
    return validateAllCredentials(config);
  });

  // ── Process control ──
  ipcMain.handle('start-bot', async () => {
    const config = getConfig();

    // Validate that required fields are filled
    if (!config.discordToken || !config.supabaseUrl || !config.supabaseSecretKey) {
      return { ok: false, error: 'Fill in all required fields first.' };
    }

    // Phase 6: Check port availability before starting
    const portFree = await checkPortAvailable(3456);
    if (!portFree) {
      return {
        ok: false,
        error: 'Port 3456 is already in use. Close the application using that port, or restart your computer and try again.',
      };
    }

    // Phase 6: Start managed Lavalink if enabled (non-blocking)
    if (config.lavalinkEnabled) {
      const llResult = await startLavalink();
      if (!llResult.ok) {
        // Non-fatal — music just won't work. Notify but continue.
        console.warn('[Launcher] Lavalink failed to start:', llResult.error);
      }
    }

    // Generate a new session token for this run
    sessionToken = crypto.randomBytes(32).toString('hex');

    // Build env vars and start processes
    const envVars = buildEnvVars(config, sessionToken);
    startAll(envVars);

    // Sync credentials to Supabase in background (best-effort)
    pushToSupabase(config.supabaseUrl, config.supabaseSecretKey, {
      discordToken: config.discordToken,
      discordApplicationId: config.discordApplicationId,
      discordClientSecret: config.discordClientSecret,
      discordGuildId: config.discordGuildId,
      supabasePublishableKey: config.supabasePublishableKey,
    }).catch(() => {
      // Silent — sync is best-effort
    });

    return { ok: true };
  });

  ipcMain.handle('stop-bot', () => {
    stopAll();
    stopLavalink();
    sessionToken = null;
  });

  ipcMain.handle('get-status', () => {
    return getStatus();
  });

  // ── Dashboard ──
  ipcMain.handle('open-dashboard', () => {
    shell.openExternal('http://localhost:3456');
  });

  // ── External links ──
  // V5 Audit [1.1]: Only allow https:// URLs to prevent protocol abuse.
  // The open-dashboard handler has its own explicit http://localhost:3456 allowance.
  ipcMain.handle('open-external', (_event, url: string) => {
    if (url.startsWith('https://')) {
      shell.openExternal(url);
    }
  });

  // ── Cloud sync ──
  ipcMain.handle('pull-from-supabase', async (_event, supabaseUrl: string, supabaseSecretKey: string) => {
    const { pullFromSupabase } = await import('./supabase-sync.js');
    const result = await pullFromSupabase(supabaseUrl, supabaseSecretKey);
    if (result.ok && result.credentials) {
      saveConfig(result.credentials);
    }
    return result;
  });

  // ── App info ──
  ipcMain.on('get-version', (event) => {
    event.returnValue = app.getVersion();
  });

  // ── Phase 6: First-run onboarding ──
  ipcMain.handle('is-first-run', () => {
    return !getConfig().firstRunComplete;
  });

  ipcMain.handle('complete-first-run', () => {
    saveConfig({ firstRunComplete: true });
  });

  // ── Phase 6: Lavalink management ──
  ipcMain.handle('get-lavalink-enabled', () => {
    return getConfig().lavalinkEnabled;
  });

  ipcMain.handle('set-lavalink-enabled', (_event, enabled: boolean) => {
    saveConfig({ lavalinkEnabled: enabled });
  });

  ipcMain.handle('check-java', async () => {
    return checkJava();
  });

  ipcMain.handle('download-lavalink', async () => {
    const result = await downloadLavalink((percent, downloadedMB, totalMB) => {
      // Forward progress to renderer
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('lavalink-download-progress', { percent, downloadedMB, totalMB });
        }
      }
    });
    return result;
  });

  ipcMain.handle('get-lavalink-info', () => {
    return {
      status: getLavalinkStatus(),
      jarPresent: isLavalinkJarPresent(),
      error: getLavalinkError(),
    };
  });
}

/* ------------------------------------------------------------------ */
/*  App lifecycle                                                      */
/* ------------------------------------------------------------------ */

app.whenReady().then(() => {
  // Phase 6: Clean up stale processes from a previous crash
  cleanupStaleProcesses();

  registerIpcHandlers();
  createWindow();

  // macOS: re-create window when dock icon is clicked
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });

  // Auto-updater
  initUpdater();
});

// Second instance: focus the existing window
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// Clean shutdown — kill child processes before quitting
app.on('before-quit', () => {
  if (isRunning()) {
    stopAll();
  }
  stopLavalink();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (isRunning()) {
      stopAll();
    }
    stopLavalink();
    app.quit();
  }
});
