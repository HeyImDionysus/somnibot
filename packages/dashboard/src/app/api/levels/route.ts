/**
 * /api/levels — CRUD for level system settings, rewards, and multipliers.
 *
 * GET: Fetch level settings + rewards + multipliers + leaderboard
 * PUT: Update guild level settings
 * POST: Create a reward or multiplier
 * DELETE: Delete a reward or multiplier
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { notifyBot } from '@/lib/notify-bot';
export async function GET(req: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const { searchParams } = new URL(req.url);
  const section = searchParams.get('section');

  // Leaderboard
  if (section === 'leaderboard') {
    const page = parseInt(searchParams.get('page') ?? '0', 10);
    const pageSize = 20;
    const offset = page * pageSize;

    const { data, count } = await supabase
      .from('member_levels')
      .select('member_id, xp, level, total_messages, voice_minutes', { count: 'exact' })
      .eq('guild_id', guildId)
      .order('xp', { ascending: false })
      .range(offset, offset + pageSize - 1);

    return NextResponse.json({
      success: true,
      data: data ?? [],
      total: count ?? 0,
      page,
      pageSize,
    });
  }

  // Full settings bundle
  const [configResult, rewardsResult, multipliersResult] = await Promise.all([
    supabase
      .from('guild_config')
      .select(
        'levels_enabled, xp_min, xp_max, xp_cooldown_seconds, voice_xp_enabled, voice_xp_per_interval, voice_xp_interval_minutes, xp_multiplier_mode, xp_channel_mode, xp_channel_list, level_up_channel_id, level_up_message, rank_card_accent_color, rank_card_background',
      )
      .eq('guild_id', guildId)
      .maybeSingle(),
    supabase
      .from('level_rewards')
      .select('*')
      .eq('guild_id', guildId)
      .order('level', { ascending: true }),
    supabase
      .from('xp_multipliers')
      .select('*')
      .eq('guild_id', guildId)
      .order('multiplier', { ascending: false }),
  ]);

  return NextResponse.json({
    success: true,
    config: configResult.data ?? {},
    rewards: rewardsResult.data ?? [],
    multipliers: multipliersResult.data ?? [],
  });
}

export async function PUT(req: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const body = await req.json();

  const allowedFields = [
    'levels_enabled',
    'xp_min',
    'xp_max',
    'xp_cooldown_seconds',
    'voice_xp_enabled',
    'voice_xp_per_interval',
    'voice_xp_interval_minutes',
    'xp_multiplier_mode',
    'xp_channel_mode',
    'xp_channel_list',
    'level_up_channel_id',
    'level_up_message',
    'rank_card_accent_color',
    'rank_card_background',
  ];

  const updates: Record<string, unknown> = {};
  for (const field of allowedFields) {
    if (body[field] !== undefined) {
      updates[field] = body[field];
    }
  }

  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('guild_config')
    .upsert({ guild_id: guildId, ...updates }, { onConflict: 'guild_id' })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  await notifyBot('levels');

  return NextResponse.json({ success: true, data });
}

export async function POST(req: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const body = await req.json();
  const type = body.type as string;

  if (type === 'reward') {
    const { level, role_id, remove_at_level, announce } = body;
    if (level == null || !role_id) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields: level, role_id' },
        { status: 400 },
      );
    }

    const { data, error } = await supabase
      .from('level_rewards')
      .insert({
        guild_id: guildId,
        level,
        role_id,
        remove_at_level: remove_at_level ?? null,
        announce: announce ?? true,
      })
      .select()
      .single();

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    await notifyBot('levels');

    return NextResponse.json({ success: true, data });
  }

  if (type === 'multiplier') {
    const { role_id, multiplier } = body;
    if (!role_id || multiplier == null) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields: role_id, multiplier' },
        { status: 400 },
      );
    }

    const { data, error } = await supabase
      .from('xp_multipliers')
      .insert({
        guild_id: guildId,
        role_id,
        multiplier,
      })
      .select()
      .single();

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    await notifyBot('levels');

    return NextResponse.json({ success: true, data });
  }

  return NextResponse.json({ success: false, error: 'Invalid type' }, { status: 400 });
}

export async function DELETE(req: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const { searchParams } = new URL(req.url);
  const type = searchParams.get('type');
  const id = searchParams.get('id');

  if (!id || !type) {
    return NextResponse.json(
      { success: false, error: 'Missing id or type' },
      { status: 400 },
    );
  }

  const table = type === 'reward' ? 'level_rewards' : 'xp_multipliers';

  const { error } = await supabase
    .from(table)
    .delete()
    .eq('id', id)
    .eq('guild_id', guildId);

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  await notifyBot('levels');

  return NextResponse.json({ success: true });
}
