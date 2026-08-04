import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const mainSource = readFileSync(new URL('../main/index.ts', import.meta.url), 'utf8');
const configStoreSource = readFileSync(new URL('../main/config-store.ts', import.meta.url), 'utf8');
const rendererSource = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');

describe('packaged launcher startup ordering', () => {
  it('creates the operator surface before network-bound startup reconciliation', () => {
    const createWindow = mainSource.indexOf('await createWindow(!requestedBackgroundLaunch)');
    expect(createWindow).toBeGreaterThan(0);
    expect(createWindow).toBeLessThan(mainSource.indexOf('await restoreMissingCredentialsOnStartup(config)'));
    expect(createWindow).toBeLessThan(mainSource.indexOf('await reconcileSandboxPayPalWebhookOnStartup('));
    expect(createWindow).toBeLessThan(mainSource.indexOf('await readRuntimeLeaseStatus(config.supabaseUrl'));
  });

  it('never calls the Windows/macOS login-item API on Linux', () => {
    expect(mainSource).toContain(
      "app.isPackaged && (process.platform === 'win32' || process.platform === 'darwin')",
    );
  });

  it('defers legacy credential migration until Electron is ready', () => {
    expect(configStoreSource).not.toMatch(/\nmigrateLegacyConfig\(\);\n/);
    expect(mainSource.indexOf('migrateLegacyConfig();')).toBeGreaterThan(
      mainSource.indexOf('app.whenReady().then(async () => {'),
    );
    expect(mainSource.indexOf('migrateCurrentPlaintextSecrets();')).toBeLessThan(
      mainSource.indexOf('migrateLegacyConfig();'),
    );
  });

  it('rejects Electron basic-text storage on Linux', () => {
    expect(configStoreSource).toContain(
      "process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text'",
    );
  });

  it('surfaces an unexpected startup failure instead of retaining a hidden lock', () => {
    expect(mainSource).toContain('}).catch(() => {');
    expect(mainSource).toMatch(/dialog\.showErrorBox\(\r?\n\s*'SomniBot could not start'/);
  });

  it('gates renderer writes and local child startup until reconciliation is safe', () => {
    expect(mainSource).toContain("ipcMain.handle('wait-for-startup-ready'");
    expect(mainSource).toContain('if (cancelled()) return cancelAndStop();');
    expect(mainSource).toContain('resolveStartupReady?.();');
    expect(rendererSource.indexOf('document.body.inert = true;')).toBeLessThan(
      rendererSource.indexOf('await window.somnibot.waitForStartupReady();'),
    );
    expect(rendererSource.indexOf('document.body.inert = false;')).toBeGreaterThan(
      rendererSource.indexOf('await window.somnibot.waitForStartupReady();'),
    );
  });
});
