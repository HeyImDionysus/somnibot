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
import { parseBody, schemas } from '@/lib/api/validation';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';
export async function GET() {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();

  const { data, error } = await supabase
    .from('guild_config')
    .select('music_enabled, music_default_volume, dj_role_id, music_auto_leave_minutes, music_auto_destroy_minutes, vote_skip_threshold_percent, self_skip_enabled, requester_move_enabled, priority_voting_enabled')
    .eq('guild_id', guildId)
    .maybeSingle();

  if (error) {
    return dbError(error, 'music');
  }

  // Default values if no config exists yet
  const config = {
    music_enabled: data?.music_enabled ?? true,
    music_default_volume: data?.music_default_volume ?? 50,
    dj_role_id: data?.dj_role_id ?? null,
    music_auto_leave_minutes: data?.music_auto_leave_minutes ?? 5,
    music_auto_destroy_minutes: data?.music_auto_destroy_minutes ?? 30,
    vote_skip_threshold_percent: data?.vote_skip_threshold_percent ?? 50,
    self_skip_enabled: data?.self_skip_enabled ?? true,
    requester_move_enabled: data?.requester_move_enabled ?? true,
    priority_voting_enabled: data?.priority_voting_enabled ?? true,
  };

  return NextResponse.json({ success: true, data: config });
}

export async function PUT(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const parsed = await parseBody(req, schemas.music.config);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const {
    music_enabled,
    music_default_volume,
    dj_role_id,
    music_auto_leave_minutes,
    music_auto_destroy_minutes,
    vote_skip_threshold_percent,
    self_skip_enabled,
    requester_move_enabled,
    priority_voting_enabled,
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
  if (typeof vote_skip_threshold_percent === 'number') {
    updates.vote_skip_threshold_percent = Math.max(1, Math.min(100, Math.round(vote_skip_threshold_percent)));
  }
  if (typeof self_skip_enabled === 'boolean') updates.self_skip_enabled = self_skip_enabled;
  if (typeof requester_move_enabled === 'boolean') updates.requester_move_enabled = requester_move_enabled;
  if (typeof priority_voting_enabled === 'boolean') updates.priority_voting_enabled = priority_voting_enabled;

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
    return dbError(error, 'music');
  }

  await notifyBot('music');

  return NextResponse.json({ success: true });
}
