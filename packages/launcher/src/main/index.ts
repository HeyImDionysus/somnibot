/**
 * SomniBot Launcher — Main Process.
 *
 * Creates the launcher window, handles IPC from the renderer,
 * manages bot + dashboard child processes, and delegates auto-updates
 * to the updater module.
 */

import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getConfig, saveConfig, buildEnvVars, setKeychainFallbackListener, type LauncherConfig } from './config-store.js';
import { writeLauncherAuditLog, resolveLauncherGuildId, type LauncherAuditEntry } from './audit-log.js';
import {
  REGULAR_LOCAL_OPERATOR_DASHBOARD_URL,
  getLauncherLocalStartBlocker,
  normalizeBaseUrl,
  resolveRuntimeProfile,
} from './runtime-profile.js';
import {
  evaluateDashboardHealthPayload,
  type DashboardHealthEvaluation,
  type DashboardHealthPayload,
} from './setup-automation-health.js';
import {
  ensurePayPalWebhook,
  type EnsurePayPalWebhookResult,
} from './paypal-webhook-service.js';
import { buildSetupStatus, type PayPalWebhookProofStatus, type SetupFlowInput } from './setup-flow.js';
import {
  SOMNIBOT_FUNNEL_TARGET,
  TAILSCALE_DNS_PROPAGATION_WAIT_MS,
  enableSomniBotFunnel,
  getTailscaleReadiness,
  probePublicCallbackHealth,
} from './tailscale-service.js';
import { validateAllCredentials, type FullValidationResult } from './validators.js';
import { startAll, stopAll, getStatus, isRunning, checkPortAvailable, cleanupStaleProcesses } from './process-manager.js';
import { maskRestoredCredentials, pushToSupabaseWithRetry } from './supabase-sync.js';
import { importExistingSomniBotEnv } from './existing-env-import.js';
import { initUpdater } from './updater.js';
import { resolveLauncherDisplayVersion } from './launcher-version.js';
import {
  MASKED_SECRET,
  maskConfigSecrets,
  sanitizeConfigPatchForStorage,
} from './config-bridge.js';
import {
  checkJava,
  downloadLavalink,
  startLavalink,
  stopLavalink,
  getLavalinkStatus,
  getLavalinkError,
  isLavalinkJarPresent,
  setLavalinkPassword,
} from './lavalink-manager.js';
import {
  downloadValkey,
  startValkey,
  stopValkey,
  getValkeyStatus,
  getValkeyError,
  isValkeyBinaryPresent,
} from './valkey-manager.js';
import { createVpsCommandRunner } from './vps-command-runner.js';
import { VpsDeploymentRunGate, redactVpsDeploymentText } from './vps-deployment-executor.js';
import { confirmVpsDeploymentApproval } from './vps-deployment-approval.js';
import { handleVpsDeploymentRunRequest, type VpsDeploymentRunRequest } from './vps-deployment-request.js';
import { ensurePersistedVpsSecrets } from './vps-env-materializer.js';
import { handleVpsRollbackRunRequest, type VpsRollbackRunRequest } from './vps-rollback-request.js';
import { planVpsSshPreflight } from './vps-preflight.js';
import { runLocalToVpsHandoff, waitForProcessIdsToExit } from './local-vps-handoff.js';
import {
  startLocalValkeyBackupSchedule,
  stopLocalValkeyBackupSchedule,
} from './local-backup-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ */
/*  App setup                                                          */
/* ------------------------------------------------------------------ */

// Single instance lock — only one launcher at a time
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let sessionToken: string | null = null;
let lastStartedPayPalConfig: PayPalRuntimeConfig | null = null;
const activeVpsDeployment = new VpsDeploymentRunGate();
/**
 * [infrastructure-launcher] Fire-and-forget durable audit for launcher-side
 * lifecycle/security operations. Resolves the current Supabase creds + target
 * guild from config at call time and writes an audit_logs row (best-effort).
 */
function recordLauncherAudit(entry: LauncherAuditEntry): void {
  const cfg = getConfig();
  void writeLauncherAuditLog(
    {
      supabaseUrl: cfg.supabaseUrl,
      supabaseSecretKey: cfg.supabaseSecretKey,
      guildId: resolveLauncherGuildId(cfg),
    },
    entry,
  );
}

async function syncLauncherCredentials(config: LauncherConfig): Promise<void> {
  const result = await pushToSupabaseWithRetry(config.supabaseUrl, config.supabaseSecretKey, {
    discordToken: config.discordToken,
    discordApplicationId: config.discordApplicationId,
    discordClientSecret: config.discordClientSecret,
    discordGuildId: config.discordGuildId,
    supabaseUrl: config.supabaseUrl,
    supabaseSecretKey: config.supabaseSecretKey,
    supabasePublishableKey: config.supabasePublishableKey,
    supabaseDbPassword: config.supabaseDbPassword,
    supabaseAccessToken: config.supabaseAccessToken,
    supabaseDiscordAuthProviderConfigured: config.supabaseDiscordAuthProviderConfigured,
    paypalClientId: config.paypalClientId,
    paypalClientSecret: config.paypalClientSecret,
    paypalWebhookId: config.paypalWebhookId,
    paypalWebhookProofKey: config.paypalWebhookProofKey,
    paypalSandbox: config.paypalSandbox,
    lavalinkEnabled: config.lavalinkEnabled,
    publicCallbackBaseUrl: config.publicCallbackBaseUrl,
    vpsDomain: config.vpsDomain,
    vpsSshHost: config.vpsSshHost,
    vpsSshUser: config.vpsSshUser,
    vpsDeployPath: config.vpsDeployPath,
    tailscaleAuthKey: config.tailscaleAuthKey,
    vpsCsrfSecret: config.vpsCsrfSecret,
    vpsNextAuthSecret: config.vpsNextAuthSecret,
    vpsWebhookReplaySecret: config.vpsWebhookReplaySecret,
    vpsValkeyPassword: config.vpsValkeyPassword,
    vpsLavalinkPassword: config.vpsLavalinkPassword,
  });
  if (result.ok) return;

  recordLauncherAudit({
    action: 'launcher.credentials.sync_failed',
    category: 'infrastructure',
    targetType: 'instance_settings',
    details: { attempts: result.attempts },
    success: false,
    errorMessage: result.error ?? 'unknown error',
  });
}

let credentialSyncTail: Promise<void> = Promise.resolve();

/** Serialize snapshots so a slower older write can never overwrite a newer save. */
function queueLauncherCredentialSync(config: LauncherConfig): Promise<void> {
  const queued = credentialSyncTail.then(() => syncLauncherCredentials(config));
  credentialSyncTail = queued.catch(() => undefined);
  return queued;
}
const DASHBOARD_SETUP_SNAPSHOT_CACHE_MS = 5_000;
let dashboardSetupSnapshotCache: {
  loadedAt: number;
  payload: DashboardSetupStatusPayload | undefined;
} | null = null;

