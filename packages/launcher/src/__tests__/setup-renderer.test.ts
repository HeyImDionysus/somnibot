import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, '..');

function readSourceFile(relativePath: string): string {
  return readFileSync(path.join(srcDir, relativePath), 'utf8');
}

describe('launcher setup renderer wiring', () => {
  it('shows VPS-ready callback values as first-class setup summary rows', () => {
    const html = readSourceFile('renderer/index.html');

    expect(html).toContain('id="summary-dashboard-label"');
    expect(html).toContain('id="summary-public-callback-label"');
    expect(html).toContain('id="summary-auth-callback"');
    expect(html).toContain('id="summary-paypal-webhook"');
    expect(html).toContain('Discord/Supabase callback');
    expect(html).toContain('PayPal webhook');
    expect(html).toContain('id="runtime-summary" aria-live="polite"');
    expect(html).toContain('id="runtime-steps" aria-live="polite"');
  });

  it('lets the VPS domain field accept the bare-domain contract from runtime setup', () => {
    const html = readSourceFile('renderer/index.html');

    expect(html).toContain('id="vpsDomain"');
    expect(html).toContain('type="text" id="vpsDomain"');
    expect(html).toContain('placeholder="somnibot.example.com"');
    expect(html).toContain('inputmode="url"');
  });

  it('renders derived callback values from setup diagnostics without exposing ports in normal labels', () => {
    const renderer = readSourceFile('renderer/renderer.js');

    expect(renderer).toContain("const diagnostics = status.summary.diagnostics || {};");
    expect(renderer).toContain("summaryDashboardLabel.textContent = isVpsStatus ? 'Dashboard URL' : 'Local dashboard URL';");
    expect(renderer).toContain("summaryPublicCallbackLabel.textContent = isVpsStatus ? 'Public callback base' : 'Public callback URL';");
    expect(renderer).toContain('summaryAuthCallback.textContent = status.summary.authCallbackUrl;');
    expect(renderer).toContain('summaryPayPalWebhook.textContent = status.summary.paypalWebhookUrl;');
    expect(renderer).toContain("authCallbackUrl: 'Discord/Supabase callback'");
    expect(renderer).toContain("paypalWebhookUrl: 'PayPal webhook'");
  });

  it('keeps setup status IPC wired through preload and main process VPS fields', () => {
    const preload = readSourceFile('main/preload.ts');
    const main = readSourceFile('main/index.ts');

    expect(preload).toContain("getSetupStatus: (input?: Record<string, unknown>)");
    expect(preload).toContain("ipcRenderer.invoke('get-setup-status', input)");
    expect(main).toContain("ipcMain.handle('get-setup-status'");
    expect(main).toContain('runtimeMode: input.runtimeMode ?? config.runtimeMode');
    expect(main).toContain('publicCallbackBaseUrl: input.publicCallbackBaseUrl ?? config.publicCallbackBaseUrl');
    expect(main).toContain('vpsDomain: input.vpsDomain ?? config.vpsDomain');
    expect(main).toContain('vpsSshHost: input.vpsSshHost ?? config.vpsSshHost');
    expect(main).toContain('vpsSshUser: input.vpsSshUser ?? config.vpsSshUser');
    expect(main).toContain('vpsDeployPath: input.vpsDeployPath ?? config.vpsDeployPath');
    expect(main).toContain('credentialReady: input.credentialReady ?? Boolean(');
  });
});
