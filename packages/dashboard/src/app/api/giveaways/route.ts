/**
 * /api/giveaways — CRUD for giveaway configurations.
 *
 * GET: List all giveaways for the guild
 * POST: Create a new giveaway
 * PUT: Update/end/reroll a giveaway
 * DELETE: Delete a giveaway by ID
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { notifyBot } from '@/lib/notify-bot';
import { parseBody, schemas } from '@/lib/api/validation';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { typedPick } from '@/lib/api/typed-pick';
import { dbError } from '@/lib/api/response';
import { readRowBefore, recordCrudChange } from '@/lib/admin-changes';

/**
 * [#57] Append-only audit rows for the dashboard giveaway CRUD surface (the
 * bot rail audits lifecycle events it performs itself — start/pause/end —
 * but never these dashboard-origin config writes). Best-effort service-role
 * insert — an audit failure never fails the request.
 */
async function writeGiveawayAudit(
  supabase: ReturnType<typeof createAdminSupabase>,
  entry: {
    guildId: string;
    actorId: string;
    action: 'giveaway.created' | 'giveaway.updated' | 'giveaway.deleted';
    targetId: string;
    details?: Record<string, unknown>;
    beforeState?: Record<string, unknown> | null;
    afterState?: Record<string, unknown> | null;
  },
): Promise<void> {
  try {
    const { error } = await supabase.from('audit_logs').insert({
      guild_id: entry.guildId,
      actor_type: 'dashboard',
      actor_id: entry.actorId,
      action: entry.action,
      category: 'giveaways',
      target_type: 'giveaway',
      target_id: entry.targetId,
      details: entry.details ?? {},
      before_state: entry.beforeState ?? null,
      after_state: entry.afterState ?? null,
      success: true,
    });
    if (error) {
      console.error(`[giveaways] Failed to write ${entry.action} audit row:`, error.message);
    }
  } catch (err) {
    // Audit logging must never break the CRUD flow — but never silently.
    console.error(`[giveaways] Exception writing ${entry.action} audit row:`, err);
  }
}

export async function GET() {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();

  const { data, error } = await supabase
    .from('giveaways')
    .select('*')
    .eq('guild_id', guildId)
    .order('created_at', { ascending: false })
    .limit(500);

  if (error) {
    return dbError(error, 'giveaways');
  }

  return NextResponse.json({ success: true, data: data ?? [] });
}

export async function POST(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const parsed = await parseBody(req, schemas.giveaway.create);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const {
    channel_id,
    prize,
    winner_count,
    ends_at,
    required_role_id,
    required_level,
    prize_product_id,
    prize_license_count,
    created_by,
  } = body;

  if (!channel_id || !prize || !ends_at) {
    return NextResponse.json(
      { success: false, error: 'Missing required fields: channel_id, prize, ends_at' },
      { status: 400 },
    );
  }

  // Canonical prize form: the winner-notification contract compares
  // btrim(left(btrim(prize), 1000)) snapshots, so store that form directly
  // (code-point slice — never cut mid-surrogate).
  const canonicalPrize = Array.from(String(prize).trim()).slice(0, 1_000).join('').trim();
  if (canonicalPrize.length === 0) {
    return NextResponse.json(
      { success: false, error: 'Prize cannot be empty' },
      { status: 400 },
    );
  }

  // Max 25 active giveaways
  const { count } = await supabase
    .from('giveaways')
    .select('id', { count: 'exact', head: true })
    .eq('guild_id', guildId)
    .eq('status', 'active');

  if ((count ?? 0) >= 25) {
    return NextResponse.json(
      { success: false, error: 'Maximum active giveaway limit reached (25)' },
      { status: 400 },
    );
  }

  const { data, error } = await supabase
    .from('giveaways')
    .insert({
      guild_id: guildId,
      channel_id,
      prize: canonicalPrize,
      winner_count: winner_count ?? 1,
      ends_at,
      required_role_id: required_role_id ?? null,
      required_level: required_level ?? null,
      prize_product_id: prize_product_id ?? null,
      prize_license_count: prize_license_count ?? 1,
      created_by: created_by ?? 'dashboard',
      entries: [],
      winners: [],
      status: 'active',
    })
    .select()
    .single();

  if (error) {
    return dbError(error, 'giveaways');
  }

  await writeGiveawayAudit(supabase, {
    guildId,
    actorId: auth.ctx.discordId,
    action: 'giveaway.created',
    targetId: data.id,
    details: { prize: data.prize, channelId: data.channel_id, endsAt: data.ends_at },
    afterState: typedPick(data, ['prize', 'channel_id', 'winner_count', 'ends_at', 'required_role_id', 'required_level', 'prize_product_id', 'prize_license_count', 'status']),
  });

  await notifyBot(guildId, 'giveaways');

  await recordCrudChange({
    guildId: auth.ctx.guildId,
    actorId: auth.ctx.discordId,
    operation: 'created',
    action: 'giveaways.giveaway_created',
    table: 'giveaways',
    targetType: 'giveaway',
    targetId: (data as { id?: string } | null)?.id ?? null,
    label: undefined,
    after: data as Record<string, unknown> | null,
    blastRadius: 'medium',
  }, supabase);

  return NextResponse.json({ success: true, data });
}

