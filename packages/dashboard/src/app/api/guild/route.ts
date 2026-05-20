/**
 * GET /api/guild — Fetch guild info, bot status, and config.
 * PATCH /api/guild — Update guild config.
 *
 * SECURITY (Phase A):
 * - Uses requireGuildOwner() — no fallback to "any guild".
 * - PATCH validates fields against an allowlist.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';

export async function GET() {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const admin = createAdminSupabase();

  const { data: guild } = await admin
    .from('guild')
    .select('*, guild_config(*)')
    .eq('id', guildId)
    .single();

  if (!guild) {
    return NextResponse.json({ error: 'Guild not found' }, { status: 404 });
  }

  // Get desired state
  const { data: desiredState } = await admin
    .from('guild_desired_state')
    .select('*')
    .eq('guild_id', guildId)
    .single();

  return NextResponse.json({
    guild,
    config: guild.guild_config?.[0] ?? null,
    desiredState,
    totalRoles: guild.total_roles ?? null,
  });
}

export async function PATCH(request: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const body = await request.json();
  const admin = createAdminSupabase();

  // Allowlist of updatable guild_config fields (must match actual schema)
  const allowedFields = new Set([
    'mod_log_channel_id',
    'welcome_channel_id',
    'goodbye_channel_id',
    'level_up_channel_id',
    'store_channel_id',
    'music_enabled',
    'music_default_volume',
    'dj_role_id',
    'stats_enabled',
    'temp_channels_enabled',
    'scheduled_messages_enabled',
    'giveaways_enabled',
  ]);

  const updates: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (allowedFields.has(key)) {
      updates[key] = value;
    }
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
  }

  const { error } = await admin
    .from('guild_config')
    .upsert({ guild_id: guildId, ...updates }, { onConflict: 'guild_id' });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ success: true });
}
