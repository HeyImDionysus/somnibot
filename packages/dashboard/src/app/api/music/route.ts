/**
 * /api/music — Music settings CRUD.
 *
 * GET: Load music config (from guild_config)
 * PUT: Update music settings
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';

const GUILD_ID = process.env.DISCORD_GUILD_ID!;

export async function GET() {
  const supabase = createAdminSupabase();

  const { data, error } = await supabase
    .from('guild_config')
    .select('music_enabled, default_volume, max_queue_length, allow_duplicates, dj_role_id')
    .eq('guild_id', GUILD_ID)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  // Default values if no config exists yet
  const config = {
    music_enabled: data?.music_enabled ?? true,
    default_volume: data?.default_volume ?? 50,
    max_queue_length: data?.max_queue_length ?? 500,
    allow_duplicates: data?.allow_duplicates ?? true,
    dj_role_id: data?.dj_role_id ?? null,
  };

  return NextResponse.json({ success: true, data: config });
}

export async function PUT(req: NextRequest) {
  const supabase = createAdminSupabase();
  const body = await req.json();

  const {
    music_enabled,
    default_volume,
    max_queue_length,
    allow_duplicates,
    dj_role_id,
  } = body;

  const updates: Record<string, unknown> = {};

  if (typeof music_enabled === 'boolean') updates.music_enabled = music_enabled;
  if (typeof default_volume === 'number') {
    updates.default_volume = Math.max(0, Math.min(150, default_volume));
  }
  if (typeof max_queue_length === 'number') {
    updates.max_queue_length = Math.max(1, Math.min(2000, max_queue_length));
  }
  if (typeof allow_duplicates === 'boolean') updates.allow_duplicates = allow_duplicates;
  if (dj_role_id !== undefined) updates.dj_role_id = dj_role_id || null;

  if (Object.keys(updates).length === 0) {
    return NextResponse.json(
      { success: false, error: 'No valid fields to update' },
      { status: 400 },
    );
  }

  updates.updated_at = new Date().toISOString();

  const { error } = await supabase
    .from('guild_config')
    .update(updates)
    .eq('guild_id', GUILD_ID);

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