type LauncherConfigPatch = Partial<LauncherConfig>;
type PayPalRuntimeConfig = Pick<
  LauncherConfig,
  'paypalClientId' | 'paypalClientSecret' | 'paypalWebhookId' | 'paypalSandbox'
> & {
  publicCallbackBaseUrl: string;
  paypalWebhookUrl: string;
};

function buildPayPalWebhookProofKey(input: {
  webhookId: string;
  webhookUrl: string;
  clientId: string;
  sandbox: boolean;
}): string {
  const parts = [
    input.webhookId.trim(),
    normalizeBaseUrl(input.webhookUrl),
    input.clientId.trim(),
    input.sandbox ? 'sandbox' : 'live',
  ];
  if (parts.some(part => !part)) return '';
  return crypto.createHash('sha256').update(parts.join('\0')).digest('hex');
}

interface DashboardAuthProviderOptions {
  manualAuthProviderConfirmed: boolean;
  callbackBaseUrlChanged: boolean;
}

interface DashboardSetupStatusPayload {
  supabaseProjectRef?: string | null;
  publicCallbackBaseUrl?: string | null;
  discordClientId?: string | null;
  discordAuthProviderReady?: boolean;
  discordAuthConfigured?: boolean;
  discordAuthProviderStatus?: SetupFlowInput['supabaseDiscordAuthProviderStatus'];
}

interface ReadDashboardSetupOptions {
  force?: boolean;
}

type DashboardAuthProviderStatus = NonNullable<SetupFlowInput['supabaseDiscordAuthProviderStatus']>;

interface SetupAutomationResult {
  ok: boolean;
  stage: string;
  message: string;
  error?: string;
  servicesStarted?: boolean;
  meta?: Record<string, string>;
  providerValidation?: FullValidationResult;
  warnings?: string[];
  publicCallbackBaseUrl?: string;
  callbackProbe?: Awaited<ReturnType<typeof probePublicCallbackHealth>>;
  paypalWebhook?: EnsurePayPalWebhookResult;
}

function sanitizeConfigPatch(config: LauncherConfigPatch): LauncherConfigPatch {
  return sanitizeConfigPatchForStorage(config);
}

function sanitizePayPalConfigPatch(config: LauncherConfigPatch): LauncherConfigPatch {
  const sanitized = sanitizeConfigPatch(config);
  for (const key of ['paypalClientId', 'paypalClientSecret', 'paypalWebhookId'] as const) {
    if (typeof sanitized[key] === 'string') {
      sanitized[key] = sanitized[key].trim();
    }
  }
  return sanitized;
}

function snapshotPayPalRuntimeConfig(config: LauncherConfig): PayPalRuntimeConfig {
  let publicCallbackBaseUrl = config.publicCallbackBaseUrl.trim();
  let paypalWebhookUrl = resolvePayPalWebhookUrl(config);
  try {
    const profile = resolveRuntimeProfile(config);
    publicCallbackBaseUrl = profile.publicCallbackBaseUrl;
    paypalWebhookUrl = profile.paypalWebhookUrl;
  } catch {
    // Keep the raw callback value so invalid edits still differ from the running snapshot.
  }

  return {
    paypalClientId: config.paypalClientId,
    paypalClientSecret: config.paypalClientSecret,
    paypalWebhookId: config.paypalWebhookId,
    paypalSandbox: config.paypalSandbox,
    publicCallbackBaseUrl,
    paypalWebhookUrl,
  };
}

