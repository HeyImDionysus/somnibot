/**
 * /api/music — Music settings CRUD.
 *
 * GET: Load music config (from guild_config)
 * PUT: Update music settings
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { notifyBot } from '@/lib/notify-bot';
export async function GET() {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();

  const { data, error } = await supabase
    .from('guild_config')
    .select('music_enabled, music_default_volume, dj_role_id, music_auto_leave_minutes, music_auto_destroy_minutes')
    .eq('guild_id', guildId)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  // Default values if no config exists yet
  const config = {
    music_enabled: data?.music_enabled ?? true,
    music_default_volume: data?.music_default_volume ?? 50,
    dj_role_id: data?.dj_role_id ?? null,
    music_auto_leave_minutes: data?.music_auto_leave_minutes ?? 5,
    music_auto_destroy_minutes: data?.music_auto_destroy_minutes ?? 30,
  };

  return NextResponse.json({ success: true, data: config });
}

export async function PUT(req: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const body = await req.json();

  const {
    music_enabled,
    music_default_volume,
    dj_role_id,
    music_auto_leave_minutes,
    music_auto_destroy_minutes,
  } = body;

  const updates: Record<string, unknown> = {};

  if (typeof music_enabled === 'boolean') updates.music_enabled = music_enabled;
  if (typeof music_default_volume === 'number') {
    updates.music_default_volume = Math.max(0, Math.min(150, music_default_volume));
  }
  if (dj_role_id !== undefined) updates.dj_role_id = dj_role_id || null;
  if (typeof music_auto_leave_minutes === 'number') {
    updates.music_auto_leave_minutes = Math.max(1, Math.min(60, music_auto_leave_minutes));
  }
  if (typeof music_auto_destroy_minutes === 'number') {
    updates.music_auto_destroy_minutes = Math.max(1, Math.min(120, music_auto_destroy_minutes));
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json(
      { success: false, error: 'No valid fields to update' },
      { status: 400 },
    );
  }

  updates.updated_at = new Date().toISOString();

  const { error } = await supabase
    .from('guild_config')
    .upsert({ guild_id: guildId, ...updates }, { onConflict: 'guild_id' });

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  await notifyBot('music');

  return NextResponse.json({ success: true });
}
