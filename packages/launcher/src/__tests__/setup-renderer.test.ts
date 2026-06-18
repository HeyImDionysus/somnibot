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
    expect(html).toContain('id="supabaseAccessToken"');
    expect(html).toContain('id="supabaseDiscordAuthProviderConfigured"');
    expect(html).toContain('id="paypalClientId"');
    expect(html).toContain('id="paypalClientSecret"');
    expect(html).toContain('id="paypalWebhookId"');
    expect(html).toContain('id="paypalSandbox"');
    expect(html).toContain('id="btn-setup-paypal-webhook"');
    expect(html).toContain('id="btn-open-discord-invite"');
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

  it('presents the regular-local callback URL as auto-filled instead of required manual setup', () => {
    const html = readSourceFile('renderer/index.html');
    const renderer = readSourceFile('renderer/renderer.js');

    expect(html).toContain('Public Callback URL <span class="opt">(auto-filled)</span>');
    expect(html).toContain('placeholder="Auto-filled by Tailscale Funnel"');
    expect(html).toContain('The launcher fills this after Tailscale Funnel is ready. Paste an HTTPS URL only as a fallback.');
    expect(html).not.toContain('Public Callback URL <span class="req">*</span>');
    expect(renderer).toContain('let latestTailscaleReadiness = null;');
    expect(renderer).toContain('tailscaleReadinessState: runtimeMode === \'regular-local\' ? latestTailscaleReadiness?.state : undefined');
    expect(renderer).toContain('tailscaleAuthKeyReady: fields.tailscaleAuthKey.value.trim().length > 0');
    expect(renderer).toContain('latestTailscaleReadiness = readiness;');
    expect(renderer).toContain('const firstSetupField = runtimeMode === \'vps\' ? runtimeFields.vpsDomain : fields.discordToken;');
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
    const html = readSourceFile('renderer/index.html');
    const renderer = readSourceFile('renderer/renderer.js');
    const styles = readSourceFile('renderer/styles.css');

    expect(html).toContain('Use read-only preflight, dry-run deploy, or approval-gated deployment from the deployment plan.');
    expect(html).not.toContain('SSH automation is not run from this setup screen');
    expect(renderer).toContain("const vpsDeploymentPlan = $('vps-deployment-plan');");
    expect(renderer).toContain("const btnOpenDiscordInvite = $('btn-open-discord-invite');");
    expect(renderer).toContain('function getDiscordInviteState()');
    expect(renderer).toContain('function buildDiscordInviteUrl()');
    expect(renderer).toContain("permissions: '8'");
    expect(renderer).toContain("scope: 'bot applications.commands'");
    expect(renderer).toContain("const guildIdInput = fields.discordGuildId.value.trim();");
    expect(renderer).toContain('Enter one valid Discord Guild ID, or clear the Guild ID field to choose a server in Discord.');
    expect(renderer).toContain("params.set('guild_id', guildId)");
    expect(renderer).toContain("params.set('disable_guild_select', 'true')");
    expect(renderer).toContain('btnOpenDiscordInvite.addEventListener');
    expect(renderer).toContain('const inviteState = getDiscordInviteState();');
    expect(renderer).toContain('window.somnibot.openExternal(inviteState.url);');
    expect(renderer).toContain('updateDiscordInviteButton();\n      updateRestoreBanner();');
    expect(renderer).toContain('renderDeploymentPlan(status.deploymentPlan, isVpsStatus);');
    expect(renderer).toContain('let latestProviderValidation = null;');
    expect(renderer).toContain('providerValidation: latestProviderValidation');
    expect(renderer).toContain('paypalReady: isPayPalFormComplete()');
    expect(renderer).toContain("const btnSetupPayPalWebhook = $('btn-setup-paypal-webhook');");
    expect(renderer).toContain('function updatePayPalWebhookButton()');
    expect(renderer).toContain('|| isValidating');
    expect(renderer).toContain('|| isVpsDeploymentActionRunning');
    expect(renderer).toContain('function applyPayPalWebhookResult(webhookResult)');
    expect(renderer).toContain('applyPayPalWebhookResult(result.paypalWebhook)');
    expect(renderer).toContain('applyPayPalWebhookResult(result)');
    expect(renderer).toContain('Local services were restarted to load the new Webhook ID.');
    expect(renderer).toContain('window.somnibot.ensurePayPalWebhook(collectConfig())');
    expect(renderer).toContain("btnSetupPayPalWebhook.textContent = 'Create/Update Webhook';");
    expect(renderer).toContain('latestProviderValidation = result.providerValidation;');
    expect(renderer).toContain('Finish VPS readiness fields before SSH preflight or deployment actions are available.');
    expect(renderer).toContain('The launcher can run read-only SSH preflight, dry-run deployment, and approval-gated deployment with redacted output.');
    expect(renderer).not.toContain('does not run SSH or deploy commands in this build');
    expect(renderer).toContain('Review the plan, run a read-only SSH preflight, then use native approval before remote changes.');
    expect(renderer).toContain('data-vps-deploy-action="preflight"');
    expect(renderer).toContain('data-vps-deploy-action="dry-run"');
    expect(renderer).toContain('data-vps-deploy-action="run-live"');
    expect(renderer).toContain('window.somnibot.runVpsPreflight()');
    expect(renderer).toContain('window.somnibot.runVpsDeployment({');
    expect(renderer).toContain('window.somnibot.runSetupAutomation(config)');
    expect(renderer).toContain('result.servicesStarted');
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
    const renderer = readSourceFile('renderer/renderer.js');
    const configStore = readSourceFile('main/config-store.ts');
    const validationIndex = main.indexOf('const validation = await validateAllCredentials(config);');
    const authProviderIndex = main.indexOf('if (!config.supabaseAccessToken.trim() && !config.supabaseDiscordAuthProviderConfigured)');
    const startIndex = main.indexOf('const startResult = await startLocalStack(config, { forceRestart: true });');
    const dashboardHealthIndex = main.indexOf('const dashboardReady = await waitForDashboardHealth();', startIndex);
    const configureAuthIndex = main.indexOf('const authConfigured = await configureDashboardAuthProvider({', dashboardHealthIndex);
    const paypalWebhookIndex = main.indexOf('const rawPayPalWebhook = await ensureConfiguredPayPalWebhook(config);', configureAuthIndex);

    expect(preload).toContain("getSetupStatus: (input?: Record<string, unknown>)");
    expect(preload).toContain("ipcRenderer.invoke('get-setup-status', input)");
    expect(preload).toContain("ipcRenderer.invoke('run-setup-automation', config)");
    expect(preload).toContain("ipcRenderer.invoke('paypal:ensure-webhook', config)");
    expect(preload).toContain('servicesRestarted?: boolean');
    expect(preload).toContain('servicesStarted?: boolean');
    expect(preload).toContain('providerValidation?:');
    expect(preload).toContain("runVpsPreflight: () => ipcRenderer.invoke('vps:run-preflight')");
    expect(preload).toContain("runVpsDeployment: (payload) => ipcRenderer.invoke('vps:run-deployment', payload)");
    expect(main).toContain("ipcMain.handle('get-setup-status'");
    expect(main).toContain("ipcMain.handle('run-setup-automation'");
    expect(main).toContain("ipcMain.handle('paypal:ensure-webhook'");
    expect(main).toContain('function sanitizePayPalConfigPatch(config: LauncherConfigPatch): LauncherConfigPatch');
    expect(main).toContain('saveConfig(sanitizePayPalConfigPatch(configPatch))');
    expect(main).toContain('saveConfig(sanitizePayPalConfigPatch(config))');
    expect(main).toContain('type PayPalRuntimeConfig = Pick<');
    expect(main).toContain('let lastStartedPayPalConfig: PayPalRuntimeConfig | null = null;');
    expect(main).toContain('function snapshotPayPalRuntimeConfig(config: LauncherConfig): PayPalRuntimeConfig');
    expect(main).toContain('function payPalRuntimeChanged(previous: PayPalRuntimeConfig | null, current: PayPalRuntimeConfig): boolean');
    expect(main).toContain('publicCallbackBaseUrl: string;');
    expect(main).toContain('paypalWebhookUrl: string;');
    expect(main).toContain('publicCallbackBaseUrl = profile.publicCallbackBaseUrl;');
    expect(main).toContain('paypalWebhookUrl = profile.paypalWebhookUrl;');
    expect(main).toContain('|| previous.publicCallbackBaseUrl !== current.publicCallbackBaseUrl');
    expect(main).toContain('|| previous.paypalWebhookUrl !== current.paypalWebhookUrl');
    expect(main).toContain('restartRunningLocalStackForPayPalChange(previousPayPalConfig)');
    expect(main).toContain('const restartBaseline = lastStartedPayPalConfig ?? snapshotPayPalRuntimeConfig(previousConfig);');
    expect(main).toContain('{ forceRestart: !lastStartedPayPalConfig }');
    expect(main).toContain('ensureConfiguredPayPalWebhook(config)');
    expect(main).toContain('const rawResult = await ensureConfiguredPayPalWebhook(cfg)');
    expect(main).toContain('startLocalStack(currentConfig, { forceRestart: true })');
    expect(main).toContain('lastStartedPayPalConfig = snapshotPayPalRuntimeConfig(config);');
    expect(main).toContain('servicesRestarted: true');
    expect(renderer).toContain('applyPayPalWebhookResult(result);\n    if (!result.ok)');
    expect(renderer).toContain('&& !isValidating');
    expect(renderer).toContain('&& !isPayPalWebhookRunning');
    expect(main).toContain('Public callback health must pass before the PayPal webhook can be changed.');
    expect(main).not.toContain('const previousWebhookId = cfg.paypalWebhookId');
    expect(main).not.toContain('rawResult.webhookId && wasRunning && rawResult.webhookId !== previousWebhookId');
    expect(main).not.toContain('restartRunningLocalStackForPayPalChange(previousConfig, { forceRestart: true })');
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
    expect(main).toContain('providerValidation: input.providerValidation');
    expect(main).toContain('paypalReady: input.paypalReady ?? Boolean(');
    expect(main).toContain('paypalClientSecret: config.paypalClientSecret ?');
    expect(main).toContain('paypalWebhookId: config.paypalWebhookId ?');
    expect(configStore).toContain('PAYPAL_CLIENT_ID: config.paypalClientId');
    expect(configStore).toContain('PAYPAL_CLIENT_SECRET: config.paypalClientSecret');
    expect(configStore).toContain('PAYPAL_WEBHOOK_ID: config.paypalWebhookId');
    expect(configStore).toContain('PAYPAL_SANDBOX: config.paypalSandbox ?');
    expect(main).toContain('supabaseAccessTokenReady: input.supabaseAccessTokenReady ?? Boolean(config.supabaseAccessToken)');
    expect(main).toContain('supabaseDiscordAuthProviderConfigured: input.supabaseDiscordAuthProviderConfigured');
    expect(main).toContain('tailscaleAuthKeyReady: input.tailscaleAuthKeyReady ?? Boolean(config.tailscaleAuthKey)');
    expect(main).toContain('tailscaleReadinessState: input.tailscaleReadinessState');
    expect(main).toContain('setupLocked?: boolean');
    expect(main).toContain('response.status === 403 && body?.setupLocked');
    expect(main).toContain('manualAuthProviderConfirmed');
    expect(main).toContain('callbackBaseUrlChanged');
    expect(main).toContain('manualAuthProviderConfirmed && !callbackBaseUrlChanged');
    expect(main).toContain('const authConfigured = await configureDashboardAuthProvider({');
    expect(validationIndex).toBeGreaterThan(-1);
    expect(authProviderIndex).toBeGreaterThan(validationIndex);
    expect(startIndex).toBeGreaterThan(validationIndex);
    expect(dashboardHealthIndex).toBeGreaterThan(startIndex);
    expect(configureAuthIndex).toBeGreaterThan(dashboardHealthIndex);
    expect(paypalWebhookIndex).toBeGreaterThan(configureAuthIndex);
    expect(main).toContain('evaluateDashboardHealthPayload(body)');
    expect(main).toContain('servicesStarted: true');
    expect(main).toContain('startLocalStack(config, { forceRestart: true })');
    expect(main).toContain('waitForPortAvailable(3456)');
  });
});
