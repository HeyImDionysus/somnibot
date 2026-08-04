/**
 * SomniBot Launcher — Renderer Script.
 *
 * Talks to the main process via window.somnibot (preload bridge).
 * Pure vanilla JS — no framework needed for this small UI.
 */

/* ================================================================== */
/*  DOM refs                                                           */
/* ================================================================== */

const $ = (id) => document.getElementById(id);
const MASKED_SECRET = '••••••••';

const fields = {
  discordToken: $('discordToken'),
  discordApplicationId: $('discordApplicationId'),
  discordClientSecret: $('discordClientSecret'),
  discordGuildId: $('discordGuildId'),
  supabaseUrl: $('supabaseUrl'),
  supabaseSecretKey: $('supabaseSecretKey'),
  supabasePublishableKey: $('supabasePublishableKey'),
  supabaseDbPassword: $('supabaseDbPassword'),
  supabaseAccessToken: $('supabaseAccessToken'),
  supabaseDiscordAuthProviderConfigured: $('supabaseDiscordAuthProviderConfigured'),
  paypalClientId: $('paypalClientId'),
  paypalClientSecret: $('paypalClientSecret'),
  paypalWebhookId: $('paypalWebhookId'),
  paypalSandbox: $('paypalSandbox'),
  tailscaleAuthKey: $('tailscaleAuthKey'),
};

const runtimeFields = {
  publicCallbackBaseUrl: $('publicCallbackBaseUrl'),
  vpsDomain: $('vpsDomain'),
  vpsSshHost: $('vpsSshHost'),
  vpsSshUser: $('vpsSshUser'),
  vpsDeployPath: $('vpsDeployPath'),
};

const btnStart = $('btn-start');
const btnStop = $('btn-stop');
const btnOpenDashboard = $('btn-open-dashboard');
const btnToggleLogs = $('btn-toggle-logs');
const btnCloseLogs = $('btn-close-logs');
const btnHelp = $('btn-help');
const btnOpenDiscord = $('btn-open-discord');
const btnOpenDiscordInvite = $('btn-open-discord-invite');
const btnVerifyDiscord = $('btn-verify-discord');
const btnOpenSupabase = $('btn-open-supabase');
const btnDiscoverSupabase = $('btn-discover-supabase');
const supabaseProjectPicker = $('supabase-project-picker');
const supabaseProjectSelect = $('supabase-project-select');
const btnSelectSupabaseProject = $('btn-select-supabase-project');
const supabaseProjectStatus = $('supabase-project-status');
const btnGenerateSupabaseDbPassword = $('btn-generate-supabase-db-password');
const supabaseDbPasswordStatus = $('supabase-db-password-status');
const btnSetupPayPalWebhook = $('btn-setup-paypal-webhook');
const btnCheckUpdates = $('btn-check-updates');

const btnRestoreCloud = $('btn-restore-cloud');
const btnImportExistingEnv = $('btn-import-existing-env');
const restoreBanner = $('restore-banner');

const botDot = $('bot-dot');
const dashDot = $('dash-dot');
const lavalinkDot = $('lavalink-dot');
const lavalinkStatusItem = $('lavalink-status-item');
const messageArea = $('message-area');
const metaArea = $('meta-area');
const logPanel = $('log-panel');
const logContent = $('log-content');
const versionEl = $('version');
const updateBanner = $('update-banner');
const offlineBanner = $('offline-banner');
const runtimeModeLabel = $('runtime-mode-label');
const runtimeSection = $('runtime-section');
const regularRuntimeFields = $('regular-runtime-fields');
const vpsRuntimeFields = $('vps-runtime-fields');
const runtimeSteps = $('runtime-steps');
const summaryDashboardLabel = $('summary-dashboard-label');
const summaryPublicCallbackLabel = $('summary-public-callback-label');
const summaryLocalDashboard = $('summary-local-dashboard');
const summaryPublicCallback = $('summary-public-callback');
const summaryAuthCallback = $('summary-auth-callback');
const summaryPayPalWebhook = $('summary-paypal-webhook');
const runtimeDiagnosticsList = $('runtime-diagnostics-list');
const setupCompletion = $('setup-completion');
const vpsDeploymentPlan = $('vps-deployment-plan');
const vpsHealthVerification = $('vps-health-verification');

// Onboarding
const onboardingOverlay = $('onboarding-overlay');
const onboardingRuntimeTitle = $('onboarding-runtime-title');
const onboardingRuntimeDesc = $('onboarding-runtime-desc');
const onboardingRuntimeList = $('onboarding-runtime-list');

// Lavalink
const lavalinkToggle = $('lavalink-toggle');
const lavalinkPanel = $('lavalink-panel');
const lavalinkJavaStatus = $('lavalink-java-status');
const lavalinkJarStatus = $('lavalink-jar-status');
const lavalinkDownloadRow = $('lavalink-download-row');
const btnDownloadLavalink = $('btn-download-lavalink');
const lavalinkDownloadProgress = $('lavalink-download-progress');
const btnLavalinkHelp = $('btn-lavalink-help');

// Tailscale public callback
const tailscaleSectionHeader = $('tailscale-section-header');
const tailscaleSection = $('tailscale-section');
const btnTailscaleCheck = $('btn-tailscale-check');
const btnTailscaleEnable = $('btn-tailscale-enable');
const btnTailscaleProbe = $('btn-tailscale-probe');
const tailscaleDot = $('tailscale-dot');
const tailscaleStatusText = $('tailscale-status-text');
const tailscaleUrl = $('tailscale-url');
const tailscaleNote = $('tailscale-note');
const tailscaleDetails = $('tailscale-details');
const tailscaleCommand = $('tailscale-command');

/* ================================================================== */
/*  State                                                              */
/* ================================================================== */

let isRunning = false;
let isValidating = false;
let isPayPalWebhookRunning = false;
let runtimeMode = 'regular-local';
let setupStatus = null;
let setupStatusSeq = 0;
let latestProcessStatus = null;
let tailscalePublicCallbackBaseUrl = '';
let latestTailscaleReadiness = null;
let latestCallbackProbe = null;
let latestProviderValidation = null;
let latestPayPalWebhook = null;
let latestVpsHealthProof = null;
let tailscaleReadinessSeq = 0;
let vpsPreflightResult = null;
let vpsDeploymentResult = null;
let vpsActionResultPlanKey = '';
let isVpsDeploymentActionRunning = false;
let isSupabaseDiscoveryRunning = false;
let supabaseProjects = [];

/* ================================================================== */
/*  Init                                                               */
/* ================================================================== */

function applyConfigToForm(config) {
  for (const [key, input] of Object.entries(fields)) {
    if (!input) continue;
    if (input.type === 'checkbox') {
      input.checked = Boolean(config[key]);
    } else if (config[key]) {
      input.value = config[key];
      if (config[key] === MASKED_SECRET) markSavedSecret(input);
    }
  }
  for (const [key, input] of Object.entries(runtimeFields)) {
    if (config[key]) input.value = config[key];
  }
  tailscalePublicCallbackBaseUrl = config.publicCallbackBaseUrl || '';
  setRuntimeMode(config.runtimeMode === 'vps' ? 'vps' : 'regular-local', { save: false });
  updateDiscordInviteButton();
  updatePayPalWebhookButton();
  updateRestoreBanner();
}

async function init() {
  // Show version
  try {
    const ver = await window.somnibot.getVersion();
    versionEl.textContent = `v${ver}`;
  } catch {
    versionEl.textContent = 'dev';
  }

  // Load saved config
  try {
    const config = await window.somnibot.getConfig();
    applyConfigToForm(config);
    if (isCredentialFormComplete() && navigator.onLine) {
      try {
        latestProviderValidation = await window.somnibot.validateCredentials(collectCredentialConfig());
      } catch (err) {
        console.warn('Provider startup validation was unavailable:', err);
      }
    }
  } catch (err) {
    console.error('Failed to load config:', err);
  }

  // Check current status (in case app reconnected)
  await refreshProcessStatus();

  // Auto-save on field change (debounced)
  let saveTimeout = null;
  for (const input of Object.values(fields)) {
    if (!input) continue;
    const eventName = input.type === 'checkbox' ? 'change' : 'input';
    input.addEventListener(eventName, () => {
      if (input.dataset.savedSecret === 'true' && input.value !== MASKED_SECRET) {
        clearSavedSecretState(input);
      }
      clearTimeout(saveTimeout);
      saveTimeout = setTimeout(saveConfig, 500);
      input.classList.remove('error', 'valid');
      latestProviderValidation = null;
      latestPayPalWebhook = null;
      latestVpsHealthProof = null;
      updateRestoreBanner();
      updateDiscordInviteButton();
      updateDiscordVerifyButton();
      updatePayPalWebhookButton();
      refreshSetupStatus();
    });
  }

  for (const input of Object.values(runtimeFields)) {
    input.addEventListener('input', () => {
      clearTimeout(saveTimeout);
      saveTimeout = setTimeout(saveConfig, 500);
      input.classList.remove('error', 'valid');
      if (input === runtimeFields.publicCallbackBaseUrl) {
        tailscalePublicCallbackBaseUrl = input.value.trim();
        latestCallbackProbe = null;
      }
      latestPayPalWebhook = null;
      latestVpsHealthProof = null;
      updatePayPalWebhookButton();
      refreshSetupStatus();
    });
  }

  document.querySelectorAll('[data-runtime]').forEach((btn) => {
    btn.addEventListener('click', () => {
      setRuntimeMode(btn.dataset.runtime === 'vps' ? 'vps' : 'regular-local');
    });
  });

  // Show restore banner if appropriate
  updateRestoreBanner();
  updateDiscordVerifyButton();
  await refreshSetupStatus();

  // Phase 6: Network status
  initNetworkMonitor();

  // Phase 6: Onboarding
  await initOnboarding();

  // Phase 6: Lavalink
  await initLavalink();

  // Public callback readiness
  if (runtimeMode === 'regular-local') {
    await refreshTailscaleReadiness({ quiet: true });
  }
}

/* ================================================================== */
/*  Config persistence                                                 */
/* ================================================================== */

async function saveConfig() {
  const config = collectConfig();
  try {
    await window.somnibot.saveConfig(config);
  } catch (err) {
    console.error('Failed to save config:', err);
  }
}

function collectCredentialConfig() {
  const config = {};
  for (const [key, input] of Object.entries(fields)) {
    if (!input) continue;
    config[key] = input.type === 'checkbox'
      ? input.checked
      : input.dataset.savedSecret === 'true' ? MASKED_SECRET : input.value;
  }
  return config;
}

