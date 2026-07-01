/**
 * First-Run Setup API — Manages the initial deployment wizard.
 *
 * GET  /api/setup  — Returns first-run status (is DB initialized? is bot online? guild detected?)
 * POST /api/setup  — Verify credentials, save to instance_settings, configure auth, run migrations, detect guild
 *
 * SECURITY (Phase A):
 * - After `finalize`, a `setup_completed_at` timestamp is written.
 * - Once set, all credential-mutation actions are BLOCKED unless the authenticated
 *   guild owner first calls `action: 'unlock-maintenance'`.
 * - Maintenance mode auto-expires after 10 minutes.
 * - GET remains public so the setup page can detect state.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { ensureDiscordAuthProvider, getDiscordAuthProviderStatus } from '@/lib/supabase/auto-config';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { parseBody, schemas } from '@/lib/api/validation';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { applyRuntimeSupabaseEnv, readBuildBrowserSupabaseConfig, readEnvSupabaseConfig, requireBrowserSupabaseConfig } from '@/lib/supabase/runtime-config';
import { applyRuntimePayPalEnv } from '@/lib/paypal';
import {
  SETUP_PAYPAL_WEBHOOK_PATH,
  getSetupPayPalWebhookUrlError,
  isSetupLocalHostname,
  normalizeSetupPayPalWebhookUrl,
} from '@/lib/setup-paypal-webhook';

const MAINTENANCE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const SETUP_STATUS_AUTH_PROVIDER_TIMEOUT_MS = 3_000;
const BOT_HEARTBEAT_KEY = 'somnibot:heartbeat:bot';
const BOT_HEARTBEAT_STALE_MS = 120_000;

interface RuntimeCallbackConfig {
  operatorDashboardUrl: string | null;
  publicCallbackBaseUrl: string | null;
  paypalWebhookUrl: string | null;
  publicCallbackRequired: boolean;
  publicCallbackReady: boolean;
  publicCallbackError: string | null;
}

type DiscordAuthProviderStatus = Awaited<ReturnType<typeof getDiscordAuthProviderStatus>>;

interface OwnerRuntimeReadiness {
  botOnline: boolean;
  guildDetected: boolean;
  guildId: string | null;
  guildName: string | null;
}

type SetupSettingMap = Map<string, string>;

type DiscordAuthProviderStatusReason =
  | 'ready'
  | 'management-token-missing'
  | 'project-ref-missing'
  | 'provider-disabled'
  | 'callback-allow-list-missing'
  | 'management-api-error'
  | 'unknown';

function getDiscordAuthProviderStatusReason(status: DiscordAuthProviderStatus): DiscordAuthProviderStatusReason {
  if (status.ready) return 'ready';
  if (status.error?.includes('SUPABASE_ACCESS_TOKEN')) return 'management-token-missing';
  if (status.error?.includes('project ref')) return 'project-ref-missing';
  if (status.error?.includes('Supabase Management API error')) return 'management-api-error';
  if (status.error) return 'unknown';
  if (!status.providerEnabled) return 'provider-disabled';
  if (!status.callbackAllowListReady) return 'callback-allow-list-missing';
  return 'unknown';
}

function buildDiscordAuthProviderStatusDetail(
  status: DiscordAuthProviderStatus,
  reason: DiscordAuthProviderStatusReason,
): string {
  switch (reason) {
    case 'ready':
      return status.manualConfigured
        ? 'Manual Discord auth provider setup is confirmed.'
        : 'Discord auth provider is enabled and callback URLs are allow-listed.';
    case 'management-token-missing':
      return 'Add a Supabase Management API token so setup can verify and configure Discord auth, or confirm that Discord auth and callback URLs are already configured in Supabase.';
    case 'project-ref-missing':
      return 'Check the Supabase project URL; setup could not identify the project ref needed for auth provider verification.';
    case 'provider-disabled':
      return 'Discord auth provider is not enabled in Supabase yet.';
    case 'callback-allow-list-missing':
      return status.missingCallbackUrls.length > 0
        ? `Supabase auth callback allow-list is missing: ${status.missingCallbackUrls.join(', ')}.`
        : 'Supabase auth callback allow-list does not include the current dashboard callback URL.';
    case 'management-api-error':
      return 'Supabase Management API could not verify Discord auth provider readiness. Check the server logs or retry with a valid Management API token.';
    case 'unknown':
    default:
      return 'Discord auth provider readiness could not be verified.';
  }
}

function toPublicDiscordAuthProviderStatus(status: DiscordAuthProviderStatus) {
  const statusReason = getDiscordAuthProviderStatusReason(status);
  return {
    ready: status.ready,
    providerEnabled: status.providerEnabled,
    callbackAllowListReady: status.callbackAllowListReady,
    missingCallbackUrls: status.missingCallbackUrls,
    manualConfigured: status.manualConfigured,
    statusReason,
    statusDetail: buildDiscordAuthProviderStatusDetail(status, statusReason),
  };
}

/**
 * Create a Supabase client from provided credentials (not from env vars).
 * Used during setup when env vars may not be fully configured yet.
 */
