/**
 * GET /api/guild — Fetch guild info, bot status, and config.
 * PATCH /api/guild — Update guild config.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { createServerSupabase } from '@/lib/supabase/server';

export async function GET() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const admin = createAdminSupabase();

  // Get the user's guild (single-guild architecture)
  const { data: dbUser } = await admin
    .from('users')
    .select('discord_id')
    .eq('id', user.id)
    .single();

  if (!dbUser) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  const { data: guild } = await admin
    .from('guild')
    .select('*, guild_config(*)')
    .eq('owner_discord_id', dbUser.discord_id)
    .single();

  if (!guild) return NextResponse.json({ error: 'No guild found' }, { status: 404 });

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

  const body = await request.json();
  const admin = createAdminSupabase();

  const { data: dbUser } = await admin
    .from('users')
    .select('discord_id')
    .eq('id', user.id)
    .single();

  if (!dbUser) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  const { data: guild } = await admin
    .from('guild')
    .select('id')
    .eq('owner_discord_id', dbUser.discord_id)
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