function collectRuntimeConfig() {
  const config = { runtimeMode };
  for (const [key, input] of Object.entries(runtimeFields)) {
    config[key] = input.value;
  }
  return config;
}

function collectConfig() {
  return {
    ...collectCredentialConfig(),
    ...collectRuntimeConfig(),
  };
}

function isCredentialFormComplete() {
  const discordReady = [
    'discordToken',
    'discordApplicationId',
    'discordClientSecret',
  ].every((key) => fields[key].value.trim().length > 0);
  const supabaseKeysReady = [
    'supabaseUrl',
    'supabaseSecretKey',
    'supabasePublishableKey',
  ].every((key) => fields[key].value.trim().length > 0);
  const supabaseTokenReady = fields.supabaseAccessToken.value.trim().length > 0;
  return discordReady && (supabaseKeysReady || supabaseTokenReady);
}

function isPayPalFormComplete() {
  return [
    'paypalClientId',
    'paypalClientSecret',
    'paypalWebhookId',
  ].every((key) => fields[key].value.trim().length > 0);
}

function getPayPalWebhookActionState() {
  const hasClientId = fields.paypalClientId.value.trim().length > 0;
  const hasClientSecret = fields.paypalClientSecret.value.trim().length > 0;
  const webhookUrl = setupStatus?.summary?.paypalWebhookUrl || '';
  const hasWebhookUrl = webhookUrl.startsWith('https://');

  if (!hasClientId || !hasClientSecret) {
    return {
      enabled: false,
      title: 'Enter PayPal Client ID and Client Secret first',
    };
  }

  if (!hasWebhookUrl) {
    return {
      enabled: false,
      title: 'Finish public callback setup so the PayPal webhook URL is public HTTPS',
    };
  }

  return {
    enabled: true,
    title: `Create or update PayPal webhook for ${webhookUrl}`,
  };
}

function updatePayPalWebhookButton() {
  const state = getPayPalWebhookActionState();
  btnSetupPayPalWebhook.disabled = !state.enabled
    || isPayPalWebhookRunning
    || isValidating
    || isVpsDeploymentActionRunning;
  btnSetupPayPalWebhook.title = state.title;
}

function applyPayPalWebhookResult(webhookResult) {
  latestPayPalWebhook = webhookResult?.ok ? webhookResult : null;
  if (webhookResult?.ok) {
    latestVpsHealthProof = null;
  }
  if (webhookResult?.webhookId) {
    fields.paypalWebhookId.value = webhookResult.webhookId;
  }
}

function setRuntimeMode(mode, options = {}) {
  if (runtimeMode !== (mode === 'vps' ? 'vps' : 'regular-local')) {
    latestCallbackProbe = null;
    latestPayPalWebhook = null;
    latestVpsHealthProof = null;
  }
  runtimeMode = mode === 'vps' ? 'vps' : 'regular-local';
  const isVps = runtimeMode === 'vps';

  runtimeModeLabel.textContent = isVps ? 'VPS' : 'Regular local';
  regularRuntimeFields.classList.toggle('hidden', isVps);
  vpsRuntimeFields.classList.toggle('hidden', !isVps);
  tailscaleSectionHeader.classList.toggle('hidden', isVps);
  tailscaleSection.classList.toggle('hidden', isVps);

  document.querySelectorAll('[data-runtime]').forEach((btn) => {
    const active = btn.dataset.runtime === runtimeMode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });

  renderOnboardingRuntimeStep();

  if (options.save !== false) {
    saveConfig();
    refreshSetupStatus();
  }
}

async function refreshSetupStatus(options = {}) {
  const seq = ++setupStatusSeq;
  const input = {
    ...collectRuntimeConfig(),
    discordGuildId: fields.discordGuildId.value,
    credentialReady: isCredentialFormComplete(),
    providerValidation: latestProviderValidation,
    paypalReady: isPayPalFormComplete(),
    paypalWebhook: latestPayPalWebhook,
    callbackProbe: latestCallbackProbe,
    supabaseAccessTokenReady: fields.supabaseAccessToken.value.trim().length > 0,
    supabaseDiscordAuthProviderConfigured: fields.supabaseDiscordAuthProviderConfigured.checked,
    tailscaleAuthKeyReady: fields.tailscaleAuthKey.value.trim().length > 0,
    tailscaleReadinessState: runtimeMode === 'regular-local' ? latestTailscaleReadiness?.state : undefined,
    dashboardOnline: latestProcessStatus?.dashboard === 'online',
    checking: Boolean(options.checking),
    ...(runtimeMode === 'vps' && latestVpsHealthProof ? latestVpsHealthProof : {}),
  };

  if (options.checking) {
    renderSetupStatus({
      runtimeMode,
      summary: setupStatus?.summary ?? {
        runtimeMode,
        runtimeLabel: runtimeMode === 'vps' ? 'VPS' : 'Regular local',
        localDashboardUrl: 'Checking...',
        publicCallbackUrl: 'Checking...',
        authCallbackUrl: 'Checking...',
        paypalWebhookUrl: 'Checking...',
        diagnostics: {},
      },
      steps: [{
        id: 'checking',
        label: 'Setup',
        status: 'loading',
        summary: 'Checking setup gates.',
        detail: 'The launcher is checking runtime readiness.',
      }],
      completion: {
        status: 'incomplete',
        summary: 'Owner setup completion is being checked.',
        detail: 'The launcher is refreshing proof for callback, provider, PayPal, Discord, and runtime health readiness.',
        requiredStepIds: [],
        missingStepIds: [],
        missingLabels: [],
      },
      primaryAction: { label: 'Checking...', enabled: false, status: 'loading' },
      firstBlockingStepId: null,
    });
  }

  try {
    const status = await window.somnibot.getSetupStatus(input);
    if (seq !== setupStatusSeq) return setupStatus;
    setupStatus = status;
    clearStaleVpsActionResults(status);
    renderSetupStatus(status);
    updatePayPalWebhookButton();
    return status;
  } catch (err) {
    console.error('Failed to refresh setup status:', err);
    return setupStatus;
  }
}

function getVpsDeploymentPlanKey(plan) {
  const target = plan?.target;
  if (!target) return '';
  return [
    target.publicBaseUrl,
    target.sshTarget,
    target.deployPath,
    target.envFilePath,
  ].join('|');
}

function clearStaleVpsActionResults(status) {
  const planKey = getVpsDeploymentPlanKey(status?.deploymentPlan);
  if (!planKey) {
    vpsPreflightResult = null;
    vpsDeploymentResult = null;
    vpsActionResultPlanKey = '';
    return;
  }

  if (vpsActionResultPlanKey && vpsActionResultPlanKey !== planKey) {
    vpsPreflightResult = null;
    vpsDeploymentResult = null;
    vpsActionResultPlanKey = '';
  }
}

function renderSetupStatus(status) {
  if (!status) return;

  const isVpsStatus = status.runtimeMode === 'vps';
  const diagnostics = status.summary.diagnostics || {};

  runtimeSection.dataset.runtimeMode = status.runtimeMode;
  summaryDashboardLabel.textContent = isVpsStatus ? 'Dashboard URL' : 'Local dashboard URL';
  summaryPublicCallbackLabel.textContent = isVpsStatus ? 'Public callback base' : 'Public callback URL';
  summaryLocalDashboard.textContent = status.summary.localDashboardUrl;
  summaryPublicCallback.textContent = status.summary.publicCallbackUrl;
  summaryAuthCallback.textContent = status.summary.authCallbackUrl;
  summaryPayPalWebhook.textContent = status.summary.paypalWebhookUrl;

  runtimeDiagnosticsList.innerHTML = Object.entries(diagnostics)
    .map(([label, value]) => (
      `<div class="diagnostic-row"><span>${escapeHtml(formatDiagnosticLabel(label))}</span><span>${escapeHtml(value)}</span></div>`
    ))
    .join('');

  renderDeploymentPlan(status.deploymentPlan, isVpsStatus);
  renderVpsHealthVerification(status.healthVerification, isVpsStatus);
  renderSetupCompletion(status.completion);

  runtimeSteps.innerHTML = status.steps.map((step) => {
    const statusLabel = formatStepStatus(step.status);
    const manual = renderSetupStepAction(step);
    return (
      `<div class="runtime-step ${escapeHtml(step.status)}">` +
        `<div class="runtime-step-status">${escapeHtml(statusLabel)}</div>` +
        '<div>' +
          `<h3>${escapeHtml(step.label)}</h3>` +
          `<p><strong>${escapeHtml(step.summary)}</strong></p>` +
          `<p>${escapeHtml(step.detail)}</p>` +
          manual +
        '</div>' +
      '</div>'
    );
  }).join('');

  if (!isValidating) {
    btnStart.textContent = status.primaryAction.label;
  }
  btnStart.disabled = !status.primaryAction.enabled || isValidating || isRunning;
  updatePayPalWebhookButton();
}

function renderSetupCompletion(completion) {
  if (!setupCompletion) return;

  if (!completion) {
    setupCompletion.classList.add('hidden');
    setupCompletion.innerHTML = '';
    return;
  }

  const status = completion.status || 'incomplete';
  const badgeClass = status === 'complete' ? 'ready'
    : status === 'blocked' ? 'blocked'
      : 'pending';
  const missingLabels = Array.isArray(completion.missingLabels) ? completion.missingLabels : [];
  const missing = missingLabels.length > 0
    ? `<div class="setup-completion-missing">${renderList(missingLabels)}</div>`
    : '';

  setupCompletion.classList.remove('hidden', 'complete', 'incomplete', 'blocked');
  setupCompletion.classList.add(status);
  setupCompletion.innerHTML = (
    '<div>' +
      '<div class="setup-completion-header">' +
        '<h3>Owner setup completion</h3>' +
        `<span class="deployment-plan-badge ${escapeHtml(badgeClass)}">${escapeHtml(formatCompletionStatus(status))}</span>` +
      '</div>' +
      `<p><strong>${escapeHtml(completion.summary || '')}</strong></p>` +
      `<p>${escapeHtml(completion.detail || '')}</p>` +
      missing +
    '</div>'
  );
}

function renderSetupStepAction(step) {
  if (!step.actionLabel) return '';

  if (step.actionKind === 'discord-invite') {
    const inviteState = getDiscordInviteState();
    const disabled = inviteState.url ? '' : ' disabled';
    const title = inviteState.url
      ? 'Open the Discord bot invite'
      : inviteState.error || 'Enter a valid Discord Application ID first';
    return `<button class="manual-action setup-step-action" type="button" data-setup-action="discord-invite" title="${escapeHtml(title)}"${disabled}>${escapeHtml(step.actionLabel)}</button>`;
  }

  if (step.manualAction) {
    return `<span class="manual-action">${escapeHtml(step.actionLabel)}</span>`;
  }

  return '';
}