function createSetupSupabase(url?: string, key?: string) {
  const envConfig = readEnvSupabaseConfig();
  const supabaseUrl = url || envConfig.url;
  const serviceKey = key || envConfig.secretKey;

  if (!supabaseUrl || !serviceKey) return null;
  return createClient(supabaseUrl, serviceKey);
}

async function verifySupabasePublishableKey(url: string, publishableKey: string) {
  try {
    const response = await fetch(`${url.replace(/\/$/, '')}/auth/v1/settings`, {
      headers: {
        apikey: publishableKey,
        Authorization: `Bearer ${publishableKey}`,
      },
      signal: AbortSignal.timeout(10_000),
    });

    return response.ok;
  } catch (err) {
    console.error('[setup/validate-supabase] Publishable key check failed:', err);
    return false;
  }
}

/**
 * Check whether setup has been completed (setup_completed_at exists).
 */
// V11 Audit L-7: Replace `any` with typed SupabaseClient.
async function getSetupLock(supabase: SupabaseClient) {
  const { data: completedRow } = await supabase
    .from('instance_settings')
    .select('value')
    .eq('key', 'setup_completed_at')
    .maybeSingle() as { data: { value: string } | null };

  const { data: maintenanceRow } = await supabase
    .from('instance_settings')
    .select('value')
    .eq('key', 'setup_maintenance_until')
    .maybeSingle() as { data: { value: string } | null };

  const isCompleted = !!completedRow?.value;
  let maintenanceActive = false;

  if (maintenanceRow?.value) {
    const until = new Date(maintenanceRow.value).getTime();
    maintenanceActive = Date.now() < until;
  }

  return { isCompleted, maintenanceActive };
}

function isTruthyEnv(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'required'].includes(value?.trim().toLowerCase() ?? '');
}

function normalizeRuntimeBaseUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.pathname && parsed.pathname !== '/') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

async function readSetupInstanceSettings(
  supabase: SupabaseClient,
  keys: string[],
): Promise<SetupSettingMap> {
  const result = await supabase
    .from('instance_settings')
    .select('key, value')
    .in('key', keys)
    .limit(1000) as { data?: Array<{ key: string; value: string | null }> | null };

  return new Map(
    (result.data ?? [])
      .filter((row): row is { key: string; value: string } => typeof row.value === 'string' && row.value.trim().length > 0)
      .map(row => [row.key, row.value.trim()]),
  );
}

