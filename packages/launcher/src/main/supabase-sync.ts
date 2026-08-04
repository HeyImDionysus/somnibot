/**
 * Supabase Sync — persists launcher credentials to Supabase `instance_settings`.
 *
 * Local electron-store is a cache for fast startup. Supabase is the source of
 * truth so credentials survive machine changes. Bootstrap creds (Supabase URL +
 * secret key) are always needed locally — everything else can be pulled from
 * Supabase on a new machine.
 *
 * Uses direct REST calls (no SDK dependency in the launcher).
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { canonicalSupabaseProjectOrigin } from './runtime-lease-client.js';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** Credentials that get synced to instance_settings. */
export interface SyncableCredentials {
  discordToken: string;
  discordApplicationId: string;
  discordClientSecret: string;
  discordGuildId: string;
  supabaseUrl: string;
  supabaseSecretKey: string;
  supabasePublishableKey: string;
  supabaseDbPassword: string;
  supabaseDbUrlTemplate?: string;
  supabaseAccessToken: string;
  supabaseDiscordAuthProviderConfigured: boolean;
  paypalClientId: string;
  paypalClientSecret: string;
  paypalWebhookId: string;
  paypalWebhookProofKey: string;
  paypalSandbox: boolean;
  lavalinkEnabled: boolean;
  publicCallbackBaseUrl: string;
  vpsDomain: string;
  vpsSshHost: string;
  vpsSshUser: string;
  vpsDeployPath: string;
  tailscaleAuthKey?: string;
  vpsCsrfSecret?: string;
  vpsNextAuthSecret?: string;
  vpsWebhookReplaySecret?: string;
  vpsValkeyPassword?: string;
  vpsLavalinkPassword?: string;
}

/** Complete set of existing SomniBot connection values the launcher can restore. */
export type RestorableCredentials = SyncableCredentials;

export type RestoredCredentials = Partial<RestorableCredentials>;

const RESTORED_SECRET_KEYS: ReadonlySet<keyof RestorableCredentials> = new Set([
  'discordToken',
  'discordClientSecret',
  'supabaseSecretKey',
  'supabaseDbPassword',
  'supabaseDbUrlTemplate',
  'supabaseAccessToken',
  'paypalClientSecret',
  'paypalWebhookId',
  'paypalWebhookProofKey',
  'tailscaleAuthKey',
  'vpsCsrfSecret',
  'vpsNextAuthSecret',
  'vpsWebhookReplaySecret',
  'vpsValkeyPassword',
  'vpsLavalinkPassword',
]);

export interface LauncherSettingsRow {
  key: string;
  value: string;
  section: string;
  updated_at?: string;
}

/** Keep restored secrets in the main process while preserving configured state in the UI. */
export function maskRestoredCredentials(
  credentials: RestoredCredentials,
  mask: string,
): RestoredCredentials {
  const masked: RestoredCredentials = { ...credentials };
  for (const key of RESTORED_SECRET_KEYS) {
    if (typeof masked[key] === 'string' && masked[key]) {
      (masked as Record<string, unknown>)[key] = mask;
    }
  }
  return masked;
}

/** Map from SyncableCredentials key → instance_settings row key.
 *
 * These keys must match what the bot's config-loader reads from
 * instance_settings (SETTINGS_TO_ENV in config-loader.ts). The bot
 * expects `discord_bot_token` (not `discord_token`), so we use that
 * here to ensure the launcher → DB → bot flow works on fresh starts.
 */
const BASE_SETTINGS_MAP: Record<keyof SyncableCredentials, string> = {
  discordToken: 'discord_bot_token',
  discordApplicationId: 'discord_application_id',
  discordClientSecret: 'discord_client_secret',
  discordGuildId: 'discord_guild_id',
  supabaseUrl: 'supabase_url',
  supabaseSecretKey: 'supabase_secret_key',
  supabasePublishableKey: 'supabase_publishable_key',
  supabaseDbPassword: 'supabase_db_password',
  supabaseDbUrlTemplate: 'supabase_db_url_template',
  supabaseAccessToken: 'supabase_access_token',
  supabaseDiscordAuthProviderConfigured: 'supabase_discord_auth_provider_configured',
  paypalClientId: 'paypal_client_id',
  paypalClientSecret: 'paypal_client_secret',
  paypalWebhookId: 'paypal_webhook_id',
  paypalWebhookProofKey: 'paypal_webhook_proof_key',
  paypalSandbox: 'paypal_sandbox',
  lavalinkEnabled: 'lavalink_enabled',
  publicCallbackBaseUrl: 'local_public_callback_base_url',
  vpsDomain: 'vps_domain',
  vpsSshHost: 'vps_ssh_host',
  vpsSshUser: 'vps_ssh_user',
  vpsDeployPath: 'vps_deploy_path',
  tailscaleAuthKey: 'tailscale_auth_key',
  vpsCsrfSecret: 'vps_csrf_secret',
  vpsNextAuthSecret: 'vps_nextauth_secret',
  vpsWebhookReplaySecret: 'vps_webhook_replay_secret',
  vpsValkeyPassword: 'vps_valkey_password',
  vpsLavalinkPassword: 'vps_lavalink_password',
};