function renderDeploymentPlan(plan, isVpsStatus) {
  if (!vpsDeploymentPlan) return;

  if (!isVpsStatus || !plan) {
    vpsDeploymentPlan.classList.add('hidden');
    vpsDeploymentPlan.innerHTML = '';
    return;
  }

  vpsDeploymentPlan.classList.remove('hidden');

  if (plan.status === 'blocked') {
    const reasons = plan.blockedReasons.length > 0
      ? renderList(plan.blockedReasons)
      : '<p>Finish the VPS readiness fields before the launcher checks or provisions the remote checkout.</p>';
    vpsDeploymentPlan.innerHTML = (
      '<div class="deployment-plan-header">' +
        '<div>' +
          '<h3>VPS deployment plan</h3>' +
          '<p>Finish VPS readiness fields before SSH preflight or deployment actions are available.</p>' +
        '</div>' +
        '<span class="deployment-plan-badge blocked">Blocked</span>' +
      '</div>' +
      `<div class="deployment-plan-section"><h4>Blocked by</h4>${reasons}</div>`
    );
    return;
  }

  const target = plan.target || {};
  const environment = plan.environment || { variables: [], redactedEnvFile: '' };
  const reverseProxy = plan.reverseProxy;
  const rollback = plan.rollback;
  const warnings = plan.warnings.length > 0
    ? `<div class="deployment-plan-section warning"><h4>Warnings</h4>${renderList(plan.warnings)}</div>`
    : '';

  vpsDeploymentPlan.innerHTML = (
    '<div class="deployment-plan-header">' +
      '<div>' +
        '<h3>VPS deployment plan</h3>' +
      '<p>Review the plan, run the read-only SSH/prerequisite preflight, then use explicit approval before runtime installation, checkout, credential, or container changes.</p>' +
      '</div>' +
      '<span class="deployment-plan-badge ready">Ready</span>' +
    '</div>' +
    renderDeploymentActions(plan) +
    renderPreflightResult(vpsPreflightResult) +
    renderDeploymentRunResult(vpsDeploymentResult) +
    warnings +
    '<div class="deployment-plan-grid">' +
      `<div><span>Source</span><strong>${escapeHtml(target.repositoryUrl || '')} @ ${escapeHtml(target.repositoryRef || '')}</strong></div>` +
      `<div><span>SSH target</span><strong>${escapeHtml(target.sshTarget || '')}</strong></div>` +
      `<div><span>Deploy path</span><strong>${escapeHtml(target.deployPath || '')}</strong></div>` +
      `<div><span>Env file</span><strong>${escapeHtml(target.envFilePath || '')}</strong></div>` +
      `<div><span>Permissions</span><strong>${escapeHtml(target.envFilePermissions || '')}</strong></div>` +
    '</div>' +
    '<div class="deployment-plan-section">' +
      '<h4>Environment shape</h4>' +
      `<div class="deployment-env-vars">${environment.variables.map(renderEnvVar).join('')}</div>` +
      `<pre>${escapeHtml(environment.redactedEnvFile)}</pre>` +
    '</div>' +
    '<div class="deployment-plan-section">' +
      '<h4>Service layout</h4>' +
      `${renderPlanRows(plan.serviceLayout.map(service => [service.name, `${service.role} (${service.exposure}; ${service.endpoint})`]))}` +
    '</div>' +
    '<div class="deployment-plan-section">' +
      '<h4>Caddy/reverse proxy</h4>' +
      `${reverseProxy ? renderPlanRows([
        ['Caddyfile', reverseProxy.filePath],
        ['Public ports', reverseProxy.publicPorts.join(', ')],
        ['Upstream', reverseProxy.upstream],
      ]) + renderList(reverseProxy.outline) : ''}` +
    '</div>' +
    '<div class="deployment-plan-section">' +
      '<h4>Service commands</h4>' +
      `${renderCommands(plan.commands)}` +
    '</div>' +
    '<div class="deployment-plan-section">' +
      '<h4>Approval gates</h4>' +
      `${renderPlanRows(plan.approvalGates.map(gate => [gate.label, `${gate.detail} Required before: ${gate.requiredBefore}`]))}` +
    '</div>' +
    '<div class="deployment-plan-section">' +
      '<h4>Rollback</h4>' +
      `<p>${escapeHtml(rollback?.summary || '')}</p>` +
      `${rollback ? renderCommands(rollback.commands) + renderList(rollback.notes) : ''}` +
    '</div>'
  );
}

function renderVpsHealthVerification(verification, isVpsStatus) {
  if (!vpsHealthVerification) return;

  if (!isVpsStatus || !verification) {
    vpsHealthVerification.classList.add('hidden');
    vpsHealthVerification.innerHTML = '';
    return;
  }

  vpsHealthVerification.classList.remove('hidden');
  const status = verification.status || 'pending';
  const blockedReasons = verification.blockedReasons || [];
  const checks = verification.checks || [];
  const badgeClass = getVpsHealthBadgeClass(status);
  const summary = status === 'pass'
    ? 'VPS health proof is complete.'
    : status === 'fail'
      ? 'VPS health proof has failures to fix.'
      : status === 'running'
        ? 'VPS health proof is running.'
        : status === 'manual'
          ? 'VPS health proof needs manual provider confirmation.'
          : status === 'blocked'
            ? 'Finish VPS deployment readiness before health proof can run.'
            : 'VPS health proof has not run yet.';

  const blockedSection = blockedReasons.length > 0
    ? `<div class="deployment-plan-section warning"><h4>Blocked by</h4>${renderList(blockedReasons)}</div>`
    : '';
  const checksSection = checks.length > 0
    ? `<div class="deployment-plan-section vps-health-checks"><h4>Health checks</h4>${checks.map(renderVpsHealthCheck).join('')}</div>`
    : '<div class="deployment-plan-section"><p>No health checks returned.</p></div>';

  vpsHealthVerification.innerHTML = (
    '<div class="deployment-plan-header">' +
      '<div>' +
        '<h3>VPS health verification</h3>' +
        `<p>${escapeHtml(summary)}</p>` +
      '</div>' +
      `<span class="deployment-plan-badge ${escapeHtml(badgeClass)}">${escapeHtml(formatVpsHealthStatus(status))}</span>` +
    '</div>' +
    blockedSection +
    checksSection
  );
}

function renderVpsHealthCheck(check) {
  const status = check.status || 'pending';
  const diagnostics = Object.entries(check.diagnostics || {})
    .filter(([, value]) => value !== undefined && value !== null && String(value).length > 0)
    .map(([label, value]) => [formatDiagnosticLabel(label), String(value)]);
  const diagnosticRows = diagnostics.length > 0
    ? `<div class="vps-health-diagnostics">${renderPlanRows(diagnostics)}</div>`
    : '';
  const manual = check.manualAction ? '<span class="manual-action">Manual confirmation</span>' : '';

  return (
    `<div class="vps-health-check ${escapeHtml(status)}">` +
      '<div class="vps-health-check-header">' +
        `<span class="deployment-plan-badge ${escapeHtml(getVpsHealthBadgeClass(status))}">${escapeHtml(formatVpsHealthStatus(status))}</span>` +
        `<strong>${escapeHtml(check.label || check.id || 'Health check')}</strong>` +
      '</div>' +
      `<p><strong>${escapeHtml(check.summary || '')}</strong></p>` +
      `<p>${escapeHtml(check.detail || '')}</p>` +
      manual +
      diagnosticRows +
    '</div>'
  );
}

function getVpsHealthBadgeClass(status) {
  if (status === 'pass') return 'ready';
  if (status === 'fail' || status === 'blocked') return 'blocked';
  return status;
}

function formatVpsHealthStatus(status) {
  const labels = {
    blocked: 'Blocked',
    fail: 'Fix',
    manual: 'Manual',
    pass: 'Ready',
    pending: 'Waiting',
    running: 'Checking',
  };
  return labels[status] || status;
}

function formatCompletionStatus(status) {
  const labels = {
    blocked: 'Blocked',
    complete: 'Complete',
    incomplete: 'In progress',
  };
  return labels[status] || status;
}

function renderDeploymentActions(plan) {
  const disabled = isVpsDeploymentActionRunning || !plan.canApprove;
  const disabledAttr = disabled ? ' disabled' : '';
  const preflightLabel = isVpsDeploymentActionRunning ? 'Running...' : 'Run SSH Preflight';
  const dryRunLabel = isVpsDeploymentActionRunning ? 'Running...' : 'Dry Run';
  const liveLabel = isVpsDeploymentActionRunning ? 'Running...' : 'Run Deployment';

  return (
    '<div class="deployment-plan-actions">' +
      `<button class="btn btn-small btn-secondary" type="button" data-vps-deploy-action="preflight"${disabledAttr}>${escapeHtml(preflightLabel)}</button>` +
      `<button class="btn btn-small btn-secondary" type="button" data-vps-deploy-action="dry-run"${disabledAttr}>${escapeHtml(dryRunLabel)}</button>` +
      `<button class="btn btn-small btn-danger" type="button" data-vps-deploy-action="run-live"${disabledAttr}>${escapeHtml(liveLabel)}</button>` +
      '<label class="deployment-rollback-sha"><span>Last-good commit SHA</span><input type="text" data-vps-last-good-commit maxlength="40" pattern="[0-9a-fA-F]{40}" placeholder="40 hexadecimal characters" autocomplete="off"></label>' +
      `<button class="btn btn-small btn-danger" type="button" data-vps-deploy-action="rollback"${disabledAttr}>Run approved rollback</button>` +
    '</div>'
  );
}

function renderPreflightResult(result) {
  if (!result) return '';
  const lines = [
    ...((result.blockedReasons || []).map(reason => ['Blocked', reason])),
    ...((result.warnings || []).map(warning => ['Warning', warning])),
    ...((result.logs || []).map(log => [log.message, log.detail || log.code])),
  ];

  return renderRunResultPanel('SSH preflight', result.state, lines, result.command?.redactedDisplay);
}

function renderDeploymentRunResult(result) {
  if (!result) return '';
  const commandLines = (result.commandStates || []).map(command => [
    command.commandId,
    `${command.status}${command.detail ? ` — ${command.detail}` : ''}`,
  ]);
  const logLines = (result.logs || []).map(log => [log.message, log.detail || log.code]);
  const blockedLines = (result.manualBlockReasons || []).map(reason => ['Manual block', reason]);
  const recoveryLines = result.recovery
    ? [['Recovery action', `${result.recovery.action}: ${result.recovery.detail}`]]
    : [];

  return renderRunResultPanel('Deployment run', result.state, [
    ...blockedLines,
    ...commandLines,
    ...logLines,
    ...recoveryLines,
  ]);
}

