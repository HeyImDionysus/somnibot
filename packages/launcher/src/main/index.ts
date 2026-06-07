/**
 * SomniBot Launcher — Main Process.
 *
 * Creates the launcher window, handles IPC from the renderer,
 * manages bot + dashboard child processes, and delegates auto-updates
 * to the updater module.
 */

import { app, BrowserWindow, ipcMain, session, shell } from 'electron';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getConfig, saveConfig, buildEnvVars, type LauncherConfig } from './config-store.js';
import { getLauncherLocalStartBlocker } from './runtime-profile.js';
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
import {
  downloadValkey,
  startValkey,
  stopValkey,
  getValkeyStatus,
  getValkeyError,
  isValkeyBinaryPresent,
} from './valkey-manager.js';

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

async function createWindow(): Promise<void> {
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

  // V5-Audit §10.1: Enforce Content-Security-Policy on the renderer.
  // The launcher loads only local HTML/CSS/JS — no CDN, no inline scripts.
  // This CSP blocks XSS even if an attacker injects content into the renderer.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none';",
        ],
      },
    });
  });

  // Load the renderer HTML.
  // Primary: dist/renderer/ (copied during build). Fallback: src/renderer/ (source).
  // app.getAppPath() returns the asar root in packaged builds, or the package
  // dir in development — both work because electron-builder includes both paths.
  const distRenderer = path.join(__dirname, '..', 'renderer', 'index.html');
  const srcRenderer = path.join(app.getAppPath(), 'src', 'renderer', 'index.html');

  // Use whichever exists — check dist first (the build copy), fall back to src
  const { existsSync } = await import('node:fs');
  const rendererPath = existsSync(distRenderer) ? distRenderer : srcRenderer;

  // Debug: log the resolved renderer path for troubleshooting
  console.log('[Launcher] Renderer dist path:', distRenderer, '→ exists:', existsSync(distRenderer));
  console.log('[Launcher] Renderer src path:', srcRenderer, '→ exists:', existsSync(srcRenderer));
  console.log('[Launcher] Using:', rendererPath);

  mainWindow.loadFile(rendererPath).catch((err) => {
    console.error('[Launcher] Failed to load renderer:', err);
  });

  // Open DevTools only in development — never in packaged builds
  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // Log renderer load failures
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[Launcher] Renderer failed to load: ${errorCode} ${errorDescription} (${validatedURL})`);
  });

  // Log renderer console messages to main process stdout for debugging
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const tag = ['LOG', 'WARN', 'ERROR'][level] ?? 'LOG';
    console.log(`[Renderer ${tag}] ${message} (${sourceId}:${line})`);
  });

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
      // V5 Audit §10.P3a: Mask secret key — renderer only needs to know if it's set,
      // not the actual value. Supabase operations are handled in the main process.
      supabaseSecretKey: config.supabaseSecretKey ? '••••••••' : '',
      supabasePublishableKey: config.supabasePublishableKey,
      supabaseDbPassword: config.supabaseDbPassword ? '••••••••' : '',
      runtimeMode: config.runtimeMode,
      publicCallbackBaseUrl: config.publicCallbackBaseUrl,
      vpsDomain: config.vpsDomain,
      vpsSshHost: config.vpsSshHost,
      vpsSshUser: config.vpsSshUser,
      vpsDeployPath: config.vpsDeployPath,
    };
  });

  ipcMain.handle('save-config', (_event, config: Partial<LauncherConfig>) => {
    // V5 Audit §10.P3a: Never overwrite a real secret with the mask placeholder.
    // The renderer receives '••••••••' for masked fields; if it sends that value
    // back, strip it so the real secret in the config store is preserved.
    const MASK = '••••••••';
    const sanitized = { ...config };
    for (const key of ['supabaseSecretKey', 'supabaseDbPassword', 'discordToken', 'discordClientSecret'] as const) {
      if (sanitized[key] === MASK) {
        delete sanitized[key];
      }
    }
    saveConfig(sanitized);
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

    const runtimeBlocker = getLauncherLocalStartBlocker(config);
    if (runtimeBlocker) {
      return { ok: false, error: runtimeBlocker };
    }

    // Phase 6: Check port availability before starting
    const portFree = await checkPortAvailable(3456);
    if (!portFree) {
      return {
        ok: false,
        error: 'Port 3456 is already in use. Close the application using that port, or restart your computer and try again.',
      };
    }

    // Start Valkey/Redis server (required for cache, rate limiting, XP cooldowns)
    const vkResult = await startValkey();
    if (!vkResult.ok) {
      // Non-fatal — bot has in-memory fallbacks, but features are degraded.
      console.warn('[Launcher] Valkey/Redis failed to start:', vkResult.error);
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
      supabaseDbPassword: config.supabaseDbPassword,
    }).catch(() => {
      // Silent — sync is best-effort
    });

    return { ok: true };
  });

  ipcMain.handle('stop-bot', () => {
    stopAll();
    stopLavalink();
    stopValkey();
    sessionToken = null;
  });

  ipcMain.handle('get-status', () => {
    return getStatus();
  });

  // ── Dashboard ──
  // V5C-9: This URL is intentionally http://localhost:3456 (not https).
  // The launcher only runs locally — the Next.js dev/standalone server
  // binds to localhost without TLS. Hosted deployments and VPS domains
  // do NOT use the launcher; they have their own HTTPS termination.
  // Do NOT make this URL configurable without also adding URL validation.
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
  // V5 Audit §10.P3a: Use main-process config for secret — renderer never receives it.
  ipcMain.handle('pull-from-supabase', async () => {
    const cfg = getConfig();
    const { pullFromSupabase } = await import('./supabase-sync.js');
    const result = await pullFromSupabase(cfg.supabaseUrl, cfg.supabaseSecretKey);
    if (result.ok && result.credentials) {
      saveConfig(result.credentials);
    }
    return result;
  });

  // ── App info ──
  ipcMain.handle('get-version', () => app.getVersion());

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


  // ── Valkey/Redis management ──
  ipcMain.handle('get-valkey-info', () => {
    return {
      status: getValkeyStatus(),
      binaryPresent: isValkeyBinaryPresent(),
      error: getValkeyError(),
    };
  });

  ipcMain.handle('download-valkey', async () => {
    const result = await downloadValkey((percent, downloadedMB, totalMB) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('valkey-download-progress', { percent, downloadedMB, totalMB });
        }
      }
    });
    return result;
  });
}

/* ------------------------------------------------------------------ */
/*  App lifecycle                                                      */
/* ------------------------------------------------------------------ */

app.whenReady().then(async () => {
  // Phase 6: Clean up stale processes from a previous crash
  cleanupStaleProcesses();

  registerIpcHandlers();
  await createWindow();

  // macOS: re-create window when dock icon is clicked
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });

  // Auto-updater — must await so IPC handlers are registered before renderer calls them
  await initUpdater();
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
  stopValkey();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (isRunning()) {
      stopAll();
    }
    stopLavalink();
    stopValkey();
    app.quit();
  }
});
