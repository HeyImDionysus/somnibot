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
  supabasePublishableKey: string;
  supabaseDbPassword: string;
}

/** Map from SyncableCredentials key → instance_settings row key.
 *
 * These keys must match what the bot's config-loader reads from
 * instance_settings (SETTINGS_TO_ENV in config-loader.ts). The bot
 * expects `discord_bot_token` (not `discord_token`), so we use that
 * here to ensure the launcher → DB → bot flow works on fresh starts.
 */
const SETTINGS_MAP: Record<keyof SyncableCredentials, string> = {
  discordToken: 'discord_bot_token',
  discordApplicationId: 'discord_application_id',
  discordClientSecret: 'discord_client_secret',
  discordGuildId: 'discord_guild_id',
  supabasePublishableKey: 'supabase_publishable_key',
  supabaseDbPassword: 'supabase_db_password',
};

const SECTION = 'launcher';

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
  const rows = Object.entries(SETTINGS_MAP).map(([localKey, settingsKey]) => ({
    key: settingsKey,
    value: credentials[localKey as keyof SyncableCredentials] || '',
    section: SECTION,
    updated_at: new Date().toISOString(),
  }));

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
): Promise<{ ok: boolean; credentials?: SyncableCredentials; error?: string }> {
  try {
    const res = await fetch(
      `${supabaseUrl.replace(/\/+$/, '')}/rest/v1/instance_settings?section=eq.${SECTION}&select=key,value`,
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
      return { ok: false, error: 'No saved launcher credentials found in Supabase. Run the bot once to sync.' };
    }

    // Reverse-map: instance_settings key → SyncableCredentials key
    const reverseMap: Record<string, keyof SyncableCredentials> = {};
    for (const [localKey, settingsKey] of Object.entries(SETTINGS_MAP)) {
      reverseMap[settingsKey] = localKey as keyof SyncableCredentials;
    }

    const credentials: SyncableCredentials = {
      discordToken: '',
      discordApplicationId: '',
      discordClientSecret: '',
      discordGuildId: '',
      supabasePublishableKey: '',
      supabaseDbPassword: '',
    };

    for (const row of rows) {
      const localKey = reverseMap[row.key];
      if (localKey) {
        credentials[localKey] = row.value || '';
      }
    }

    // Check that at least the Discord token was found
    if (!credentials.discordToken) {
      return { ok: false, error: 'Credentials found but Discord token is empty. Was the bot started at least once on another machine?' };
    }

    return { ok: true, credentials };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