export async function PUT(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const parsed = await parseBody(req, schemas.giveaway.action);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  if (!body.id) {
    return NextResponse.json({ success: false, error: 'Missing giveaway id' }, { status: 400 });
  }

  const updates = typedPick(body, ['prize', 'winner_count', 'ends_at', 'required_role_id', 'required_level', 'prize_product_id', 'prize_license_count', 'status', 'winners']);

  // Prize edits get the same canonical form as creation: a raw edit with
  // edge whitespace btrim cannot strip would permanently dead-letter every
  // winner notification for this giveaway at the snapshot contract check.
  if (typeof updates.prize === 'string') {
    const canonical = Array.from(updates.prize.trim()).slice(0, 1_000).join('').trim();
    if (canonical.length === 0) {
      return NextResponse.json(
        { success: false, error: 'Prize cannot be empty' },
        { status: 400 },
      );
    }
    updates.prize = canonical;
  }

  // If ending the giveaway
  if (body.status === 'ended' && !body.ended_at) {
    updates.ended_at = new Date().toISOString();
  }

  // Read the row first so the audit diff carries the BEFORE side of exactly
  // the keys this update touches (an honest two-sided diff, no fabrication).
  // A FAILED read is logged and the diff stays one-sided — a null before_state
  // must mean "unavailable, and we said so", never a swallowed error.
  const { data: beforeRow, error: beforeErr } = await supabase
    .from('giveaways')
    .select('*')
    .eq('id', body.id)
    .eq('guild_id', guildId)
    .maybeSingle();
  if (beforeErr) {
    console.error('[giveaways] before-state read failed for giveaway.updated audit:', beforeErr.message);
  }

  const { data, error } = await supabase
    .from('giveaways')
    .update(updates)
    .eq('id', body.id)
    .eq('guild_id', guildId)
    .select()
    .single();

  if (error) {
    return dbError(error, 'giveaways');
  }

  const changedKeys = Object.keys(updates);
  // A no-op PUT (nothing picked from the body) changed nothing — writing a
  // giveaway.updated row with an empty diff would fabricate a mutation.
  if (changedKeys.length > 0) {
    await writeGiveawayAudit(supabase, {
      guildId,
      actorId: auth.ctx.discordId,
      action: 'giveaway.updated',
      targetId: data.id,
      details: { prize: data.prize, fields: changedKeys },
      beforeState: beforeRow
        ? Object.fromEntries(changedKeys.map((k) => [k, (beforeRow as Record<string, unknown>)[k] ?? null]))
        : null,
      afterState: Object.fromEntries(changedKeys.map((k) => [k, (data as Record<string, unknown>)[k] ?? null])),
    });
  }

  await notifyBot(guildId, 'giveaways');

  await recordCrudChange({
    guildId: auth.ctx.guildId,
    actorId: auth.ctx.discordId,
    operation: 'updated',
    action: 'giveaways.giveaway_updated',
    table: 'giveaways',
    targetType: 'giveaway',
    targetId: body.id,
    label: (beforeRow as Record<string, unknown> | null)?.prize as string | undefined,

    before: (beforeRow as Record<string, unknown> | null) ?? undefined,
    after: updates as Record<string, unknown>,
    match: { id: body.id, guild_id: auth.ctx.guildId },
    blastRadius: 'medium',
  }, supabase);

  return NextResponse.json({ success: true, data });
}

export async function DELETE(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');

  if (!id) {
    return NextResponse.json({ success: false, error: 'Missing giveaway id' }, { status: 400 });
  }

  const before = await readRowBefore(supabase, 'giveaways', { id: id, guild_id: auth.ctx.guildId });

  const { data: deletedRows, error } = await supabase
    .from('giveaways')
    .delete()
    .eq('id', id)
    .eq('guild_id', guildId)
    .select();

  if (error) {
    return dbError(error, 'giveaways');
  }

  const deleted = (deletedRows ?? [])[0] as Record<string, unknown> | undefined;
  if (deleted) {
    await writeGiveawayAudit(supabase, {
      guildId,
      actorId: auth.ctx.discordId,
      action: 'giveaway.deleted',
      targetId: id,
      details: { prize: deleted.prize, status: deleted.status, entryCount: Array.isArray(deleted.entries) ? deleted.entries.length : 0 },
      beforeState: typedPick(deleted, ['prize', 'channel_id', 'winner_count', 'ends_at', 'required_role_id', 'required_level', 'prize_product_id', 'prize_license_count', 'status']),
    });
  }

  await notifyBot(guildId, 'giveaways');

  await recordCrudChange({
    guildId: auth.ctx.guildId,
    actorId: auth.ctx.discordId,
    operation: 'deleted',
    action: 'giveaways.giveaway_deleted',
    table: 'giveaways',
    targetType: 'giveaway',
    targetId: id,
    label: before?.prize as string | undefined,

    before,
    blastRadius: 'medium',
  }, supabase);

  return NextResponse.json({ success: true });
}
