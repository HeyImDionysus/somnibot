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
  supabaseAccessToken: string;
  supabaseDiscordAuthProviderConfigured: boolean;
  paypalClientId: string;
  paypalClientSecret: string;
  paypalWebhookId: string;
  paypalWebhookProofKey: string;
  paypalSandbox: boolean;
  lavalinkEnabled: boolean;
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
  'supabaseAccessToken',
  'paypalClientSecret',
  'paypalWebhookId',
  'paypalWebhookProofKey',
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
const PUSH_SETTINGS_MAP: Record<keyof SyncableCredentials, string> = {
  discordToken: 'discord_bot_token',
  discordApplicationId: 'discord_application_id',
  discordClientSecret: 'discord_client_secret',
  discordGuildId: 'discord_guild_id',
  supabaseUrl: 'supabase_url',
  supabaseSecretKey: 'supabase_secret_key',
  supabasePublishableKey: 'supabase_publishable_key',
  supabaseDbPassword: 'supabase_db_password',
  supabaseAccessToken: 'supabase_access_token',
  supabaseDiscordAuthProviderConfigured: 'supabase_discord_auth_provider_configured',
  paypalClientId: 'paypal_client_id',
  paypalClientSecret: 'paypal_client_secret',
  paypalWebhookId: 'paypal_webhook_id',
  paypalWebhookProofKey: 'paypal_webhook_proof_key',
  paypalSandbox: 'paypal_sandbox',
  lavalinkEnabled: 'lavalink_enabled',
  vpsCsrfSecret: 'vps_csrf_secret',
  vpsNextAuthSecret: 'vps_nextauth_secret',
  vpsWebhookReplaySecret: 'vps_webhook_replay_secret',
  vpsValkeyPassword: 'vps_valkey_password',
  vpsLavalinkPassword: 'vps_lavalink_password',
};

const RESTORE_SETTINGS_MAP: Record<keyof RestorableCredentials, string> = PUSH_SETTINGS_MAP;

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
    // The setup wizard stores the complete connection URL; the launcher keeps
    // only its decoded password and reconstructs the URL for child processes.
    'supabase_db_url',
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
  updatedAt = new Date().toISOString(),
): LauncherSettingsRow[] {
  return Object.entries(PUSH_SETTINGS_MAP).flatMap(([localKey, settingsKey]) => {
    const key = localKey as keyof SyncableCredentials;
    const rawValue = credentials[key];
    if (rawValue === undefined) return [];
    if (typeof rawValue === 'string' && rawValue.length === 0) return [];
    return [{ key: settingsKey, value: String(rawValue), section: SECTION, updated_at: updatedAt }];
  });
}

/** Parse only values that are actually present, so restore merges safely. */
export function parseSyncRows(rows: Array<Pick<LauncherSettingsRow, 'key' | 'value'>>): RestoredCredentials {
  const reverseMap: Record<string, keyof RestorableCredentials> = {};
  for (const [localKey, settingsKey] of Object.entries(RESTORE_SETTINGS_MAP)) {
    reverseMap[settingsKey] = localKey as keyof RestorableCredentials;
  }

  const credentials: RestoredCredentials = {};
  for (const row of rows) {
    if (row.key === 'supabase_db_url' && row.value) {
      try {
        const databaseUrl = new URL(row.value);
        if (databaseUrl.protocol === 'postgres:' || databaseUrl.protocol === 'postgresql:') {
          const password = decodeURIComponent(databaseUrl.password);
          if (password) credentials.supabaseDbPassword = password;
        }
      } catch {
        // Ignore malformed legacy URLs instead of replacing a valid local password.
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
  const rows = buildSyncRows(credentials);

  if (rows.length === 0) return { ok: true };

  try {
    const res = await fetch(`${supabaseUrl.replace(/\/+$/, '')}/rest/v1/instance_settings`, {
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
    const query = new URLSearchParams({
      select: 'key,value',
      key: `in.(${RESTORE_SETTING_KEYS.join(',')})`,
    });
    const res = await fetch(
      `${supabaseUrl.replace(/\/+$/, '')}/rest/v1/instance_settings?${query.toString()}`,
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

    const credentials = parseSyncRows(rows);
    if (Object.keys(credentials).length === 0) {
      return { ok: false, error: 'Saved SomniBot rows were found, but none contained restorable connection values.' };
    }

    return { ok: true, credentials };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
