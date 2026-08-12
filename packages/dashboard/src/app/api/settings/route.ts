import { NextResponse, type NextRequest } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { notifyBot } from '@/lib/notify-bot';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { parseBody } from '@/lib/api/validation';
import { z } from 'zod';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { apiServerError, dbError } from '@/lib/api/response';
import { recordAdminChange, humanizeColumn } from '@/lib/admin-changes';
import { isSoleInstanceOperator } from '@/app/api/webhooks/scope';
import { encryptCloudCredential } from '@/lib/cloud-credential-crypto';

const settingsUpdate = z.object({
  section: z.string().min(1).max(64),
  values: z.record(z.string().max(4096)),
});

/**
 * Settings API — read and write operator configuration.
 *
 * Connection status is derived from ACTUAL env vars and database state,
 * not just whether a row exists. The settings page shows the real state.
 *
 * Values come from two sources:
 * 1. Environment variables (set at deploy time — host env, .env, etc.)
 * 2. instance_settings table (set via the Settings page at runtime)
 *
 * Env vars take priority. The Settings page shows which are already configured
 * via env and which need to be added.
 */

const SECRET_FIELDS = new Set([
  'supabase_anon_key',
  'supabase_secret_key',
  'discord_bot_token',
  'discord_client_secret',
  'paypal_client_secret',
  'paypal_webhook_id',
  'lavalink_password',
  'valkey_url',
  'supabase_access_token',
  'supabase_db_url',
  'supabase_db_url_template',
  'supabase_db_password',
  'discord_token',
  'paypal_webhook_proof_key',
  'tailscale_auth_key',
  'vps_csrf_secret',
  'vps_nextauth_secret',
  'vps_webhook_replay_secret',
  'vps_valkey_password',
  'vps_lavalink_password',
]);

const ENCRYPTED_SECRET_FIELDS = new Set([
  'discord_bot_token', 'discord_client_secret', 'paypal_client_secret',
  'paypal_webhook_id', 'lavalink_password', 'valkey_url',
  'supabase_access_token', 'supabase_db_url',
]);

/**
 * Map of setting keys → env var names.
 * These are checked on the server to detect what's already configured.
 */
const ENV_MAP: Record<string, string[]> = {
  supabase_url: ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_URL'],
  supabase_anon_key: ['NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_ANON_KEY'],
  supabase_secret_key: ['SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY'],
  discord_application_id: ['DISCORD_APPLICATION_ID'],
  discord_bot_token: ['DISCORD_TOKEN'],
  discord_guild_id: ['DISCORD_GUILD_ID'],
  discord_client_secret: ['DISCORD_CLIENT_SECRET'],
  paypal_client_id: ['PAYPAL_CLIENT_ID'],
  paypal_client_secret: ['PAYPAL_CLIENT_SECRET'],
  paypal_webhook_id: ['PAYPAL_WEBHOOK_ID'],
  paypal_webhook_url: ['PAYPAL_WEBHOOK_URL'],
  paypal_sandbox: ['PAYPAL_SANDBOX'],
  lavalink_host: ['LAVALINK_HOST'],
  lavalink_port: ['LAVALINK_PORT'],
  lavalink_password: ['LAVALINK_PASSWORD'],
  valkey_url: ['VALKEY_URL', 'REDIS_URL'],
};
const INSTALLATION_DEFAULTS: Record<string, string> = {
  auto_install_on_quit: 'true',
  keychain_required: 'true',
  lavalink_enabled: 'false',
  owner_brand_name: 'SomniBot',
  runtime_mode: 'regular-local',
  update_prompt_before_download: 'true',
  vps_deploy_path: '',
  sdk_cache_ttl_ms: '60000',
};
const ALLOWED_SETTING_KEYS = new Set([...Object.keys(ENV_MAP), ...Object.keys(INSTALLATION_DEFAULTS)]);

function getEnvValue(key: string): string | null {
  const envNames = ENV_MAP[key];
  if (!envNames) return null;
  for (const name of envNames) {
    const val = process.env[name];
    if (val) return val;
  }
  return null;
}

function maskValue(value: string): string {
  if (value.length <= 4) return '••••••••';
  return '••••••••' + value.slice(-4);
}

/**
 * GET /api/settings — Load all settings with masked secrets.
 * Merges env vars with database overrides.
 */
