/**
 * First-Run Setup API — Manages the initial deployment wizard.
 *
 * GET  /api/setup         — Returns first-run status (is DB initialized? is bot online? guild detected?)
 * POST /api/setup         — Verify credentials, save to instance_settings, configure auth, run migrations, detect guild
 *
 * This endpoint does NOT require authentication — it's used before Discord OAuth is configured.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { ensureDiscordAuthProvider } from '@/lib/supabase/auto-config';

/**
 * Create a Supabase client from provided credentials (not from env vars).
 * Used during setup when env vars may not be fully configured yet.
 */
function createSetupSupabase(url?: string, key?: string) {
  const supabaseUrl = url || process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';
  const serviceKey = key || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '';

  if (!supabaseUrl || !serviceKey) return null;
  return createClient(supabaseUrl, serviceKey);
}

export async function GET() {
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
      .from('diagnostics_snapshots')
      .select('created_at')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (diag) {
      const lastSnapshot = new Date(diag.created_at).getTime();
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
        .in('key', ['discord_application_id', 'discord_client_secret']);

      if (settings && settings.length >= 2) {
        status.discordAuthConfigured = true;
      }
    }
  }

  return NextResponse.json(status);
}

export async function POST(request: NextRequest) {
  const body = await request.json();

  // Step 1: Verify Discord credentials
  if (body.action === 'verify-discord') {
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
  if (body.action === 'verify-supabase') {
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
            supabase_service_role_key: { value: serviceRoleKey, section: 'supabase' },
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

      return NextResponse.json({ valid: false, error: error.message });
    } catch (err) {
      return NextResponse.json({ valid: false, error: String(err) });
    }
  }

  // Step 3: Generate bot invite URL
  if (body.action === 'generate-invite') {
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
  if (body.action === 'configure-auth') {
    const result = await ensureDiscordAuthProvider();
    return NextResponse.json(result);
  }

  // Step 5: Finalize setup — save any remaining credentials and ensure auth is configured
  if (body.action === 'finalize') {
    const supabase = createSetupSupabase();
    if (!supabase) {
      return NextResponse.json({ error: 'No Supabase connection' }, { status: 500 });
    }

    // Save any additional credentials passed in
    const { credentials } = body as { credentials?: Record<string, string> };
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

    return NextResponse.json({
      ok: true,
      authConfigured: authResult.success,
      authError: authResult.error || null,
    });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
