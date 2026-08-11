import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, '..');

function readSourceFile(relativePath: string): string {
  return readFileSync(path.join(srcDir, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

describe('launcher setup renderer wiring', () => {
  it('distinguishes encrypted saved secrets from revealable newly entered values', () => {
    const html = readSourceFile('renderer/index.html');
    const renderer = readSourceFile('renderer/renderer.js');

    expect(html).toContain('data-target="discordToken" title="Show/hide" type="button"');
    expect(html).toContain('type="text" id="supabasePublishableKey"');
    expect(html).toContain('type="text" id="paypalClientId"');
    expect(renderer).toContain("const MASKED_SECRET = '••••••••'");
    expect(renderer).toContain('if (config[key] === MASKED_SECRET) markSavedSecret(input)');
    expect(renderer).toContain("btn.textContent = 'Saved'");
    expect(renderer).toContain("input.placeholder = 'Saved securely — type to replace'");
    expect(renderer).toContain("input.dataset.savedSecret === 'true' ? MASKED_SECRET : input.value");
    const styles = readSourceFile('renderer/styles.css');
    expect(styles).toMatch(/\.toggle-vis \{[\s\S]*?top: 27px;[\s\S]*?\}/);
    expect(styles).not.toMatch(/\.toggle-vis \{[\s\S]*?bottom: 8px;[\s\S]*?\}/);
  });

  it('shows VPS-ready callback values as first-class setup summary rows', () => {
    const html = readSourceFile('renderer/index.html');

    expect(html).toContain('id="summary-dashboard-label"');
    expect(html).toContain('id="summary-public-callback-label"');
    expect(html).toContain('id="summary-auth-callback"');
    expect(html).toContain('id="summary-paypal-webhook"');
    expect(html).toContain('id="vps-deployment-plan"');
    expect(html).toContain('id="supabaseAccessToken"');
    expect(html).toContain('id="btn-generate-supabase-db-password"');
    expect(html).toContain('invalidates existing direct database connections');
    expect(html).toContain('id="btn-discover-supabase"');
    expect(html).toContain('id="supabase-project-picker"');
    expect(html).toContain('id="supabase-project-select"');
    expect(html).toContain('id="btn-select-supabase-project"');
    expect(html).toContain('id="supabaseDiscordAuthProviderConfigured"');
    expect(html).toContain('id="paypalClientId"');
    expect(html).toContain('id="paypalClientSecret"');
    expect(html).toContain('id="paypalWebhookId"');
    expect(html).toContain('id="paypalSandbox"');
    expect(html).toContain('id="btn-setup-paypal-webhook"');
    expect(html).toContain('id="btn-open-discord-invite"');
    expect(html).toContain('id="btn-verify-discord"');
    expect(html).toContain('Discord/Supabase callback');
    expect(html).toContain('PayPal webhook');
    expect(html).toContain('id="runtime-summary" aria-live="polite"');
    expect(html).toContain('id="setup-completion" aria-live="polite"');
    expect(html).toContain('id="runtime-steps" aria-live="polite"');
  });

  it('lets the VPS domain field accept the bare-domain contract from runtime setup', () => {
    const html = readSourceFile('renderer/index.html');

    expect(html).toContain('id="vpsDomain"');
    expect(html).toContain('type="text" id="vpsDomain"');
    expect(html).toContain('placeholder="somnibot.example.com"');
    expect(html).toContain('inputmode="url"');
  });

  it('wires the VPS public-edge mode and Funnel URL through machine-consumed field ids', () => {
    const html = readSourceFile('renderer/index.html');
    const renderer = readSourceFile('renderer/renderer.js');

    expect(html).toContain('id="vpsPublicAccessMode"');
    expect(html).toContain('value="tailscale-funnel"');
    expect(html).toContain('id="vpsTailscaleFunnelUrl"');
    expect(html).toContain('id="vps-funnel-url-preview"');
    expect(renderer).toContain("vpsPublicAccessMode: $('vpsPublicAccessMode')");
    expect(renderer).toContain("vpsTailscaleFunnelUrl: $('vpsTailscaleFunnelUrl')");
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
    expect(renderer).toContain("runtimeFields.vpsPublicAccessMode.value === 'tailscale-funnel'");
    expect(renderer).toContain('? runtimeFields.vpsTailscaleFunnelUrl');
    expect(renderer).toContain(': runtimeFields.vpsDomain');
  });

  it('keeps Supabase project discovery in the main process and applies only readiness to the renderer', () => {
    const renderer = readSourceFile('renderer/renderer.js');
    const preload = readSourceFile('main/preload.ts');
    const main = readSourceFile('main/index.ts');
    const configBridge = readSourceFile('main/config-bridge.ts');

    expect(renderer).toContain('window.somnibot.discoverSupabaseProjects(');
    expect(renderer).toContain('fields.supabaseAccessToken.value');
    expect(renderer).toContain('window.somnibot.selectSupabaseProject(ref)');
    expect(renderer).toContain('window.somnibot.generateSupabaseDatabasePassword()');
    expect(renderer).toContain('database password generated and saved for VPS/direct migrations');
    expect(renderer).toContain('result.databasePasswordReady ?');
    expect(renderer).toContain('if (!result.secretKeyReady) fields.supabaseSecretKey.value = \'\';');
    expect(renderer).toContain('if (!result.publishableKeyReady) fields.supabasePublishableKey.value = \'\';');
    expect(preload).toContain("ipcRenderer.invoke('supabase:discover-projects', accessToken)");
    expect(preload).toContain("ipcRenderer.invoke('supabase:select-project', ref)");
    expect(preload).toContain("ipcRenderer.invoke('supabase:generate-db-password')");
    expect(main).toContain("ipcMain.handle('supabase:discover-projects'");
    expect(main).toContain("saveConfig(sanitized)");
    expect(main).toContain('sanitized.supabaseAccessToken ?? getConfig().supabaseAccessToken');
    expect(main).toContain('listSupabaseProjects(effectiveAccessToken)');
    expect(main).toContain("ipcMain.handle('supabase:select-project'");
    expect(main).toContain('secretKeyReady: Boolean(result.credentials.secretKey)');
    expect(main).not.toContain('secretKey: result.credentials.secretKey');
  });

  it('makes launcher lifecycle decisions explicit instead of leaving hidden stale processes', () => {
    const main = readSourceFile('main/index.ts');
    const processManager = readSourceFile('main/process-manager.ts');
    const lavalink = readSourceFile('main/lavalink-manager.ts');
    const valkey = readSourceFile('main/valkey-manager.ts');
    const configBridge = readSourceFile('main/config-bridge.ts');

    expect(main).toContain('process.exit(0);');
    expect(main).toContain("mainWindow.on('close'");
    expect(main).toContain("Keep running in background");
    expect(main).toContain("Stop services and quit");
    expect(main).toContain('mainWindow.show();');
    expect(main).toContain("app.on('before-quit', (event)");
    expect(main).toContain('event.preventDefault();');
    expect(main).toContain('await stopAll();');
    expect(processManager).toContain('function stopManagedChild');
    expect(processManager).toContain('async function waitForStaleProcessExit');
    expect(processManager).toContain('export async function cleanupStaleProcesses(): Promise<StaleProcessCleanupResult>');
    expect(processManager).toContain('await Promise.all(stalePids.map');
    expect(processManager).toContain('typeof pid === \'number\' && Number.isSafeInteger(pid) && pid > 0');
    expect(processManager).toContain('processMatchesExpectedIdentity');
    expect(processManager).toContain('identity is ambiguous');
    expect(processManager).toContain("code === 'ESRCH'");
    expect(processManager).toContain("? 'dead' : 'unknown'");
    expect(processManager).toContain("liveness === 'unknown'");
    expect(processManager).toContain("(?:[\"']|\\s|$)");
    expect(main).toContain('staleCleanup.ok');
    expect(main).toContain('dialog.showErrorBox(');
    expect(main).toContain('const staleCleanup = await cleanupStaleProcesses();');
    expect(main).toMatch(/if \(!staleCleanup\.ok\) \{[\s\S]*?app\.quit\(\);[\s\S]*?return;/);
    expect(configBridge).toContain('delete sanitized.lastPids;');
    expect(configBridge).toContain('delete sanitized.lastPidStartedAt;');
    expect(processManager).toContain('processMatchesStartWitness');
    expect(main).toContain('Promise.allSettled([stopAll(), stopLavalink(), stopValkey()])');
    expect(main).toContain('The launcher is staying open because one or more managed services could not be confirmed stopped.');
    expect(processManager).toContain('let stopPromise: Promise<void> | null = null;');
    expect(lavalink).toContain('export function stopLavalink(): Promise<void>');
    expect(valkey).toContain('export function stopValkey(): Promise<void>');
  });

  it('preserves the local callback profile while the owner configures VPS mode', () => {
    const renderer = readSourceFile('renderer/renderer.js');
    const collectRuntimeConfig = renderer.slice(
      renderer.indexOf('function collectRuntimeConfig()'),
      renderer.indexOf('function collectConfig()'),
    );

    expect(collectRuntimeConfig).toContain('config[key] = input.value;');
    expect(collectRuntimeConfig).not.toContain("config.publicCallbackBaseUrl = '';");
  });

  it('keeps cloud connection recovery available for partial established profiles', () => {
    const html = readSourceFile('renderer/index.html');
    const renderer = readSourceFile('renderer/renderer.js');

    expect(html).toContain('Restore saved Discord, Supabase, and PayPal connections from Supabase.');
    expect(renderer).toContain("restoreBanner.classList.toggle('hidden', !hasSupabase);");
    expect(renderer).not.toContain('const missingDiscord = !fields.discordToken.value.trim();');
    expect(renderer).toContain("if (fields[key].type === 'checkbox') fields[key].checked = Boolean(value);");
    expect(renderer).toContain('else fields[key].value = String(value);');
  });

  it('validates saved provider credentials automatically without testing masked secrets', () => {
    const renderer = readSourceFile('renderer/renderer.js');
    const main = readSourceFile('main/index.ts');

    expect(renderer).toContain('latestProviderValidation = await window.somnibot.validateCredentials(collectCredentialConfig())');
    expect(main).toContain('const supplied = sanitizeConfigPatchForStorage(config);');
    expect(main).toContain('const bootstrap = await bootstrapSupabaseFromManagementToken({ ...current, ...supplied });');
    expect(main).toContain('return validateAllCredentials(bootstrap.config);');
  });

  it('lets the owner revalidate saved connections without starting the local stack', () => {
    const html = readSourceFile('renderer/index.html');
    const renderer = readSourceFile('renderer/renderer.js');

    expect(html).toContain('Verify Saved Connection');
    expect(renderer).toContain("const btnVerifyDiscord = $('btn-verify-discord');");
    expect(renderer).toContain('window.somnibot.validateCredentials(collectCredentialConfig())');
    expect(renderer).toContain('latestProviderValidation = result;');
    expect(renderer).toContain('Saved Discord and Supabase connections verified.');
    expect(renderer).toContain('without starting services');
  });

  it('imports an established SomniBot environment without asking the owner to recreate credentials', () => {
    const html = readSourceFile('renderer/index.html');
    const renderer = readSourceFile('renderer/renderer.js');
    const preload = readSourceFile('main/preload.ts');
    const main = readSourceFile('main/index.ts');

    expect(html).toContain('id="btn-import-existing-env"');
    expect(html).toContain('Only missing launcher fields are filled.');
    expect(renderer).toContain('window.somnibot.importExistingEnv()');
    expect(renderer).toContain('applyConfigToForm(await window.somnibot.getConfig());');
    expect(preload).toContain("ipcRenderer.invoke('import-existing-env')");
    expect(main).toContain("ipcMain.handle('import-existing-env'");
    expect(main).toContain("properties: ['openFile']");
    expect(main).toContain('saveConfig(result.patch);');
    expect(main).not.toContain('result.patch,');
  });

  it('reuses one portable service generation across local restarts and VPS deployment', () => {
    const main = readSourceFile('main/index.ts');
    const configStore = readSourceFile('main/config-store.ts');

    expect(main).toContain('const preparedSecrets = ensurePersistedVpsSecrets(config);');
    expect(main).toContain('saveConfig(preparedSecrets.patch);');
    expect(main).toContain('setLavalinkPassword(runtimeConfig.vpsLavalinkPassword);');
    expect(configStore).toContain('CSRF_SECRET: config.vpsCsrfSecret || randomBytes(32)');
    expect(configStore).toContain('NEXTAUTH_SECRET: config.vpsNextAuthSecret || randomBytes(32)');
    expect(configStore).toContain('WEBHOOK_REPLAY_SECRET: config.vpsWebhookReplaySecret || randomBytes(32)');
    expect(configStore).toContain('LAVALINK_PASSWORD: config.vpsLavalinkPassword || getLavalinkPassword()');
  });

  it('restores local provider callbacks as well as processes after a failed VPS handoff', () => {
    const main = readSourceFile('main/index.ts');
    expect(main).toContain("runLocalSetupAutomation({\n              runtimeMode: 'regular-local'");
    expect(main).toContain('Local SomniBot and its provider callbacks could not be restored.');
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
    const main = readSourceFile('main/index.ts');

    expect(html).toContain('The launcher checks a fresh or existing target, can install the supported Ubuntu/Debian Docker runtime, provisions the authoritative GitHub checkout, and then runs the disclosed deployment plan after explicit approval.');
    expect(html).not.toContain('SSH automation is not run from this setup screen');
    expect(renderer).toContain("const vpsDeploymentPlan = $('vps-deployment-plan');");
    expect(renderer).toContain("const vpsHealthVerification = $('vps-health-verification');");
    expect(renderer).toContain("const btnOpenDiscordInvite = $('btn-open-discord-invite');");
    expect(renderer).toContain('function getDiscordInviteState()');
    expect(renderer).toContain('function buildDiscordInviteUrl()');
    expect(renderer).toContain('discordGuildId: fields.discordGuildId.value');
    expect(renderer).toContain('function renderSetupStepAction(step)');
    expect(renderer).toContain("const setupCompletion = $('setup-completion');");
    expect(renderer).toContain('function renderSetupCompletion(completion)');
    expect(renderer).toContain('renderSetupCompletion(status.completion);');
    expect(renderer).toContain('<h3>Owner setup completion</h3>');
    expect(renderer).toContain('function formatCompletionStatus(status)');
    expect(styles).toContain('.setup-completion');
    expect(styles).toContain('.setup-completion-missing');
    expect(renderer).toContain('data-setup-action="discord-invite"');
    expect(renderer).toContain("runtimeSteps.addEventListener('click'");
    expect(renderer).toContain("button.dataset.setupAction === 'discord-invite'");
    expect(styles).toContain('.runtime-step button.manual-action');
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
    expect(renderer).toContain('renderVpsHealthVerification(status.healthVerification, isVpsStatus);');
    expect(renderer).toContain('let latestProviderValidation = null;');
    expect(renderer).toContain('let latestCallbackProbe = null;');
    expect(renderer).toContain('let latestPayPalWebhook = null;');
    expect(renderer).toContain('let latestVpsHealthProof = null;');
    expect(renderer).toContain('latestVpsHealthProof = null;');
    expect(renderer).toContain('providerValidation: latestProviderValidation');
    expect(renderer).toContain('paypalWebhook: latestPayPalWebhook');
    expect(renderer).toContain('callbackProbe: latestCallbackProbe');
    expect(renderer).toContain("...(runtimeMode === 'vps' && latestVpsHealthProof ? latestVpsHealthProof : {})");
    expect(renderer).toContain('if (!dryRun) {\n      latestVpsHealthProof = null;\n    }');
    expect(renderer).toContain('latestVpsHealthProof = vpsDeploymentResult.healthProof');
    expect(renderer).toContain("if (runtimeMode !== 'regular-local' || isValidating) return;");
    expect(renderer).toContain('paypalReady: isPayPalFormComplete()');
    expect(renderer).toContain("const btnSetupPayPalWebhook = $('btn-setup-paypal-webhook');");
    expect(renderer).toContain('function updatePayPalWebhookButton()');
    expect(renderer).toContain('|| isValidating');
    expect(renderer).toContain('|| isVpsDeploymentActionRunning');
    expect(renderer).toContain('function applyPayPalWebhookResult(webhookResult)');
    expect(renderer).toContain('if (webhookResult?.ok) {\n    latestVpsHealthProof = null;\n  }');
    expect(renderer).toContain('applyPayPalWebhookResult(result.paypalWebhook)');
    expect(renderer).toContain('applyPayPalWebhookResult(result)');
    expect(renderer).toContain('async function refreshProcessStatus()');
    expect(renderer).toContain('const status = await window.somnibot.getStatus();');
    expect(renderer).toContain('function scheduleRuntimeHealthRetry(status)');
    expect(renderer).toContain("latestProcessStatus?.dashboard === 'online'");
    expect(renderer).toContain("runtimeHealth?.status === 'pending'");
    expect(renderer).toContain('setupStatusRetryCount < 12');
    expect(renderer).toContain('void refreshSetupStatus({ runtimeHealthRetry: true });');
    expect(renderer).toContain('await refreshProcessStatus();\n    updatePayPalWebhookButton();');
    expect(renderer).toContain('Local services were restarted to load the new Webhook ID.');
    expect(renderer).toContain('window.somnibot.ensurePayPalWebhook(collectConfig())');
    expect(main).toContain('if (config.publicCallbackBaseUrl.trim())');
    expect(main).not.toContain("config.publicCallbackBaseUrl.includes('.ts.net')");
    expect(renderer).toContain('function syncTailscalePublicCallbackAvailability(publicUrl)');
    expect(renderer).toContain("btnTailscaleProbe.classList.toggle('hidden', !publicUrl);");
    expect(renderer).toContain('syncTailscalePublicCallbackAvailability(publicUrl);\n  const callbackField = document.getElementById');
    expect(renderer).toContain('function canProbePublicCallbackWhileRunning()');
    expect(renderer).toContain("return runtimeMode === 'regular-local'");
    expect(renderer).toContain('&& isRunning');
    expect(renderer).toContain('btnTailscaleProbe.disabled = disabled && !canProbePublicCallbackWhileRunning();');
    expect(renderer).toContain("btnSetupPayPalWebhook.textContent = 'Create/Update Webhook';");
    expect(renderer).toContain('latestProviderValidation = result.providerValidation;');
    expect(renderer).toContain('Finish VPS readiness fields before SSH preflight or deployment actions are available.');
    expect(renderer).toContain('The launcher can check a fresh target, install the supported runtime, provision or update the GitHub checkout, show the dry-run, and execute the approved deployment with redacted output.');
    expect(renderer).not.toContain('does not run SSH or deploy commands in this build');
    expect(renderer).toContain('Review the plan, run the read-only SSH/prerequisite preflight, then use explicit approval before runtime installation, checkout, credential, or container changes.');
    expect(renderer).toContain('data-vps-deploy-action="preflight"');
    expect(renderer).toContain('data-vps-deploy-action="dry-run"');
    expect(renderer).toContain('data-vps-deploy-action="run-live"');
    expect(renderer).toContain('window.somnibot.runVpsPreflight()');
    expect(renderer).toContain('window.somnibot.runVpsDeployment({');
    expect(renderer).toContain('window.somnibot.runVpsRollback({ lastGoodCommit });');
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
    expect(renderer).toContain('function renderVpsHealthVerification(verification, isVpsStatus)');
    expect(renderer).toContain('<h3>VPS health verification</h3>');
    expect(renderer).toContain('function renderVpsHealthCheck(check)');
    expect(renderer).toContain('formatVpsHealthStatus(status)');
    expect(renderer).toContain('formatDiagnosticLabel(label)');
    expect(styles).toContain('.deployment-plan');
    expect(styles).toContain('.vps-health-verification');
    expect(styles).toContain('.vps-health-check');
    expect(styles).toContain('.vps-health-diagnostics');
    expect(styles).toContain('.deployment-plan-actions');
    expect(styles).toContain('.deployment-run-result');
    expect(styles).toContain('.deployment-command');
  });

  it('keeps setup status IPC wired through preload and main process VPS fields', () => {
    const preload = readSourceFile('main/preload.ts');
    const main = readSourceFile('main/index.ts');
    const renderer = readSourceFile('renderer/renderer.js');
    const configStore = readSourceFile('main/config-store.ts');
    const configBridge = readSourceFile('main/config-bridge.ts');
    const validationIndex = main.indexOf('const validation = await validateAllCredentials(config);');
    const authProviderReadinessIndex = main.indexOf('const dashboardVerifiedAuthProvider = !callbackBaseUrlChanged');
    const authProviderIndex = main.indexOf('&& !dashboardVerifiedAuthProvider');
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
    expect(preload).toContain("runVpsRollback: (payload) => ipcRenderer.invoke('vps:run-rollback', payload)");
    expect(preload).toContain('healthProof?: Record<string, unknown>');
    expect(main).toContain("ipcMain.handle('get-setup-status'");
    expect(main).toContain("ipcMain.handle('run-setup-automation'");
    expect(main).toContain("ipcMain.handle('paypal:ensure-webhook'");
    expect(main).toContain('function sanitizePayPalConfigPatch(config: LauncherConfigPatch): LauncherConfigPatch');
    expect(main).toContain('delete sanitized.lastSuccessfulRuntimeMode;');
    expect(main).toContain('sanitizedPatch = sanitizeRendererConfigPatch(configPatch);');
    expect(main).toContain('saveConfig(sanitizeRendererConfigPatch(config))');
    expect(main).toContain("savedConfig.lastSuccessfulRuntimeMode === 'vps'");
    expect(main).toContain("!leaseStatus.active && savedConfig.lastSuccessfulRuntimeMode !== 'vps'");
    expect(main).toContain("shouldStopManagedLocalStackBeforeLeaseWait(leaseStatus, isRunning())");
    expect(main).toContain('await stopManagedLocalStack();');
    expect(main).toContain('const localResult = await runLocalSetupAutomation(sanitizedPatch);');
    expect(main).toContain('waitForVpsBotReadyAfter(vpsPlan.target.publicBaseUrl, recoveryStartedAt)');
    expect(main).toContain('installIncomingLocalValkeySnapshot(transferredValkeyPath!)');
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
    expect(main).toContain('lastStartedPayPalConfig = snapshotPayPalRuntimeConfig(runtimeConfig);');
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
    expect(main).toContain("ipcMain.handle('vps:run-rollback'");
    expect(main).toContain('runtimeMode: input.runtimeMode ?? config.runtimeMode');
    expect(main).toContain('publicCallbackBaseUrl: input.publicCallbackBaseUrl ?? config.publicCallbackBaseUrl');
    expect(main).toContain('vpsDomain: input.vpsDomain ?? config.vpsDomain');
    expect(main).toContain('vpsSshHost: input.vpsSshHost ?? config.vpsSshHost');
    expect(main).toContain('vpsSshUser: input.vpsSshUser ?? config.vpsSshUser');
    expect(main).toContain('vpsDeployPath: input.vpsDeployPath ?? config.vpsDeployPath');
    expect(main).toContain("'vpsPublicAccessMode'");
    expect(main).toContain("'vpsTailscaleFunnelUrl'");
    expect(main).toContain('vpsPublicAccessMode: config.vpsPublicAccessMode');
    expect(main).toContain('vpsTailscaleFunnelUrl: config.vpsTailscaleFunnelUrl');
    expect(main).toContain("sanitized.vpsTailscaleFunnelVerifiedUrl = ''");
    expect(main).toContain('credentialReady: input.credentialReady ?? Boolean(');
    expect(main).toContain('providerValidation: input.providerValidation');
    expect(main).toContain('paypalReady: input.paypalReady ?? Boolean(');
    expect(main).toContain('function buildPayPalWebhookProofKey');
    expect(main).toContain('paypalWebhookProofKey');
    expect(main).toContain('paypalWebhook: input.paypalWebhook ?? persistedPayPalWebhookProof');
    expect(main).toContain('callbackProbe: input.callbackProbe');
    expect(main).toContain('return maskConfigSecrets({');
    expect(main).toContain('paypalClientSecret: config.paypalClientSecret');
    expect(main).toContain('paypalWebhookId: config.paypalWebhookId');
    expect(configBridge).toContain("'discordToken'");
    expect(configBridge).toContain("'discordClientSecret'");
    expect(configBridge).toContain("'paypalClientSecret'");
    expect(configStore).toContain('PAYPAL_CLIENT_ID: config.paypalClientId');
    expect(configStore).toContain('PAYPAL_CLIENT_SECRET: config.paypalClientSecret');
    expect(configStore).toContain('PAYPAL_WEBHOOK_ID: config.paypalWebhookId');
    expect(configStore).toContain('PAYPAL_SANDBOX: config.paypalSandbox ?');
    expect(main).toContain('supabaseAccessTokenReady: input.supabaseAccessTokenReady ?? Boolean(config.supabaseAccessToken)');
    expect(main).toContain('supabaseDiscordAuthProviderConfigured: input.supabaseDiscordAuthProviderConfigured');
    expect(main).toContain('function readDashboardSetupSnapshot');
    expect(main).toContain("fetch(`${REGULAR_LOCAL_OPERATOR_DASHBOARD_URL}/api/setup`");
    expect(main).toContain('supabaseProjectRef?: string | null;');
    expect(main).toContain('function dashboardSetupMatchesLauncherConfig');
    expect(main).toContain('function dashboardAuthProviderStatusUsableForLauncherConfig');
    expect(main).toContain('function getDashboardAuthProviderStatusForLauncherConfig');
    expect(main).toContain('function dashboardSetupVerifiesAuthProvider');
    expect(main).toContain('dashboardAuthProviderConfigured');
    expect(main).toContain('DASHBOARD_SETUP_SNAPSHOT_CACHE_MS');
    expect(main).toContain('const dashboardSetupStatus = getDashboardAuthProviderStatusForLauncherConfig');
    expect(main).toContain('const dashboardSetupBeforeStart = await readDashboardSetupSnapshot(1_500, { force: true })');
    expect(main).toContain('&& !dashboardVerifiedAuthProvider');
    expect(main).toContain('&& (config.supabaseAccessToken.trim() || config.supabaseDiscordAuthProviderConfigured)');
    expect(main).toContain('Dashboard already verified Discord auth provider readiness for this launcher config');
    expect(main).not.toContain('saveConfig({ supabaseDiscordAuthProviderConfigured: true })');
    expect(main).toContain('supabaseDiscordAuthProviderStatus: selectedAuthProviderStatus');
    expect(main).toContain('function vpsSupabaseCallbackSignal');
    expect(main).toContain('Manual confirmation says the Discord auth callback allow-list is configured for this VPS setup.');
    expect(main).toContain('tailscaleAuthKeyReady: input.tailscaleAuthKeyReady ?? Boolean(config.tailscaleAuthKey)');
    expect(main).toContain('tailscaleReadinessState: input.tailscaleReadinessState');
    expect(main).toContain('httpsDashboardProbe: input.httpsDashboardProbe');
    expect(main).toContain('apiHealthProbe: input.apiHealthProbe');
    expect(main).toContain('supabaseCallbackAllowList: vpsSupabaseCallbackSignal(input, selectedAuthProviderStatus)');
    expect(main).toContain('lavalink: input.lavalink');
    expect(main).toContain('setupLocked?: boolean');
    expect(main).toContain('response.status === 403 && body?.setupLocked');
    expect(main).toContain('manualAuthProviderConfirmed');
    expect(main).toContain('callbackBaseUrlChanged');
    expect(main).toContain('manualAuthProviderConfirmed && !callbackBaseUrlChanged');
    expect(main).toContain('providerStatus.manualConfigured === true && !config.supabaseDiscordAuthProviderConfigured');
    expect(main).toContain('providerStatus.ready === true');
    expect(main).toContain('!config.supabaseAccessToken.trim()');
    expect(main).toContain('const authConfigured = await configureDashboardAuthProvider({');
    expect(validationIndex).toBeGreaterThan(-1);
    expect(authProviderIndex).toBeGreaterThan(validationIndex);
    expect(startIndex).toBeGreaterThan(validationIndex);
    expect(dashboardHealthIndex).toBeGreaterThan(startIndex);
    expect(configureAuthIndex).toBeGreaterThan(dashboardHealthIndex);
    expect(paypalWebhookIndex).toBeGreaterThan(configureAuthIndex);
    expect(authProviderReadinessIndex).toBeGreaterThan(validationIndex);
    expect(authProviderIndex).toBeGreaterThan(authProviderReadinessIndex);
    expect(main).toContain('evaluateDashboardHealthPayload(body)');
    expect(main).toContain('servicesStarted: true');
    expect(main).toContain('startLocalStack(config, { forceRestart: true })');
    expect(main).toContain('waitForPortAvailable(3456)');
  });
});