export async function GET() {
  try {
    const auth = await requireGuildOwner();
    if (!auth.ok) return auth.response;
    const admin = createAdminSupabase();
    if (!(await isSoleInstanceOperator(admin, auth.ctx.discordId))) {
      return NextResponse.json(
        { error: 'Forbidden — installation operator access required' },
        { status: 403 },
      );
    }

    // Step 1: Read env vars as base values
    const values: Record<string, string> = {};
    const sources: Record<string, 'env' | 'db' | 'none'> = {};

    for (const key of Object.keys(ENV_MAP)) {
      const envVal = getEnvValue(key);
      if (envVal) {
        values[key] = SECRET_FIELDS.has(key) ? maskValue(envVal) : envVal;
        sources[key] = 'env';
      }
    }
    for (const [key, value] of Object.entries(INSTALLATION_DEFAULTS)) {
      values[key] = value;
      sources[key] = 'none';
    }

    // Step 2: Read DB overrides (instance_settings)
    const { data: settings } = await admin
      .from('instance_settings')
      .select('key, value, section')
      .limit(1000);

    if (settings) {
      for (const row of settings) {
        const encryptedBaseKey = row.key.endsWith('_encrypted')
          ? row.key.slice(0, -'_encrypted'.length)
          : null;
        if (encryptedBaseKey && SECRET_FIELDS.has(encryptedBaseKey) && !values[encryptedBaseKey]) {
          values[encryptedBaseKey] = '••••••••';
          sources[encryptedBaseKey] = 'db';
        } else if (SECRET_FIELDS.has(row.key)) {
          // Ignore legacy plaintext secret rows. The migration retires them,
          // and a stale row must never be treated as usable configuration.
          continue;
        } else if (row.value && (!values[row.key] || sources[row.key] === 'none')) {
          // DB value, only if env var isn't already set
          values[row.key] = SECRET_FIELDS.has(row.key) ? maskValue(row.value) : row.value;
          sources[row.key] = 'db';
        }
      }
    }

    // Step 3: Determine connection statuses.
    // Check env vars AND actual database state (the bot writes guild data on startup).
    const statuses: Record<string, 'connected' | 'disconnected' | 'bot-side'> = {
      supabase: 'disconnected',
      discord: 'disconnected',
      paypal: 'disconnected',
      lavalink: 'disconnected',
      valkey: 'disconnected',
    };

    // Supabase: if we got this far, Supabase IS connected (we just queried it)
    if (values.supabase_url && values.supabase_secret_key) {
      statuses.supabase = 'connected';
    }

    // Check if the bot has connected by looking for a guild record in the DB.
    // The bot upserts a guild row on startup with role position data.
    let botHasConnected = false;
    const { data: guildRecord } = await admin
      .from('guild')
      .select('id, bot_role_position')
      .limit(1)
      .single();
    if (guildRecord) {
      botHasConnected = true;
    }

    // Discord: connected if env vars are present OR the bot has connected
    if (values.discord_bot_token && values.discord_guild_id) {
      statuses.discord = 'connected';
    } else if (botHasConnected) {
      statuses.discord = 'connected';
    }

    // PayPal: only from env/db config
    if (values.paypal_client_id && values.paypal_client_secret) {
      statuses.paypal = 'connected';
    }

    // Lavalink & Valkey: these run on the bot server/private network.
    // If the dashboard has env vars, show connected. If the bot has connected
    // (meaning the bot server is running with Docker), show "bot-side".
    if (values.lavalink_host && values.lavalink_port) {
      statuses.lavalink = 'connected';
    } else if (botHasConnected) {
      statuses.lavalink = 'bot-side';
    }

    if (values.valkey_url) {
      statuses.valkey = 'connected';
    } else if (botHasConnected) {
      statuses.valkey = 'bot-side';
    }

    return NextResponse.json({ values, statuses, sources });
  } catch (err) {
    return apiServerError(err, 'GET /api/settings');
  }
}

/**
 * PUT /api/settings — Save settings for a section.
 */
