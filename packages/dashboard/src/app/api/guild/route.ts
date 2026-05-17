/**
 * GET /api/guild — Fetch guild info, bot status, and config.
 * PATCH /api/guild — Update guild config.
 *
 * Resolves the guild via the logged-in user's Discord ID (from auth metadata).
 * Single-guild architecture: one bot instance → one guild.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { createServerSupabase } from '@/lib/supabase/server';

/**
 * Extract the Discord user ID from Supabase auth user metadata.
 * Discord OAuth stores it in `provider_id` or `sub`.
 */
function getDiscordId(user: { user_metadata?: Record<string, unknown> }): string | null {
  const meta = user.user_metadata;
  if (!meta) return null;
  return (meta.provider_id as string) || (meta.sub as string) || null;
}

export async function GET() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const discordId = getDiscordId(user);
  if (!discordId) return NextResponse.json({ error: 'No Discord ID found' }, { status: 400 });

  const admin = createAdminSupabase();

  // Single-guild: find the guild this user owns
  const { data: guild } = await admin
    .from('guild')
    .select('*, guild_config(*)')
    .eq('owner_discord_id', discordId)
    .single();

  if (!guild) {
    // Fallback: try to find any guild (single-instance deployment)
    const { data: anyGuild } = await admin
      .from('guild')
      .select('*, guild_config(*)')
      .limit(1)
      .single();

    if (!anyGuild) {
      return NextResponse.json({ error: 'No guild found' }, { status: 404 });
    }

    return NextResponse.json({
      guild: anyGuild,
      config: anyGuild.guild_config?.[0] ?? null,
    });
  }

  // Get desired state
  const { data: desiredState } = await admin
    .from('guild_desired_state')
    .select('*')
    .eq('guild_id', guild.id)
    .single();

  return NextResponse.json({
    guild,
    config: guild.guild_config?.[0] ?? null,
    desiredState,
  });
}

export async function PATCH(request: NextRequest) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const discordId = getDiscordId(user);
  if (!discordId) return NextResponse.json({ error: 'No Discord ID found' }, { status: 400 });

  const body = await request.json();
  const admin = createAdminSupabase();

  const { data: guild } = await admin
    .from('guild')
    .select('id')
    .eq('owner_discord_id', discordId)
    .single();

  if (!guild) return NextResponse.json({ error: 'No guild found' }, { status: 404 });

  // Update guild config
  const { error } = await admin
    .from('guild_config')
    .update(body)
    .eq('guild_id', guild.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ success: true });
}
