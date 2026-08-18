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

import { randomUUID } from 'node:crypto';
import { BrowserWindow, ipcMain } from 'electron';
import {
  buildLauncherAttemptAuditEntry,
  LauncherAttemptTracker,
  type LauncherAttemptCode,
  type LauncherAttemptIdentity,
  type LauncherAttemptPhase,
  type LauncherAttemptResult,
  type LauncherAuditEntry,
} from './audit-log.js';

/** Whether a downloaded update is staged and ready to install. */
let updateReady = false;

/** [infrastructure-launcher] Optional durable-audit sink for update lifecycle
 *  security events (download staged, install triggered). */
export interface UpdaterOptions {
  recordAudit?: (entry: LauncherAuditEntry) => void;
  autoInstallOnQuit?: boolean;
  updatePromptBeforeDownload?: boolean;
}

let auditSink: ((entry: LauncherAuditEntry) => void) | undefined;

export interface UpdaterAttemptRuntime {
  readonly tracker: LauncherAttemptTracker;
  readonly now: () => string;
  readonly recordAudit: (entry: LauncherAuditEntry) => void;
}

const defaultUpdaterAttemptRuntime: UpdaterAttemptRuntime = {
  tracker: new LauncherAttemptTracker(randomUUID),
  now: () => new Date().toISOString(),
  recordAudit: (entry) => auditSink?.(entry),
};

interface UpdaterAttemptOutcome {
  readonly identity: LauncherAttemptIdentity;
  readonly phase: LauncherAttemptPhase;
  readonly result: LauncherAttemptResult;
  readonly code: LauncherAttemptCode;
}

function recordUpdaterAttempt(outcome: UpdaterAttemptOutcome, runtime: UpdaterAttemptRuntime): void {
  runtime.recordAudit(buildLauncherAttemptAuditEntry({
    operationId: outcome.identity.operationId,
    attempt: outcome.identity.attempt,
    phase: outcome.phase,
    result: outcome.result,
    code: outcome.code,
    message: '',
    timestamp: runtime.now(),
  }));
  runtime.tracker.finish(outcome.phase, outcome.result);
}

export interface UpdaterOperation {
  readonly phase: 'updater-check' | 'updater-download';
  readonly execute: () => Promise<unknown>;
  readonly successCode: LauncherAttemptCode;
  readonly retryCode: LauncherAttemptCode;
}

export async function runUpdaterOperation(
  operation: UpdaterOperation,
  runtime: UpdaterAttemptRuntime = defaultUpdaterAttemptRuntime,
): Promise<{ ok: boolean; error?: string }> {
  const identity = runtime.tracker.next(operation.phase);

  try {
    await operation.execute();
    recordUpdaterAttempt({
      identity,
      phase: operation.phase,
      result: 'success',
      code: operation.successCode,
    }, runtime);
    return { ok: true };
  } catch (error) {
    recordUpdaterAttempt({
      identity,
      phase: operation.phase,
      result: 'retry',
      code: operation.retryCode,
    }, runtime);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function recordUnavailableUpdaterAttempt(
  phase: UpdaterOperation['phase'],
  runtime: UpdaterAttemptRuntime = defaultUpdaterAttemptRuntime,
): { ok: false; error: string } {
  const identity = runtime.tracker.next(phase);
  recordUpdaterAttempt({
    identity,
    phase,
    result: 'failure',
    code: 'updater_unavailable',
  }, runtime);
  return { ok: false, error: 'Updater not available in dev mode.' };
}

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
export async function initUpdater(options: UpdaterOptions = {}): Promise<void> {
  auditSink = options.recordAudit;
  // Dynamic import — electron-updater may fail in dev or when not bundled
  let mod: typeof import('electron-updater');
  try {
    mod = await import('electron-updater');
  } catch {
    registerNoopHandlers();
    return;
  }

  // Wrap the rest in try/catch so noop handlers are registered if anything fails
  try {
    await initUpdaterWithModule(mod, options);
    return;
  } catch {
    registerNoopHandlers();
    return;
  }
}

async function initUpdaterWithModule(mod: typeof import('electron-updater'), options: UpdaterOptions): Promise<void> {

  const { autoUpdater } = mod;

  // User must explicitly click "Install now" — no silent background downloads
  autoUpdater.autoDownload = options.updatePromptBeforeDownload === false;
  // If an update was downloaded and the user closes the app, install on next launch
  autoUpdater.autoInstallOnAppQuit = options.autoInstallOnQuit ?? true;

  // V5 Audit §10.2: Pin the update feed URL explicitly instead of relying on
  // electron-builder.yml defaults. This prevents supply-chain attacks where a
  // compromised build config could redirect update checks to a malicious server.
  autoUpdater.setFeedURL({
    provider: 'github',
    owner: 'HeyImDionysus',
    repo: 'somnibot',
  });

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

  autoUpdater.on('update-downloaded', (info) => {
    updateReady = true;
    // [infrastructure-launcher] Audit that a signed update is staged locally.
    auditSink?.({
      action: 'launcher.update.downloaded',
      category: 'security',
      targetType: 'app_update',
      targetId: (info as { version?: string })?.version,
      details: { version: (info as { version?: string })?.version ?? null },
      success: true,
    });
    broadcast('updater:downloaded', {});
  });

  autoUpdater.on('error', (err: Error) => {
    broadcast('updater:error', { message: err?.message ?? String(err) });
  });

  /* ── IPC Handlers ──────────────────────────────────────────────── */

  ipcMain.handle('updater:check', async () => {
    return runUpdaterOperation({
      phase: 'updater-check',
      execute: () => autoUpdater.checkForUpdates(),
      successCode: 'updater_check_completed',
      retryCode: 'updater_check_failed',
    });
  });

  ipcMain.handle('updater:download', async () => {
    return runUpdaterOperation({
      phase: 'updater-download',
      execute: () => autoUpdater.downloadUpdate(),
      successCode: 'updater_download_completed',
      retryCode: 'updater_download_failed',
    });
  });

  ipcMain.handle('updater:install', () => {
    if (updateReady) {
      // [infrastructure-launcher] Audit the operator-triggered update install
      // (a security-relevant lifecycle operation) before we quit and replace
      // the running binary.
      auditSink?.({
        action: 'launcher.update.install',
        category: 'security',
        targetType: 'app_update',
        details: { trigger: 'operator' },
        success: true,
      });
      // isSilent = false (show installer), isForceRunAfter = true (relaunch app)
      autoUpdater.quitAndInstall(false, true);
    }
  });

  /* ── Auto-check on launch ──────────────────────────────────────── */

  void runUpdaterOperation({
    phase: 'updater-check',
    execute: () => autoUpdater.checkForUpdates(),
    successCode: 'updater_check_completed',
    retryCode: 'updater_check_failed',
  });
}

/* ------------------------------------------------------------------ */
/*  Noop handlers for dev mode                                         */
/* ------------------------------------------------------------------ */

/** Register harmless stubs so renderer calls never throw. */
function registerNoopHandlers(): void {
  ipcMain.handle('updater:check', () => {
    return recordUnavailableUpdaterAttempt('updater-check');
  });
  ipcMain.handle('updater:download', () => {
    return recordUnavailableUpdaterAttempt('updater-download');
  });
  ipcMain.handle('updater:install', () => undefined);
}