function getSupabaseProjectRef(env: NodeJS.ProcessEnv = process.env): string | null {
  const rawUrl = env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL || '';
  if (!rawUrl.trim()) return null;

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

function normalizeConfiguredDiscordGuildId(value: string | null | undefined): string | null {
  return value
    ?.split(',')
    .map(part => part.trim())
    .find(Boolean) ?? null;
}

function getConfiguredDiscordGuildId(
  savedSettings: SetupSettingMap = new Map(),
  credentials: Record<string, string | undefined> = {},
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return normalizeConfiguredDiscordGuildId(credentials.discord_guild_id)
    || normalizeConfiguredDiscordGuildId(env['DISCORD_GUILD_ID'])
    || normalizeConfiguredDiscordGuildId(env['NEXT_PUBLIC_DISCORD_GUILD_ID'])
    || normalizeConfiguredDiscordGuildId(savedSettings.get('discord_guild_id'));
}

function resolveRuntimeCallbackConfig(env: NodeJS.ProcessEnv = process.env): RuntimeCallbackConfig {
  const operatorDashboardUrl = normalizeRuntimeBaseUrl(env['DASHBOARD_URL']);
  const publicCallbackBaseUrl = normalizeRuntimeBaseUrl(
    env['SOMNIBOT_PUBLIC_CALLBACK_BASE_URL'] || env['NEXT_PUBLIC_APP_URL'],
  );
  const publicCallbackRequired = isTruthyEnv(env['SOMNIBOT_PUBLIC_CALLBACK_REQUIRED']);
  let publicCallbackError: string | null = null;

  if (publicCallbackRequired) {
    if (!publicCallbackBaseUrl) {
      publicCallbackError = 'Public callback URL is required before setup can finalize.';
    } else {
      const parsed = new URL(publicCallbackBaseUrl);
      if (parsed.protocol !== 'https:') {
        publicCallbackError = 'Public callback URL must use HTTPS before setup can finalize.';
      } else if (isSetupLocalHostname(parsed.hostname)) {
        publicCallbackError = 'Public callback URL cannot point at localhost before setup can finalize.';
      }
    }
  }

  return {
    operatorDashboardUrl,
    publicCallbackBaseUrl,
    paypalWebhookUrl: publicCallbackBaseUrl ? `${publicCallbackBaseUrl}${SETUP_PAYPAL_WEBHOOK_PATH}` : null,
    publicCallbackRequired,
    publicCallbackReady: !publicCallbackRequired || publicCallbackError === null,
    publicCallbackError,
  };
}

function resolveSetupPayPalWebhookStatus(
  runtimeCallbacks: RuntimeCallbackConfig,
  env: NodeJS.ProcessEnv = process.env,
  savedSettings: SetupSettingMap = new Map(),
): { url: string | null; urlReady: boolean; ready: boolean; error: string | null } {
  const derivedWebhookUrl = normalizeSetupPayPalWebhookUrl(runtimeCallbacks.paypalWebhookUrl);
  const paypalClientId = env['PAYPAL_CLIENT_ID']?.trim() || savedSettings.get('paypal_client_id');
  const paypalClientSecret = env['PAYPAL_CLIENT_SECRET']?.trim() || savedSettings.get('paypal_client_secret');
  const paypalWebhookId = env['PAYPAL_WEBHOOK_ID']?.trim() || savedSettings.get('paypal_webhook_id');
  const paypalCredentialsConfigured = Boolean(paypalClientId && paypalClientSecret);
  const paypalWebhookIdConfigured = Boolean(paypalWebhookId);

  const readinessForUrl = (url: string | null): { url: string | null; urlReady: boolean; ready: boolean; error: string | null } => {
    if (!url) {
      return {
        url: null,
        urlReady: false,
        ready: false,
        error: 'PayPal webhook URL is waiting on a public dashboard URL.',
      };
    }

    if (!paypalCredentialsConfigured) {
      return {
        url,
        urlReady: true,
        ready: false,
        error: 'PayPal Client ID and Client Secret are required before setup can finalize.',
      };
    }

    if (!paypalWebhookIdConfigured) {
      return {
        url,
        urlReady: true,
        ready: false,
        error: 'PayPal Webhook ID is required before setup can finalize.',
      };
    }

    return { url, urlReady: true, ready: true, error: null };
  };

  if (runtimeCallbacks.publicCallbackBaseUrl) {
    if (derivedWebhookUrl) {
      return readinessForUrl(derivedWebhookUrl);
    }

    if (runtimeCallbacks.publicCallbackRequired) {
      return {
        url: null,
        urlReady: false,
        ready: false,
        error: runtimeCallbacks.publicCallbackError
          ?? 'PayPal webhook URL is waiting on a public HTTPS callback URL.',
      };
    }
  }

  const explicitWebhookUrl = env['PAYPAL_WEBHOOK_URL'] || savedSettings.get('paypal_webhook_url');
  const explicitWebhookError = getSetupPayPalWebhookUrlError(explicitWebhookUrl);
  if (explicitWebhookUrl?.trim() && explicitWebhookError) {
    return { url: null, urlReady: false, ready: false, error: explicitWebhookError };
  }

  if (explicitWebhookUrl?.trim()) {
    return readinessForUrl(normalizeSetupPayPalWebhookUrl(explicitWebhookUrl));
  }

  return {
    url: null,
    urlReady: false,
    ready: false,
    error: 'PayPal webhook URL is waiting on a public dashboard URL.',
  };
}

function getRequiredPayPalReadinessError(
  credentials: Record<string, string>,
  savedSettings: SetupSettingMap = new Map(),
): string | null {
  const paypalClientId = credentials.paypal_client_id?.trim()
    || process.env['PAYPAL_CLIENT_ID']?.trim()
    || savedSettings.get('paypal_client_id');
  const paypalClientSecret = credentials.paypal_client_secret?.trim()
    || process.env['PAYPAL_CLIENT_SECRET']?.trim()
    || savedSettings.get('paypal_client_secret');
  const paypalWebhookId = credentials.paypal_webhook_id?.trim()
    || process.env['PAYPAL_WEBHOOK_ID']?.trim()
    || savedSettings.get('paypal_webhook_id');
  const paypalWebhookUrl = credentials.paypal_webhook_url?.trim()
    || process.env['PAYPAL_WEBHOOK_URL']?.trim()
    || savedSettings.get('paypal_webhook_url');

  if (!paypalWebhookUrl) {
    return 'PayPal webhook URL is required before setup can finalize.';
  }

  const webhookUrlError = getSetupPayPalWebhookUrlError(paypalWebhookUrl);
  if (webhookUrlError) return webhookUrlError;

  if (!paypalClientId || !paypalClientSecret) {
    return 'PayPal Client ID and Client Secret are required before setup can finalize.';
  }

  if (!paypalWebhookId) {
    return 'PayPal Webhook ID is required before setup can finalize.';
  }

  return null;
}

function validateBrowserSupabaseConfigForFinalize(
  credentials: Record<string, string | undefined>,
  savedSettings: SetupSettingMap,
): string | null {
  if (process.env.SOMNIBOT_DASHBOARD_LOCAL_MODE === '1') {
    return null;
  }

  let browserConfig: ReturnType<typeof requireBrowserSupabaseConfig>;
  try {
    browserConfig = requireBrowserSupabaseConfig(readBuildBrowserSupabaseConfig());
  } catch {
    return 'Remote dashboard auth requires NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY at build time before setup can finalize. Rebuild/redeploy with public Supabase env, then finalize setup.';
  }

  const expectedUrl = credentials.supabase_url?.trim()
    || savedSettings.get('supabase_url')?.trim()
    || process.env.SUPABASE_URL?.trim()
    || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
    || browserConfig.url;
  const expectedPublishableKey = credentials.supabase_publishable_key?.trim()
    || process.env.SUPABASE_PUBLISHABLE_KEY?.trim()
    || savedSettings.get('supabase_publishable_key')?.trim()
    || credentials.supabase_anon_key?.trim()
    || savedSettings.get('supabase_anon_key')?.trim()
    || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim()
    || process.env.SUPABASE_ANON_KEY?.trim()
    || browserConfig.publishableKey;

  if (normalizeRuntimeBaseUrl(expectedUrl) !== normalizeRuntimeBaseUrl(browserConfig.url)) {
    return 'Remote dashboard auth public Supabase URL does not match the configured Supabase project. Rebuild/redeploy with matching NEXT_PUBLIC_SUPABASE_URL before finalizing setup.';
  }

  if (expectedPublishableKey !== browserConfig.publishableKey) {
    return 'Remote dashboard auth public Supabase publishable key does not match the configured Supabase project. Rebuild/redeploy with matching NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY before finalizing setup.';
  }

  return null;
}

async function getOwnerRuntimeReadiness(
  supabase: SupabaseClient,
  configuredGuildId: string | null = null,
): Promise<OwnerRuntimeReadiness> {
  if (!configuredGuildId) {
    return {
      botOnline: false,
      guildDetected: false,
      guildId: null,
      guildName: null,
    };
  }

  const { data: guild } = await supabase
    .from('guild')
    .select('id, name')
    .eq('id', configuredGuildId)
    .limit(1)
    .maybeSingle() as { data: { id: string; name: string | null } | null };

  if (!guild?.id) {
    return {
      botOnline: false,
      guildDetected: false,
      guildId: null,
      guildName: null,
    };
  }

  let botOnline = false;
  const { data: diag } = await supabase
    .from('bot_diagnostics')
    .select('snapshot_at')
    .eq('guild_id', guild.id)
    .eq('type', 'health')
    .order('snapshot_at', { ascending: false })
    .limit(1)
    .maybeSingle() as { data: { snapshot_at: string } | null };

  if (diag?.snapshot_at) {
    const lastSnapshot = new Date(diag.snapshot_at).getTime();
    botOnline = Number.isFinite(lastSnapshot) && Date.now() - lastSnapshot < 5 * 60 * 1000;
  }

  if (!botOnline) {
    botOnline = await isBotLevelHeartbeatOnline(guild.id);
  }

  return {
    botOnline,
    guildDetected: true,
    guildId: guild.id,
    guildName: guild.name,
  };
}

async function isBotLevelHeartbeatOnline(configuredGuildId: string): Promise<boolean> {
  try {
    const { readValkeyKey } = await import('@/lib/api/rate-limit');
    const heartbeatRaw = await readValkeyKey(BOT_HEARTBEAT_KEY);
    if (!heartbeatRaw) return false;

    const heartbeat = JSON.parse(heartbeatRaw) as { timestamp?: unknown; guildIds?: unknown };
    const timestamp = typeof heartbeat.timestamp === 'number'
      ? heartbeat.timestamp
      : Number(heartbeat.timestamp);

    const guildIds = Array.isArray(heartbeat.guildIds)
      ? heartbeat.guildIds.filter((id): id is string => typeof id === 'string')
      : [];

    return Number.isFinite(timestamp)
      && Date.now() - timestamp < BOT_HEARTBEAT_STALE_MS
      && guildIds.includes(configuredGuildId);
  } catch {
    return false;
  }
}

function publicCallbackNotReadyResponse(runtimeCallbacks: RuntimeCallbackConfig) {
  return NextResponse.json(
    {
      ok: false,
      error: runtimeCallbacks.publicCallbackError,
      publicCallbackReady: false,
      setupLocked: false,
    },
    { status: 400 },
  );
}

export async function GET(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'standard');
  if (rateLimited) return rateLimited;

  const supabase = createSetupSupabase();
  const runtimeCallbacks = resolveRuntimeCallbackConfig();
  const paypalWebhookStatus = resolveSetupPayPalWebhookStatus(runtimeCallbacks);
  const status = {
    supabaseConnected: false,
    databaseInitialized: false,
    botOnline: false,
    guildDetected: false,
    guildId: null as string | null,
    guildName: null as string | null,
    dashboardUrl: runtimeCallbacks.publicCallbackBaseUrl || runtimeCallbacks.operatorDashboardUrl || null,
    operatorDashboardUrl: runtimeCallbacks.operatorDashboardUrl,
    publicCallbackBaseUrl: runtimeCallbacks.publicCallbackBaseUrl,
    paypalWebhookUrl: paypalWebhookStatus.url,
    paypalWebhookReady: paypalWebhookStatus.ready,
    paypalWebhookUrlReady: paypalWebhookStatus.urlReady,
    paypalWebhookError: paypalWebhookStatus.error,
    paypalCredentialsConfigured: Boolean(process.env['PAYPAL_CLIENT_ID']?.trim() && process.env['PAYPAL_CLIENT_SECRET']?.trim()),
    paypalWebhookIdConfigured: Boolean(process.env['PAYPAL_WEBHOOK_ID']?.trim()),
    publicCallbackRequired: runtimeCallbacks.publicCallbackRequired,
    publicCallbackReady: runtimeCallbacks.publicCallbackReady,
    publicCallbackError: runtimeCallbacks.publicCallbackError,
    supabaseProjectRef: getSupabaseProjectRef(),
    discordClientId: process.env.DISCORD_APPLICATION_ID || null,
    discordCredentialsPresent: Boolean(process.env.DISCORD_APPLICATION_ID && process.env.DISCORD_CLIENT_SECRET),
    discordAuthProviderReady: false,
    discordAuthConfigured: false,
    discordAuthProviderStatus: null as ReturnType<typeof toPublicDiscordAuthProviderStatus> | null,
    setupCompleted: false,
  };

  if (!supabase) {
    return NextResponse.json(status);
  }

  // Check Supabase connection
  try {
    const { error } = await supabase.from('guild').select('id').limit(0);
    if (!error) {
      status.supabaseConnected = true;
      status.databaseInitialized = true;
    } else if (error.code === '42P01') {
      // Table doesn't exist — connected but not initialized
      status.supabaseConnected = true;
      status.databaseInitialized = false;
    }
  } catch {
    status.supabaseConnected = false;
  }

  // Check if bot is online and guild is detected
  if (status.databaseInitialized) {
    // Check setup lock
    const { isCompleted } = await getSetupLock(supabase);
    status.setupCompleted = isCompleted;

    const savedSettings = await readSetupInstanceSettings(supabase, [
      'discord_application_id',
      'discord_client_secret',
      'discord_guild_id',
      'paypal_client_id',
      'paypal_client_secret',
      'paypal_webhook_id',
      'paypal_webhook_url',
    ]);

    const runtimeReadiness = await getOwnerRuntimeReadiness(
      supabase,
      getConfiguredDiscordGuildId(savedSettings),
    );
    status.guildDetected = runtimeReadiness.guildDetected;
    status.guildId = runtimeReadiness.guildId;
    status.guildName = runtimeReadiness.guildName;
    status.botOnline = runtimeReadiness.botOnline;

    const savedPayPalStatus = resolveSetupPayPalWebhookStatus(runtimeCallbacks, process.env, savedSettings);
    status.paypalWebhookUrl = savedPayPalStatus.url;
    status.paypalWebhookReady = savedPayPalStatus.ready;
    status.paypalWebhookUrlReady = savedPayPalStatus.urlReady;
    status.paypalWebhookError = savedPayPalStatus.error;
    status.paypalCredentialsConfigured = Boolean(
      (process.env['PAYPAL_CLIENT_ID']?.trim() || savedSettings.get('paypal_client_id'))
      && (process.env['PAYPAL_CLIENT_SECRET']?.trim() || savedSettings.get('paypal_client_secret')),
    );
    status.paypalWebhookIdConfigured = Boolean(
      process.env['PAYPAL_WEBHOOK_ID']?.trim() || savedSettings.get('paypal_webhook_id'),
    );

    // Check if Discord creds exist in instance_settings (for display purposes)
    if (!status.discordCredentialsPresent) {
      if (savedSettings.has('discord_application_id') && savedSettings.has('discord_client_secret')) {
        status.discordCredentialsPresent = true;
        status.discordClientId ||= savedSettings.get('discord_application_id') ?? null;
      }
    }
  }

  const authProviderStatus = await getDiscordAuthProviderStatus({
    timeoutMs: SETUP_STATUS_AUTH_PROVIDER_TIMEOUT_MS,
  });
  status.discordAuthProviderReady = authProviderStatus.ready;
  status.discordAuthConfigured = authProviderStatus.ready;
  status.discordAuthProviderStatus = toPublicDiscordAuthProviderStatus(authProviderStatus);

  return NextResponse.json(status);
}