function renderRunResultPanel(title, state, rows, commandDisplay) {
  const stateClass = ['success', 'dry-run'].includes(state) ? 'success'
    : ['blocked', 'manual-blocked', 'failure'].includes(state) ? 'blocked'
      : 'ready';
  const command = commandDisplay
    ? `<code>${escapeHtml(commandDisplay)}</code>`
    : '';
  const contentRows = rows.length > 0
    ? renderPlanRows(rows)
    : '<p>No result details returned.</p>';

  return (
    `<div class="deployment-run-result ${escapeHtml(stateClass)}">` +
      '<div class="deployment-run-result-header">' +
        `<h4>${escapeHtml(title)}</h4>` +
        `<span>${escapeHtml(state)}</span>` +
      '</div>' +
      command +
      contentRows +
    '</div>'
  );
}

function getApprovedDeploymentCommandIds(plan) {
  return (plan?.commands || [])
    .filter(command => command.approvalRequired)
    .map(command => command.id);
}

function renderList(items) {
  return `<ul>${items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

function renderPlanRows(rows) {
  return rows.map(([label, value]) => (
    '<div class="deployment-plan-row">' +
      `<span>${escapeHtml(label)}</span>` +
      `<strong>${escapeHtml(value)}</strong>` +
    '</div>'
  )).join('');
}

function renderEnvVar(variable) {
  const secret = variable.secret ? '<span class="deployment-secret">secret</span>' : '';
  const required = variable.required ? '<span class="deployment-required">required</span>' : '';
  return (
    '<div class="deployment-env-var">' +
      `<span>${escapeHtml(variable.name)}</span>` +
      `<strong>${escapeHtml(variable.value)}</strong>` +
      `<em>${secret}${required}</em>` +
    '</div>'
  );
}

function renderCommands(commands) {
  return commands.map((command) => {
    const approval = command.approvalRequired ? 'approval required' : 'read-only';
    const display = command.redactedDisplay || command.redactedArgs?.join(' ') || command.command;
    return (
      '<div class="deployment-command">' +
        '<div>' +
          `<strong>${escapeHtml(command.label)}</strong>` +
          `<span>${escapeHtml(approval)}</span>` +
        '</div>' +
        `<code>${escapeHtml(display)}</code>` +
      '</div>'
    );
  }).join('');
}

function formatDiagnosticLabel(label) {
  const labels = {
    operatorDashboardUrl: 'Dashboard URL',
    publicCallbackBaseUrl: 'Callback base',
    authCallbackUrl: 'Discord/Supabase callback',
    paypalWebhookUrl: 'PayPal webhook',
  };
  return labels[label] || label;
}

function formatStepStatus(status) {
  const labels = {
    pending: 'Waiting',
    loading: 'Checking',
    success: 'Ready',
    blocked: 'Manual',
    'recoverable-error': 'Fix',
  };
  return labels[status] || status;
}

/* ================================================================== */
/*  Automated Setup & Start                                            */
/* ================================================================== */

btnStart.addEventListener('click', async () => {
  if (isValidating || isRunning) return;

  const config = collectConfig();
  for (const key of Object.keys(config)) {
    if (typeof config[key] === 'string') {
      config[key] = config[key].trim();
    }
  }

  hideMessage();
  hideMeta();

  const currentSetup = await refreshSetupStatus();

  // Quick local check for required fields. A Supabase Personal Access Token
  // (`sbp_…`) is the single bootstrap input; project URL/API keys hydrate in
  // the main process. Existing key fields remain a supported manual fallback.
  const required = ['discordToken', 'discordApplicationId', 'discordClientSecret'];
  const supabaseTokenReady = config.supabaseAccessToken?.trim();
  const supabaseKeysReady = ['supabaseUrl', 'supabaseSecretKey', 'supabasePublishableKey']
    .every((key) => config[key]);
  if (!supabaseTokenReady && !supabaseKeysReady) {
    required.push('supabaseAccessToken');
  }
  const missing = required.filter((k) => !config[k]);
  if (!currentSetup?.primaryAction.enabled) {
    const blockedReason = currentSetup?.primaryAction.blockedReason || '';
    if (missing.length > 0 && /credential/i.test(blockedReason)) {
      for (const k of missing) fields[k].classList.add('error');
      showMessage('error', `Fill in all required fields: ${missing.map(fieldLabel).join(', ')}`);
    } else {
      showMessage('error', blockedReason || 'Finish the runtime setup steps before starting setup.');
    }
    await refreshSetupStatus();
    return;
  }

  if (missing.length > 0) {
    for (const k of missing) fields[k].classList.add('error');
    showMessage('error', `Fill in all required fields: ${missing.map(fieldLabel).join(', ')}`);
    await refreshSetupStatus();
    return;
  }

  // Check network before validating (Phase 6)
  if (!navigator.onLine) {
    showMessage('error', 'No internet connection. Credential validation requires network access.');
    await refreshSetupStatus();
    return;
  }

  for (const input of Object.values(fields)) {
    if (input) input.classList.remove('error', 'valid');
  }

  isValidating = true;
  btnStart.innerHTML = '<span class="spinner"></span>Setting up...';
  btnStart.classList.add('loading');
  setFieldsDisabled(true);

  try {
    latestProviderValidation = null;
    const result = await window.somnibot.runSetupAutomation(config);

    if (result.providerValidation) {
      latestProviderValidation = result.providerValidation;
    }

    if (result.meta) {
      showMeta(result.meta);
    }

    if (result.publicCallbackBaseUrl) {
      applyTailscalePublicCallbackBaseUrl(result.publicCallbackBaseUrl);
    }
    if (result.callbackProbe) {
      latestCallbackProbe = result.callbackProbe;
    }

    applyPayPalWebhookResult(result.paypalWebhook);

    if (!result.ok) {
      showMessage('error', result.error || result.message || 'Setup did not complete.');
      btnStart.classList.remove('loading');
      if (result.servicesStarted) {
        isRunning = true;
        btnStart.classList.add('hidden');
        btnStop.classList.remove('hidden');
        btnOpenDashboard.disabled = false;
      } else {
        setFieldsDisabled(false);
      }
      isValidating = false;
      if (result.servicesStarted) {
        setTailscaleActionsDisabled(true);
      }
      await refreshSetupStatus();
      return;
    }

    for (const input of Object.values(fields)) {
      if (input && input.type !== 'checkbox') input.classList.add('valid');
    }

    isRunning = true;
    isValidating = false;
    btnStart.classList.add('hidden');
    btnStop.classList.remove('hidden');
    btnOpenDashboard.disabled = false;
    setTailscaleActionsDisabled(true);
    await refreshSetupStatus();
    const summary = setupStatus?.summary;
    const dashboardText = summary?.localDashboardUrl || 'the local dashboard';
    const callbackText = summary?.publicCallbackUrl || 'the public callback URL';
    const warningText = Array.isArray(result.warnings) && result.warnings.length > 0
      ? ` ${result.warnings.join(' ')}`
      : '';
    showMessage('success', `${result.message || 'Setup complete.'} Local dashboard URL: ${dashboardText}. Public callback URL: ${callbackText}.${warningText}`);

  } catch (err) {
    showMessage('error', `Unexpected error: ${err.message || err}`);
    btnStart.classList.remove('loading');
    setFieldsDisabled(false);
    isValidating = false;
    await refreshSetupStatus();
  }
});

vpsDeploymentPlan?.addEventListener('click', async (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const button = target?.closest('[data-vps-deploy-action]');
  if (!button || isVpsDeploymentActionRunning) return;

  const action = button.dataset.vpsDeployAction;
  isVpsDeploymentActionRunning = true;
  setFieldsDisabled(true);
  hideMessage();

  try {
    await saveConfig();
    const currentSetup = await refreshSetupStatus();
    const plan = currentSetup?.deploymentPlan;
    if (!plan || plan.status !== 'ready') {
      showMessage('error', 'Finish the VPS deployment plan before running preflight or deployment actions.');
      return;
    }
    const actionPlanKey = getVpsDeploymentPlanKey(plan);
    renderDeploymentPlan(plan, true);

    if (action === 'rollback') {
      const commitInput = vpsDeploymentPlan.querySelector('[data-vps-last-good-commit]');
      const lastGoodCommit = commitInput?.value?.trim() || '';
      vpsDeploymentResult = await window.somnibot.runVpsRollback({ lastGoodCommit });
      vpsActionResultPlanKey = actionPlanKey;
      const ok = vpsDeploymentResult.state === 'success';
      showMessage(ok ? 'success' : 'error', ok ? 'VPS rollback completed.' : 'VPS rollback did not complete.');
      return;
    }

    if (action === 'preflight') {
      vpsPreflightResult = await window.somnibot.runVpsPreflight();
      vpsActionResultPlanKey = actionPlanKey;
      showMessage(
        vpsPreflightResult.state === 'success' ? 'success' : 'error',
        vpsPreflightResult.state === 'success'
          ? 'Read-only SSH/prerequisite preflight passed.'
          : 'Read-only SSH/prerequisite preflight needs attention.',
      );
      return;
    }

    const dryRun = action !== 'run-live';
    if (!dryRun) {
      latestVpsHealthProof = null;
    }
    vpsDeploymentResult = await window.somnibot.runVpsDeployment({
      operatorApproved: true,
      approvedCommandIds: getApprovedDeploymentCommandIds(plan),
      dryRun,
    });
    if (!dryRun) {
      latestVpsHealthProof = vpsDeploymentResult.healthProof
        ? { ...vpsDeploymentResult.healthProof }
        : null;
    }
    vpsActionResultPlanKey = actionPlanKey;
    const ok = ['success', 'dry-run'].includes(vpsDeploymentResult.state);
    showMessage(
      ok ? 'success' : 'error',
      dryRun
        ? 'Deployment dry run completed. No live SSH or remote changes were made.'
        : ok
          ? 'VPS deployment completed.'
          : 'VPS deployment did not complete.',
    );
  } catch (err) {
    showMessage('error', `VPS action failed: ${err.message || err}`);
  } finally {
    isVpsDeploymentActionRunning = false;
    setFieldsDisabled(false);
    await refreshSetupStatus();
  }
});

/* ================================================================== */
/*  Stop                                                               */
/* ================================================================== */

btnStop.addEventListener('click', async () => {
  try {
    await window.somnibot.stopBot();
  } catch (err) {
    console.error('Failed to stop:', err);
  }

  isRunning = false;
  btnStop.classList.add('hidden');
  btnStart.classList.remove('hidden');
  btnStart.textContent = setupStatus?.primaryAction?.label || 'Set Up & Start';
  btnStart.classList.remove('loading');
  btnOpenDashboard.disabled = true;
  setFieldsDisabled(false);
  hideMessage();
  refreshSetupStatus();
});

/* ================================================================== */
/*  Dashboard button                                                   */
/* ================================================================== */

btnOpenDashboard.addEventListener('click', () => {
  window.somnibot.openDashboard();
});

/* ================================================================== */
/*  External links                                                     */
/* ================================================================== */

btnOpenDiscord.addEventListener('click', () => {
  window.somnibot.openExternal('https://discord.com/developers/applications');
});

btnOpenDiscordInvite.addEventListener('click', () => {
  const inviteState = getDiscordInviteState();
  if (!inviteState.url) {
    showMessage('error', inviteState.error || 'Enter a valid Discord Application ID before opening the bot invite.');
    return;
  }
  window.somnibot.openExternal(inviteState.url);
});

btnVerifyDiscord.addEventListener('click', async () => {
  if (isValidating || isRunning) return;

  if (!isCredentialFormComplete()) {
    showMessage('error', 'Fill the required Discord and Supabase fields before verifying the saved connection.');
    updateDiscordVerifyButton();
    return;
  }

  isValidating = true;
  btnVerifyDiscord.disabled = true;
  btnVerifyDiscord.textContent = 'Verifying...';
  hideMessage();

  try {
    const result = await window.somnibot.validateCredentials(collectCredentialConfig());
    latestProviderValidation = result;
    if (result.valid) {
      showMessage('success', 'Saved Discord and Supabase connections verified.');
    } else {
      const detail = result.errors?.filter(Boolean).join(' ') || 'Provider verification failed.';
      showMessage('error', detail);
    }
  } catch (err) {
    showMessage('error', `Saved connection verification failed: ${err.message || err}`);
  } finally {
    isValidating = false;
    btnVerifyDiscord.textContent = 'Verify Saved Connection';
    updateDiscordVerifyButton();
    await refreshSetupStatus();
  }
});

runtimeSteps.addEventListener('click', (event) => {
  const button = event.target.closest('[data-setup-action]');
  if (!button || button.disabled) return;

  if (button.dataset.setupAction === 'discord-invite') {
    const inviteState = getDiscordInviteState();
    if (!inviteState.url) {
      showMessage('error', inviteState.error || 'Enter a valid Discord Application ID before opening the bot invite.');
      return;
    }
    window.somnibot.openExternal(inviteState.url);
  }
});

btnOpenSupabase.addEventListener('click', () => {
  window.somnibot.openExternal('https://supabase.com/dashboard');
});

function setSupabaseProjectStatus(text, type = '') {
  supabaseProjectStatus.textContent = text;
  supabaseProjectStatus.className = `field-help${type ? ` ${type}` : ''}`;
}

function renderSupabaseProjectOptions(projects) {
  supabaseProjects = Array.isArray(projects) ? projects : [];
  supabaseProjectSelect.replaceChildren();

  for (const project of supabaseProjects) {
    const option = document.createElement('option');
    option.value = project.ref;
    const details = [project.region, project.status].filter(Boolean).join(' · ');
    option.textContent = details ? `${project.name} (${project.ref}) — ${details}` : `${project.name} (${project.ref})`;
    supabaseProjectSelect.appendChild(option);
  }

  const currentRef = (() => {
    try {
      const hostname = new URL(fields.supabaseUrl.value.trim()).hostname;
      return hostname.endsWith('.supabase.co') ? hostname.slice(0, -'.supabase.co'.length) : '';
    } catch {
      return '';
    }
  })();
  if (currentRef && supabaseProjects.some((project) => project.ref === currentRef)) {
    supabaseProjectSelect.value = currentRef;
  }
  supabaseProjectPicker.classList.toggle('hidden', supabaseProjects.length === 0);
}

btnDiscoverSupabase.addEventListener('click', async () => {
  if (isSupabaseDiscoveryRunning) return;
  isSupabaseDiscoveryRunning = true;
  btnDiscoverSupabase.disabled = true;
  btnDiscoverSupabase.textContent = 'Discovering...';
  setSupabaseProjectStatus('Listing projects visible to the saved Management API token.');
  hideMessage();

  try {
    // Persist and consume the currently entered PAT in one main-process
    // operation so discovery can never race with autosave or use stale state.
    const result = await window.somnibot.discoverSupabaseProjects(
      fields.supabaseAccessToken.value,
    );
    if (!result.ok) {
      supabaseProjectPicker.classList.add('hidden');
      setSupabaseProjectStatus(result.error || 'Could not discover Supabase projects.', 'error');
      showMessage('error', result.error || 'Could not discover Supabase projects.');
      return;
    }
    renderSupabaseProjectOptions(result.projects || []);
    if (!result.projects?.length) {
      setSupabaseProjectStatus('No Supabase projects were returned for this token.', 'error');
      showMessage('error', 'No Supabase projects were returned for this token.');
      return;
    }
    setSupabaseProjectStatus(`${result.projects.length} project${result.projects.length === 1 ? '' : 's'} found. Select the project SomniBot should use.`);
  } catch (err) {
    supabaseProjectPicker.classList.add('hidden');
    setSupabaseProjectStatus(`Project discovery failed: ${err.message || err}`, 'error');
    showMessage('error', `Project discovery failed: ${err.message || err}`);
  } finally {
    isSupabaseDiscoveryRunning = false;
    btnDiscoverSupabase.disabled = false;
    btnDiscoverSupabase.textContent = 'Discover Supabase Projects';
  }
});

btnSelectSupabaseProject.addEventListener('click', async () => {
  const ref = supabaseProjectSelect.value.trim();
  if (!ref) {
    setSupabaseProjectStatus('Choose a Supabase project first.', 'error');
    return;
  }

  btnSelectSupabaseProject.disabled = true;
  btnSelectSupabaseProject.textContent = 'Loading...';
  setSupabaseProjectStatus('Loading the selected project credentials into the launcher.');
  hideMessage();

  try {
    const result = await window.somnibot.selectSupabaseProject(ref);
    if (!result.ok || !result.project) {
      setSupabaseProjectStatus(result.error || 'Could not select that Supabase project.', 'error');
      showMessage('error', result.error || 'Could not select that Supabase project.');
      return;
    }

    // The main process never returns key material. Refreshing the masked
    // config keeps the existing safe renderer contract while the readiness
    // flags let us clear stale values when a project lacks a key.
    applyConfigToForm(await window.somnibot.getConfig());
    fields.supabaseUrl.value = result.project.url;
    if (!result.secretKeyReady) fields.supabaseSecretKey.value = '';
    if (!result.publishableKeyReady) fields.supabasePublishableKey.value = '';
    await saveConfig();
    await refreshSetupStatus();

    const readiness = [
      result.secretKeyReady ? 'secret key loaded' : 'secret key not available',
      result.publishableKeyReady ? 'publishable key loaded' : 'publishable key not available',
      result.databasePasswordReady ? 'database password generated and saved' : 'database password still needed for VPS/direct migrations',
    ].join('; ');
    setSupabaseProjectStatus(`${result.project.name} selected (${result.project.ref}); ${readiness}.`);
    showMessage(
      result.databasePasswordGenerationError ? 'info' : 'success',
      result.databasePasswordGenerationError
        ? `Supabase project selected: ${result.project.name} (${result.project.ref}). The database password was not generated automatically: ${result.databasePasswordGenerationError}`
        : `Supabase project selected: ${result.project.name} (${result.project.ref}).`,
    );
  } catch (err) {
    setSupabaseProjectStatus(`Project selection failed: ${err.message || err}`, 'error');
    showMessage('error', `Project selection failed: ${err.message || err}`);
  } finally {
    btnSelectSupabaseProject.disabled = false;
    btnSelectSupabaseProject.textContent = 'Use Selected Project';
  }
});

btnGenerateSupabaseDbPassword.addEventListener('click', async () => {
  btnGenerateSupabaseDbPassword.disabled = true;
  btnGenerateSupabaseDbPassword.textContent = 'Generating...';
  supabaseDbPasswordStatus.textContent = 'Waiting for confirmation, then updating Supabase and saving the new password.';
  hideMessage();

  try {
    const result = await window.somnibot.generateSupabaseDatabasePassword();
    if (result.canceled) {
      supabaseDbPasswordStatus.textContent = 'Password generation canceled.';
      return;
    }
    if (!result.ok) {
      supabaseDbPasswordStatus.textContent = result.error || 'Could not generate a Supabase database password.';
      showMessage('error', result.error || 'Could not generate a Supabase database password.');
      return;
    }

    applyConfigToForm(await window.somnibot.getConfig());
    await refreshSetupStatus();
    supabaseDbPasswordStatus.textContent = 'A new database password was generated and saved. Restart or redeploy any direct Postgres installation.';
    showMessage('success', 'Supabase database password generated and saved to SomniBot.');
  } catch (err) {
    supabaseDbPasswordStatus.textContent = `Password generation failed: ${err.message || err}`;
    showMessage('error', `Password generation failed: ${err.message || err}`);
  } finally {
    btnGenerateSupabaseDbPassword.disabled = false;
    btnGenerateSupabaseDbPassword.textContent = 'Generate database password';
  }
});

btnSetupPayPalWebhook.addEventListener('click', async () => {
  if (isPayPalWebhookRunning) return;

  const actionState = getPayPalWebhookActionState();
  if (!actionState.enabled) {
    showMessage('error', actionState.title);
    return;
  }

  isPayPalWebhookRunning = true;
  btnSetupPayPalWebhook.disabled = true;
  btnSetupPayPalWebhook.textContent = 'Configuring...';
  hideMessage();

  try {
    await saveConfig();
    const result = await window.somnibot.ensurePayPalWebhook(collectConfig());
    applyPayPalWebhookResult(result);
    if (!result.ok) {
      showMessage('error', result.error || result.message || 'PayPal webhook setup failed.');
      return;
    }

    const restartText = result.servicesRestarted
      ? ' Local services were restarted to load the new Webhook ID.'
      : '';
    showMessage('success', `${result.message} Webhook URL: ${result.webhookUrl}.${restartText}`);
    await refreshSetupStatus();
  } catch (err) {
    showMessage('error', `PayPal webhook setup failed: ${err.message || err}`);
  } finally {
    isPayPalWebhookRunning = false;
    btnSetupPayPalWebhook.textContent = 'Create/Update Webhook';
    await refreshProcessStatus();
    updatePayPalWebhookButton();
  }
});

btnHelp.addEventListener('click', () => {
  window.somnibot.openExternal('https://github.com/HeyImDionysus/somnibot#readme');
});

btnLavalinkHelp.addEventListener('click', () => {
  window.somnibot.openExternal('https://lavalink.dev/getting-started/');
});

/* ================================================================== */
/*  Show/hide password fields                                          */
/* ================================================================== */

document.querySelectorAll('.toggle-vis').forEach((btn) => {
  btn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const target = document.getElementById(btn.dataset.target);
    if (target && target.dataset.savedSecret !== 'true') {
      const isPassword = target.type === 'password';
      target.type = isPassword ? 'text' : 'password';
      btn.textContent = isPassword ? '🔒' : '👁';
      btn.setAttribute('aria-pressed', String(isPassword));
    }
  });
});

function visibilityButtonFor(input) {
  return document.querySelector(`.toggle-vis[data-target="${input.id}"]`);
}

function markSavedSecret(input) {
  input.dataset.savedSecret = 'true';
  input.classList.add('has-saved-secret');
  input.type = 'password';
  const btn = visibilityButtonFor(input);
  if (btn) {
    btn.disabled = true;
    btn.classList.add('saved');
    btn.textContent = 'Saved';
    btn.title = 'Saved securely. Enter a replacement to change it.';
    btn.setAttribute('aria-label', `${input.id} is saved securely`);
    btn.setAttribute('aria-pressed', 'false');
  }
}

function clearSavedSecretState(input) {
  delete input.dataset.savedSecret;
  input.classList.remove('has-saved-secret');
  const btn = visibilityButtonFor(input);
  if (btn) {
    btn.disabled = false;
    btn.classList.remove('saved');
    btn.textContent = '👁';
    btn.title = 'Show/hide';
    btn.setAttribute('aria-label', `Show or hide ${input.id}`);
    btn.setAttribute('aria-pressed', 'false');
  }
}

for (const input of Object.values(fields)) {
  if (!input || input.type === 'checkbox') continue;
  input.addEventListener('focus', () => {
    if (input.dataset.savedSecret !== 'true') return;
    input.value = '';
    input.placeholder = 'Saved securely — type to replace';
  });
  input.addEventListener('blur', () => {
    if (input.dataset.savedSecret !== 'true' || input.value) return;
    input.value = MASKED_SECRET;
  });
}

/* ================================================================== */
/*  Log panel                                                          */
/* ================================================================== */

btnToggleLogs.addEventListener('click', () => {
  logPanel.classList.toggle('hidden');
});

btnCloseLogs.addEventListener('click', () => {
  logPanel.classList.add('hidden');
});

function appendLog(source, type, line) {
  const el = document.createElement('div');
  el.className = `log-line ${source} ${type}`;
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  el.textContent = `[${ts}] [${source}] ${line}`;
  logContent.appendChild(el);

  const isNearBottom = logContent.scrollHeight - logContent.scrollTop - logContent.clientHeight < 60;
  if (isNearBottom) {
    logContent.scrollTop = logContent.scrollHeight;
  }

  while (logContent.children.length > 500) {
    logContent.removeChild(logContent.firstChild);
  }
}

/* ================================================================== */
/*  Status updates from main process                                   */
/* ================================================================== */

window.somnibot.onStatusUpdate((status) => {
  updateStatusUI(status);
});

window.somnibot.onBotLog((log) => {
  appendLog('bot', log.type, log.line);
});

window.somnibot.onDashboardLog((log) => {
  appendLog('dashboard', log.type, log.line);
});

// Phase 6: Lavalink logs
window.somnibot.onLavalinkLog((log) => {
  appendLog('lavalink', log.type, log.line);
});

async function refreshProcessStatus() {
  try {
    const status = await window.somnibot.getStatus();
    updateStatusUI(status);
  } catch {
    // Not running
  }
}

function updateStatusUI(status) {
  latestProcessStatus = status;

  // Bot status dot
  botDot.className = 'status-dot';
  if (status.bot) botDot.classList.add(status.bot);

  // Dashboard status dot
  dashDot.className = 'status-dot';
  if (status.dashboard) dashDot.classList.add(status.dashboard);

  // Lavalink status dot (Phase 6)
  if (status.lavalink && status.lavalink !== 'offline') {
    lavalinkStatusItem.style.display = '';
    lavalinkDot.className = 'status-dot';
    lavalinkDot.classList.add(status.lavalink);
  }

  // Enable dashboard button when it's online
  if (status.dashboard === 'online') {
    btnOpenDashboard.disabled = false;
  }

  // Show error if any
  if (status.error) {
    showMessage('error', status.error);
  }

  // If both are offline and we thought we were running, reset
  if (
    status.bot === 'offline'
    && status.dashboard === 'offline'
    && isRunning
    && !isValidating
    && !isPayPalWebhookRunning
  ) {
    isRunning = false;
    btnStop.classList.add('hidden');
    btnStart.classList.remove('hidden');
    btnStart.textContent = setupStatus?.primaryAction?.label || 'Set Up & Start';
    btnStart.classList.remove('loading');
    btnOpenDashboard.disabled = true;
    setFieldsDisabled(false);
  }

  refreshSetupStatus();
}

/* ================================================================== */
/*  Phase 6: First-Run Onboarding                                     */
/* ================================================================== */

async function initOnboarding() {
  try {
    const isFirstRun = await window.somnibot.isFirstRun();
    if (!isFirstRun) return;

    onboardingOverlay.classList.remove('hidden');
    renderOnboardingRuntimeStep();

    // Step navigation
    const showStep = (n) => {
      document.querySelectorAll('.onboarding-step').forEach((el) => {
        el.classList.toggle('hidden', parseInt(el.dataset.step) !== n);
      });
      document.querySelectorAll('.onboarding-dots .dot').forEach((dot) => {
        dot.classList.toggle('active', parseInt(dot.dataset.dot) === n);
      });
    };

    $('onboarding-next-1').addEventListener('click', async () => {
      await saveConfig();
      await refreshSetupStatus();
      renderOnboardingRuntimeStep();
      showStep(2);
    });
    $('onboarding-next-2').addEventListener('click', () => showStep(3));

    $('onboarding-open-discord').addEventListener('click', () => {
      window.somnibot.openExternal('https://discord.com/developers/applications');
    });

    $('onboarding-open-supabase').addEventListener('click', () => {
      window.somnibot.openExternal('https://supabase.com/dashboard');
    });

    // Final step → dismiss overlay, focus first field
    $('onboarding-next-3').addEventListener('click', () => {
      dismissOnboarding();
    });

    // Skip button
    $('onboarding-skip').addEventListener('click', () => {
      dismissOnboarding();
    });
  } catch (err) {
    console.error('Onboarding init failed:', err);
  }
}

function dismissOnboarding() {
  onboardingOverlay.classList.add('hidden');
  window.somnibot.completeFirstRun();
  const firstSetupField = runtimeMode === 'vps' ? runtimeFields.vpsDomain : fields.discordToken;
  firstSetupField.focus();
}

function renderOnboardingRuntimeStep() {
  if (!onboardingRuntimeTitle || !onboardingRuntimeDesc || !onboardingRuntimeList) return;

  const isVps = runtimeMode === 'vps';
  onboardingRuntimeTitle.textContent = isVps ? 'Prepare VPS Readiness' : 'Prepare Local Access';
  onboardingRuntimeDesc.textContent = isVps
    ? 'VPS mode needs a domain, SSH target, and guided deployment readiness before credentials can be validated.'
    : 'Regular local mode checks Tailscale, prepares Funnel, and fills the public callback URL for you.';

  const items = isVps
    ? [
      ['Domain', 'Use the HTTPS domain that will serve the dashboard and receive provider callbacks.'],
      ['SSH target', 'Enter host, user, and deploy path on the setup screen. Do not enter private keys or passwords.'],
      ['Guided deploy', 'The launcher can check a fresh target, install the supported runtime, provision or update the GitHub checkout, show the dry-run, and execute the approved deployment with redacted output.'],
    ]
    : [
      ['Tailscale check', 'The launcher detects whether Tailscale is installed, signed in, and allowed to use Funnel.'],
      ['Automatic Funnel', 'If a Tailscale auth key is saved, setup can sign in, enable Funnel, and fill the callback URL.'],
      ['Fallback URL', 'Paste an HTTPS callback URL only when automatic Funnel setup is not available on this machine.'],
    ];

  onboardingRuntimeList.innerHTML = items.map(([title, body], index) => (
    '<div class="onboarding-check-item">' +
      `<span class="check-num">${index + 1}</span>` +
      '<div>' +
        `<strong>${escapeHtml(title)}</strong>` +
        `<p>${escapeHtml(body)}</p>` +
      '</div>' +
    '</div>'
  )).join('');
}

/* ================================================================== */
/*  Tailscale Public Callback                                          */
/* ================================================================== */

btnTailscaleCheck.addEventListener('click', async () => {
  if (runtimeMode !== 'regular-local' || isValidating || isRunning) return;
  await refreshTailscaleReadiness({ quiet: false });
});

btnTailscaleEnable.addEventListener('click', async () => {
  if (runtimeMode !== 'regular-local' || isValidating || isRunning) return;
  tailscaleReadinessSeq += 1;
  btnTailscaleEnable.disabled = true;
  btnTailscaleEnable.textContent = 'Enabling...';
  renderTailscaleBusy('Signing in and enabling Funnel...');

  try {
    await saveConfig();
    const readiness = await window.somnibot.enableTailscaleFunnel();
    renderTailscaleReadiness(readiness);
    if (readiness.publicCallbackBaseUrl) {
      applyTailscalePublicCallbackBaseUrl(readiness.publicCallbackBaseUrl);
      showMessage('info', 'Tailscale Funnel is configured. Public DNS can take a few minutes before verification succeeds.');
    }
  } catch (err) {
    renderTailscaleError(`Tailscale Funnel failed: ${err.message || err}`);
  } finally {
    btnTailscaleEnable.disabled = false;
    btnTailscaleEnable.textContent = 'Enable Funnel';
  }
});

btnTailscaleProbe.addEventListener('click', async () => {
  if (runtimeMode !== 'regular-local' || isValidating) return;
  tailscaleReadinessSeq += 1;
  const url = runtimeFields.publicCallbackBaseUrl.value.trim() || tailscalePublicCallbackBaseUrl || tailscaleUrl.textContent.trim();
  if (!url) {
    showMessage('error', 'No public callback URL is available yet.');
    return;
  }

  btnTailscaleProbe.disabled = true;
  btnTailscaleProbe.textContent = 'Verifying...';

  try {
    const result = await window.somnibot.probeTailscaleCallback(url);
    latestCallbackProbe = result;
    if (result.ok) {
      tailscaleDot.className = 'status-dot ready';
      tailscaleStatusText.textContent = 'Public callback verified.';
      showMessage('success', 'Public callback is reachable.');
    } else {
      tailscaleDot.className = 'status-dot waiting';
      showMessage('error', result.error || 'Public callback verification failed.');
    }
  } catch (err) {
    renderTailscaleError(`Callback verification failed: ${err.message || err}`);
  } finally {
    btnTailscaleProbe.disabled = false;
    btnTailscaleProbe.textContent = 'Verify Callback';
    await refreshSetupStatus();
  }
});

async function refreshTailscaleReadiness({ quiet }) {
  const seq = ++tailscaleReadinessSeq;
  renderTailscaleBusy('Checking Tailscale...');

  try {
    const readiness = await window.somnibot.getTailscaleReadiness();
    if (seq !== tailscaleReadinessSeq) return;
    renderTailscaleReadiness(readiness);
    if (!quiet && readiness.message) {
      showMessage(readiness.state === 'error' ? 'error' : 'info', readiness.message);
    }
  } catch (err) {
    if (seq !== tailscaleReadinessSeq) return;
    renderTailscaleError(`Tailscale check failed: ${err.message || err}`);
  }
}

function renderTailscaleBusy(text) {
  tailscaleDot.className = 'status-dot starting';
  tailscaleStatusText.textContent = text;
  btnTailscaleEnable.classList.add('hidden');
  btnTailscaleProbe.classList.add('hidden');
  tailscaleNote.classList.add('hidden');
}

function renderTailscaleError(text) {
  tailscaleDot.className = 'status-dot error';
  tailscaleStatusText.textContent = text;
  btnTailscaleEnable.classList.add('hidden');
  btnTailscaleProbe.classList.add('hidden');
  tailscaleNote.classList.add('hidden');
  showMessage('error', text);
}

function renderTailscaleReadiness(readiness) {
  latestTailscaleReadiness = readiness;
  const currentFieldUrl = runtimeFields.publicCallbackBaseUrl.value.trim();
  const publicUrl = readiness.publicCallbackBaseUrl || currentFieldUrl;
  if (readiness.publicCallbackBaseUrl) {
    applyTailscalePublicCallbackBaseUrl(readiness.publicCallbackBaseUrl);
  } else {
    tailscalePublicCallbackBaseUrl = currentFieldUrl;
  }

  tailscaleStatusText.textContent = readiness.message || 'Tailscale status checked.';
  tailscaleDot.className = `status-dot ${tailscaleDotClass(readiness.state)}`;
  tailscaleCommand.textContent = Array.isArray(readiness.commandPreview)
    ? readiness.commandPreview.join(' ')
    : '';

  tailscaleDetails.classList.toggle('hidden', !tailscaleCommand.textContent);
  syncTailscalePublicCallbackAvailability(publicUrl);

  btnTailscaleEnable.classList.toggle('hidden', !['not-configured', 'not-logged-in'].includes(readiness.state));

  const note = tailscaleReadinessNote(readiness);
  tailscaleNote.classList.toggle('hidden', !note);
  tailscaleNote.textContent = note;
  refreshSetupStatus();
}

function syncTailscalePublicCallbackAvailability(publicUrl) {
  tailscaleUrl.classList.toggle('hidden', !publicUrl);
  tailscaleUrl.textContent = publicUrl;
  btnTailscaleProbe.classList.toggle('hidden', !publicUrl);
}

function applyTailscalePublicCallbackBaseUrl(publicUrl) {
  tailscalePublicCallbackBaseUrl = publicUrl;
  syncTailscalePublicCallbackAvailability(publicUrl);
  const callbackField = document.getElementById('publicCallbackBaseUrl');
  if (callbackField && callbackField.value !== publicUrl) {
    callbackField.value = publicUrl;
    callbackField.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

function tailscaleDotClass(state) {
  switch (state) {
    case 'ready':
      return 'ready';
    case 'not-configured':
    case 'needs-dashboard':
      return 'waiting';
    case 'not-installed':
    case 'not-logged-in':
    case 'needs-permission':
    case 'needs-policy':
    case 'unsupported-platform':
      return 'blocked';
    default:
      return 'error';
  }
}

function tailscaleReadinessNote(readiness) {
  switch (readiness.state) {
    case 'not-configured':
      return 'Enabling Funnel may require browser or tailnet policy approval.';
    case 'needs-dashboard':
      return 'Start SomniBot, then verify the callback. Public DNS can take up to 10 minutes after Funnel changes.';
    case 'not-installed':
      return 'Install Tailscale, sign in, then check again.';
    case 'not-logged-in':
      return 'Add a Tailscale auth key, then enable Funnel again.';
    case 'needs-permission':
      return readiness.detail || 'Restart SomniBot with the Windows permission required to read Tailscale, then check again.';
    case 'needs-policy':
      return 'Tailnet policy must allow Funnel before SomniBot can automate this step.';
    case 'unsupported-platform':
      return 'Use a Tailscale install that supports the CLI Funnel feature.';
    case 'error':
      return readiness.detail || '';
    default:
      return '';
  }
}

/* ================================================================== */
/*  Phase 6: Lavalink Management                                       */
/* ================================================================== */

async function initLavalink() {
  try {
    const enabled = await window.somnibot.getLavalinkEnabled();
    lavalinkToggle.checked = enabled;
    if (enabled) {
      lavalinkPanel.classList.remove('hidden');
      lavalinkStatusItem.style.display = '';
      await refreshLavalinkPanel();
    }
  } catch (err) {
    console.error('Lavalink init failed:', err);
  }
}

lavalinkToggle.addEventListener('change', async () => {
  const enabled = lavalinkToggle.checked;
  await window.somnibot.setLavalinkEnabled(enabled);

  if (enabled) {
    lavalinkPanel.classList.remove('hidden');
    lavalinkStatusItem.style.display = '';
    await refreshLavalinkPanel();
  } else {
    lavalinkPanel.classList.add('hidden');
    lavalinkStatusItem.style.display = 'none';
  }
});

async function refreshLavalinkPanel() {
  // Check Java
  const java = await window.somnibot.checkJava();
  if (java.available) {
    lavalinkJavaStatus.className = 'lavalink-info ok';
    lavalinkJavaStatus.innerHTML = `<span class="status-icon">✓</span> Java ${escapeHtml(java.version || 'unknown')} detected`;
  } else {
    lavalinkJavaStatus.className = 'lavalink-info error';
    lavalinkJavaStatus.innerHTML = `<span class="status-icon">✗</span> Java not found — <a href="#" class="java-install-link" style="color:var(--hot-pink)">install Java 17+</a>`;
    const javaLink = lavalinkJavaStatus.querySelector('.java-install-link');
    if (javaLink) {
      javaLink.addEventListener('click', (e) => {
        e.preventDefault();
        window.somnibot.openExternal('https://adoptium.net');
      });
    }
  }

  // Check JAR
  const info = await window.somnibot.getLavalinkInfo();
  if (info.jarPresent) {
    lavalinkJarStatus.className = 'lavalink-info ok';
    lavalinkJarStatus.innerHTML = '<span class="status-icon">✓</span> Lavalink.jar ready';
    lavalinkDownloadRow.classList.add('hidden');
    lavalinkDownloadProgress.classList.add('hidden');
  } else {
    lavalinkJarStatus.className = 'lavalink-info warn';
    lavalinkJarStatus.innerHTML = '<span class="status-icon">⬇</span> Lavalink.jar not found';
    lavalinkDownloadRow.classList.remove('hidden');
  }
}

btnDownloadLavalink.addEventListener('click', async () => {
  btnDownloadLavalink.disabled = true;
  btnDownloadLavalink.textContent = 'Downloading...';
  lavalinkDownloadRow.classList.add('hidden');
  lavalinkDownloadProgress.classList.remove('hidden');

  const result = await window.somnibot.downloadLavalink();

  lavalinkDownloadProgress.classList.add('hidden');
  btnDownloadLavalink.disabled = false;
  btnDownloadLavalink.textContent = 'Download Lavalink';

  if (result.ok) {
    await refreshLavalinkPanel();
  } else {
    lavalinkDownloadRow.classList.remove('hidden');
    showMessage('error', `Lavalink download failed: ${result.error}`);
  }
});

// Lavalink download progress
window.somnibot.onLavalinkDownloadProgress((progress) => {
  lavalinkDownloadProgress.classList.remove('hidden');
  const infoEl = lavalinkDownloadProgress.querySelector('.lavalink-progress-info');
  const barEl = lavalinkDownloadProgress.querySelector('.lavalink-progress-bar');
  if (infoEl) {
    infoEl.textContent = `Downloading... ${progress.percent}%  (${progress.downloadedMB} / ${progress.totalMB} MB)`;
  }
  if (barEl) {
    barEl.style.width = `${progress.percent}%`;
  }
});

// Lavalink status updates
window.somnibot.onLavalinkStatus((info) => {
  if (info.status !== 'offline') {
    lavalinkStatusItem.style.display = '';
    lavalinkDot.className = 'status-dot';
    lavalinkDot.classList.add(info.status);
  }
});

/* ================================================================== */
/*  Phase 6: Network Monitor                                           */
/* ================================================================== */

function initNetworkMonitor() {
  const update = () => {
    offlineBanner.classList.toggle('hidden', navigator.onLine);
  };
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();
}

/* ================================================================== */
/*  Helpers                                                            */
/* ================================================================== */

function showMessage(type, text) {
  messageArea.className = `message-area ${type}`;
  messageArea.textContent = text;
}

function hideMessage() {
  messageArea.className = 'message-area hidden';
  messageArea.textContent = '';
}

function showMeta(meta) {
  metaArea.innerHTML = '';
  metaArea.classList.remove('hidden');

  const items = [];
  if (meta.botUsername) items.push(['Bot', meta.botUsername]);
  if (meta.guildName) items.push(['Server', meta.guildName]);

  for (const [label, value] of items) {
    const el = document.createElement('div');
    el.className = 'meta-item';
    el.innerHTML = `<span class="meta-label">${label}:</span> <span class="meta-value">${escapeHtml(value)}</span>`;
    metaArea.appendChild(el);
  }
}

function hideMeta() {
  metaArea.classList.add('hidden');
  metaArea.innerHTML = '';
}

function setFieldsDisabled(disabled) {
  for (const input of Object.values(fields)) {
    input.disabled = disabled;
  }
  for (const input of Object.values(runtimeFields)) {
    input.disabled = disabled;
  }
  document.querySelectorAll('[data-runtime]').forEach((btn) => {
    btn.disabled = disabled;
  });
  setTailscaleActionsDisabled(disabled);
  updateDiscordVerifyButton();
  updatePayPalWebhookButton();
}

function setTailscaleActionsDisabled(disabled) {
  btnTailscaleCheck.disabled = disabled;
  btnTailscaleEnable.disabled = disabled;
  btnTailscaleProbe.disabled = disabled && !canProbePublicCallbackWhileRunning();
}

function canProbePublicCallbackWhileRunning() {
  return runtimeMode === 'regular-local'
    && isRunning
    && !isValidating;
}

function normalizeDiscordSnowflake(value) {
  const trimmed = value.trim();
  return /^\d{17,20}$/.test(trimmed) ? trimmed : '';
}

function getDiscordInviteState() {
  const applicationId = normalizeDiscordSnowflake(fields.discordApplicationId.value);
  if (!applicationId) {
    return {
      url: '',
      error: 'Enter a valid Discord Application ID before opening the bot invite.',
    };
  }

  const params = new URLSearchParams({
    client_id: applicationId,
    permissions: '8',
    scope: 'bot applications.commands',
  });

  const guildIdInput = fields.discordGuildId.value.trim();
  const guildId = normalizeDiscordSnowflake(guildIdInput);
  if (guildIdInput && !guildId) {
    return {
      url: '',
      error: 'Enter one valid Discord Guild ID, or clear the Guild ID field to choose a server in Discord.',
    };
  }

  if (guildId) {
    params.set('guild_id', guildId);
    params.set('disable_guild_select', 'true');
  }

  return {
    url: `https://discord.com/oauth2/authorize?${params.toString()}`,
    error: '',
  };
}

