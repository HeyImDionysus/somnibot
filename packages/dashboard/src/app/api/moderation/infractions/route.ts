/**
 * /api/moderation/infractions — List, search, create manual, and pardon infractions.
 *
 * GET: List infractions (with optional member_id filter, pagination)
 * POST: Create a manual infraction (warn from dashboard)
 * PATCH: Pardon an infraction
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { parseBody, schemas } from '@/lib/api/validation';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';
import { recordAdminChange, readRowBefore } from '@/lib/admin-changes';

/** Keep a free-text reason to one readable clause in the change description. */
function summarize(text: string, max = 120): string {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export async function GET(req: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const { searchParams } = new URL(req.url);

  const memberId = searchParams.get('member_id');
  const activeOnly = searchParams.get('active') === 'true';
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '50'), 100);
  const offset = parseInt(searchParams.get('offset') ?? '0');

  let query = supabase
    .from('infractions')
    .select('*', { count: 'exact' })
    .eq('guild_id', guildId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)
    .limit(1000);

  if (memberId) {
    query = query.eq('member_id', memberId);
  }

  if (activeOnly) {
    query = query.eq('active', true).eq('pardoned', false);
  }

  const { data, error, count } = await query;

  if (error) {
    return dbError(error, 'moderation/infractions');
  }

  return NextResponse.json({
    success: true,
    data: data ?? [],
    total: count ?? 0,
    limit,
    offset,
  });
}

export async function POST(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId, discordId } = auth.ctx;

  const supabase = createAdminSupabase();
  const parsed = await parseBody(req, schemas.infraction.create);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const { member_id, type, reason, moderator_id, duration_minutes } = body;

  if (!member_id || !type || !reason) {
    return NextResponse.json(
      { success: false, error: 'Missing required fields: member_id, type, reason' },
      { status: 400 },
    );
  }

  const validTypes = ['warn', 'mute', 'kick', 'ban'];
  if (!validTypes.includes(type)) {
    return NextResponse.json(
      { success: false, error: `Invalid type. Must be one of: ${validTypes.join(', ')}` },
      { status: 400 },
    );
  }

  // Get infraction expiry config
  const { data: config } = await supabase
    .from('guild_config')
    .select('infraction_expiry_days')
    .eq('guild_id', guildId)
    .maybeSingle();

  const expiryDays = (config?.infraction_expiry_days as number) ?? 30;
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + expiryDays);

  const { data, error } = await supabase
    .from('infractions')
    .insert({
      guild_id: guildId,
      member_id,
      moderator_id: moderator_id ?? 'dashboard',
      type,
      reason,
      duration_minutes: type === 'mute' ? (duration_minutes ?? null) : null,
      active: true,
      pardoned: false,
      expires_at: expiresAt.toISOString(),
    })
    .select()
    .single();

  if (error) {
    return dbError(error, 'moderation/infractions');
  }

  // Wording matters here. This route writes an `infractions` row and nothing
  // else — no bot_action_queue entry, and the bot has no Realtime subscription
  // on `infractions` — so creating a "ban" from the dashboard does NOT ban
  // anyone in Discord. "Recorded" is the honest verb; "Banned" would tell the
  // owner something happened that did not.
  await recordAdminChange({
    guildId,
    actorId: discordId,
    action: 'moderation.infraction_created',
    targetType: 'infraction',
    targetId: (data as { id?: string } | null)?.id ?? null,
    description:
      `Recorded a manual ${type} against ${member_id} in their moderation history: `
      + `${summarize(reason)}`,
    after: {
      member_id,
      type,
      reason,
      duration_minutes: type === 'mute' ? (duration_minutes ?? null) : null,
      expires_at: expiresAt.toISOString(),
    },
    blastRadius: type === 'ban' || type === 'kick' ? 'high' : 'medium',
    undoReason:
      'a newly recorded infraction cannot be removed by an undo — pardon it from the Moderation page instead',
  }, supabase);

  return NextResponse.json({
    success: true,
    data,
    execution: 'history_only',
    message: 'Infraction recorded in moderation history; no Discord action was executed.',
  });
}

export async function PATCH(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId, discordId } = auth.ctx;

  const supabase = createAdminSupabase();
  const parsed = await parseBody(req, schemas.infraction.pardon);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  if (!body.id) {
    return NextResponse.json({ success: false, error: 'Missing infraction id' }, { status: 400 });
  }

  if (body.action === 'pardon') {
    // Prior state read BEFORE the pardon, so the change shows what the
    // infraction was rather than what it became.
    const before = await readRowBefore(
      supabase,
      'infractions',
      { id: body.id, guild_id: guildId },
      'id, member_id, type, reason, active, pardoned',
    );

    const { data, error } = await supabase
      .from('infractions')
      .update({
        active: false,
        pardoned: true,
        pardoned_by: body.pardoned_by ?? 'dashboard',
        pardoned_at: new Date().toISOString(),
      })
      .eq('id', body.id)
      .eq('guild_id', guildId)
      .select()
      .single();

    if (error) {
      return dbError(error, 'moderation/infractions');
    }

    await recordAdminChange({
      guildId,
      actorId: discordId,
      action: 'moderation.infraction_pardoned',
      targetType: 'infraction',
      targetId: body.id,
      description:
        `Pardoned the ${String(before?.type ?? '')} recorded against `
        + `${String(before?.member_id ?? 'a member')}, clearing it from their history`.replace(
          /\s+/g,
          ' ',
        ),
      before: before
        ? { active: before.active ?? null, pardoned: before.pardoned ?? null }
        : undefined,
      after: { active: false, pardoned: true, pardoned_by: body.pardoned_by ?? 'dashboard' },
      blastRadius: 'medium',
      // `infractions` is deliberately absent from UNDO_TABLE_COLUMNS, so a db
      // undo would be rejected the moment the button was pressed.
      undoReason:
        'a pardon is final — record a fresh infraction if the original action should still stand',
    }, supabase);

    return NextResponse.json({ success: true, data });
  }

  return NextResponse.json({ success: false, error: 'Unknown action' }, { status: 400 });
}
