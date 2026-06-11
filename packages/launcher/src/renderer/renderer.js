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

const fields = {
  discordToken: $('discordToken'),
  discordApplicationId: $('discordApplicationId'),
  discordClientSecret: $('discordClientSecret'),
  discordGuildId: $('discordGuildId'),
  supabaseUrl: $('supabaseUrl'),
  supabaseSecretKey: $('supabaseSecretKey'),
  supabasePublishableKey: $('supabasePublishableKey'),
  supabaseDbPassword: $('supabaseDbPassword'),
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
const btnOpenSupabase = $('btn-open-supabase');
const btnCheckUpdates = $('btn-check-updates');

const btnRestoreCloud = $('btn-restore-cloud');
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
const regularRuntimeFields = $('regular-runtime-fields');
const vpsRuntimeFields = $('vps-runtime-fields');
const runtimeSteps = $('runtime-steps');
const summaryLocalDashboard = $('summary-local-dashboard');
const summaryPublicCallback = $('summary-public-callback');
const runtimeDiagnosticsList = $('runtime-diagnostics-list');

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

/* ================================================================== */
/*  State                                                              */
/* ================================================================== */

let isRunning = false;
let isValidating = false;
let runtimeMode = 'regular-local';
let setupStatus = null;
let setupStatusSeq = 0;
let latestProcessStatus = null;

/* ================================================================== */
/*  Init                                                               */
/* ================================================================== */

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
    for (const [key, input] of Object.entries(fields)) {
      if (config[key]) {
        input.value = config[key];
      }
    }
    for (const [key, input] of Object.entries(runtimeFields)) {
      if (config[key]) {
        input.value = config[key];
      }
    }
    setRuntimeMode(config.runtimeMode === 'vps' ? 'vps' : 'regular-local', { save: false });
  } catch (err) {
    console.error('Failed to load config:', err);
  }

  // Check current status (in case app reconnected)
  try {
    const status = await window.somnibot.getStatus();
    updateStatusUI(status);
  } catch {
    // Not running
  }

  // Auto-save on field change (debounced)
  let saveTimeout = null;
  for (const input of Object.values(fields)) {
    input.addEventListener('input', () => {
      clearTimeout(saveTimeout);
      saveTimeout = setTimeout(saveConfig, 500);
      input.classList.remove('error', 'valid');
      updateRestoreBanner();
      refreshSetupStatus();
    });
  }

  for (const input of Object.values(runtimeFields)) {
    input.addEventListener('input', () => {
      clearTimeout(saveTimeout);
      saveTimeout = setTimeout(saveConfig, 500);
      input.classList.remove('error', 'valid');
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
  await refreshSetupStatus();

  // Phase 6: Network status
  initNetworkMonitor();

  // Phase 6: Onboarding
  await initOnboarding();

  // Phase 6: Lavalink
  await initLavalink();
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
    config[key] = input.value;
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
  return [
    'discordToken',
    'discordApplicationId',
    'discordClientSecret',
    'supabaseUrl',
    'supabaseSecretKey',
    'supabasePublishableKey',
  ].every((key) => fields[key].value.trim().length > 0);
}

function setRuntimeMode(mode, options = {}) {
  runtimeMode = mode === 'vps' ? 'vps' : 'regular-local';
  const isVps = runtimeMode === 'vps';

  runtimeModeLabel.textContent = isVps ? 'VPS' : 'Regular local';
  regularRuntimeFields.classList.toggle('hidden', isVps);
  vpsRuntimeFields.classList.toggle('hidden', !isVps);

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
    credentialReady: isCredentialFormComplete(),
    dashboardOnline: latestProcessStatus?.dashboard === 'online',
    checking: Boolean(options.checking),
  };

  if (options.checking) {
    renderSetupStatus({
      runtimeMode,
      summary: setupStatus?.summary ?? {
        runtimeMode,
        runtimeLabel: runtimeMode === 'vps' ? 'VPS' : 'Regular local',
        localDashboardUrl: 'Checking...',
        publicCallbackUrl: 'Checking...',
        diagnostics: {},
      },
      steps: [{
        id: 'checking',
        label: 'Setup',
        status: 'loading',
        summary: 'Checking setup gates.',
        detail: 'The launcher is checking runtime readiness.',
      }],
      primaryAction: { label: 'Checking...', enabled: false, status: 'loading' },
      firstBlockingStepId: null,
    });
  }

  try {
    const status = await window.somnibot.getSetupStatus(input);
    if (seq !== setupStatusSeq) return setupStatus;
    setupStatus = status;
    renderSetupStatus(status);
    return status;
  } catch (err) {
    console.error('Failed to refresh setup status:', err);
    return setupStatus;
  }
}

function renderSetupStatus(status) {
  if (!status) return;

  summaryLocalDashboard.textContent = status.summary.localDashboardUrl;
  summaryPublicCallback.textContent = status.summary.publicCallbackUrl;

  runtimeDiagnosticsList.innerHTML = Object.entries(status.summary.diagnostics)
    .map(([label, value]) => (
      `<div class="diagnostic-row"><span>${escapeHtml(formatDiagnosticLabel(label))}</span><span>${escapeHtml(value)}</span></div>`
    ))
    .join('');

  runtimeSteps.innerHTML = status.steps.map((step) => {
    const statusLabel = formatStepStatus(step.status);
    const manual = step.manualAction && step.actionLabel
      ? `<span class="manual-action">${escapeHtml(step.actionLabel)}</span>`
      : '';
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
}

function formatDiagnosticLabel(label) {
  const labels = {
    operatorDashboardUrl: 'Dashboard URL',
    publicCallbackBaseUrl: 'Callback base',
    authCallbackUrl: 'Auth callback',
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
/*  Validation & Start                                                 */
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

  const currentSetup = await refreshSetupStatus({ checking: true });

  // Quick local check for required fields
  const required = ['discordToken', 'discordApplicationId', 'discordClientSecret', 'supabaseUrl', 'supabaseSecretKey', 'supabasePublishableKey'];
  const missing = required.filter((k) => !config[k]);
  if (!currentSetup?.primaryAction.enabled) {
    const blockedReason = currentSetup?.primaryAction.blockedReason || '';
    if (missing.length > 0 && /credential/i.test(blockedReason)) {
      for (const k of missing) fields[k].classList.add('error');
      showMessage('error', `Fill in all required fields: ${missing.map(fieldLabel).join(', ')}`);
    } else {
      showMessage('error', blockedReason || 'Finish the runtime setup steps before validation.');
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

  for (const input of Object.values(fields)) input.classList.remove('error', 'valid');

  isValidating = true;
  btnStart.innerHTML = '<span class="spinner"></span>Validating...';
  btnStart.classList.add('loading');
  setFieldsDisabled(true);

  try {
    const result = await window.somnibot.validateCredentials(config);

    if (!result.valid) {
      showMessage('error', result.errors.join('\n\n'));
      btnStart.classList.remove('loading');
      setFieldsDisabled(false);
      isValidating = false;
      await refreshSetupStatus();
      return;
    }

    if (result.meta) {
      showMeta(result.meta);
    }

    for (const input of Object.values(fields)) input.classList.add('valid');

    await saveConfig();

    btnStart.innerHTML = '<span class="spinner"></span>Starting...';

    const startResult = await window.somnibot.startBot();
    if (!startResult.ok) {
      showMessage('error', startResult.error || 'Failed to start.');
      btnStart.classList.remove('loading');
      setFieldsDisabled(false);
      isValidating = false;
      await refreshSetupStatus();
      return;
    }

    isRunning = true;
    isValidating = false;
    btnStart.classList.add('hidden');
    btnStop.classList.remove('hidden');
    btnOpenDashboard.disabled = false;
    await refreshSetupStatus();
    const summary = setupStatus?.summary;
    const dashboardText = summary?.localDashboardUrl || 'the local dashboard';
    const callbackText = summary?.publicCallbackUrl || 'the public callback URL';
    showMessage('success', `Bot started. Local dashboard URL: ${dashboardText}. Public callback URL: ${callbackText}.`);

  } catch (err) {
    showMessage('error', `Unexpected error: ${err.message || err}`);
    btnStart.classList.remove('loading');
    setFieldsDisabled(false);
    isValidating = false;
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
  btnStart.textContent = setupStatus?.primaryAction?.label || 'Validate & Start';
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

btnOpenSupabase.addEventListener('click', () => {
  window.somnibot.openExternal('https://supabase.com/dashboard');
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
  btn.addEventListener('click', () => {
    const target = document.getElementById(btn.dataset.target);
    if (target) {
      const isPassword = target.type === 'password';
      target.type = isPassword ? 'text' : 'password';
      btn.textContent = isPassword ? '🔒' : '👁';
    }
  });
});

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
  if (status.bot === 'offline' && status.dashboard === 'offline' && isRunning) {
    isRunning = false;
    btnStop.classList.add('hidden');
    btnStart.classList.remove('hidden');
    btnStart.textContent = setupStatus?.primaryAction?.label || 'Validate & Start';
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
  const firstRuntimeField = runtimeMode === 'vps' ? runtimeFields.vpsDomain : runtimeFields.publicCallbackBaseUrl;
  firstRuntimeField.focus();
}

function renderOnboardingRuntimeStep() {
  if (!onboardingRuntimeTitle || !onboardingRuntimeDesc || !onboardingRuntimeList) return;

  const isVps = runtimeMode === 'vps';
  onboardingRuntimeTitle.textContent = isVps ? 'Prepare VPS Readiness' : 'Prepare Public Callbacks';
  onboardingRuntimeDesc.textContent = isVps
    ? 'VPS mode needs a domain, SSH target, and manual deployment readiness before credentials can be validated.'
    : 'Regular local mode needs Tailscale Funnel readiness before credentials can be validated.';

  const items = isVps
    ? [
      ['Domain', 'Use the HTTPS domain that will serve the dashboard and receive provider callbacks.'],
      ['SSH target', 'Enter host, user, and deploy path on the setup screen. Do not enter private keys or passwords.'],
      ['Manual deploy', 'The launcher records readiness details but does not run SSH or deploy commands in this build.'],
    ]
    : [
      ['Tailscale Funnel', 'Enable Funnel for this machine so providers can reach the dashboard over HTTPS.'],
      ['Public callback URL', 'Paste the Funnel URL into the setup screen before credential validation.'],
      ['Local dashboard', 'The launcher keeps the dashboard local while public callbacks use the Funnel URL.'],
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

function updateRestoreBanner() {
  const hasSupabase = fields.supabaseUrl.value.trim() && fields.supabaseSecretKey.value.trim();
  const missingDiscord = !fields.discordToken.value.trim();
  restoreBanner.classList.toggle('hidden', !(hasSupabase && missingDiscord));
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
        if (fields[key] && value) {
          fields[key].value = value;
        }
      }
      await saveConfig();
      showMessage('success', 'Credentials restored from Supabase! Review the values and hit "Validate & Start".');
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
