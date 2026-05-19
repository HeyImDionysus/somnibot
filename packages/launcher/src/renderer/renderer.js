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
const messageArea = $('message-area');
const metaArea = $('meta-area');
const logPanel = $('log-panel');
const logContent = $('log-content');
const versionEl = $('version');
const updateBanner = $('update-banner');

/* ================================================================== */
/*  State                                                              */
/* ================================================================== */

let isRunning = false;
let isValidating = false;

/* ================================================================== */
/*  Init                                                               */
/* ================================================================== */

async function init() {
  // Show version
  try {
    const ver = window.somnibot.getVersion();
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
      // Clear field validation state on edit
      input.classList.remove('error', 'valid');
      // Re-check restore banner visibility
      updateRestoreBanner();
    });
  }

  // Show restore banner if appropriate
  updateRestoreBanner();
}

/* ================================================================== */
/*  Config persistence                                                 */
/* ================================================================== */

async function saveConfig() {
  const config = {};
  for (const [key, input] of Object.entries(fields)) {
    config[key] = input.value;
  }
  try {
    await window.somnibot.saveConfig(config);
  } catch (err) {
    console.error('Failed to save config:', err);
  }
}

/* ================================================================== */
/*  Validation & Start                                                 */
/* ================================================================== */

btnStart.addEventListener('click', async () => {
  if (isValidating || isRunning) return;

  // Collect values
  const config = {};
  for (const [key, input] of Object.entries(fields)) {
    config[key] = input.value.trim();
  }

  // Quick local check for required fields
  const required = ['discordToken', 'discordApplicationId', 'discordClientSecret', 'supabaseUrl', 'supabaseSecretKey', 'supabasePublishableKey'];
  const missing = required.filter((k) => !config[k]);
  if (missing.length > 0) {
    for (const k of missing) fields[k].classList.add('error');
    showMessage('error', `Fill in all required fields: ${missing.map(fieldLabel).join(', ')}`);
    return;
  }

  // Clear old errors
  for (const input of Object.values(fields)) input.classList.remove('error', 'valid');
  hideMessage();
  hideMeta();

  // Start validation
  isValidating = true;
  btnStart.innerHTML = '<span class="spinner"></span>Validating...';
  btnStart.classList.add('loading');
  setFieldsDisabled(true);

  try {
    const result = await window.somnibot.validateCredentials(config);

    if (!result.valid) {
      showMessage('error', result.errors.join('\n\n'));
      btnStart.innerHTML = 'Validate &amp; Start';
      btnStart.classList.remove('loading');
      setFieldsDisabled(false);
      isValidating = false;
      return;
    }

    // Show meta info
    if (result.meta) {
      showMeta(result.meta);
    }

    // Mark all fields as valid
    for (const input of Object.values(fields)) input.classList.add('valid');

    // Save config before starting
    await saveConfig();

    // Start the bot
    btnStart.innerHTML = '<span class="spinner"></span>Starting...';

    const startResult = await window.somnibot.startBot();
    if (!startResult.ok) {
      showMessage('error', startResult.error || 'Failed to start.');
      btnStart.innerHTML = 'Validate &amp; Start';
      btnStart.classList.remove('loading');
      setFieldsDisabled(false);
      isValidating = false;
      return;
    }

    // Started successfully — switch to running state
    isRunning = true;
    isValidating = false;
    btnStart.classList.add('hidden');
    btnStop.classList.remove('hidden');
    btnOpenDashboard.disabled = false;
    showMessage('success', 'Bot started! Dashboard will be available at localhost:3456 in a moment.');

  } catch (err) {
    showMessage('error', `Unexpected error: ${err.message || err}`);
    btnStart.innerHTML = 'Validate &amp; Start';
    btnStart.classList.remove('loading');
    setFieldsDisabled(false);
    isValidating = false;
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
  btnStart.innerHTML = 'Validate &amp; Start';
  btnStart.classList.remove('loading');
  btnOpenDashboard.disabled = true;
  setFieldsDisabled(false);
  hideMessage();
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

  // Auto-scroll if near bottom
  const isNearBottom = logContent.scrollHeight - logContent.scrollTop - logContent.clientHeight < 60;
  if (isNearBottom) {
    logContent.scrollTop = logContent.scrollHeight;
  }

  // Cap log lines
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

function updateStatusUI(status) {
  // Bot status dot
  botDot.className = 'status-dot';
  if (status.bot) botDot.classList.add(status.bot);

  // Dashboard status dot
  dashDot.className = 'status-dot';
  if (status.dashboard) dashDot.classList.add(status.dashboard);

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
    btnStart.innerHTML = 'Validate &amp; Start';
    btnStart.classList.remove('loading');
    btnOpenDashboard.disabled = true;
    setFieldsDisabled(false);
  }
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

/**
 * Show the "Restore from Cloud" banner when Supabase creds are present
 * but Discord creds are empty — suggests this is a new machine.
 */
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
    const result = await window.somnibot.pullFromSupabase(url, key);

    if (!result.ok) {
      showMessage('error', result.error || 'Could not restore credentials from Supabase.');
      return;
    }

    // Fill in the pulled credentials
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

/**
 * Full auto-update lifecycle:
 *   check → available → download (with progress) → downloaded → install
 *
 * On launch, the main process auto-checks silently.
 * Manual "Check for Updates" button triggers the same flow.
 */

let pendingUpdateVersion = null;

// State for progress bar DOM refs (avoids recreating on every progress tick)
let progressInfoEl = null;
let progressBarEl = null;
let downloadingSetup = false;

/* ── Manual check button ── */
btnCheckUpdates.addEventListener('click', () => {
  window.somnibot.checkForUpdates();
});

/* ── Checking ── */
window.somnibot.onUpdaterChecking(() => {
  showUpdateBanner('checking', 'Checking for updates...');
});

/* ── Update available ── */
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

/* ── No update available ── */
window.somnibot.onUpdateNotAvailable(() => {
  showUpdateBanner('up-to-date', "You're up to date!");
  setTimeout(() => {
    updateBanner.classList.add('hidden');
  }, 4000);
});

/* ── Download progress ── */
window.somnibot.onDownloadProgress((progress) => {
  // Set up the downloading banner structure once on first progress event
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

/* ── Downloaded — ready to install ── */
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

/* ── Error ── */
window.somnibot.onUpdateError((info) => {
  downloadingSetup = false;
  progressInfoEl = null;
  progressBarEl = null;

  showUpdateBanner('error', `Update failed: ${info.message}`);
  setTimeout(() => {
    updateBanner.classList.add('hidden');
  }, 8000);
});

/**
 * Simple text-only banner for transient states (checking, up-to-date, error).
 */
function showUpdateBanner(type, message) {
  updateBanner.innerHTML = `<span>${escapeHtml(message)}</span>`;
  updateBanner.className = `update-banner ${type}`;
}

/* ================================================================== */
/*  Boot                                                               */
/* ================================================================== */

init();