export async function PUT(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;

  try {
    const auth = await requireGuildOwner();
    if (!auth.ok) return auth.response;
    const admin = createAdminSupabase();
    if (!(await isSoleInstanceOperator(admin, auth.ctx.discordId))) {
      return NextResponse.json(
        { error: 'Forbidden — installation operator access required' },
        { status: 403 },
      );
    }

    const parsed = await parseBody(request, settingsUpdate);
    if (!parsed.ok) return parsed.response;
    const { section, values } = parsed.data;

    // V10 Audit §6: Batch all upserts into a single operation to avoid
    // sequential timing that leaks info about which keys were skipped.
    const now = new Date().toISOString();
    const writableEntries = Object.entries(values)
      .filter(([, value]) => !value.includes('••••') && value.trim() !== '');
    const unsupportedKey = writableEntries.find(([key]) => !ALLOWED_SETTING_KEYS.has(key))?.[0];
    if (unsupportedKey) {
      return NextResponse.json(
        { error: `Unsupported installation setting: ${unsupportedKey}` },
        { status: 400 },
      );
    }
    if (writableEntries.some(([key]) => key === 'supabase_secret_key')) {
      return NextResponse.json(
        { error: 'The Supabase bootstrap secret must be changed through the encrypted launcher setup.' },
        { status: 400 },
      );
    }
    for (const [key, value] of writableEntries) {
      if (['auto_install_on_quit', 'keychain_required', 'lavalink_enabled', 'update_prompt_before_download'].includes(key) && value !== 'true' && value !== 'false') {
        return NextResponse.json({ error: `${key} must be true or false` }, { status: 400 });
      }
      if (key === 'runtime_mode' && !['regular-local', 'vps', 'development'].includes(value)) {
        return NextResponse.json({ error: 'runtime_mode is invalid' }, { status: 400 });
      }
      if (key === 'sdk_cache_ttl_ms' && (!/^\d+$/.test(value) || Number(value) < 1000 || Number(value) > 3600000)) {
        return NextResponse.json({ error: 'sdk_cache_ttl_ms must be between 1000 and 3600000' }, { status: 400 });
      }
      if (key === 'owner_brand_name' && value.length > 128) {
        return NextResponse.json({ error: 'owner_brand_name is too long' }, { status: 400 });
      }
      if (key === 'vps_deploy_path' && value.length > 512) {
        return NextResponse.json({ error: 'vps_deploy_path is too long' }, { status: 400 });
      }
    }
    const bootstrapSecret = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const projectOrigin = supabaseUrl ? new URL(supabaseUrl).origin : '';
    const upsertRows = writableEntries.map(([key, value]) => {
      if (!ENCRYPTED_SECRET_FIELDS.has(key)) return { key, value, section, updated_at: now };
      if (!bootstrapSecret || !projectOrigin) {
        throw new Error('Supabase bootstrap credentials are required to encrypt settings.');
      }
      const encrypted = encryptCloudCredential(value, key, bootstrapSecret, projectOrigin);
      return { ...encrypted, section, updated_at: now };
    });

    if (upsertRows.length === 0) {
      return NextResponse.json(
        { error: 'No writable settings were supplied' },
        { status: 400 },
      );
    }

    const { error: upsertError } = await admin
      .from('instance_settings')
      .upsert(upsertRows, { onConflict: 'key' });
    if (upsertError) return dbError(upsertError, 'settings');

    await notifyBot(auth.ctx.guildId, 'settings', { section });

    {
      const changedKeys = upsertRows.map((r) => r.key);
      await recordAdminChange({
        // `instance_settings` is keyed by `key` alone — it has NO guild column
        // and every row applies to the whole installation. `admin_changes` is
        // per-guild and `guild_id` is NOT NULL, so this is filed under the
        // acting owner's active guild (a real guild from the session, never a
        // placeholder) and the sentence says out loud that the change is
        // installation-wide, so nobody reads it as a per-server setting.
        guildId: auth.ctx.guildId,
        actorId: auth.ctx.discordId,
        action: 'instance.settings_updated',
        targetType: 'installation settings',
        targetId: section,
        description:
          `Changed ${changedKeys.length} ${section} connection setting`
          + `${changedKeys.length === 1 ? '' : 's'} `
          + `(${changedKeys.map(humanizeColumn).join(', ')}) for the whole bot installation`,
        // [security] KEY NAMES ONLY — never values, and no before-read.
        // instance_settings is where the Discord bot token, the Supabase
        // service-role key, the PayPal client secret and the Lavalink password
        // live (SECRET_FIELDS above). Copying either the old or the new value
        // into before_state/after_state would replicate every credential of
        // this installation into a table the Admin Changes page renders in
        // full. The names alone are what an owner needs to see.
        after: { section, changed_keys: changedKeys },
        // A wrong bot token or Supabase key takes the entire installation down.
        blastRadius: 'critical',
        undoReason:
          'the previous values are credentials that are deliberately never copied into this log, so there is nothing here to restore them from',
      }, admin);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[Settings] Save error:', err);
    return NextResponse.json({ error: 'Failed to save settings' }, { status: 500 });
  }
}
