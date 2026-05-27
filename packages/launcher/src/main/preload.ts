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

  // Events — process status (return cleanup function for React unmount)
  onStatusUpdate: (callback: (status: Record<string, unknown>) => void) => () => void;
  onBotLog: (callback: (log: { type: string; line: string }) => void) => () => void;
  onDashboardLog: (callback: (log: { type: string; line: string }) => void) => () => void;

  // Auto-updater — actions
  checkForUpdates: () => Promise<{ ok: boolean; error?: string }>;
  downloadUpdate: () => Promise<{ ok: boolean; error?: string }>;
  installUpdate: () => Promise<void>;

  // Auto-updater — events (return cleanup function for React unmount)
  onUpdaterChecking: (callback: () => void) => () => void;
  onUpdateAvailable: (callback: (info: { version: string }) => void) => () => void;
  onUpdateNotAvailable: (callback: () => void) => () => void;
  onDownloadProgress: (callback: (progress: {
    percent: number;
    transferred: number;
    total: number;
    bytesPerSecond: number;
  }) => void) => () => void;
  onUpdateDownloaded: (callback: () => void) => () => void;
  onUpdateError: (callback: (info: { message: string }) => void) => () => void;

  // Phase 6: First-run onboarding
  isFirstRun: () => Promise<boolean>;
  completeFirstRun: () => Promise<void>;

  // Phase 6: Lavalink management
  getLavalinkEnabled: () => Promise<boolean>;
  setLavalinkEnabled: (enabled: boolean) => Promise<void>;
  checkJava: () => Promise<{ available: boolean; version?: string; error?: string }>;
  downloadLavalink: () => Promise<{ ok: boolean; error?: string }>;
  getLavalinkInfo: () => Promise<{ status: string; jarPresent: boolean; error: string }>;
  onLavalinkStatus: (callback: (info: { status: string; jarPresent: boolean; error: string }) => void) => () => void;
  onLavalinkLog: (callback: (log: { type: string; line: string }) => void) => () => void;
  onLavalinkDownloadProgress: (callback: (progress: { percent: number; downloadedMB: string; totalMB: string }) => void) => () => void;

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
  // V8 Audit §10.P3a: Return cleanup functions to prevent listener leaks on unmount
  onStatusUpdate: (callback: (status: Record<string, unknown>) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: Record<string, unknown>) => callback(status);
    ipcRenderer.on('status-update', handler);
    return () => { ipcRenderer.removeListener('status-update', handler); };
  },
  onBotLog: (callback: (log: { type: string; line: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, log: { type: string; line: string }) => callback(log);
    ipcRenderer.on('bot-log', handler);
    return () => { ipcRenderer.removeListener('bot-log', handler); };
  },
  onDashboardLog: (callback: (log: { type: string; line: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, log: { type: string; line: string }) => callback(log);
    ipcRenderer.on('dashboard-log', handler);
    return () => { ipcRenderer.removeListener('dashboard-log', handler); };
  },

  // Auto-updater — actions
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  downloadUpdate: () => ipcRenderer.invoke('updater:download'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),

  // Auto-updater — events (V8 Audit §10.P3a: return cleanup functions)
  onUpdaterChecking: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('updater:checking', handler);
    return () => { ipcRenderer.removeListener('updater:checking', handler); };
  },
  onUpdateAvailable: (callback: (info: { version: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, info: { version: string }) => callback(info);
    ipcRenderer.on('updater:available', handler);
    return () => { ipcRenderer.removeListener('updater:available', handler); };
  },
  onUpdateNotAvailable: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('updater:not-available', handler);
    return () => { ipcRenderer.removeListener('updater:not-available', handler); };
  },
  onDownloadProgress: (callback: (progress: {
    percent: number;
    transferred: number;
    total: number;
    bytesPerSecond: number;
  }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: { percent: number; transferred: number; total: number; bytesPerSecond: number }) => callback(progress);
    ipcRenderer.on('updater:progress', handler);
    return () => { ipcRenderer.removeListener('updater:progress', handler); };
  },
  onUpdateDownloaded: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('updater:downloaded', handler);
    return () => { ipcRenderer.removeListener('updater:downloaded', handler); };
  },
  onUpdateError: (callback: (info: { message: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, info: { message: string }) => callback(info);
    ipcRenderer.on('updater:error', handler);
    return () => { ipcRenderer.removeListener('updater:error', handler); };
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
    const handler = (_event: Electron.IpcRendererEvent, info: { status: string; jarPresent: boolean; error: string }) => callback(info);
    ipcRenderer.on('lavalink-status', handler);
    return () => { ipcRenderer.removeListener('lavalink-status', handler); };
  },
  onLavalinkLog: (callback: (log: { type: string; line: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, log: { type: string; line: string }) => callback(log);
    ipcRenderer.on('lavalink-log', handler);
    return () => { ipcRenderer.removeListener('lavalink-log', handler); };
  },
  onLavalinkDownloadProgress: (callback: (progress: { percent: number; downloadedMB: string; totalMB: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: { percent: number; downloadedMB: string; totalMB: string }) => callback(progress);
    ipcRenderer.on('lavalink-download-progress', handler);
    return () => { ipcRenderer.removeListener('lavalink-download-progress', handler); };
  },

  // App
  getVersion: () => ipcRenderer.invoke('get-version'),
} satisfies SomniBotAPI);
