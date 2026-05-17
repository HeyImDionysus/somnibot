/**
 * /api/store/promotions — Promotion/Coupon CRUD.
 *
 * GET: List all promotions
 * POST: Create a promotion
 * PUT: Update a promotion
 * DELETE: Delete a promotion
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';

const GUILD_ID = process.env.DISCORD_GUILD_ID!;

export async function GET() {
  const supabase = createAdminSupabase();

  const { data, error } = await supabase
    .from('promotions')
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
    name,
    type,
    value,
    coupon_code,
    applies_to_product_ids,
    applies_to_plan_ids,
    start_date,
    end_date,
    max_uses,
    min_purchase_cents,
    first_purchase_only,
    active,
  } = body;

  if (!name || !type || value == null) {
    return NextResponse.json(
      { success: false, error: 'Missing required fields: name, type, value' },
      { status: 400 },
    );
  }

  const { data, error } = await supabase
    .from('promotions')
    .insert({
      guild_id: GUILD_ID,
      name,
      type,
      value,
      coupon_code: coupon_code ?? null,
      applies_to_product_ids: applies_to_product_ids ?? [],
      applies_to_plan_ids: applies_to_plan_ids ?? [],
      start_date: start_date ?? null,
      end_date: end_date ?? null,
      max_uses: max_uses ?? null,
      min_purchase_cents: min_purchase_cents ?? null,
      first_purchase_only: first_purchase_only ?? false,
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
  const supabase = createAdminSupabase();
  const body = await req.json();
  const { id, ...updates } = body;

  if (!id) {
    return NextResponse.json({ success: false, error: 'Missing promotion id' }, { status: 400 });
  }

  delete updates.guild_id;
  delete updates.created_at;
  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('promotions')
    .update(updates)
    .eq('id', id)
    .eq('guild_id', GUILD_ID)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, data });
}

export async function DELETE(req: NextRequest) {
  const supabase = createAdminSupabase();
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');

  if (!id) {
    return NextResponse.json({ success: false, error: 'Missing promotion id' }, { status: 400 });
  }

  const { error } = await supabase
    .from('promotions')
    .delete()
    .eq('id', id)
    .eq('guild_id', GUILD_ID);

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