const CLOUD_ENCRYPTED_PREFIX = 'somnibot-cloud-v1:';
const CLOUD_SECRET_INFO = Buffer.from('SomniBot launcher cross-machine credential sync v1', 'utf8');

function cloudSettingsKey(localKey: keyof SyncableCredentials): string {
  const baseKey = BASE_SETTINGS_MAP[localKey];
  return RESTORED_SECRET_KEYS.has(localKey) ? `${baseKey}_encrypted` : baseKey;
}

const PUSH_SETTINGS_MAP = Object.fromEntries(
  (Object.keys(BASE_SETTINGS_MAP) as Array<keyof SyncableCredentials>)
    .map((key) => [key, cloudSettingsKey(key)]),
) as Record<keyof SyncableCredentials, string>;

const RESTORE_SETTINGS_MAP: Record<keyof RestorableCredentials, string> = PUSH_SETTINGS_MAP;

function deriveCloudSyncKey(supabaseSecretKey: string, projectOrigin: string): Buffer {
  return Buffer.from(hkdfSync(
    'sha256',
    Buffer.from(supabaseSecretKey, 'utf8'),
    Buffer.from(projectOrigin, 'utf8'),
    CLOUD_SECRET_INFO,
    32,
  ));
}

function encryptCloudSecret(value: string, settingsKey: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(settingsKey, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${CLOUD_ENCRYPTED_PREFIX}${Buffer.concat([iv, tag, ciphertext]).toString('base64url')}`;
}

function decryptCloudSecret(value: string, settingsKey: string, key: Buffer): string | null {
  if (!value.startsWith(CLOUD_ENCRYPTED_PREFIX)) return null;
  try {
    const payload = Buffer.from(value.slice(CLOUD_ENCRYPTED_PREFIX.length), 'base64url');
    if (payload.length < 29) return null;
    const iv = payload.subarray(0, 12);
    const tag = payload.subarray(12, 28);
    const ciphertext = payload.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(settingsKey, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Keys written by earlier launcher builds or the Discord setup wizard. */
const RESTORE_ALIASES: Record<string, Exclude<keyof RestorableCredentials, 'paypalSandbox'>> = {
  discord_token: 'discordToken',
  discord_app_id: 'discordApplicationId',
  supabase_anon_key: 'supabasePublishableKey',
};

const BOOLEAN_SETTINGS: ReadonlySet<keyof RestorableCredentials> = new Set([
  'paypalSandbox',
  'supabaseDiscordAuthProviderConfigured',
  'lavalinkEnabled',
]);

const RESTORE_SETTING_KEYS = [
  ...new Set([
    ...Object.values(RESTORE_SETTINGS_MAP),
    ...Object.keys(RESTORE_ALIASES),
    // Older setup flows stored the derived callback but not the launcher's
    // local public base. Recover the base from this exact endpoint contract.
    'paypal_webhook_url',
  ]),
];

const SECTION = 'launcher';

/**
 * Build non-destructive cloud-sync rows.
 *
 * Blank local strings are deliberately omitted: a partial/older desktop cache
 * must never erase credentials that another SomniBot surface already saved in
 * Supabase. Save and restore intentionally use the same connection contract.
 */
export function buildSyncRows(
  credentials: SyncableCredentials,
  supabaseSecretKey: string,
  projectOrigin: string,
  updatedAt = new Date().toISOString(),
): LauncherSettingsRow[] {
  const cloudKey = deriveCloudSyncKey(supabaseSecretKey, projectOrigin);
  return Object.entries(PUSH_SETTINGS_MAP).flatMap(([localKey, settingsKey]) => {
    const key = localKey as keyof SyncableCredentials;
    const rawValue = credentials[key];
    if (rawValue === undefined) return [];
    if (typeof rawValue === 'string' && rawValue.trim().length === 0) return [];
    const value = RESTORED_SECRET_KEYS.has(key)
      ? encryptCloudSecret(String(rawValue), settingsKey, cloudKey)
      : String(rawValue);
    return [{ key: settingsKey, value, section: SECTION, updated_at: updatedAt }];
  });
}

/** Parse only values that are actually present, so restore merges safely. */
export function parseSyncRows(
  rows: Array<Pick<LauncherSettingsRow, 'key' | 'value'>>,
  supabaseSecretKey: string,
  projectOrigin: string,
): RestoredCredentials {
  const cloudKey = deriveCloudSyncKey(supabaseSecretKey, projectOrigin);
  const reverseMap: Record<string, keyof RestorableCredentials> = {};
  for (const [localKey, settingsKey] of Object.entries(RESTORE_SETTINGS_MAP)) {
    reverseMap[settingsKey] = localKey as keyof RestorableCredentials;
  }

  const credentials: RestoredCredentials = {};
  for (const row of rows) {
    if (row.key === 'paypal_webhook_url' && row.value) {
      try {
        const webhookUrl = new URL(row.value);
        const suffix = '/api/paypal/webhook';
        if (webhookUrl.protocol === 'https:' && webhookUrl.pathname.endsWith(suffix)) {
          webhookUrl.pathname = webhookUrl.pathname.slice(0, -suffix.length) || '/';
          webhookUrl.search = '';
          webhookUrl.hash = '';
          credentials.publicCallbackBaseUrl = webhookUrl.toString().replace(/\/$/, '');
        }
      } catch {
        // Ignore malformed legacy callback rows instead of replacing local state.
      }
      continue;
    }

    const localKey = reverseMap[row.key] ?? RESTORE_ALIASES[row.key];
    if (!localKey || row.value === '') continue;

    if (BOOLEAN_SETTINGS.has(localKey)) {
      const normalized = row.value.trim().toLowerCase();
      if (normalized === 'true' || normalized === 'false') {
        (credentials as Record<string, unknown>)[localKey] = normalized === 'true';
      }
      continue;
    }

    const stringKey = localKey as Exclude<keyof RestorableCredentials,
      'paypalSandbox' | 'supabaseDiscordAuthProviderConfigured' | 'lavalinkEnabled'>;
    if (RESTORED_SECRET_KEYS.has(localKey)) {
      const decrypted = decryptCloudSecret(row.value, row.key, cloudKey);
      if (decrypted) credentials[stringKey] = decrypted;
      continue;
    }
    credentials[stringKey] = row.value;
  }

  return credentials;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function headers(secretKey: string): Record<string, string> {
  return {
    apikey: secretKey,
    Authorization: `Bearer ${secretKey}`,
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates',
  };
}

/* ------------------------------------------------------------------ */
/*  Push to Supabase                                                   */
/* ------------------------------------------------------------------ */

/**
 * Upsert launcher credentials into `instance_settings`.
 * Silent failure — sync is best-effort (table may not exist yet before
 * the wizard runs Database Setup).
 */
export async function pushToSupabase(
  supabaseUrl: string,
  supabaseSecretKey: string,
  credentials: SyncableCredentials,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const projectOrigin = canonicalSupabaseProjectOrigin(supabaseUrl);
    const rows = buildSyncRows(credentials, supabaseSecretKey, projectOrigin);
    if (rows.length === 0) return { ok: true };
    const res = await fetch(`${projectOrigin}/rest/v1/instance_settings`, {
      method: 'POST',
      headers: headers(supabaseSecretKey),
      body: JSON.stringify(rows),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `Supabase returned ${res.status}: ${text.slice(0, 200)}` };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export async function pushToSupabaseWithRetry(
  supabaseUrl: string,
  supabaseSecretKey: string,
  credentials: SyncableCredentials,
  options: {
    maxAttempts?: number;
    wait?: (delayMs: number) => Promise<void>;
  } = {},
): Promise<{ ok: boolean; attempts: number; error?: string }> {
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('Credential sync attempts must be a positive integer.');
  }
  const wait = options.wait ?? ((delayMs) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  let lastError = 'unknown error';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await pushToSupabase(supabaseUrl, supabaseSecretKey, credentials);
    if (result.ok) return { ok: true, attempts: attempt };
    lastError = result.error ?? lastError;
    if (attempt < maxAttempts) await wait(1_000 * (2 ** (attempt - 1)));
  }

  return { ok: false, attempts: maxAttempts, error: lastError };
}

/* ------------------------------------------------------------------ */
/*  Pull from Supabase                                                 */
/* ------------------------------------------------------------------ */

/**
 * Read launcher credentials from `instance_settings`.
 * Used on new machines: user enters Supabase URL + secret key → pulls the rest.
 */
export async function pullFromSupabase(
  supabaseUrl: string,
  supabaseSecretKey: string,
): Promise<{ ok: boolean; credentials?: RestoredCredentials; error?: string }> {
  try {
    const projectOrigin = canonicalSupabaseProjectOrigin(supabaseUrl);
    const query = new URLSearchParams({
      select: 'key,value',
      key: `in.(${RESTORE_SETTING_KEYS.join(',')})`,
    });
    const res = await fetch(
      `${projectOrigin}/rest/v1/instance_settings?${query.toString()}`,
      {
        headers: {
          apikey: supabaseSecretKey,
          Authorization: `Bearer ${supabaseSecretKey}`,
        },
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `Supabase returned ${res.status}: ${text.slice(0, 200)}` };
    }

    const rows = (await res.json()) as { key: string; value: string }[];

    if (rows.length === 0) {
      return { ok: false, error: 'No saved SomniBot connection values were found in Supabase.' };
    }

    const credentials = parseSyncRows(rows, supabaseSecretKey, projectOrigin);
    if (Object.keys(credentials).length === 0) {
      return { ok: false, error: 'Saved SomniBot rows were found, but none contained restorable connection values.' };
    }

    return { ok: true, credentials };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
