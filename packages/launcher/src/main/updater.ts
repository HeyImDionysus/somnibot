/**
 * Auto-Updater — download, progress tracking, and install via electron-updater.
 *
 * Flow:
 *   Launch → auto-check → (update available?) → user clicks "Install now" →
 *   download with progress → downloaded → user clicks "Restart" →
 *   quitAndInstall.
 *
 * IPC channels (main → renderer):
 *   updater:checking        — check started
 *   updater:available       — { version }
 *   updater:not-available   — no update found
 *   updater:progress        — { percent, transferred, total, bytesPerSecond }
 *   updater:downloaded      — ready to install
 *   updater:error           — { message }
 *
 * IPC handlers (renderer → main):
 *   updater:check           — trigger a manual check
 *   updater:download        — start downloading the available update
 *   updater:install         — quit and install the downloaded update
 */

import { BrowserWindow, ipcMain } from 'electron';

/** Whether a downloaded update is staged and ready to install. */
let updateReady = false;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Init                                                               */
/* ------------------------------------------------------------------ */

/**
 * Initialise the auto-updater, wire up all events and IPC handlers.
 * Safe to call in dev — no-ops gracefully when electron-updater cannot resolve.
 */
export async function initUpdater(): Promise<void> {
  // Dynamic import — electron-updater may fail in dev or when not bundled
  let mod: typeof import('electron-updater');
  try {
    mod = await import('electron-updater');
  } catch {
    registerNoopHandlers();
    return;
  }

  const { autoUpdater } = mod;

  // User must explicitly click "Install now" — no silent background downloads
  autoUpdater.autoDownload = false;
  // If an update was downloaded and the user closes the app, install on next launch
  autoUpdater.autoInstallOnAppQuit = true;

  /* ── Events → Renderer ─────────────────────────────────────────── */

  autoUpdater.on('checking-for-update', () => {
    broadcast('updater:checking', {});
  });

  autoUpdater.on('update-available', (info) => {
    broadcast('updater:available', { version: info.version });
  });

  autoUpdater.on('update-not-available', () => {
    broadcast('updater:not-available', {});
  });

  autoUpdater.on('download-progress', (progress) => {
    broadcast('updater:progress', {
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond,
    });
  });

  autoUpdater.on('update-downloaded', () => {
    updateReady = true;
    broadcast('updater:downloaded', {});
  });

  autoUpdater.on('error', (err: Error) => {
    broadcast('updater:error', { message: err?.message ?? String(err) });
  });

  /* ── IPC Handlers ──────────────────────────────────────────────── */

  ipcMain.handle('updater:check', async () => {
    try {
      await autoUpdater.checkForUpdates();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle('updater:download', async () => {
    try {
      await autoUpdater.downloadUpdate();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle('updater:install', () => {
    if (updateReady) {
      // isSilent = false (show installer), isForceRunAfter = true (relaunch app)
      autoUpdater.quitAndInstall(false, true);
    }
  });

  /* ── Auto-check on launch ──────────────────────────────────────── */

  autoUpdater.checkForUpdates().catch(() => {
    // Silent — don't block app startup if the update server is unreachable
  });
}

/* ------------------------------------------------------------------ */
/*  Noop handlers for dev mode                                         */
/* ------------------------------------------------------------------ */

/** Register harmless stubs so renderer calls never throw. */
function registerNoopHandlers(): void {
  ipcMain.handle('updater:check', () => ({
    ok: false,
    error: 'Updater not available in dev mode.',
  }));
  ipcMain.handle('updater:download', () => ({
    ok: false,
    error: 'Updater not available in dev mode.',
  }));
  ipcMain.handle('updater:install', () => undefined);
}
