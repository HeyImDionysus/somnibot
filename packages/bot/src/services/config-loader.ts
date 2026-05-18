/**
 * Config loader with instance_settings fallback.
 *
 * Reads environment variables first, then fills missing values
 * from the instance_settings table in Supabase.
 *
 * This allows operators to configure the bot via the dashboard
 * Settings page instead of requiring every value as an env var.
 *
 * Bootstrap requirement: SUPABASE_URL + SUPABASE_SECRET_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY)
 * must be in env vars (needed to connect to DB at all).
 */

import { createClient } from '@supabase/supabase-js';

/**
 * Map of instance_settings keys → env var names.
 * Only fills env vars that aren't already set.
 */
const SETTINGS_TO_ENV: Record<string, string> = {
  discord_bot_token: 'DISCORD_TOKEN',
  discord_application_id: 'DISCORD_APPLICATION_ID',
  discord_client_secret: 'DISCORD_CLIENT_SECRET',
  discord_guild_id: 'DISCORD_GUILD_ID',
  paypal_client_id: 'PAYPAL_CLIENT_ID',
  paypal_client_secret: 'PAYPAL_CLIENT_SECRET',
  paypal_webhook_id: 'PAYPAL_WEBHOOK_ID',
  paypal_sandbox: 'PAYPAL_SANDBOX',
  lavalink_host: 'LAVALINK_HOST',
  lavalink_port: 'LAVALINK_PORT',
  lavalink_password: 'LAVALINK_PASSWORD',
  valkey_url: 'VALKEY_URL',
};

/**
 * Load missing config values from instance_settings into process.env.
 * Call this BEFORE loadConfig() in the boot sequence.
 *
 * Returns the number of values loaded from the database.
 */
export async function loadConfigFromDatabase(): Promise<number> {
  const supabaseUrl = process.env.SUPABASE_URL
    || process.env.NEXT_PUBLIC_SUPABASE_URL
    || '';
  const serviceKey = process.env.SUPABASE_SECRET_KEY
    || process.env.SUPABASE_SERVICE_ROLE_KEY
    || '';

  if (!supabaseUrl || !serviceKey) {
    console.log('[ConfigLoader] No Supabase credentials in env — skipping DB config fallback');
    return 0;
  }

  try {
    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Determine which env vars are missing
    const missingKeys: string[] = [];
    for (const [settingsKey, envVar] of Object.entries(SETTINGS_TO_ENV)) {
      if (!process.env[envVar]) {
        missingKeys.push(settingsKey);
      }
    }

    if (missingKeys.length === 0) {
      console.log('[ConfigLoader] All config values present in env vars — no DB fallback needed');
      return 0;
    }

    // Query only the missing keys from instance_settings
    const { data: settings, error } = await supabase
      .from('instance_settings')
      .select('key, value')
      .in('key', missingKeys);

    if (error) {
      // Table may not exist yet on first boot — that's OK
      if (error.code === '42P01') {
        console.log('[ConfigLoader] instance_settings table not found — skipping');
        return 0;
      }
      console.warn('[ConfigLoader] Failed to read instance_settings:', error.message);
      return 0;
    }

    let loaded = 0;
    if (settings) {
      for (const row of settings) {
        if (row.value && SETTINGS_TO_ENV[row.key]) {
          const envVar = SETTINGS_TO_ENV[row.key];
          process.env[envVar] = row.value;
          loaded++;
          // Don't log the actual value for security
          console.log(`[ConfigLoader] Loaded ${envVar} from instance_settings`);
        }
      }
    }

    if (loaded > 0) {
      console.log(`[ConfigLoader] ✅ Loaded ${loaded} config value(s) from database`);
    } else {
      console.log('[ConfigLoader] No additional config values found in database');
    }

    return loaded;
  } catch (err) {
    console.warn('[ConfigLoader] Error loading config from database (non-fatal):', err);
    return 0;
  }
}
