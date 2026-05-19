/**
 * SomniBot Launcher — Main Process.
 *
 * Creates the launcher window, handles IPC from the renderer,
 * manages bot + dashboard child processes, and handles auto-updates.
 */

import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getConfig, saveConfig, buildEnvVars, type LauncherConfig } from './config-store.js';
import { validateAllCredentials } from './validators.js';
import { startAll, stopAll, getStatus, isRunning } from './process-manager.js';

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
      sandbox: false, // Need node APIs in preload
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
    // Return as plain object (no class methods)
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
  ipcMain.handle('start-bot', () => {
    const config = getConfig();

    // Validate that required fields are filled
    if (!config.discordToken || !config.supabaseUrl || !config.supabaseSecretKey) {
      return { ok: false, error: 'Fill in all required fields first.' };
    }

    // Generate a new session token for this run
    sessionToken = crypto.randomBytes(32).toString('hex');

    // Build env vars and start processes
    const envVars = buildEnvVars(config, sessionToken);
    startAll(envVars);

    return { ok: true };
  });

  ipcMain.handle('stop-bot', () => {
    stopAll();
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
  ipcMain.handle('open-external', (_event, url: string) => {
    // Only allow http/https URLs
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
  });

  // ── App info ──
  ipcMain.on('get-version', (event) => {
    event.returnValue = app.getVersion();
  });

  ipcMain.handle('check-for-updates', async () => {
    try {
      // Dynamic import — electron-updater might not be available in dev
      const { autoUpdater } = await import('electron-updater');
      autoUpdater.checkForUpdatesAndNotify();
    } catch {
      // Updater not available in dev mode — silently ignore
    }
  });
}

/* ------------------------------------------------------------------ */
/*  App lifecycle                                                      */
/* ------------------------------------------------------------------ */

app.whenReady().then(() => {
  registerIpcHandlers();
  createWindow();

  // macOS: re-create window when dock icon is clicked
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });

  // Auto-update check on launch (production only)
  if (app.isPackaged) {
    import('electron-updater').then(({ autoUpdater }) => {
      autoUpdater.autoDownload = false;
      autoUpdater.checkForUpdatesAndNotify().catch(() => {
        // Silent — don't block app startup if update check fails
      });

      autoUpdater.on('update-available', (info) => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('update-available', {
              version: info.version,
            });
          }
        }
      });
    }).catch(() => {
      // electron-updater not available — fine
    });
  }
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
});

app.on('window-all-closed', () => {
  // On macOS, apps stay open until Cmd+Q
  if (process.platform !== 'darwin') {
    if (isRunning()) {
      stopAll();
    }
    app.quit();
  }
});