function buildDiscordInviteUrl() {
  return getDiscordInviteState().url;
}

function updateDiscordInviteButton() {
  const inviteState = getDiscordInviteState();
  btnOpenDiscordInvite.disabled = !inviteState.url;
  btnOpenDiscordInvite.title = inviteState.url
    ? 'Open the Discord bot invite for this Application ID'
    : inviteState.error || 'Enter a valid Discord Application ID first';
}

function updateDiscordVerifyButton() {
  if (!btnVerifyDiscord) return;
  const ready = isCredentialFormComplete();
  btnVerifyDiscord.disabled = !ready || isValidating || isRunning;
  btnVerifyDiscord.title = ready
    ? 'Revalidate the saved Discord and Supabase connections without starting services'
    : 'Fill the required Discord and Supabase fields first';
}

function fieldLabel(key) {
  const labels = {
    discordToken: 'Bot Token',
    discordApplicationId: 'Application ID',
    discordClientSecret: 'Client Secret',
    discordGuildId: 'Guild ID',
    supabaseUrl: 'Supabase URL',
    supabaseSecretKey: 'Secret Key',
    supabasePublishableKey: 'Publishable Key',
    supabaseDbPassword: 'Database Password',
    supabaseAccessToken: 'Management API Token',
    supabaseDiscordAuthProviderConfigured: 'Discord auth provider confirmation',
    paypalClientId: 'PayPal Client ID',
    paypalClientSecret: 'PayPal Client Secret',
    paypalWebhookId: 'PayPal Webhook ID',
    paypalSandbox: 'PayPal sandbox mode',
  };
  return labels[key] || key;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/* ================================================================== */
/*  Cloud Restore                                                      */
/* ================================================================== */

btnImportExistingEnv.addEventListener('click', async () => {
  btnImportExistingEnv.disabled = true;
  btnImportExistingEnv.textContent = 'Importing...';
  hideMessage();
  try {
    const result = await window.somnibot.importExistingEnv();
    if (result.canceled) return;
    if (!result.ok) {
      showMessage('error', result.error || 'SomniBot could not import the selected setup.');
      return;
    }
    applyConfigToForm(await window.somnibot.getConfig());
    await refreshSetupStatus();
    const importedCount = Array.isArray(result.importedFields) ? result.importedFields.length : 0;
    showMessage(
      'success',
      importedCount > 0
        ? `Recovered ${importedCount} missing setup field${importedCount === 1 ? '' : 's'} from the existing SomniBot installation.`
        : 'The launcher already has every connection value found in that SomniBot installation.',
    );
  } catch (err) {
    showMessage('error', `Import failed: ${err.message || err}`);
  } finally {
    btnImportExistingEnv.disabled = false;
    btnImportExistingEnv.textContent = 'Import Existing Setup';
  }
});

function updateRestoreBanner() {
  const hasSupabase = fields.supabaseUrl.value.trim() && fields.supabaseSecretKey.value.trim();
  // Keep recovery available even when Discord is already present: an older or
  // partial local cache may still be missing the DB password or PayPal values.
  restoreBanner.classList.toggle('hidden', !hasSupabase);
}

btnRestoreCloud.addEventListener('click', async () => {
  const url = fields.supabaseUrl.value.trim();
  const key = fields.supabaseSecretKey.value.trim();

  if (!url || !key) {
    showMessage('error', 'Enter your Supabase URL and Secret Key first.');
    return;
  }

  btnRestoreCloud.disabled = true;
  btnRestoreCloud.textContent = 'Restoring...';
  hideMessage();

  try {
    // V5 Audit §10.P3a: Secret stays in main process — no args needed
    const result = await window.somnibot.pullFromSupabase();

    if (!result.ok) {
      showMessage('error', result.error || 'Could not restore credentials from Supabase.');
      return;
    }

    const creds = result.credentials;
    if (creds) {
      for (const [key, value] of Object.entries(creds)) {
        if (!fields[key] || value === '' || value === undefined || value === null) continue;
        if (fields[key].type === 'checkbox') fields[key].checked = Boolean(value);
        else fields[key].value = String(value);
      }
      updateDiscordInviteButton();
      updateRestoreBanner();
      await saveConfig();
      await refreshSetupStatus();
      showMessage('success', 'Credentials restored from Supabase. Review the values and run setup.');
      restoreBanner.classList.add('hidden');
    }
  } catch (err) {
    showMessage('error', `Restore failed: ${err.message || err}`);
  } finally {
    btnRestoreCloud.disabled = false;
    btnRestoreCloud.textContent = 'Restore from Cloud';
  }
});

/* ================================================================== */
/*  Auto-Update Flow                                                   */
/* ================================================================== */

let pendingUpdateVersion = null;
let progressInfoEl = null;
let progressBarEl = null;
let downloadingSetup = false;

btnCheckUpdates.addEventListener('click', () => {
  window.somnibot.checkForUpdates();
});

window.somnibot.onUpdaterChecking(() => {
  showUpdateBanner('checking', 'Checking for updates...');
});

window.somnibot.onUpdateAvailable((info) => {
  pendingUpdateVersion = info.version;
  downloadingSetup = false;
  progressInfoEl = null;
  progressBarEl = null;

  updateBanner.innerHTML = '';
  updateBanner.className = 'update-banner available';

  const text = document.createElement('span');
  text.textContent = `Update available: v${info.version}`;
  updateBanner.appendChild(text);

  const actions = document.createElement('div');
  actions.className = 'update-actions';

  const installBtn = document.createElement('button');
  installBtn.textContent = 'Install now';
  installBtn.addEventListener('click', () => {
    window.somnibot.downloadUpdate();
  });
  actions.appendChild(installBtn);

  const dismissBtn = document.createElement('button');
  dismissBtn.className = 'update-dismiss';
  dismissBtn.textContent = '✕';
  dismissBtn.title = 'Dismiss';
  dismissBtn.addEventListener('click', () => {
    updateBanner.classList.add('hidden');
  });
  actions.appendChild(dismissBtn);

  updateBanner.appendChild(actions);
});

window.somnibot.onUpdateNotAvailable(() => {
  showUpdateBanner('up-to-date', "You're up to date!");
  setTimeout(() => {
    updateBanner.classList.add('hidden');
  }, 4000);
});

window.somnibot.onDownloadProgress((progress) => {
  if (!downloadingSetup) {
    updateBanner.innerHTML = '';
    updateBanner.className = 'update-banner downloading';

    const info = document.createElement('div');
    info.className = 'update-progress-info';
    updateBanner.appendChild(info);
    progressInfoEl = info;

    const track = document.createElement('div');
    track.className = 'update-progress-track';
    const bar = document.createElement('div');
    bar.className = 'update-progress-bar';
    track.appendChild(bar);
    updateBanner.appendChild(track);
    progressBarEl = bar;

    downloadingSetup = true;
  }

  const pct = Math.round(progress.percent);
  const mbTransferred = (progress.transferred / 1_048_576).toFixed(1);
  const mbTotal = (progress.total / 1_048_576).toFixed(1);
  const speed = (progress.bytesPerSecond / 1_048_576).toFixed(1);

  if (progressInfoEl) {
    progressInfoEl.innerHTML =
      `<span>Downloading v${escapeHtml(pendingUpdateVersion || '?')}... ${pct}%</span>` +
      `<span>${mbTransferred}/${mbTotal} MB · ${speed} MB/s</span>`;
  }
  if (progressBarEl) {
    progressBarEl.style.width = `${pct}%`;
  }
});

window.somnibot.onUpdateDownloaded(() => {
  downloadingSetup = false;
  progressInfoEl = null;
  progressBarEl = null;

  updateBanner.innerHTML = '';
  updateBanner.className = 'update-banner downloaded';

  const text = document.createElement('span');
  text.textContent = `v${pendingUpdateVersion || 'New version'} ready — restart to apply.`;
  updateBanner.appendChild(text);

  const btn = document.createElement('button');
  btn.textContent = 'Restart';
  btn.addEventListener('click', () => {
    window.somnibot.installUpdate();
  });
  updateBanner.appendChild(btn);
});

window.somnibot.onUpdateError((info) => {
  downloadingSetup = false;
  progressInfoEl = null;
  progressBarEl = null;

  showUpdateBanner('error', `Update failed: ${info.message}`);
  setTimeout(() => {
    updateBanner.classList.add('hidden');
  }, 8000);
});

function showUpdateBanner(type, message) {
  updateBanner.innerHTML = `<span>${escapeHtml(message)}</span>`;
  updateBanner.className = `update-banner ${type}`;
}

/* ================================================================== */
/*  Boot                                                               */
/* ================================================================== */

init();
