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
    botPid?: number;
    dashboardPid?: number;
    lastHeartbeat?: number;
    error?: string;
  }>;

  // Dashboard
  openDashboard: () => Promise<void>;

  // Links
  openExternal: (url: string) => Promise<void>;

  // Events
  onStatusUpdate: (callback: (status: Record<string, unknown>) => void) => void;
  onBotLog: (callback: (log: { type: string; line: string }) => void) => void;
  onDashboardLog: (callback: (log: { type: string; line: string }) => void) => void;

  // App
  getVersion: () => string;
  checkForUpdates: () => Promise<void>;
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

  // Dashboard
  openDashboard: () => ipcRenderer.invoke('open-dashboard'),

  // Links
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),

  // Events
  onStatusUpdate: (callback: (status: Record<string, unknown>) => void) => {
    ipcRenderer.on('status-update', (_event, status) => callback(status));
  },
  onBotLog: (callback: (log: { type: string; line: string }) => void) => {
    ipcRenderer.on('bot-log', (_event, log) => callback(log));
  },
  onDashboardLog: (callback: (log: { type: string; line: string }) => void) => {
    ipcRenderer.on('dashboard-log', (_event, log) => callback(log));
  },

  // App
  getVersion: () => ipcRenderer.sendSync('get-version'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
} satisfies SomniBotAPI);
