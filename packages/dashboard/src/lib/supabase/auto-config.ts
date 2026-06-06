/**
 * Auto-configure Supabase Discord OAuth provider.
 *
 * Uses the Supabase Management API to enable Discord as an auth provider
 * so operators never touch the Supabase dashboard manually.
 *
 * Requires SUPABASE_ACCESS_TOKEN (personal access token from supabase.com/dashboard/account/tokens).
 * Reads Discord Client ID + Secret from env vars or instance_settings.
 */

import { createAdminSupabase } from './admin';

interface AutoConfigResult {
  success: boolean;
  error?: string;
  alreadyConfigured?: boolean;
}

interface DashboardUrlEnv {
  NEXT_PUBLIC_APP_URL?: string;
  VERCEL_URL?: string;
}

/**
 * Extract Supabase project ref from the project URL.
 * e.g. "https://YOUR_PROJECT.supabase.co" → "YOUR_PROJECT_REF"
 */
function getProjectRef(): string | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';
  const match = url.match(/https:\/\/([a-z0-9]+)\.supabase\.co/);
  return match ? match[1] : null;
}

/**
 * Get the Supabase Management API access token.
 */
function getAccessToken(): string | null {
  return process.env.SUPABASE_ACCESS_TOKEN || null;
}

/**
 * Resolve the dashboard's public base URL for Supabase auth callback allow-listing.
 */
export function getDashboardBaseUrl(env?: DashboardUrlEnv): string {
  const appUrl = (env?.NEXT_PUBLIC_APP_URL ?? process.env.NEXT_PUBLIC_APP_URL)?.trim();
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
 * Check if Discord auth provider is already enabled in Supabase.
 */
async function isDiscordProviderEnabled(
  projectRef: string,
  accessToken: string,
): Promise<boolean> {
  try {
    const res = await fetch(
      `https://api.supabase.com/v1/projects/${projectRef}/config/auth`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      },
    );

    if (!res.ok) return false;

    const config = await res.json();
    return config.EXTERNAL_DISCORD_ENABLED === true;
  } catch {
    return false;
  }
}

/**
 * Enable Discord as an OAuth provider in Supabase.
 * Also adds the dashboard callback URL to the redirect allow list.
 */
export async function ensureDiscordAuthProvider(): Promise<AutoConfigResult> {
  const projectRef = getProjectRef();
  if (!projectRef) {
    return { success: false, error: 'Could not extract Supabase project ref from URL' };
  }

  const accessToken = getAccessToken();
  if (!accessToken) {
    return {
      success: false,
      error: 'SUPABASE_ACCESS_TOKEN not set — cannot auto-configure auth provider. Set it in env vars or configure Discord auth manually in Supabase dashboard.',
    };
  }

  // Check if already configured
  const alreadyEnabled = await isDiscordProviderEnabled(projectRef, accessToken);
  if (alreadyEnabled) {
    return { success: true, alreadyConfigured: true };
  }

  // Get Discord credentials
  const { clientId, clientSecret } = await getDiscordCredentials();
  if (!clientId || !clientSecret) {
    return {
      success: false,
      error: 'Discord Client ID and Client Secret are required. Set DISCORD_APPLICATION_ID and DISCORD_CLIENT_SECRET in env vars.',
    };
  }

  // Build the callback/redirect URL
  const dashboardUrl = getDashboardBaseUrl();

  const supabaseCallbackUrl = `${process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL}/auth/v1/callback`;

  try {
    // First, get current auth config to preserve existing settings
    const currentRes = await fetch(
      `https://api.supabase.com/v1/projects/${projectRef}/config/auth`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      },
    );

    let currentAllowList = '';
    if (currentRes.ok) {
      const currentConfig = await currentRes.json();
      currentAllowList = currentConfig.URI_ALLOW_LIST || '';
    }

    // Append dashboard callback URL to allow list if not already there
    const callbackPath = `${dashboardUrl}/api/auth/callback`;
    const allowListEntries = currentAllowList ? currentAllowList.split(',').map((s: string) => s.trim()) : [];
    if (!allowListEntries.includes(callbackPath)) {
      allowListEntries.push(callbackPath);
    }

    // Enable Discord provider
    const res = await fetch(
      `https://api.supabase.com/v1/projects/${projectRef}/config/auth`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          EXTERNAL_DISCORD_ENABLED: true,
          EXTERNAL_DISCORD_CLIENT_ID: clientId,
          EXTERNAL_DISCORD_SECRET: clientSecret,
          URI_ALLOW_LIST: allowListEntries.filter(Boolean).join(','),
        }),
      },
    );

    if (!res.ok) {
      const errBody = await res.text();
      return { success: false, error: `Supabase Management API error (${res.status}): ${errBody}` };
    }

    console.log('[AutoConfig] ✅ Discord OAuth provider enabled in Supabase');
    return { success: true, alreadyConfigured: false };
  } catch (err) {
    return { success: false, error: `Failed to configure Discord auth: ${err}` };
  }
}
