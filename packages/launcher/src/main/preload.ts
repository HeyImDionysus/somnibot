/**
 * Preload script — exposes a safe IPC bridge to the renderer process.
 *
 * The renderer (UI) can only call these explicitly exposed methods.
 * No direct access to Node.js, Electron internals, or the filesystem.
 */

import { contextBridge, ipcRenderer } from 'electron';

export interface SomniBotAPI {
  // Config
  getConfig: () => Promise<Record<string, string>>;
  saveConfig: (config: Record<string, string>) => Promise<void>;

  // Validation
  validateCredentials: (config: Record<string, string>) => Promise<{
    valid: boolean;
    errors: string[];
    meta: Record<string, string>;
  }>;

  // Process control
  startBot: () => Promise<{ ok: boolean; error?: string }>;
  stopBot: () => Promise<void>;
  getStatus: () => Promise<{
    bot: string;
    dashboard: string;
    lavalink: string;
    botPid?: number;
    dashboardPid?: number;
    lastHeartbeat?: number;
    error?: string;
  }>;

  // Cloud sync
  // V5 Audit §10.P3a: No args — main process owns the secret
  pullFromSupabase: () => Promise<{
    ok: boolean;
    credentials?: Record<string, string>;
    error?: string;
  }>;

  // Dashboard
  openDashboard: () => Promise<void>;

  // Links
  openExternal: (url: string) => Promise<void>;

  // Events — process status
  onStatusUpdate: (callback: (status: Record<string, unknown>) => void) => void;
  onBotLog: (callback: (log: { type: string; line: string }) => void) => void;
  onDashboardLog: (callback: (log: { type: string; line: string }) => void) => void;

  // Auto-updater — actions
  checkForUpdates: () => Promise<{ ok: boolean; error?: string }>;
  downloadUpdate: () => Promise<{ ok: boolean; error?: string }>;
  installUpdate: () => Promise<void>;

  // Auto-updater — events
  onUpdaterChecking: (callback: () => void) => void;
  onUpdateAvailable: (callback: (info: { version: string }) => void) => void;
  onUpdateNotAvailable: (callback: () => void) => void;
  onDownloadProgress: (callback: (progress: {
    percent: number;
    transferred: number;
    total: number;
    bytesPerSecond: number;
  }) => void) => void;
  onUpdateDownloaded: (callback: () => void) => void;
  onUpdateError: (callback: (info: { message: string }) => void) => void;

  // Phase 6: First-run onboarding
  isFirstRun: () => Promise<boolean>;
  completeFirstRun: () => Promise<void>;

  // Phase 6: Lavalink management
  getLavalinkEnabled: () => Promise<boolean>;
  setLavalinkEnabled: (enabled: boolean) => Promise<void>;
  checkJava: () => Promise<{ available: boolean; version?: string; error?: string }>;
  downloadLavalink: () => Promise<{ ok: boolean; error?: string }>;
  getLavalinkInfo: () => Promise<{ status: string; jarPresent: boolean; error: string }>;
  onLavalinkStatus: (callback: (info: { status: string; jarPresent: boolean; error: string }) => void) => void;
  onLavalinkLog: (callback: (log: { type: string; line: string }) => void) => void;
  onLavalinkDownloadProgress: (callback: (progress: { percent: number; downloadedMB: string; totalMB: string }) => void) => void;

  // App
  getVersion: () => Promise<string>;
}

contextBridge.exposeInMainWorld('somnibot', {
  // Config
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config: Record<string, string>) => ipcRenderer.invoke('save-config', config),

  // Validation
  validateCredentials: (config: Record<string, string>) =>
    ipcRenderer.invoke('validate-credentials', config),

  // Process control
  startBot: () => ipcRenderer.invoke('start-bot'),
  stopBot: () => ipcRenderer.invoke('stop-bot'),
  getStatus: () => ipcRenderer.invoke('get-status'),

  // Cloud sync
  // V5 Audit §10.P3a: Secret stays in main process
  pullFromSupabase: () => ipcRenderer.invoke('pull-from-supabase'),

  // Dashboard
  openDashboard: () => ipcRenderer.invoke('open-dashboard'),

  // Links
  openExternal: (url: string) => {
    // V5 Audit §10.2 — Only allow https:// URLs to prevent protocol abuse
    if (!url.startsWith('https://')) {
      return Promise.reject(new Error('Only https:// URLs are allowed'));
    }
    return ipcRenderer.invoke('open-external', url);
  },

  // Events — process status
  onStatusUpdate: (callback: (status: Record<string, unknown>) => void) => {
    ipcRenderer.on('status-update', (_event, status) => callback(status));
  },
  onBotLog: (callback: (log: { type: string; line: string }) => void) => {
    ipcRenderer.on('bot-log', (_event, log) => callback(log));
  },
  onDashboardLog: (callback: (log: { type: string; line: string }) => void) => {
    ipcRenderer.on('dashboard-log', (_event, log) => callback(log));
  },

  // Auto-updater — actions
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  downloadUpdate: () => ipcRenderer.invoke('updater:download'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),

  // Auto-updater — events
  onUpdaterChecking: (callback: () => void) => {
    ipcRenderer.on('updater:checking', () => callback());
  },
  onUpdateAvailable: (callback: (info: { version: string }) => void) => {
    ipcRenderer.on('updater:available', (_event, info) => callback(info));
  },
  onUpdateNotAvailable: (callback: () => void) => {
    ipcRenderer.on('updater:not-available', () => callback());
  },
  onDownloadProgress: (callback: (progress: {
    percent: number;
    transferred: number;
    total: number;
    bytesPerSecond: number;
  }) => void) => {
    ipcRenderer.on('updater:progress', (_event, progress) => callback(progress));
  },
  onUpdateDownloaded: (callback: () => void) => {
    ipcRenderer.on('updater:downloaded', () => callback());
  },
  onUpdateError: (callback: (info: { message: string }) => void) => {
    ipcRenderer.on('updater:error', (_event, info) => callback(info));
  },

  // Phase 6: First-run onboarding
  isFirstRun: () => ipcRenderer.invoke('is-first-run'),
  completeFirstRun: () => ipcRenderer.invoke('complete-first-run'),

  // Phase 6: Lavalink management
  getLavalinkEnabled: () => ipcRenderer.invoke('get-lavalink-enabled'),
  setLavalinkEnabled: (enabled: boolean) => ipcRenderer.invoke('set-lavalink-enabled', enabled),
  checkJava: () => ipcRenderer.invoke('check-java'),
  downloadLavalink: () => ipcRenderer.invoke('download-lavalink'),
  getLavalinkInfo: () => ipcRenderer.invoke('get-lavalink-info'),
  onLavalinkStatus: (callback: (info: { status: string; jarPresent: boolean; error: string }) => void) => {
    ipcRenderer.on('lavalink-status', (_event, info) => callback(info));
  },
  onLavalinkLog: (callback: (log: { type: string; line: string }) => void) => {
    ipcRenderer.on('lavalink-log', (_event, log) => callback(log));
  },
  onLavalinkDownloadProgress: (callback: (progress: { percent: number; downloadedMB: string; totalMB: string }) => void) => {
    ipcRenderer.on('lavalink-download-progress', (_event, progress) => callback(progress));
  },

  // App
  getVersion: () => ipcRenderer.invoke('get-version'),
} satisfies SomniBotAPI);
