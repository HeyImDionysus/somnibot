/**
 * Auto-configure Supabase Discord OAuth provider.
 *
 * Uses the Supabase Management API to enable Discord as an auth provider
 * so operators never touch the Supabase dashboard manually.
 *
 * Requires SUPABASE_ACCESS_TOKEN (personal access token from supabase.com/dashboard/account/tokens),
 * unless SUPABASE_DISCORD_AUTH_PROVIDER_CONFIGURED=true confirms manual provider setup.
 * Reads Discord Client ID + Secret from env vars or instance_settings.
 */

import { createAdminSupabase } from './admin';

interface AutoConfigResult {
  success: boolean;
  error?: string;
  alreadyConfigured?: boolean;
}

interface DiscordAuthProviderStatus {
  ready: boolean;
  providerEnabled: boolean;
  callbackAllowListReady: boolean;
  missingCallbackUrls: string[];
  manualConfigured: boolean;
  error?: string;
}

interface DashboardUrlEnv {
  SOMNIBOT_PUBLIC_CALLBACK_BASE_URL?: string;
  NEXT_PUBLIC_APP_URL?: string;
  DASHBOARD_URL?: string;
  VERCEL_URL?: string;
}

interface AutoConfigOptions {
  accessToken?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Extract Supabase project ref from the project URL.
 * e.g. "https://YOUR_PROJECT.supabase.co" → "YOUR_PROJECT_REF"
 */
function getProjectRef(): string | null {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const match = url.match(/https:\/\/([a-z0-9]+)\.supabase\.co/);
  return match ? match[1] : null;
}

/**
 * Get the Supabase Management API access token.
 */
function getAccessToken(options?: AutoConfigOptions): string | null {
  return options?.accessToken?.trim() || process.env.SUPABASE_ACCESS_TOKEN || null;
}

function isManualDiscordAuthProviderConfigured(): boolean {
  return process.env.SUPABASE_DISCORD_AUTH_PROVIDER_CONFIGURED?.toLowerCase() === 'true';
}

function getAuthConfigUrl(projectRef: string) {
  return `https://api.supabase.com/v1/projects/${projectRef}/config/auth`;
}

/**
 * Resolve the dashboard's public base URL for Supabase auth callback allow-listing.
 */
export function getDashboardBaseUrl(env?: DashboardUrlEnv): string {
  const appUrl = [
    env?.SOMNIBOT_PUBLIC_CALLBACK_BASE_URL,
    process.env['SOMNIBOT_PUBLIC_CALLBACK_BASE_URL'],
    env?.NEXT_PUBLIC_APP_URL,
    process.env['NEXT_PUBLIC_APP_URL'],
  ]
    .map((value) => value?.trim())
    .find((value): value is string => Boolean(value));
  if (appUrl) {
    return appUrl.replace(/\/+$/, '');
  }

  const vercelUrl = (env?.VERCEL_URL ?? process.env.VERCEL_URL)?.trim();
  if (vercelUrl) {
    const withScheme = vercelUrl.startsWith('http://') || vercelUrl.startsWith('https://')
      ? vercelUrl
      : `https://${vercelUrl}`;
    return withScheme.replace(/\/+$/, '');
  }

  return 'http://localhost:3000';
}

function normalizeDashboardUrl(value?: string): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return trimmed.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export function getDashboardCallbackUrls(env?: DashboardUrlEnv): string[] {
  const bases = [
    getDashboardBaseUrl(env),
    normalizeDashboardUrl(env?.DASHBOARD_URL ?? process.env.DASHBOARD_URL),
  ].filter((base): base is string => Boolean(base));

  return [...new Set(bases)].map((base) => `${base}/api/auth/callback`);
}

function getAutoConfigAbortSignal(options?: AutoConfigOptions): AbortSignal | undefined {
  return options?.signal ?? (options?.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined);
}

async function fetchAuthConfig(projectRef: string, accessToken: string, options?: AutoConfigOptions): Promise<{
  ok: true;
  config: Record<string, unknown>;
} | {
  ok: false;
  error: string;
}> {
  const res = await fetch(
    getAuthConfigUrl(projectRef),
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      signal: getAutoConfigAbortSignal(options),
    },
  );

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    return { ok: false, error: `Supabase Management API error (${res.status}): ${errBody}` };
  }

  return { ok: true, config: await res.json() };
}

function getAllowListEntries(config: Record<string, unknown>): string[] {
  const rawAllowList = config.uri_allow_list ?? config.URI_ALLOW_LIST;
  const allowList = typeof rawAllowList === 'string' ? rawAllowList : '';
  return allowList
    ? allowList.split(',').map((entry) => entry.trim()).filter(Boolean)
    : [];
}

function getMissingCallbackUrls(config: Record<string, unknown>): string[] {
  const allowListEntries = getAllowListEntries(config);
  return getDashboardCallbackUrls().filter((callbackUrl) => !allowListEntries.includes(callbackUrl));
}

function buildAllowList(config: Record<string, unknown>) {
  const allowListEntries = getAllowListEntries(config);
  for (const callbackUrl of getMissingCallbackUrls(config)) {
    allowListEntries.push(callbackUrl);
  }

  return allowListEntries.join(',');
}

