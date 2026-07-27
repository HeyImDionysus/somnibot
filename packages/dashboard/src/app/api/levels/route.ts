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
import { parseBody, schemas } from '@/lib/api/validation';
import { z } from 'zod';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';
import { readGuildConfigBefore, recordGuildConfigChange } from '@/lib/admin-changes';

const snowflake = z.string().regex(/^\d{17,20}$/);

const levelsConfigUpdate = z.object({
  levels_enabled: z.boolean().optional(),
  xp_min: z.number().int().min(0).max(10000).optional(),
  xp_max: z.number().int().min(0).max(10000).optional(),
  xp_cooldown_seconds: z.number().int().min(0).max(3600).optional(),
  voice_xp_enabled: z.boolean().optional(),
  voice_xp_per_interval: z.number().int().min(0).max(1000).optional(),
  voice_xp_interval_minutes: z.number().int().min(1).max(60).optional(),
  xp_multiplier_mode: z.string().max(32).optional(),
  xp_channel_mode: z.string().max(32).optional(),
  xp_channel_list: z.array(snowflake).max(100).optional(),
  level_up_channel_id: snowflake.optional().nullable(),
  level_up_message: z.string().max(2000).optional(),
  rank_card_accent_color: z.string().max(32).optional().nullable(),
  rank_card_background: z.string().max(512).optional().nullable(),
  no_xp_role_id: snowflake.optional().nullable(),
});
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
      .range(offset, offset + pageSize - 1)
      .limit(1000);

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
        'levels_enabled, xp_min, xp_max, xp_cooldown_seconds, voice_xp_enabled, voice_xp_per_interval, voice_xp_interval_minutes, xp_multiplier_mode, xp_channel_mode, xp_channel_list, level_up_channel_id, level_up_message, rank_card_accent_color, rank_card_background, no_xp_role_id',
      )
      .eq('guild_id', guildId)
      .maybeSingle(),
    supabase
      .from('level_rewards')
      .select('*')
      .eq('guild_id', guildId)
      .order('level', { ascending: true })
      .limit(1000),
    supabase
      .from('xp_multipliers')
      .select('*')
      .eq('guild_id', guildId)
      .order('multiplier', { ascending: false })
      .limit(1000),
  ]);

  return NextResponse.json({
    success: true,
    config: configResult.data ?? {},
    rewards: rewardsResult.data ?? [],
    multipliers: multipliersResult.data ?? [],
  });
}

export async function PUT(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const parsed = await parseBody(req, levelsConfigUpdate);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const updates: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(body)) {
    if (val !== undefined) {
      updates[key] = val;
    }
  }

  // Prior values captured before the bookkeeping columns below are folded in.
  const before = await readGuildConfigBefore(supabase, guildId, Object.keys(updates));

  updates.updated_at = new Date().toISOString();

  // FIX #10: Use upsert instead of update — new guilds may not have a
  // guild_config row yet, causing .update().single() to fail with a
  // Supabase error. Upsert ensures the row is created if missing.
  updates.guild_id = guildId;
  const { data, error } = await supabase
    .from('guild_config')
    .upsert(updates, { onConflict: 'guild_id' })
    .select()
    .single();

  if (error) {
    return dbError(error, 'levels');
  }

  await notifyBot('levels');

  await recordGuildConfigChange({
    guildId,
    actorId: auth.ctx.discordId,
    action: 'levels.updated',
    area: 'levels & XP',
    updates,
    before,
  }, supabase);

  return NextResponse.json({ success: true, data });
}

export async function POST(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const parsed = await parseBody(req, schemas.levelReward.create);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
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
      return dbError(error, 'levels');
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
      return dbError(error, 'levels');
    }

    await notifyBot('levels');

    return NextResponse.json({ success: true, data });
  }

  return NextResponse.json({ success: false, error: 'Invalid type' }, { status: 400 });
}

export async function DELETE(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

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
    return dbError(error, 'levels');
  }

  await notifyBot('levels');

  return NextResponse.json({ success: true });
}
