/**
 * /api/giveaways — CRUD for giveaway configurations.
 *
 * GET: List all giveaways for the guild
 * POST: Create a new giveaway
 * PUT: Update/end/reroll a giveaway
 * DELETE: Delete a giveaway by ID
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { notifyBot } from '@/lib/notify-bot';

const GUILD_ID = process.env.DISCORD_GUILD_ID!;

export async function GET() {
  const supabase = createAdminSupabase();

  const { data, error } = await supabase
    .from('giveaways')
    .select('*')
    .eq('guild_id', GUILD_ID)
    .order('created_at', { ascending: false });

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, data: data ?? [] });
}

export async function POST(req: NextRequest) {
  const supabase = createAdminSupabase();
  const body = await req.json();

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

  // Max 25 active giveaways
  const { count } = await supabase
    .from('giveaways')
    .select('id', { count: 'exact', head: true })
    .eq('guild_id', GUILD_ID)
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
      guild_id: GUILD_ID,
      channel_id,
      prize,
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
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  await notifyBot('giveaways');

  return NextResponse.json({ success: true, data });
}

export async function PUT(req: NextRequest) {
  const supabase = createAdminSupabase();
  const body = await req.json();

  if (!body.id) {
    return NextResponse.json({ success: false, error: 'Missing giveaway id' }, { status: 400 });
  }

  const allowedFields = [
    'prize',
    'winner_count',
    'ends_at',
    'required_role_id',
    'required_level',
    'prize_product_id',
    'prize_license_count',
    'status',
    'winners',
  ];

  const updates: Record<string, unknown> = {};
  for (const field of allowedFields) {
    if (body[field] !== undefined) {
      updates[field] = body[field];
    }
  }

  // If ending the giveaway
  if (body.status === 'ended' && !body.ended_at) {
    updates.ended_at = new Date().toISOString();
  }

  const { data, error } = await supabase
    .from('giveaways')
    .update(updates)
    .eq('id', body.id)
    .eq('guild_id', GUILD_ID)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  await notifyBot('giveaways');

  return NextResponse.json({ success: true, data });
}

export async function DELETE(req: NextRequest) {
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
    .eq('guild_id', GUILD_ID);

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  await notifyBot('giveaways');

  return NextResponse.json({ success: true });
}