export async function getDiscordAuthProviderStatus(options?: AutoConfigOptions): Promise<DiscordAuthProviderStatus> {
  if (isManualDiscordAuthProviderConfigured()) {
    return {
      ready: true,
      providerEnabled: true,
      callbackAllowListReady: true,
      missingCallbackUrls: [],
      manualConfigured: true,
    };
  }

  const projectRef = getProjectRef();
  if (!projectRef) {
    return {
      ready: false,
      providerEnabled: false,
      callbackAllowListReady: false,
      missingCallbackUrls: getDashboardCallbackUrls(),
      manualConfigured: false,
      error: 'Could not extract Supabase project ref from URL',
    };
  }

  const accessToken = getAccessToken(options);
  if (!accessToken) {
    return {
      ready: false,
      providerEnabled: false,
      callbackAllowListReady: false,
      missingCallbackUrls: getDashboardCallbackUrls(),
      manualConfigured: false,
      error: 'SUPABASE_ACCESS_TOKEN not set',
    };
  }

  try {
    const current = await fetchAuthConfig(projectRef, accessToken, options);
    if (!current.ok) {
      return {
        ready: false,
        providerEnabled: false,
        callbackAllowListReady: false,
        missingCallbackUrls: getDashboardCallbackUrls(),
        manualConfigured: false,
        error: current.error,
      };
    }

    const providerEnabled = current.config.external_discord_enabled === true
      || current.config.EXTERNAL_DISCORD_ENABLED === true;
    const missingCallbackUrls = getMissingCallbackUrls(current.config);
    const callbackAllowListReady = missingCallbackUrls.length === 0;

    return {
      ready: providerEnabled && callbackAllowListReady,
      providerEnabled,
      callbackAllowListReady,
      missingCallbackUrls,
      manualConfigured: false,
    };
  } catch (err) {
    return {
      ready: false,
      providerEnabled: false,
      callbackAllowListReady: false,
      missingCallbackUrls: getDashboardCallbackUrls(),
      manualConfigured: false,
      error: `Failed to check Discord auth provider: ${err}`,
    };
  }
}

/**
 * Read Discord credentials from env vars, falling back to instance_settings.
 */
async function getDiscordCredentials(): Promise<{
  clientId: string | null;
  clientSecret: string | null;
}> {
  let clientId = process.env.DISCORD_APPLICATION_ID || null;
  let clientSecret = process.env.DISCORD_CLIENT_SECRET || null;

  if (clientId && clientSecret) {
    return { clientId, clientSecret };
  }

  // Fallback: read from instance_settings
  try {
    const admin = createAdminSupabase();
    const { data: settings } = await admin
      .from('instance_settings')
      .select('key, value')
      .in('key', ['discord_application_id', 'discord_client_secret'])
      .limit(1000);

    if (settings) {
      for (const row of settings) {
        if (row.key === 'discord_application_id' && row.value && !clientId) {
          clientId = row.value;
        }
        if (row.key === 'discord_client_secret' && row.value && !clientSecret) {
          clientSecret = row.value;
        }
      }
    }
  } catch {
    // Can't read instance_settings — that's OK
  }

  return { clientId, clientSecret };
}

/**
 * Enable Discord as an OAuth provider in Supabase.
 * Also adds the dashboard callback URL to the redirect allow list.
 */
export async function ensureDiscordAuthProvider(options?: AutoConfigOptions): Promise<AutoConfigResult> {
  const projectRef = getProjectRef();
  if (!projectRef) {
    return { success: false, error: 'Could not extract Supabase project ref from URL' };
  }

  if (isManualDiscordAuthProviderConfigured()) {
    return { success: true, alreadyConfigured: true };
  }

  const accessToken = getAccessToken(options);
  if (!accessToken) {
    return {
      success: false,
      error: 'SUPABASE_ACCESS_TOKEN not set — cannot auto-configure auth provider. Set it in env vars, or manually configure Discord auth in Supabase and set SUPABASE_DISCORD_AUTH_PROVIDER_CONFIGURED=true.',
    };
  }

  try {
    const current = await fetchAuthConfig(projectRef, accessToken, options);
    const currentConfig = current.ok ? current.config : {};
    const providerEnabled = current.ok && (
      currentConfig.external_discord_enabled === true
      || currentConfig.EXTERNAL_DISCORD_ENABLED === true
    );
    const allowListReady = current.ok && getMissingCallbackUrls(currentConfig).length === 0;

    if (providerEnabled && allowListReady) {
      return { success: true, alreadyConfigured: true };
    }

    const patchBody: Record<string, string | boolean> = {
      uri_allow_list: buildAllowList(currentConfig),
    };

    if (!providerEnabled) {
      const { clientId, clientSecret } = await getDiscordCredentials();
      if (!clientId || !clientSecret) {
        return {
          success: false,
          error: 'Discord Client ID and Client Secret are required. Set DISCORD_APPLICATION_ID and DISCORD_CLIENT_SECRET in env vars.',
        };
      }

      patchBody.external_discord_enabled = true;
      patchBody.external_discord_client_id = clientId;
      patchBody.external_discord_secret = clientSecret;
    }

    const res = await fetch(
      getAuthConfigUrl(projectRef),
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(patchBody),
      },
    );

    if (!res.ok) {
      const errBody = await res.text();
      return { success: false, error: `Supabase Management API error (${res.status}): ${errBody}` };
    }

    console.log(
      providerEnabled
        ? '[AutoConfig] ✅ Discord OAuth callback allow-list updated in Supabase'
        : '[AutoConfig] ✅ Discord OAuth provider enabled in Supabase',
    );
    return { success: true, alreadyConfigured: false };
  } catch (err) {
    return { success: false, error: `Failed to configure Discord auth: ${err}` };
  }
}