function payPalRuntimeChanged(previous: PayPalRuntimeConfig | null, current: PayPalRuntimeConfig): boolean {
  if (!previous) return true;
  return previous.paypalClientId !== current.paypalClientId
    || previous.paypalClientSecret !== current.paypalClientSecret
    || previous.paypalWebhookId !== current.paypalWebhookId
    || previous.paypalSandbox !== current.paypalSandbox
    || previous.publicCallbackBaseUrl !== current.publicCallbackBaseUrl
    || previous.paypalWebhookUrl !== current.paypalWebhookUrl;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getSupabaseProjectRef(supabaseUrl: string): string | null {
  const rawUrl = supabaseUrl.trim();
  if (!rawUrl) return null;

  try {
    const hostname = new URL(rawUrl).hostname;
    const suffix = '.supabase.co';
    if (!hostname.endsWith(suffix)) return null;
    const projectRef = hostname.slice(0, -suffix.length);
    return /^[a-z0-9]+$/.test(projectRef) ? projectRef : null;
  } catch {
    return null;
  }
}

function dashboardSetupMatchesLauncherConfig(
  snapshot: DashboardSetupStatusPayload | undefined,
  config: LauncherConfig,
): boolean {
  if (!snapshot) return false;

  let profilePublicCallbackBaseUrl = '';
  try {
    profilePublicCallbackBaseUrl = resolveRuntimeProfile(config).publicCallbackBaseUrl;
  } catch {
    return false;
  }

  const dashboardPublicCallbackBaseUrl = normalizeBaseUrl(snapshot.publicCallbackBaseUrl ?? undefined);
  if (!dashboardPublicCallbackBaseUrl || dashboardPublicCallbackBaseUrl !== profilePublicCallbackBaseUrl) {
    return false;
  }

  const expectedProjectRef = getSupabaseProjectRef(config.supabaseUrl);
  const dashboardProjectRef = snapshot.supabaseProjectRef?.trim() ?? '';
  if (!expectedProjectRef || dashboardProjectRef !== expectedProjectRef) {
    return false;
  }

  const expectedDiscordClientId = config.discordApplicationId.trim();
  const dashboardDiscordClientId = snapshot.discordClientId?.trim() ?? '';
  if (!expectedDiscordClientId || dashboardDiscordClientId !== expectedDiscordClientId) {
    return false;
  }

  return true;
}

function dashboardAuthProviderStatusUsableForLauncherConfig(
  providerStatus: DashboardAuthProviderStatus | undefined,
  config: LauncherConfig,
): boolean {
  if (!providerStatus) return false;

  if (providerStatus.manualConfigured === true && !config.supabaseDiscordAuthProviderConfigured) {
    return false;
  }

  if (
    providerStatus.ready === true
    && providerStatus.manualConfigured !== true
    && !config.supabaseAccessToken.trim()
    && !config.supabaseDiscordAuthProviderConfigured
  ) {
    return false;
  }

  return true;
}

function getDashboardAuthProviderStatusForLauncherConfig(
  snapshot: DashboardSetupStatusPayload | undefined,
  config: LauncherConfig,
): DashboardAuthProviderStatus | undefined {
  if (!dashboardSetupMatchesLauncherConfig(snapshot, config)) return undefined;

  const providerStatus = snapshot?.discordAuthProviderStatus;
  return dashboardAuthProviderStatusUsableForLauncherConfig(providerStatus, config)
    ? providerStatus
    : undefined;
}

function dashboardSetupVerifiesAuthProvider(
  snapshot: DashboardSetupStatusPayload | undefined,
  config: LauncherConfig,
): boolean {
  const providerStatus = snapshot?.discordAuthProviderStatus;
  if (!dashboardSetupMatchesLauncherConfig(snapshot, config) || providerStatus?.ready !== true) {
    return false;
  }

  return dashboardAuthProviderStatusUsableForLauncherConfig(providerStatus, config);
}

function vpsSupabaseCallbackSignal(
  input: Partial<SetupFlowInput>,
  providerStatus: SetupFlowInput['supabaseDiscordAuthProviderStatus'],
): SetupFlowInput['supabaseCallbackAllowList'] {
  if (input.supabaseCallbackAllowList) {
    return input.supabaseCallbackAllowList;
  }

  if (providerStatus?.ready === true) {
    return {
      status: 'pass',
      detail: providerStatus.statusDetail ?? 'Dashboard setup status verified the Discord auth callback allow-list.',
    };
  }

  if (providerStatus?.ready === false) {
    return {
      status: 'fail',
      detail: providerStatus.statusDetail ?? 'Dashboard setup status reports the Discord auth callback allow-list is not ready.',
      missingCallbackUrls: providerStatus.missingCallbackUrls,
    };
  }

  if (input.supabaseDiscordAuthProviderConfigured) {
    return {
      status: 'pass',
      detail: 'Manual confirmation says the Discord auth callback allow-list is configured for this VPS setup.',
    };
  }

  return undefined;
}

async function waitForDashboardHealth(timeoutMs = 30_000): Promise<{ ok: boolean; error?: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${REGULAR_LOCAL_OPERATOR_DASHBOARD_URL}/api/health`, {
        method: 'GET',
        cache: 'no-store',
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) {
        lastError = `Dashboard health returned HTTP ${response.status}.`;
      } else {
        const body = await response.json().catch(() => null) as DashboardHealthPayload | null;
        const health = evaluateDashboardHealthPayload(body);
        if (health.ok) {
          return { ok: true };
        }
        lastError = health.error || 'Dashboard health endpoint did not report healthy status.';
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    await delay(1_000);
  }

  return { ok: false, error: lastError || 'Dashboard did not become ready in time.' };
}

async function readDashboardHealthSnapshot(timeoutMs = 1_500): Promise<DashboardHealthEvaluation | undefined> {
  if (getStatus().dashboard !== 'online') return undefined;

  try {
    const response = await fetch(`${REGULAR_LOCAL_OPERATOR_DASHBOARD_URL}/api/health`, {
      method: 'GET',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return {
        ok: false,
        status: 'unknown',
        services: {},
        error: `Dashboard health returned HTTP ${response.status}.`,
      };
    }

    const body = await response.json().catch(() => null) as DashboardHealthPayload | null;
    return evaluateDashboardHealthPayload(body);
  } catch (err) {
    return {
      ok: false,
      status: 'unknown',
      services: {},
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function readDashboardSetupSnapshot(
  timeoutMs = 1_500,
  options: ReadDashboardSetupOptions = {},
): Promise<DashboardSetupStatusPayload | undefined> {
  if (getStatus().dashboard !== 'online') {
    dashboardSetupSnapshotCache = null;
    return undefined;
  }

  const now = Date.now();
  if (
    !options.force
    && dashboardSetupSnapshotCache
    && now - dashboardSetupSnapshotCache.loadedAt < DASHBOARD_SETUP_SNAPSHOT_CACHE_MS
  ) {
    return dashboardSetupSnapshotCache.payload;
  }

  try {
    const response = await fetch(`${REGULAR_LOCAL_OPERATOR_DASHBOARD_URL}/api/setup`, {
      method: 'GET',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      dashboardSetupSnapshotCache = { loadedAt: Date.now(), payload: undefined };
      return undefined;
    }

    const payload = await response.json().catch(() => undefined) as DashboardSetupStatusPayload | undefined;
    dashboardSetupSnapshotCache = { loadedAt: Date.now(), payload };
    return payload;
  } catch {
    dashboardSetupSnapshotCache = { loadedAt: Date.now(), payload: undefined };
    return undefined;
  }
}

async function waitForPortAvailable(port: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await checkPortAvailable(port)) return true;
    await delay(250);
  }

  return checkPortAvailable(port);
}

async function configureDashboardAuthProvider({
  manualAuthProviderConfirmed,
  callbackBaseUrlChanged,
}: DashboardAuthProviderOptions): Promise<{ ok: boolean; error?: string; alreadyLocked?: boolean; setupLocked?: boolean }> {
  try {
    const response = await fetch(`${REGULAR_LOCAL_OPERATOR_DASHBOARD_URL}/api/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'configure-auth' }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await response.json().catch(() => null) as {
      success?: boolean;
      error?: string;
      setupLocked?: boolean;
    } | null;

    if (response.status === 403 && body?.setupLocked) {
      if (manualAuthProviderConfirmed && !callbackBaseUrlChanged) {
        return { ok: true, alreadyLocked: true };
      }

      return {
        ok: false,
        setupLocked: true,
        error: [
          body.error || 'Dashboard setup is locked and refused auth-provider configuration.',
          'Unlock dashboard setup or confirm that the current Discord auth callback and PayPal webhook URLs are already allow-listed in Supabase before rerunning setup.',
        ].join(' '),
      };
    }

    if (!response.ok || body?.success === false) {
      return {
        ok: false,
        error: body?.error || `Dashboard setup returned HTTP ${response.status}.`,
      };
    }

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function resolvePayPalWebhookUrl(config: LauncherConfig): string {
  try {
    return resolveRuntimeProfile(config).paypalWebhookUrl;
  } catch {
    return '';
  }
}

function persistedPayPalWebhookProof(config: LauncherConfig, webhookUrl: string): PayPalWebhookProofStatus | undefined {
  const proofKey = buildPayPalWebhookProofKey({
    webhookId: config.paypalWebhookId,
    webhookUrl,
    clientId: config.paypalClientId,
    sandbox: config.paypalSandbox,
  });

  if (!proofKey || proofKey !== config.paypalWebhookProofKey) {
    return undefined;
  }

  return {
    ok: true,
    webhookUrl,
    status: 'already-configured',
    message: 'Saved PayPal webhook proof matches the current callback URL and PayPal app.',
  };
}

async function ensureConfiguredPayPalWebhook(config: LauncherConfig): Promise<EnsurePayPalWebhookResult> {
  const webhookUrl = resolvePayPalWebhookUrl(config);
  const result = await ensurePayPalWebhook({
    clientId: config.paypalClientId,
    clientSecret: config.paypalClientSecret,
    webhookId: config.paypalWebhookId,
    webhookUrl,
    sandbox: config.paypalSandbox,
  });
  if (result.ok && result.webhookId) {
    saveConfig({
      paypalWebhookId: result.webhookId,
      paypalWebhookProofKey: buildPayPalWebhookProofKey({
        webhookId: result.webhookId,
        webhookUrl: result.webhookUrl,
        clientId: config.paypalClientId,
        sandbox: config.paypalSandbox,
      }),
    });
  }
  return result;
}

async function restartRunningLocalStackForPayPalChange(
  previousConfig: PayPalRuntimeConfig | null,
  options: { forceRestart?: boolean } = {},
): Promise<{ ok: boolean; restarted: boolean; error?: string }> {
  if (!isRunning()) return { ok: true, restarted: false };
  const currentConfig = getConfig();
  if (!options.forceRestart && !payPalRuntimeChanged(previousConfig, snapshotPayPalRuntimeConfig(currentConfig))) {
    return { ok: true, restarted: false };
  }

  const restartResult = await startLocalStack(currentConfig, { forceRestart: true });
  if (!restartResult.ok) {
    return {
      ok: false,
      restarted: false,
      error: restartResult.error || 'Restart local services so the dashboard can load the updated PayPal settings.',
    };
  }

  const dashboardReady = await waitForDashboardHealth();
  if (!dashboardReady.ok) {
    return {
      ok: false,
      restarted: true,
      error: dashboardReady.error,
    };
  }

  return { ok: true, restarted: true };
}

function maskPayPalWebhookResult(result: EnsurePayPalWebhookResult): EnsurePayPalWebhookResult {
  if (!result.webhookId) return result;
  return {
    ...result,
    webhookId: MASKED_SECRET,
  };
}

async function startLocalStack(
  config: LauncherConfig,
  options: { forceRestart?: boolean } = {},
): Promise<{ ok: boolean; error?: string }> {
  const running = isRunning();
  if (running && !options.forceRestart) {
    return { ok: true };
  }

  if (!config.discordToken || !config.supabaseUrl || !config.supabaseSecretKey) {
    return { ok: false, error: 'Fill in all required fields first.' };
  }

  const runtimeBlocker = getLauncherLocalStartBlocker(config);
  if (runtimeBlocker) {
    return { ok: false, error: runtimeBlocker };
  }

  if (running) {
    stopAll();
    lastStartedPayPalConfig = null;
  }

  const portFree = running
    ? await waitForPortAvailable(3456)
    : await checkPortAvailable(3456);
  if (!portFree) {
    return {
      ok: false,
      error: 'The local dashboard port is already in use. Close the application using that port, or restart your computer and try again. See diagnostics for implementation details.',
    };
  }

  const vkResult = await startValkey();
  if (!vkResult.ok) {
    stopValkey();
    return {
      ok: false,
      error: `Valkey/Redis is required for production-safe local operation and did not become ready: ${vkResult.error ?? 'unknown error'}`,
    };
  }

  const preparedSecrets = ensurePersistedVpsSecrets(config);
  const runtimeConfig = preparedSecrets.config;
  if (Object.keys(preparedSecrets.patch).length > 0) {
    saveConfig(preparedSecrets.patch);
    void queueLauncherCredentialSync(runtimeConfig);
  }
  setLavalinkPassword(runtimeConfig.vpsLavalinkPassword);
  if (runtimeConfig.lavalinkEnabled) {
    const llResult = await startLavalink();
    if (!llResult.ok) {
      stopLavalink();
      stopValkey();
      return {
        ok: false,
        error: `Lavalink is enabled but did not become ready: ${llResult.error ?? 'unknown error'}`,
      };
    }
  }

  startLocalValkeyBackupSchedule((result) => {
    if (result.ok) return;
    recordLauncherAudit({
      action: 'launcher.backup.valkey_failed',
      category: 'infrastructure',
      targetType: 'local_valkey',
      details: { mode: 'regular-local' },
      success: false,
      errorMessage: result.error ?? 'Local Valkey backup failed.',
    });
  });

  sessionToken = crypto.randomBytes(32).toString('hex');
  const envVars = buildEnvVars(runtimeConfig, sessionToken);
  startAll(envVars);
  lastStartedPayPalConfig = snapshotPayPalRuntimeConfig(runtimeConfig);

  void queueLauncherCredentialSync(runtimeConfig);

  return { ok: true };
}

async function runLocalSetupAutomation(configPatch: LauncherConfigPatch): Promise<SetupAutomationResult> {
  const previousPublicCallbackBaseUrl = getConfig().publicCallbackBaseUrl.trim();
  saveConfig(sanitizePayPalConfigPatch(configPatch));
  let config = getConfig();
  const warnings: string[] = [];
  let callbackBaseUrlChanged = previousPublicCallbackBaseUrl !== config.publicCallbackBaseUrl.trim();

  if (config.runtimeMode !== 'regular-local') {
    return {
      ok: false,
      stage: 'runtime',
      message: 'VPS mode uses the deployment plan workflow.',
      error: 'Self-configuring local setup is only available in Regular local mode in this launcher build.',
    };
  }

  if (!config.publicCallbackBaseUrl.trim()) {
    const readiness = await enableSomniBotFunnel(undefined, {
      authKey: config.tailscaleAuthKey,
    });
    if (readiness.publicCallbackBaseUrl) {
      saveConfig({ publicCallbackBaseUrl: readiness.publicCallbackBaseUrl });
      config = getConfig();
      callbackBaseUrlChanged = true;
    } else {
      return {
        ok: false,
        stage: 'public-callback',
        message: readiness.message,
        error: readiness.detail || readiness.message,
      };
    }
  }

  const validation = await validateAllCredentials(config);
  if (!validation.valid) {
    return {
      ok: false,
      stage: 'credentials',
      message: 'Credential validation failed.',
      error: validation.errors.join('\n\n'),
      meta: validation.meta,
      providerValidation: validation,
      publicCallbackBaseUrl: config.publicCallbackBaseUrl,
    };
  }

  const dashboardSetupBeforeStart = await readDashboardSetupSnapshot(1_500, { force: true });
  const dashboardVerifiedAuthProvider = !callbackBaseUrlChanged
    && dashboardSetupVerifiesAuthProvider(dashboardSetupBeforeStart, config);

  if (!config.supabaseAccessToken.trim()
    && !config.supabaseDiscordAuthProviderConfigured
    && !dashboardVerifiedAuthProvider
  ) {
    return {
      ok: false,
      stage: 'auth-provider',
      message: 'Supabase Discord auth setup needs one more input.',
      error: 'Add a Supabase Management API token so the launcher can configure Discord auth, or confirm that Discord auth and callback URLs are already configured in Supabase.',
      meta: validation.meta,
      providerValidation: validation,
      publicCallbackBaseUrl: config.publicCallbackBaseUrl,
    };
  }

  const startResult = await startLocalStack(config, { forceRestart: true });
  if (!startResult.ok) {
    return {
      ok: false,
      stage: 'start',
      message: 'Local services did not start.',
      error: startResult.error,
      meta: validation.meta,
      providerValidation: validation,
      publicCallbackBaseUrl: config.publicCallbackBaseUrl,
    };
  }

  const dashboardReady = await waitForDashboardHealth();
  if (!dashboardReady.ok) {
    return {
      ok: false,
      stage: 'dashboard-health',
      message: 'Bot and dashboard were started, but dashboard readiness could not be verified yet.',
      error: dashboardReady.error,
      servicesStarted: true,
      meta: validation.meta,
      providerValidation: validation,
      warnings,
      publicCallbackBaseUrl: config.publicCallbackBaseUrl,
    };
  }

  if (
    dashboardVerifiedAuthProvider
    && (config.supabaseAccessToken.trim() || config.supabaseDiscordAuthProviderConfigured)
  ) {
    warnings.push(
      'Dashboard already verified Discord auth provider readiness for this launcher config; auth-provider configuration was skipped for this restart.',
    );
  } else {
    const authConfigured = await configureDashboardAuthProvider({
      manualAuthProviderConfirmed: config.supabaseDiscordAuthProviderConfigured,
      callbackBaseUrlChanged,
    });
    if (authConfigured.alreadyLocked) {
      warnings.push('Setup is already locked, so auth-provider configuration was skipped for this restart.');
    }
    if (!authConfigured.ok) {
      return {
        ok: false,
        stage: 'auth-provider',
        message: 'Bot and dashboard are running, but Supabase Discord auth was not configured.',
        error: authConfigured.error,
        servicesStarted: true,
        meta: validation.meta,
        providerValidation: validation,
        warnings,
        publicCallbackBaseUrl: config.publicCallbackBaseUrl,
      };
    }
  }

  let callbackProbe: Awaited<ReturnType<typeof probePublicCallbackHealth>> | undefined;
  if (config.publicCallbackBaseUrl.trim()) {
    callbackProbe = await probePublicCallbackHealth(config.publicCallbackBaseUrl);
    if (!callbackProbe.ok) {
      warnings.push(callbackProbe.error || 'Public callback health check did not pass yet.');
    }
  }

  let paypalWebhook: EnsurePayPalWebhookResult | undefined;
  if (config.paypalClientId.trim() && config.paypalClientSecret.trim()) {
    if (callbackProbe && !callbackProbe.ok) {
      return {
        ok: false,
        stage: 'public-callback',
        message: 'Public callback health must pass before the PayPal webhook can be changed.',
        error: callbackProbe.error || 'Verify the public callback URL before creating or updating the PayPal webhook.',
        servicesStarted: true,
        meta: validation.meta,
        providerValidation: validation,
        warnings,
        publicCallbackBaseUrl: config.publicCallbackBaseUrl,
        callbackProbe,
      };
    }

    const previousPayPalConfig = snapshotPayPalRuntimeConfig(getConfig());
    const rawPayPalWebhook = await ensureConfiguredPayPalWebhook(config);
    paypalWebhook = maskPayPalWebhookResult(rawPayPalWebhook);
    if (!rawPayPalWebhook.ok) {
      return {
        ok: false,
        stage: 'paypal-webhook',
        message: 'PayPal webhook setup did not complete.',
        error: paypalWebhook.error || paypalWebhook.message,
        servicesStarted: true,
        meta: validation.meta,
        providerValidation: validation,
        warnings,
        publicCallbackBaseUrl: config.publicCallbackBaseUrl,
        paypalWebhook,
        ...(callbackProbe ? { callbackProbe } : {}),
      };
    }

    const restartResult = await restartRunningLocalStackForPayPalChange(previousPayPalConfig);
    if (!restartResult.ok) {
      return {
        ok: false,
        stage: 'paypal-webhook',
        message: 'PayPal webhook was configured, but local services could not restart.',
        error: restartResult.error,
        servicesStarted: restartResult.restarted,
        meta: validation.meta,
        providerValidation: validation,
        warnings,
        publicCallbackBaseUrl: config.publicCallbackBaseUrl,
        paypalWebhook,
        ...(callbackProbe ? { callbackProbe } : {}),
      };
    }
    if (restartResult.restarted) {
      paypalWebhook = {
        ...paypalWebhook,
        servicesRestarted: true,
      };
    }
    config = getConfig();
  }

  return {
    ok: true,
    stage: 'complete',
    message: 'Setup automation finished and local services are running.',
    servicesStarted: true,
    meta: validation.meta,
    providerValidation: validation,
    warnings,
    publicCallbackBaseUrl: config.publicCallbackBaseUrl,
    ...(paypalWebhook ? { paypalWebhook } : {}),
    ...(callbackProbe ? { callbackProbe } : {}),
  };
}

async function createWindow(showWhenReady = true): Promise<void> {
  const config = getConfig();
  const bounds = config.windowBounds ?? { width: 760, height: 680 };

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 640,
    minHeight: 560,
    title: 'SomniBot',
    backgroundColor: '#0d0d0d',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // V5 Audit [10.2]: Enable Chromium sandbox. The preload script only uses
      // contextBridge + ipcRenderer, both of which work in sandboxed mode.
      sandbox: true,
    },
  });

  // V5-Audit §10.1: Enforce Content-Security-Policy on the renderer.
  // The launcher loads only local HTML/CSS/JS — no CDN, no inline scripts.
  // This CSP blocks XSS even if an attacker injects content into the renderer.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none';",
        ],
      },
    });
  });

  // Load the renderer HTML.
  // Primary: dist/renderer/ (copied during build). Fallback: src/renderer/ (source).
  // app.getAppPath() returns the asar root in packaged builds, or the package
  // dir in development — both work because electron-builder includes both paths.
  const distRenderer = path.join(__dirname, '..', 'renderer', 'index.html');
  const srcRenderer = path.join(app.getAppPath(), 'src', 'renderer', 'index.html');

  // Use whichever exists — check dist first (the build copy), fall back to src
  const { existsSync } = await import('node:fs');
  const rendererPath = existsSync(distRenderer) ? distRenderer : srcRenderer;

  // Debug: log the resolved renderer path for troubleshooting
  console.log('[Launcher] Renderer dist path:', distRenderer, '→ exists:', existsSync(distRenderer));
  console.log('[Launcher] Renderer src path:', srcRenderer, '→ exists:', existsSync(srcRenderer));
  console.log('[Launcher] Using:', rendererPath);

  mainWindow.loadFile(rendererPath).catch((err) => {
    console.error('[Launcher] Failed to load renderer:', err);
  });

  // Open DevTools only in development — never in packaged builds
  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // Log renderer load failures
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[Launcher] Renderer failed to load: ${errorCode} ${errorDescription} (${validatedURL})`);
  });

  // Log renderer console messages to main process stdout for debugging
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const tag = ['LOG', 'WARN', 'ERROR'][level] ?? 'LOG';
    console.log(`[Renderer ${tag}] ${message} (${sourceId}:${line})`);
  });

  // Show when ready to avoid white flash
  mainWindow.once('ready-to-show', () => {
    if (showWhenReady) mainWindow?.show();
  });

  // Save window bounds on move/resize
  const saveBounds = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const [width, height] = mainWindow.getSize();
      const [x, y] = mainWindow.getPosition();
      saveConfig({ windowBounds: { width, height, x, y } });
    }
  };
  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/* ------------------------------------------------------------------ */
/*  IPC Handlers                                                       */
/* ------------------------------------------------------------------ */

function registerIpcHandlers(): void {
  // ── Config ──
  ipcMain.handle('get-config', () => {
    const config = getConfig();
    return maskConfigSecrets({
      discordToken: config.discordToken,
      discordApplicationId: config.discordApplicationId,
      discordClientSecret: config.discordClientSecret,
      discordGuildId: config.discordGuildId,
      supabaseUrl: config.supabaseUrl,
      supabaseSecretKey: config.supabaseSecretKey,
      supabasePublishableKey: config.supabasePublishableKey,
      supabaseDbPassword: config.supabaseDbPassword,
      supabaseAccessToken: config.supabaseAccessToken,
      supabaseDiscordAuthProviderConfigured: config.supabaseDiscordAuthProviderConfigured,
      paypalClientId: config.paypalClientId,
      paypalClientSecret: config.paypalClientSecret,
      paypalWebhookId: config.paypalWebhookId,
      paypalSandbox: config.paypalSandbox,
      runtimeMode: config.runtimeMode,
      publicCallbackBaseUrl: config.publicCallbackBaseUrl,
      vpsDomain: config.vpsDomain,
      vpsSshHost: config.vpsSshHost,
      vpsSshUser: config.vpsSshUser,
      vpsDeployPath: config.vpsDeployPath,
      tailscaleAuthKey: config.tailscaleAuthKey,
    });
  });

  ipcMain.handle('save-config', (_event, config: Partial<LauncherConfig>) => {
    saveConfig(sanitizePayPalConfigPatch(config));
    void queueLauncherCredentialSync(getConfig());
  });

  ipcMain.handle('import-existing-env', async () => {
    const selection = await dialog.showOpenDialog({
      title: 'Import an existing SomniBot setup',
      properties: ['openFile'],
      filters: [
        { name: 'SomniBot environment', extensions: ['env'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (selection.canceled || selection.filePaths.length !== 1) {
      return { ok: false, canceled: true, importedFields: [] };
    }

    const result = await importExistingSomniBotEnv(selection.filePaths[0]!, getConfig());
    if (!result.ok) return result;
    if (Object.keys(result.patch).length > 0) {
      saveConfig(result.patch);
      await queueLauncherCredentialSync(getConfig());
    }
    recordLauncherAudit({
      action: 'launcher.credentials.existing_env_imported',
      category: 'infrastructure',
      targetType: 'credential_store',
      details: { importedFieldCount: result.importedFields.length },
      success: true,
    });
    return { ok: true, canceled: false, importedFields: result.importedFields };
  });

  ipcMain.handle('get-setup-status', async (_event, input: Partial<SetupFlowInput> = {}) => {
    const config = getConfig();
    const currentStatus = getStatus();
    const [dashboardHealth, dashboardSetup] = await Promise.all([
      readDashboardHealthSnapshot(),
      readDashboardSetupSnapshot(),
    ]);
    const dashboardSetupStatus = getDashboardAuthProviderStatusForLauncherConfig(dashboardSetup, config);
    const selectedAuthProviderStatus = input.supabaseDiscordAuthProviderStatus
      ?? dashboardSetupStatus;
    const selectedAuthProviderStatusBlocksDashboard = selectedAuthProviderStatus?.ready === false;
    const dashboardAuthProviderConfigured = dashboardSetupVerifiesAuthProvider(dashboardSetup, config);
    const discoveredAuthProviderConfigured = Boolean(
      selectedAuthProviderStatus?.ready
      || (!selectedAuthProviderStatusBlocksDashboard && dashboardAuthProviderConfigured)
      || config.supabaseDiscordAuthProviderConfigured,
    );
    const paypalWebhookUrl = resolvePayPalWebhookUrl(config);

    return buildSetupStatus({
      runtimeMode: input.runtimeMode ?? config.runtimeMode,
      publicCallbackBaseUrl: input.publicCallbackBaseUrl ?? config.publicCallbackBaseUrl,
      discordGuildId: input.discordGuildId ?? config.discordGuildId,
      vpsDomain: input.vpsDomain ?? config.vpsDomain,
      vpsSshHost: input.vpsSshHost ?? config.vpsSshHost,
      vpsSshUser: input.vpsSshUser ?? config.vpsSshUser,
      vpsDeployPath: input.vpsDeployPath ?? config.vpsDeployPath,
      credentialReady: input.credentialReady ?? Boolean(
        config.discordToken
        && config.discordApplicationId
        && config.discordClientSecret
        && config.supabaseUrl
        && config.supabaseSecretKey
        && config.supabasePublishableKey
      ),
      providerValidation: input.providerValidation,
      paypalReady: input.paypalReady ?? Boolean(
        config.paypalClientId
        && config.paypalClientSecret
        && config.paypalWebhookId
      ),
      paypalWebhook: input.paypalWebhook ?? persistedPayPalWebhookProof(config, paypalWebhookUrl),
      callbackProbe: input.callbackProbe,
      supabaseAccessTokenReady: input.supabaseAccessTokenReady ?? Boolean(config.supabaseAccessToken),
      supabaseDiscordAuthProviderConfigured: input.supabaseDiscordAuthProviderConfigured
        ?? discoveredAuthProviderConfigured,
      supabaseDiscordAuthProviderStatus: selectedAuthProviderStatus,
      tailscaleAuthKeyReady: input.tailscaleAuthKeyReady ?? Boolean(config.tailscaleAuthKey),
      tailscaleReadinessState: input.tailscaleReadinessState,
      dashboardOnline: input.dashboardOnline ?? currentStatus.dashboard === 'online',
      localServiceReadiness: input.localServiceReadiness ?? {
        bot: currentStatus.bot,
        dashboard: currentStatus.dashboard,
        lavalink: currentStatus.lavalink,
        ...(dashboardHealth ? { dashboardHealth } : {}),
      },
      httpsDashboardProbe: input.httpsDashboardProbe,
      apiHealthProbe: input.apiHealthProbe,
      supabaseCallbackAllowList: vpsSupabaseCallbackSignal(input, selectedAuthProviderStatus),
      lavalink: input.lavalink,
      checking: input.checking ?? false,
    });
  });

  ipcMain.handle('run-setup-automation', async (_event, config: Partial<LauncherConfig>) => {
    return runLocalSetupAutomation(config);
  });

  ipcMain.handle('paypal:ensure-webhook', async (_event, config: Partial<LauncherConfig>) => {
    const previousConfig = getConfig();
    saveConfig(sanitizePayPalConfigPatch(config));
    const cfg = getConfig();
    const rawResult = await ensureConfiguredPayPalWebhook(cfg);
    if (rawResult.ok) {
      const restartBaseline = lastStartedPayPalConfig ?? snapshotPayPalRuntimeConfig(previousConfig);
      const restartResult = await restartRunningLocalStackForPayPalChange(
        restartBaseline,
        { forceRestart: !lastStartedPayPalConfig },
      );
      if (!restartResult.ok) {
        return maskPayPalWebhookResult({
          ...rawResult,
          ok: false,
          status: 'failed',
          message: 'PayPal webhook was configured, but local services could not restart.',
          error: restartResult.error || 'Restart local services so the dashboard can load the new PayPal Webhook ID.',
        });
      }
      if (restartResult.restarted) {
        return maskPayPalWebhookResult({
          ...rawResult,
          servicesRestarted: true,
        });
      }
    }
    return maskPayPalWebhookResult(rawResult);
  });

  // ── Validation ──
  ipcMain.handle('validate-credentials', async (_event, config) => {
    return validateAllCredentials(config);
  });

  // ── Process control ──
  ipcMain.handle('start-bot', async () => {
    const config = getConfig();
    return startLocalStack(config);
  });

  ipcMain.handle('stop-bot', () => {
    stopLocalValkeyBackupSchedule();
    stopAll();
    stopLavalink();
    stopValkey();
    sessionToken = null;
    lastStartedPayPalConfig = null;
  });

  ipcMain.handle('get-status', () => {
    return getStatus();
  });

  // ── Dashboard ──
  // V5C-9: This URL is intentionally http://localhost:3456 (not https).
  // The launcher only runs locally — the Next.js dev/standalone server
  // binds to localhost without TLS. Hosted deployments and VPS domains
  // do NOT use the launcher; they have their own HTTPS termination.
  // Do NOT make this URL configurable without also adding URL validation.
  ipcMain.handle('open-dashboard', () => {
    shell.openExternal('http://localhost:3456');
  });

  // ── External links ──
  // V5 Audit [1.1]: Only allow https:// URLs to prevent protocol abuse.
  // The open-dashboard handler has its own explicit http://localhost:3456 allowance.
  ipcMain.handle('open-external', (_event, url: string) => {
    if (url.startsWith('https://')) {
      shell.openExternal(url);
    }
  });

  // ── Cloud sync ──
  // V5 Audit §10.P3a: Use main-process config for secret — renderer never receives it.
  ipcMain.handle('pull-from-supabase', async () => {
    const cfg = getConfig();
    const { pullFromSupabase } = await import('./supabase-sync.js');
    const result = await pullFromSupabase(cfg.supabaseUrl, cfg.supabaseSecretKey);
    if (result.ok && result.credentials) {
      saveConfig(result.credentials);
      return {
        ...result,
        credentials: maskRestoredCredentials(result.credentials, MASKED_SECRET),
      };
    }
    return result;
  });

  // ── Tailscale / public callback readiness ──
  ipcMain.handle('tailscale:get-readiness', async () => {
    return getTailscaleReadiness();
  });

  ipcMain.handle('tailscale:enable-funnel', async () => {
    const cfg = getConfig();
    if (cfg.runtimeMode !== 'regular-local') {
      return {
        state: 'error',
        installed: false,
        loggedIn: false,
        funnelEnabled: false,
        publicCallbackBaseUrl: '',
        dashboardTarget: SOMNIBOT_FUNNEL_TARGET,
        commandPreview: [],
        dnsPropagationWaitMs: TAILSCALE_DNS_PROPAGATION_WAIT_MS,
        message: 'Tailscale Funnel is only available in Regular local mode.',
      };
    }

    const readiness = await enableSomniBotFunnel(undefined, {
      authKey: cfg.tailscaleAuthKey,
    });
    if (readiness.publicCallbackBaseUrl && cfg.runtimeMode === 'regular-local') {
      saveConfig({
        publicCallbackBaseUrl: readiness.publicCallbackBaseUrl,
      });
    }
    return readiness;
  });

  ipcMain.handle('tailscale:probe-callback', async (_event, publicCallbackBaseUrl?: string) => {
    const cfg = getConfig();
    const baseUrl = typeof publicCallbackBaseUrl === 'string' && publicCallbackBaseUrl.trim()
      ? publicCallbackBaseUrl
      : cfg.publicCallbackBaseUrl;
    return probePublicCallbackHealth(baseUrl);
  });

  // ── App info ──
  ipcMain.handle('get-version', () => resolveLauncherDisplayVersion({
    appVersion: app.getVersion(),
  }));

  ipcMain.handle('vps:run-deployment', async (_event, request: VpsDeploymentRunRequest) => {
    const cfg = getConfig();
    return handleVpsDeploymentRunRequest(cfg, request, {
      confirmApproval: (plan) => confirmVpsDeploymentApproval(plan, {
        showMessageBox: (options) => dialog.showMessageBox(options),
      }),
      createCommandRunner: createVpsCommandRunner,
      runGate: activeVpsDeployment,
      recordAudit: recordLauncherAudit,
      persistGeneratedSecrets: async (patch) => {
        saveConfig(patch);
        await queueLauncherCredentialSync(getConfig());
      },
      runApprovedDeployment: (executeDeployment) => {
        const localWasRunning = isRunning();
        const localProcessIds = getStatus();
        return runLocalToVpsHandoff({
          localWasRunning,
          stopLocal: async () => {
            stopLocalValkeyBackupSchedule();
            stopAll();
            stopLavalink();
            stopValkey();
            sessionToken = null;
            lastStartedPayPalConfig = null;
            await waitForProcessIdsToExit([localProcessIds.botPid, localProcessIds.dashboardPid]);
          },
          restoreLocal: async () => {
            const restored = await startLocalStack({ ...cfg, runtimeMode: 'regular-local' });
            if (!restored.ok) throw new Error(restored.error || 'Local SomniBot could not be restored.');
          },
          executeDeployment,
        });
      },
    });
  });

  ipcMain.handle('vps:run-rollback', async (_event, request: VpsRollbackRunRequest) => {
    const cfg = getConfig();
    return handleVpsRollbackRunRequest(cfg, request, {
      confirmApproval: (plan) => confirmVpsDeploymentApproval(plan, {
        showMessageBox: (options) => dialog.showMessageBox(options),
      }),
      createCommandRunner: createVpsCommandRunner,
      runGate: activeVpsDeployment,
      recordAudit: recordLauncherAudit,
    });
  });

  ipcMain.handle('vps:run-preflight', async () => {
    const cfg = getConfig();
    if (cfg.runtimeMode !== 'vps') {
      return {
        state: 'blocked',
        canRetry: false,
        command: null,
        blockedReasons: ['VPS SSH preflight is only available in VPS mode.'],
        warnings: [],
        logs: [{
          level: 'error',
          code: 'vps-preflight-blocked',
          message: 'VPS SSH preflight is blocked.',
          detail: 'Select VPS mode before running SSH preflight.',
        }],
      };
    }

    const plan = planVpsSshPreflight({
      host: cfg.vpsSshHost,
      user: cfg.vpsSshUser,
      deployPath: cfg.vpsDeployPath,
      explicitUserAction: true,
    });
    if (!plan.command) {
      return {
        state: 'blocked',
        canRetry: false,
        command: null,
        blockedReasons: plan.blockedReasons,
        warnings: plan.warnings,
        logs: plan.logEvents,
      };
    }

    const runner = createVpsCommandRunner();
    const command = {
      id: 'ssh-preflight',
      label: 'Verify deployment directory',
      executable: plan.command.executable,
      args: plan.command.args,
      redactedArgs: plan.command.redactedArgs,
      redactedDisplay: plan.command.redactedDisplay,
      changesRemote: false,
      approvalRequired: false,
      commandCategory: 'probe' as const,
    };
    const result = await runner(command, { index: 0, total: 1 });
    const state = result.ok ? 'success' : result.retriable ? 'retry' : 'failure';
    const redactedError = result.error ? redactVpsDeploymentText(result.error) : undefined;

    return {
      state,
      canRetry: !result.ok,
      command: {
        redactedDisplay: plan.command.redactedDisplay,
      },
      blockedReasons: [],
      warnings: plan.warnings,
      logs: [
        ...plan.logEvents,
        {
          level: result.ok ? 'info' : 'error',
          code: result.ok ? 'vps-preflight-success' : 'vps-preflight-failure',
          message: result.ok ? 'Read-only SSH preflight passed.' : 'Read-only SSH preflight failed.',
          detail: result.ok ? 'The deployment directory exists and SSH returned success.' : redactedError,
        },
      ],
    };
  });

  // ── Phase 6: First-run onboarding ──
  ipcMain.handle('is-first-run', () => {
    return !getConfig().firstRunComplete;
  });

  ipcMain.handle('complete-first-run', () => {
    saveConfig({ firstRunComplete: true });
  });

  // ── Phase 6: Lavalink management ──
  ipcMain.handle('get-lavalink-enabled', () => {
    return getConfig().lavalinkEnabled;
  });

  ipcMain.handle('set-lavalink-enabled', (_event, enabled: boolean) => {
    saveConfig({ lavalinkEnabled: enabled });
  });

  ipcMain.handle('check-java', async () => {
    return checkJava();
  });

  ipcMain.handle('download-lavalink', async () => {
    const result = await downloadLavalink((percent, downloadedMB, totalMB) => {
      // Forward progress to renderer
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('lavalink-download-progress', { percent, downloadedMB, totalMB });
        }
      }
    });
    return result;
  });

  ipcMain.handle('get-lavalink-info', () => {
    return {
      status: getLavalinkStatus(),
      jarPresent: isLavalinkJarPresent(),
      error: getLavalinkError(),
    };
  });


  // ── Valkey/Redis management ──
  ipcMain.handle('get-valkey-info', () => {
    return {
      status: getValkeyStatus(),
      binaryPresent: isValkeyBinaryPresent(),
      error: getValkeyError(),
    };
  });

  ipcMain.handle('download-valkey', async () => {
    const result = await downloadValkey((percent, downloadedMB, totalMB) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('valkey-download-progress', { percent, downloadedMB, totalMB });
        }
      }
    });
    return result;
  });
}

/* ------------------------------------------------------------------ */
/*  App lifecycle                                                      */
/* ------------------------------------------------------------------ */

app.whenReady().then(async () => {
  // Phase 6: Clean up stale processes from a previous crash
  cleanupStaleProcesses();

  // [infrastructure-launcher] Persist a durable audit row if the OS keychain is
  // unavailable and credentials fall back to plaintext storage.
  setKeychainFallbackListener(() => {
    recordLauncherAudit({
      action: 'launcher.keychain.unavailable',
      category: 'security',
      targetType: 'credential_store',
      details: { fallback: 'plaintext', platform: process.platform },
      success: false,
      errorMessage: 'OS keychain (safeStorage) unavailable — sensitive credentials stored in plaintext.',
    });
  });

  registerIpcHandlers();
  const config = getConfig();
  const shouldAutoRunLocal = config.firstRunComplete && config.runtimeMode !== 'vps';
  if (app.isPackaged) {
    app.setLoginItemSettings({
      openAtLogin: shouldAutoRunLocal,
      args: ['--background'],
    });
  }
  const backgroundLaunch = shouldAutoRunLocal && process.argv.includes('--background');
  await createWindow(!backgroundLaunch);

  if (shouldAutoRunLocal) {
    const autoStartResult = await startLocalStack(config);
    if (!autoStartResult.ok) {
      recordLauncherAudit({
        action: 'launcher.autostart.failed',
        category: 'infrastructure',
        targetType: 'local_stack',
        details: { runtimeMode: config.runtimeMode },
        success: false,
        errorMessage: autoStartResult.error ?? 'Local stack auto-start failed.',
      });
      mainWindow?.show();
      mainWindow?.webContents.send('status-update', {
        ...getStatus(),
        error: `Automatic restart failed: ${autoStartResult.error ?? 'unknown error'}`,
      });
    }
  }

  // macOS: re-create window when dock icon is clicked
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });

  // Auto-updater — must await so IPC handlers are registered before renderer calls them
  await initUpdater({ recordAudit: recordLauncherAudit });
});

// Second instance: focus the existing window
app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    void createWindow(true);
  } else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// Clean shutdown — kill child processes before quitting
app.on('before-quit', () => {
  stopLocalValkeyBackupSchedule();
  if (isRunning()) {
    stopAll();
  }
  stopLavalink();
  stopValkey();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Closing the control window must not take a production bot offline.
    // Use the explicit Stop action before closing when shutdown is intended.
    if (!isRunning()) app.quit();
  }
});
