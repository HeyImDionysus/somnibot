/**
 * /api/store/plans — Subscription plan CRUD.
 *
 * GET: List all plans (optionally filtered by product_id)
 * POST: Create a new plan
 * PUT: Update a plan
 * DELETE: Delete a plan by ID
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { parseBody, schemas } from '@/lib/api/validation';


export async function GET(req: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const { searchParams } = new URL(req.url);
  const productId = searchParams.get('product_id');

  let query = supabase
    .from('plans')
    .select('*')
    .eq('guild_id', guildId)
    .order('price_cents', { ascending: true });

  if (productId) {
    query = query.eq('product_id', productId);
  }

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, data: data ?? [] });
}

export async function POST(req: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const parsed = await parseBody(req, schemas.plan.create);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const {
    product_id,
    name,
    paypal_plan_id,
    interval_unit,
    interval_count,
    price_cents,
    currency,
    trial_days,
    active,
  } = body;

  if (!product_id || !name || !interval_unit || price_cents == null) {
    return NextResponse.json(
      { success: false, error: 'Missing required fields: product_id, name, interval_unit, price_cents' },
      { status: 400 },
    );
  }

  const { data, error } = await supabase
    .from('plans')
    .insert({
      product_id,
      guild_id: guildId,
      name,
      paypal_plan_id: paypal_plan_id ?? null,
      interval_unit,
      interval_count: interval_count ?? 1,
      price_cents,
      currency: currency ?? 'USD',
      trial_days: trial_days ?? 0,
      active: active ?? true,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, data });
}

export async function PUT(req: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const body = await req.json();
  const { id, ...updates } = body;

  if (!id) {
    return NextResponse.json({ success: false, error: 'Missing plan id' }, { status: 400 });
  }

  delete updates.guild_id;
  delete updates.created_at;
  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('plans')
    .update(updates)
    .eq('id', id)
    .eq('guild_id', guildId)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, data });
}

export async function DELETE(req: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');

  if (!id) {
    return NextResponse.json({ success: false, error: 'Missing plan id' }, { status: 400 });
  }

  const { error } = await supabase
    .from('plans')
    .delete()
    .eq('id', id)
    .eq('guild_id', guildId);

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
