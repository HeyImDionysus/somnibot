/**
 * /api/store/products — Product CRUD.
 *
 * GET: List all products for the guild
 * POST: Create a new product
 * PUT: Update a product
 * DELETE: Delete a product by ID
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';

const GUILD_ID = process.env.DISCORD_GUILD_ID!;

export async function GET() {
  const supabase = createAdminSupabase();

  const { data, error } = await supabase
    .from('products')
    .select('*, plans(*), product_license_config(*)')
    .eq('guild_id', GUILD_ID)
    .order('sort_order', { ascending: true });

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
    description,
    type,
    delivery_type,
    price_cents,
    currency,
    granted_role_ids,
    granted_channel_ids,
    active,
    sort_order,
    metadata,
  } = body;

  if (!name || !type || !delivery_type || price_cents == null) {
    return NextResponse.json(
      { success: false, error: 'Missing required fields: name, type, delivery_type, price_cents' },
      { status: 400 },
    );
  }

  const { data, error } = await supabase
    .from('products')
    .insert({
      guild_id: GUILD_ID,
      name,
      description: description ?? null,
      type,
      delivery_type,
      price_cents,
      currency: currency ?? 'USD',
      granted_role_ids: granted_role_ids ?? [],
      granted_channel_ids: granted_channel_ids ?? [],
      active: active ?? true,
      sort_order: sort_order ?? 0,
      metadata: metadata ?? {},
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
    return NextResponse.json({ success: false, error: 'Missing product id' }, { status: 400 });
  }

  // Remove fields that shouldn't be updated directly
  delete updates.guild_id;
  delete updates.created_at;
  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('products')
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
    return NextResponse.json({ success: false, error: 'Missing product id' }, { status: 400 });
  }

  const { error } = await supabase
    .from('products')
    .delete()
    .eq('id', id)
    .eq('guild_id', GUILD_ID);

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
