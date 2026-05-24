import { NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { notifyBot } from '@/lib/notify-bot';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { parseBody } from '@/lib/api/validation';
import { z } from 'zod';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';

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
 * 1. Environment variables (set at deploy time — Vercel, .env, etc.)
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
  'lavalink_password',
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
  paypal_sandbox: ['PAYPAL_SANDBOX'],
  lavalink_host: ['LAVALINK_HOST'],
  lavalink_port: ['LAVALINK_PORT'],
  lavalink_password: ['LAVALINK_PASSWORD'],
  valkey_url: ['VALKEY_URL', 'REDIS_URL'],
};

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

    // Step 2: Read DB overrides (instance_settings)
    const admin = createAdminSupabase();
    const { data: settings } = await admin
      .from('instance_settings')
      .select('key, value, section')
      .limit(1000);

    if (settings) {
      for (const row of settings) {
        if (row.value && !values[row.key]) {
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

    // Lavalink & Valkey: these run on the bot server (Docker), not on Vercel.
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
    console.error('[Settings] Error:', err);
    return NextResponse.json({ values: {}, statuses: {}, sources: {} });
  }
}

/**
 * PUT /api/settings — Save settings for a section.
 */
export async function PUT(request: Request) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;

  try {
    const auth = await requireGuildOwner();
    if (!auth.ok) return auth.response;

    const parsed = await parseBody(request as any, settingsUpdate);
    if (!parsed.ok) return parsed.response;
    const { section, values } = parsed.data;

    const admin = createAdminSupabase();

    for (const [key, value] of Object.entries(values)) {
      // Skip masked values (user didn't change them)
      if (value.includes('••••')) continue;
      if (!value.trim()) continue;

      await admin
        .from('instance_settings')
        .upsert(
          { key, value, section, updated_at: new Date().toISOString() },
          { onConflict: 'key' },
        );
    }

    await notifyBot('settings', { section });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[Settings] Save error:', err);
    return NextResponse.json({ error: 'Failed to save settings' }, { status: 500 });
  }
}
