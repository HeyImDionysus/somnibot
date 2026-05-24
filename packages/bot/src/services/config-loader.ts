/**
 * Config loader with two-way instance_settings sync.
 *
 * 1. On boot: reads missing env vars from instance_settings (DB → process.env)
 * 2. After boot: writes current env vars back to instance_settings (process.env → DB)
 *
 * This keeps the dashboard Settings page in sync with the bot's actual config,
 * so operators can see connection statuses at a glance.
 *
 * Bootstrap requirement: SUPABASE_URL + SUPABASE_SECRET_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY)
 * must be in env vars (needed to connect to DB at all).
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '@somnibot/shared';

const log = createLogger('ConfigLoader');

/**
 * Map of instance_settings keys → env var names.
 * Used for both directions: DB → env and env → DB.
 */
const SETTINGS_TO_ENV: Record<string, string> = {
  // Discord (collected by launcher)
  discord_bot_token: 'DISCORD_TOKEN',
  discord_application_id: 'DISCORD_APPLICATION_ID',
  discord_client_secret: 'DISCORD_CLIENT_SECRET',
  discord_guild_id: 'DISCORD_GUILD_ID',
  // PayPal (setup wizard)
  paypal_client_id: 'PAYPAL_CLIENT_ID',
  paypal_client_secret: 'PAYPAL_CLIENT_SECRET',
  paypal_webhook_id: 'PAYPAL_WEBHOOK_ID',
  paypal_sandbox: 'PAYPAL_SANDBOX',
  // Lavalink (defaults — self-managing)
  lavalink_host: 'LAVALINK_HOST',
  lavalink_port: 'LAVALINK_PORT',
  lavalink_password: 'LAVALINK_PASSWORD',
  // Valkey (defaults — self-managing)
  valkey_url: 'VALKEY_URL',
  // Supabase Management — auto-migration (setup wizard, optional)
  supabase_access_token: 'SUPABASE_ACCESS_TOKEN',
  supabase_db_url: 'SUPABASE_DB_URL',
  // Deployment (setup wizard)
  dashboard_url: 'DASHBOARD_URL',
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
    log.info('No Supabase credentials in env — skipping DB config fallback');
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
      log.info('All config values present in env vars — no DB fallback needed');
      return 0;
    }

    // Query only the missing keys from instance_settings
    const { data: settings, error } = await supabase
      .from('instance_settings')
      .select('key, value')
      .in('key', missingKeys)
      .limit(1000);

    if (error) {
      // Table may not exist yet on first boot — that's OK
      if (error.code === '42P01') {
        log.info('instance_settings table not found — skipping');
        return 0;
      }
      log.warn('Failed to read instance_settings:', error.message);
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
          log.info(`Loaded ${envVar} from instance_settings`);
        }
      }
    }

    if (loaded > 0) {
      log.info(`Loaded ${loaded} config value(s) from database`);
    } else {
      log.info('No additional config values found in database');
    }

    return loaded;
  } catch (err) {
    log.warn('Error loading config from database (non-fatal):', { error: String(err) });
    return 0;
  }
}

/**
 * Section groupings for instance_settings rows.
 */
const KEY_TO_SECTION: Record<string, string> = {
  discord_bot_token: 'discord',
  discord_application_id: 'discord',
  discord_client_secret: 'discord',
  discord_guild_id: 'discord',
  paypal_client_id: 'paypal',
  paypal_client_secret: 'paypal',
  paypal_webhook_id: 'paypal',
  paypal_sandbox: 'paypal',
  lavalink_host: 'lavalink',
  lavalink_port: 'lavalink',
  lavalink_password: 'lavalink',
  valkey_url: 'valkey',
  supabase_access_token: 'supabase_mgmt',
  supabase_db_url: 'supabase_mgmt',
  dashboard_url: 'deployment',
};

/**
 * Write current env vars back to instance_settings so the dashboard can display them.
 *
 * Call this AFTER loadConfig() / loadConfigFromDatabase() — once all env vars are final.
 * Only writes values that are actually set; never overwrites with empty strings.
 *
 * Returns the number of values synced to the database.
 */
export async function syncConfigToDatabase(): Promise<number> {
  const supabaseUrl = process.env.SUPABASE_URL
    || process.env.NEXT_PUBLIC_SUPABASE_URL
    || '';
  const serviceKey = process.env.SUPABASE_SECRET_KEY
    || process.env.SUPABASE_SERVICE_ROLE_KEY
    || '';

  if (!supabaseUrl || !serviceKey) {
    log.info('No Supabase credentials — skipping sync-to-DB');
    return 0;
  }

  try {
    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const rows: { key: string; value: string; section: string; updated_at: string }[] = [];

    for (const [settingsKey, envVar] of Object.entries(SETTINGS_TO_ENV)) {
      const value = process.env[envVar];
      if (value) {
        rows.push({
          key: settingsKey,
          value,
          section: KEY_TO_SECTION[settingsKey] ?? 'other',
          updated_at: new Date().toISOString(),
        });
      }
    }

    if (rows.length === 0) {
      log.info('No env vars to sync to database');
      return 0;
    }

    const { error } = await supabase
      .from('instance_settings')
      .upsert(rows, { onConflict: 'key' });

    if (error) {
      if (error.code === '42P01') {
        log.info('instance_settings table not found — skipping sync-to-DB');
        return 0;
      }
      log.warn('Failed to sync config to DB:', error.message);
      return 0;
    }

    log.info(`Synced ${rows.length} config value(s) to instance_settings`);
    return rows.length;
  } catch (err) {
    log.warn('Error syncing config to DB (non-fatal):', { error: String(err) });
    return 0;
  }
}
