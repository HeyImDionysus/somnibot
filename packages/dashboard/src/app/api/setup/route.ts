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
import { createClient } from '@supabase/supabase-js';
import { ensureDiscordAuthProvider } from '@/lib/supabase/auto-config';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { parseBody, schemas } from '@/lib/api/validation';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';

const MAINTENANCE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Create a Supabase client from provided credentials (not from env vars).
 * Used during setup when env vars may not be fully configured yet.
 */
function createSetupSupabase(url?: string, key?: string) {
  const supabaseUrl = url || process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';
  const serviceKey = key || process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

  if (!supabaseUrl || !serviceKey) return null;
  return createClient(supabaseUrl, serviceKey);
}

/**
 * Check whether setup has been completed (setup_completed_at exists).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getSetupLock(supabase: any) {
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

export async function GET(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'standard');
  if (rateLimited) return rateLimited;

  const supabase = createSetupSupabase();
  const status = {
    supabaseConnected: false,
    databaseInitialized: false,
    botOnline: false,
    guildDetected: false,
    guildId: null as string | null,
    guildName: null as string | null,
    dashboardUrl: process.env.NEXT_PUBLIC_APP_URL || null,
    discordClientId: process.env.DISCORD_APPLICATION_ID || null,
    discordAuthConfigured: false,
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

  // Check Discord auth provider status
  if (process.env.DISCORD_APPLICATION_ID && process.env.DISCORD_CLIENT_SECRET) {
    status.discordAuthConfigured = true;
  }

  // Check if bot is online and guild is detected
  if (status.databaseInitialized) {
    // Check setup lock
    const { isCompleted } = await getSetupLock(supabase);
    status.setupCompleted = isCompleted;

    const { data: guild } = await supabase
      .from('guild')
      .select('id, name')
      .limit(1)
      .maybeSingle();

    if (guild) {
      status.guildDetected = true;
      status.guildId = guild.id;
      status.guildName = guild.name;
    }

    // Check if bot has written a recent diagnostics snapshot (indicates it's online)
    const { data: diag } = await supabase
      .from('bot_diagnostics')
      .select('snapshot_at')
      .order('snapshot_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (diag) {
      const lastSnapshot = new Date(diag.snapshot_at).getTime();
      const now = Date.now();
      // Bot is considered online if last snapshot was within 5 minutes
      status.botOnline = now - lastSnapshot < 5 * 60 * 1000;
    }

    // Fallback: check if guild record exists and was recently updated
    if (!status.botOnline && guild) {
      status.botOnline = true; // Guild record exists = bot connected at least once
    }

    // Check if Discord creds exist in instance_settings (for display purposes)
    if (!status.discordAuthConfigured) {
      const { data: settings } = await supabase
        .from('instance_settings')
        .select('key')
        .in('key', ['discord_application_id', 'discord_client_secret'])
        .limit(1000);

      if (settings && settings.length >= 2) {
        status.discordAuthConfigured = true;
      }
    }
  }

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

  // Step 1: Verify Discord credentials
  if (action === 'verify-discord') {
    const { token, clientId, clientSecret } = body;
    if (!token || !clientId) {
      return NextResponse.json({ error: 'Missing token or clientId' }, { status: 400 });
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
      if (supabase) {
        const creds: Record<string, { value: string; section: string }> = {
          discord_bot_token: { value: token, section: 'discord' },
          discord_application_id: { value: clientId, section: 'discord' },
        };
        if (clientSecret) {
          creds.discord_client_secret = { value: clientSecret, section: 'discord' };
        }

        for (const [key, { value, section }] of Object.entries(creds)) {
          await supabase
            .from('instance_settings')
            .upsert(
              { key, value, section, updated_at: new Date().toISOString() },
              { onConflict: 'key' },
            );
        }
        console.log('[Setup] ✅ Discord credentials saved to instance_settings');

        // Auto-configure Discord OAuth in Supabase if we have the access token
        if (clientSecret) {
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
      }

      return NextResponse.json({
        valid: true,
        botUsername: botUser.username,
        botId: botUser.id,
        botAvatar: botUser.avatar
          ? `https://cdn.discordapp.com/avatars/${botUser.id}/${botUser.avatar}.png`
          : null,
        credentialsSaved: true,
      });
    } catch (err) {
      return NextResponse.json({ valid: false, error: String(err) });
    }
  }

  // Step 2: Verify Supabase credentials
  if (action === 'verify-supabase') {
    const { url, serviceRoleKey } = body;
    if (!url || !serviceRoleKey) {
      return NextResponse.json({ error: 'Missing url or serviceRoleKey' }, { status: 400 });
    }

    try {
      const supabase = createClient(url, serviceRoleKey);
      // Try a simple query — if table doesn't exist yet, that's OK (connection works)
      const { error } = await supabase.from('guild').select('id').limit(0);

      if (!error || error.code === '42P01') {
        // Save Supabase credentials to instance_settings (if tables exist)
        if (!error) {
          const creds: Record<string, { value: string; section: string }> = {
            supabase_url: { value: url, section: 'supabase' },
            supabase_secret_key: { value: serviceRoleKey, section: 'supabase' },
          };

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

    // Save any additional credentials passed in
    const credentials = (body as Record<string, unknown>).credentials as Record<string, string> | undefined;
    if (credentials) {
      for (const [key, value] of Object.entries(credentials)) {
        if (!value?.trim()) continue;
        // Determine section from key prefix
        const section = key.startsWith('discord_')
          ? 'discord'
          : key.startsWith('supabase_')
            ? 'supabase'
            : key.startsWith('paypal_')
              ? 'paypal'
              : key.startsWith('lavalink_')
                ? 'lavalink'
                : key.startsWith('valkey_')
                  ? 'valkey'
                  : 'general';

        await supabase
          .from('instance_settings')
          .upsert(
            { key, value, section, updated_at: new Date().toISOString() },
            { onConflict: 'key' },
          );
      }
    }

    // Ensure Discord auth provider is configured
    const authResult = await ensureDiscordAuthProvider();

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
