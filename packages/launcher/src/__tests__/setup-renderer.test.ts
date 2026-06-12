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
    expect(html).toContain('id="vps-deployment-plan"');
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

  it('renders the VPS deployment plan and approval-gated action controls from setup status', () => {
    const renderer = readSourceFile('renderer/renderer.js');
    const styles = readSourceFile('renderer/styles.css');

    expect(renderer).toContain("const vpsDeploymentPlan = $('vps-deployment-plan');");
    expect(renderer).toContain('renderDeploymentPlan(status.deploymentPlan, isVpsStatus);');
    expect(renderer).toContain('Finish VPS readiness fields before SSH preflight or deployment actions are available.');
    expect(renderer).toContain('Review the plan, run a read-only SSH preflight, then use native approval before remote changes.');
    expect(renderer).toContain('data-vps-deploy-action="preflight"');
    expect(renderer).toContain('data-vps-deploy-action="dry-run"');
    expect(renderer).toContain('data-vps-deploy-action="run-live"');
    expect(renderer).toContain('window.somnibot.runVpsPreflight()');
    expect(renderer).toContain('window.somnibot.runVpsDeployment({');
    expect(renderer).toContain("const dryRun = action !== 'run-live';");
    expect(renderer).toContain('await saveConfig();');
    expect(renderer).toContain('const currentSetup = await refreshSetupStatus();');
    expect(renderer).toContain('approvedCommandIds: getApprovedDeploymentCommandIds(plan)');
    expect(renderer).toContain('clearStaleVpsActionResults(status);');
    expect(renderer).toContain('vpsActionResultPlanKey = actionPlanKey;');
    expect(renderer).toContain('<h4>Environment shape</h4>');
    expect(renderer).toContain('<h4>Caddy/reverse proxy</h4>');
    expect(renderer).toContain('<h4>Approval gates</h4>');
    expect(renderer).toContain('<h4>Rollback</h4>');
    expect(styles).toContain('.deployment-plan');
    expect(styles).toContain('.deployment-plan-actions');
    expect(styles).toContain('.deployment-run-result');
    expect(styles).toContain('.deployment-command');
  });

  it('keeps setup status IPC wired through preload and main process VPS fields', () => {
    const preload = readSourceFile('main/preload.ts');
    const main = readSourceFile('main/index.ts');

    expect(preload).toContain("getSetupStatus: (input?: Record<string, unknown>)");
    expect(preload).toContain("ipcRenderer.invoke('get-setup-status', input)");
    expect(preload).toContain("runVpsPreflight: () => ipcRenderer.invoke('vps:run-preflight')");
    expect(preload).toContain("runVpsDeployment: (payload) => ipcRenderer.invoke('vps:run-deployment', payload)");
    expect(main).toContain("ipcMain.handle('get-setup-status'");
    expect(main).toContain("ipcMain.handle('vps:run-preflight'");
    expect(main).toContain('planVpsSshPreflight({');
    expect(main).toContain('createVpsCommandRunner()');
    expect(main).toContain('redactVpsDeploymentText(result.error)');
    expect(main).toContain("ipcMain.handle('vps:run-deployment'");
    expect(main).toContain('runtimeMode: input.runtimeMode ?? config.runtimeMode');
    expect(main).toContain('publicCallbackBaseUrl: input.publicCallbackBaseUrl ?? config.publicCallbackBaseUrl');
    expect(main).toContain('vpsDomain: input.vpsDomain ?? config.vpsDomain');
    expect(main).toContain('vpsSshHost: input.vpsSshHost ?? config.vpsSshHost');
    expect(main).toContain('vpsSshUser: input.vpsSshUser ?? config.vpsSshUser');
    expect(main).toContain('vpsDeployPath: input.vpsDeployPath ?? config.vpsDeployPath');
    expect(main).toContain('credentialReady: input.credentialReady ?? Boolean(');
  });
});