export async function POST(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;

  const parsed = await parseBody(request, schemas.setup.action);
  if (!parsed.ok) return parsed.response;
  // V5 Audit §8.P3a — removed `as any`; use Zod-inferred type
  const body = parsed.data;
  const { action } = body;

  // ── Maintenance unlock (requires authenticated owner) ───────
  if (action === 'unlock-maintenance') {
    const auth = await requireGuildOwner();
    if (!auth.ok) return auth.response;

    const supabase = createSetupSupabase();
    if (!supabase) {
      return NextResponse.json({ error: 'No Supabase connection' }, { status: 500 });
    }

    const until = new Date(Date.now() + MAINTENANCE_TTL_MS).toISOString();
    await supabase
      .from('instance_settings')
      .upsert(
        { key: 'setup_maintenance_until', value: until, section: 'system', updated_at: new Date().toISOString() },
        { onConflict: 'key' },
      );

    return NextResponse.json({ ok: true, maintenanceUntil: until });
  }

  // ── For credential-mutation actions, enforce setup lock ─────
  const credentialActions = new Set([
    'verify-discord',
    'verify-supabase',
    'finalize',
    'configure-auth',
  ]);

  if (credentialActions.has(action)) {
    const supabase = createSetupSupabase();
    if (supabase) {
      const { isCompleted, maintenanceActive } = await getSetupLock(supabase);

      if (isCompleted && !maintenanceActive) {
        return NextResponse.json(
          {
            error: 'Setup is locked. Authenticate as the guild owner and call unlock-maintenance first.',
            setupLocked: true,
          },
          { status: 403 },
        );
      }
    }
  }

  let authProviderRuntimeCallbacks: RuntimeCallbackConfig | null = null;
  const verifyDiscordWithClientSecret = action === 'verify-discord' && Boolean(body.clientSecret?.trim());
  const mutatesAuthProvider = action === 'configure-auth' || action === 'finalize' || verifyDiscordWithClientSecret;
  if (mutatesAuthProvider) {
    authProviderRuntimeCallbacks = resolveRuntimeCallbackConfig();
    if (!authProviderRuntimeCallbacks.publicCallbackReady) {
      return publicCallbackNotReadyResponse(authProviderRuntimeCallbacks);
    }
  }

  // Step 1: Verify Discord credentials
  if (action === 'verify-discord') {
    const { token, clientId, clientSecret } = body;
    if (!token || !clientId || !clientSecret?.trim()) {
      return NextResponse.json({ error: 'Missing token, clientId, or clientSecret' }, { status: 400 });
    }

    try {
      const res = await fetch('https://discord.com/api/v10/users/@me', {
        headers: { Authorization: `Bot ${token}` },
      });

      if (!res.ok) {
        return NextResponse.json({ valid: false, error: 'Invalid bot token' });
      }

      const botUser = await res.json();

      // Save validated Discord credentials to instance_settings
      const supabase = createSetupSupabase();
      let credentialsSaved = false;
      if (supabase) {
        const creds: Record<string, { value: string; section: string }> = {
          discord_bot_token: { value: token, section: 'discord' },
          discord_application_id: { value: clientId, section: 'discord' },
          discord_client_secret: { value: clientSecret.trim(), section: 'discord' },
        };

        for (const [key, { value, section }] of Object.entries(creds)) {
          await supabase
            .from('instance_settings')
            .upsert(
              { key, value, section, updated_at: new Date().toISOString() },
              { onConflict: 'key' },
            );
        }
        credentialsSaved = true;
        console.log('[Setup] ✅ Discord credentials saved to instance_settings');

        // Auto-configure Discord OAuth in Supabase if we have the access token
        const authResult = await ensureDiscordAuthProvider();
        if (authResult.success) {
          console.log(
            authResult.alreadyConfigured
              ? '[Setup] Discord auth provider already configured'
              : '[Setup] ✅ Discord auth provider auto-configured in Supabase',
          );
        } else {
          console.warn('[Setup] ⚠️  Could not auto-configure Discord auth:', authResult.error);
        }
      }

      return NextResponse.json({
        valid: true,
        botUsername: botUser.username,
        botId: botUser.id,
        botAvatar: botUser.avatar
          ? `https://cdn.discordapp.com/avatars/${botUser.id}/${botUser.avatar}.png`
          : null,
        credentialsSaved,
      });
    } catch (err) {
      // V11 Audit R5-1: Was returning String(err) — leaks internal network/fetch
      // error details to the client. Generic message covers both Discord
      // verification and credential-persistence failures since the catch
      // scope includes Supabase upserts and auth-provider configuration.
      console.error('[setup/verify-discord] Error:', err);
      return NextResponse.json({ valid: false, error: 'Discord verification failed — please try again or check the server logs for details' });
    }
  }

  // Step 2: Verify Supabase credentials
  if (action === 'verify-supabase') {
    const { url, serviceRoleKey, publishableKey } = body;
    if (!url || !serviceRoleKey || !publishableKey) {
      return NextResponse.json({ error: 'Missing url, publishableKey, or serviceRoleKey' }, { status: 400 });
    }

    try {
      const supabase = createClient(url, serviceRoleKey);
      // Try a simple query — if table doesn't exist yet, that's OK (connection works)
      const { error } = await supabase.from('guild').select('id').limit(0);

      if (!error || error.code === '42P01') {
        const trimmedPublishableKey = publishableKey.trim();
        if (!await verifySupabasePublishableKey(url, trimmedPublishableKey)) {
          return NextResponse.json({ valid: false, error: 'Could not validate Supabase publishable key — check your credentials' });
        }

        applyRuntimeSupabaseEnv({
          url,
          secretKey: serviceRoleKey,
          publishableKey: trimmedPublishableKey,
        });

        // Save Supabase credentials to instance_settings (if tables exist)
        if (!error) {
          const creds: Record<string, { value: string; section: string }> = {
            supabase_url: { value: url, section: 'supabase' },
            supabase_secret_key: { value: serviceRoleKey, section: 'supabase' },
          };
          creds.supabase_anon_key = { value: trimmedPublishableKey, section: 'supabase' };

          for (const [key, { value, section }] of Object.entries(creds)) {
            await supabase
              .from('instance_settings')
              .upsert(
                { key, value, section, updated_at: new Date().toISOString() },
                { onConflict: 'key' },
              );
          }
          console.log('[Setup] ✅ Supabase credentials saved to instance_settings');
        }

        return NextResponse.json({
          valid: true,
          initialized: !error, // true if tables exist
          credentialsSaved: !error,
        });
      }

      console.error('[setup/validate-supabase] DB error:', error.message);
      return NextResponse.json({ valid: false, error: 'Could not connect to Supabase — check your credentials' });
    } catch (err) {
      console.error('[setup/validate-supabase] Error:', err);
      return NextResponse.json({ valid: false, error: 'Could not connect to Supabase — check your credentials' });
    }
  }

  // Step 3: Generate bot invite URL
  if (action === 'generate-invite') {
    const clientId = body.clientId || process.env.DISCORD_APPLICATION_ID;
    if (!clientId) {
      return NextResponse.json({ error: 'No client ID available' }, { status: 400 });
    }

    const permissions = '8'; // Administrator
    const scopes = 'bot%20applications.commands';
    const inviteUrl = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&permissions=${permissions}&scope=${scopes}`;

    return NextResponse.json({ inviteUrl });
  }

  // Step 4: Configure Discord OAuth in Supabase (can be called independently)
  if (action === 'configure-auth') {
    const result = await ensureDiscordAuthProvider();
    return NextResponse.json(result);
  }

  // Step 5: Finalize setup — save any remaining credentials, mark setup complete
  if (action === 'finalize') {
    const supabase = createSetupSupabase();
    if (!supabase) {
      return NextResponse.json({ error: 'No Supabase connection' }, { status: 500 });
    }
    const runtimeCallbacks = authProviderRuntimeCallbacks ?? resolveRuntimeCallbackConfig();

    // V11 Re-Audit L-1: Whitelist of credential keys accepted during finalize.
    // Previously any key was accepted, allowing arbitrary writes to instance_settings.
    const ALLOWED_CREDENTIAL_KEYS = new Set([
      'discord_bot_token',
      'discord_application_id',
      'discord_client_secret',
      'discord_guild_id',
      'paypal_client_id',
      'paypal_client_secret',
      'paypal_webhook_id',
      'paypal_webhook_url',
      'paypal_sandbox',
      'lavalink_host',
      'lavalink_port',
      'lavalink_password',
      'valkey_url',
      'supabase_url',
      'supabase_anon_key',
      'supabase_publishable_key',
      'supabase_secret_key',
      'supabase_access_token',
      'supabase_db_url',
      'dashboard_url',
    ]);

    const SECTION_BY_PREFIX: Record<string, string> = {
      discord_: 'discord',
      supabase_: 'supabase',
      paypal_: 'paypal',
      lavalink_: 'lavalink',
      valkey_: 'valkey',
      dashboard_: 'deployment',
    };

    // Save any additional credentials passed in
    const credentials = {
      ...(((body as Record<string, unknown>).credentials as Record<string, string> | undefined) ?? {}),
    };
    if (runtimeCallbacks.publicCallbackBaseUrl && !credentials.dashboard_url?.trim()) {
      credentials.dashboard_url = runtimeCallbacks.publicCallbackBaseUrl;
    }
    const runtimePayPalWebhookUrl = normalizeSetupPayPalWebhookUrl(runtimeCallbacks.paypalWebhookUrl);
    const submittedPayPalWebhookUrl = credentials.paypal_webhook_url?.trim();
    if (
      runtimePayPalWebhookUrl
      && (
        runtimeCallbacks.publicCallbackRequired
        || runtimeCallbacks.publicCallbackBaseUrl
        || !submittedPayPalWebhookUrl
        || getSetupPayPalWebhookUrlError(submittedPayPalWebhookUrl)
      )
    ) {
      credentials.paypal_webhook_url = runtimePayPalWebhookUrl;
    } else if (submittedPayPalWebhookUrl) {
      const submittedPayPalWebhookError = getSetupPayPalWebhookUrlError(submittedPayPalWebhookUrl);
      if (submittedPayPalWebhookError) {
        return NextResponse.json(
          { ok: false, error: submittedPayPalWebhookError, setupLocked: false },
          { status: 400 },
        );
      }
      credentials.paypal_webhook_url = normalizeSetupPayPalWebhookUrl(submittedPayPalWebhookUrl) ?? submittedPayPalWebhookUrl;
    }

    const savedSetupSettings = await readSetupInstanceSettings(supabase, [
      'discord_guild_id',
      'supabase_url',
      'supabase_anon_key',
      'supabase_publishable_key',
      'paypal_client_id',
      'paypal_client_secret',
      'paypal_webhook_id',
      'paypal_webhook_url',
    ]);
    const payPalReadinessError = getRequiredPayPalReadinessError(credentials, savedSetupSettings);
    if (payPalReadinessError) {
      return NextResponse.json(
        { ok: false, error: payPalReadinessError, setupLocked: false },
        { status: 400 },
      );
    }

    let submittedSupabaseAccessToken: string | undefined;
    if (Object.keys(credentials).length > 0) {
      const submittedRuntimeConfig: { url?: string; publishableKey?: string; secretKey?: string } = {};
      const submittedPayPalConfig: {
        clientId?: string;
        clientSecret?: string;
        webhookId?: string;
        webhookUrl?: string;
        sandbox?: string;
      } = {};

      for (const [key, value] of Object.entries(credentials)) {
        if (!value?.trim()) continue;
        const trimmedValue = value.trim();

        // Reject unknown keys
        if (!ALLOWED_CREDENTIAL_KEYS.has(key)) {
          console.warn(`[Setup] Rejected unknown credential key: ${key}`);
          continue;
        }

        if (key === 'supabase_access_token') {
          submittedSupabaseAccessToken = trimmedValue;
        } else if (key === 'supabase_url') {
          submittedRuntimeConfig.url = trimmedValue;
        } else if (key === 'supabase_anon_key' || key === 'supabase_publishable_key') {
          submittedRuntimeConfig.publishableKey = trimmedValue;
        } else if (key === 'supabase_secret_key') {
          submittedRuntimeConfig.secretKey = trimmedValue;
        } else if (key === 'paypal_client_id') {
          submittedPayPalConfig.clientId = trimmedValue;
        } else if (key === 'paypal_client_secret') {
          submittedPayPalConfig.clientSecret = trimmedValue;
        } else if (key === 'paypal_webhook_id') {
          submittedPayPalConfig.webhookId = trimmedValue;
        } else if (key === 'paypal_webhook_url') {
          submittedPayPalConfig.webhookUrl = trimmedValue;
        } else if (key === 'paypal_sandbox') {
          submittedPayPalConfig.sandbox = trimmedValue;
        }

        // Determine section from key prefix
        const section = Object.entries(SECTION_BY_PREFIX).find(
          ([prefix]) => key.startsWith(prefix),
        )?.[1] ?? 'general';

        await supabase
          .from('instance_settings')
          .upsert(
            { key, value: trimmedValue, section, updated_at: new Date().toISOString() },
            { onConflict: 'key' },
          );
      }

      applyRuntimeSupabaseEnv(submittedRuntimeConfig);
      applyRuntimePayPalEnv(submittedPayPalConfig);
    }

    const browserSupabaseError = validateBrowserSupabaseConfigForFinalize(credentials, savedSetupSettings);
    if (browserSupabaseError) {
      return NextResponse.json(
        {
          ok: false,
          error: browserSupabaseError,
          setupLocked: false,
        },
        { status: 400 },
      );
    }

    // Ensure Discord auth provider is configured
    const authResult = await ensureDiscordAuthProvider({
      accessToken: submittedSupabaseAccessToken,
    });
    if (!authResult.success) {
      console.warn('[Setup] Could not finalize setup because Discord auth is not configured:', authResult.error);
      return NextResponse.json(
        {
          ok: false,
          error: authResult.error
            || 'Discord auth provider could not be configured. Set SUPABASE_ACCESS_TOKEN, or configure Discord auth manually and set SUPABASE_DISCORD_AUTH_PROVIDER_CONFIGURED=true before finalizing setup.',
          authConfigured: false,
          authError: authResult.error || null,
          setupLocked: false,
        },
        { status: 400 },
      );
    }

    const runtimeReadiness = await getOwnerRuntimeReadiness(
      supabase,
      getConfiguredDiscordGuildId(savedSetupSettings, credentials),
    );
    if (!runtimeReadiness.guildDetected) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Invite SomniBot to a Discord server before setup can finalize.',
          setupLocked: false,
        },
        { status: 400 },
      );
    }

    if (!runtimeReadiness.botOnline) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Start SomniBot and wait for a fresh bot health heartbeat before setup can finalize.',
          setupLocked: false,
        },
        { status: 400 },
      );
    }

    // ── LOCK: Mark setup as completed ──
    await supabase
      .from('instance_settings')
      .upsert(
        {
          key: 'setup_completed_at',
          value: new Date().toISOString(),
          section: 'system',
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'key' },
      );

    console.log('[Setup] 🔒 Setup finalized and locked');

    return NextResponse.json({
      ok: true,
      authConfigured: authResult.success,
      authError: authResult.error || null,
      setupLocked: true,
    });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
