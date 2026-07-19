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

  await notifyBot('giveaways');

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

  await notifyBot('giveaways');

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

  const { error } = await supabase
    .from('giveaways')
    .delete()
    .eq('id', id)
    .eq('guild_id', guildId);

  if (error) {
    return dbError(error, 'giveaways');
  }

  await notifyBot('giveaways');

  return NextResponse.json({ success: true });
}
