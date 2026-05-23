/**
 * /api/customers/[id]/entitlements — Manage entitlements for a customer.
 *
 * GET: List entitlements
 * POST: Manually grant entitlement
 * PUT: Update entitlement status
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { parseBody, schemas } from '@/lib/api/validation';


export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const { id: customerId } = await params;
  const supabase = createAdminSupabase();

  // V47-C2: assert the customer belongs to this guild before exposing
  // entitlement history; otherwise UUID guessing leaks subscription state.
  const { data: customer } = await supabase
    .from('customers')
    .select('id')
    .eq('id', customerId)
    .eq('guild_id', guildId)
    .maybeSingle();

  if (!customer) {
    return NextResponse.json({ success: false, error: 'Customer not found' }, { status: 404 });
  }

  const { data, error } = await supabase
    .from('entitlements')
    .select('*, products(name)')
    .eq('customer_id', customerId)
    .eq('guild_id', guildId)
    .order('created_at', { ascending: false });
    .limit(500)

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, data: data ?? [] });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const { id: customerId } = await params;
  const supabase = createAdminSupabase();
  const parsed = await parseBody(req, schemas.entitlement.grant);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const { product_id, type, source, expires_at, granted_role_ids, granted_channel_ids } = body;

  if (!product_id) {
    return NextResponse.json({ success: false, error: 'Missing product_id' }, { status: 400 });
  }

  // V47-C2: confirm customer + product both belong to this guild
  // before manufacturing an order + entitlement for them.
  const { data: customer } = await supabase
    .from('customers')
    .select('id')
    .eq('id', customerId)
    .eq('guild_id', guildId)
    .maybeSingle();

  if (!customer) {
    return NextResponse.json({ success: false, error: 'Customer not found' }, { status: 404 });
  }

  const { data: product } = await supabase
    .from('products')
    .select('id')
    .eq('id', product_id)
    .eq('guild_id', guildId)
    .maybeSingle();

  if (!product) {
    return NextResponse.json({ success: false, error: 'Product not found' }, { status: 404 });
  }

  // Create a manual order first
  const { data: order, error: orderErr } = await supabase
    .from('orders')
    .insert({
      order_number: `ORD-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
      customer_id: customerId,
      guild_id: guildId,
      product_id,
      amount_cents: 0,
      currency: 'USD',
      status: 'completed',
      source: source ?? 'manual',
    })
    .select('id')
    .single();

  if (orderErr || !order) {
    return NextResponse.json({ success: false, error: orderErr?.message ?? 'Failed to create order' }, { status: 500 });
  }

  const { data, error } = await supabase
    .from('entitlements')
    .insert({
      customer_id: customerId,
      guild_id: guildId,
      product_id,
      order_id: order.id,
      type: type ?? 'one_time',
      status: 'active',
      source: source ?? 'manual',
      granted_role_ids: granted_role_ids ?? [],
      granted_channel_ids: granted_channel_ids ?? [],
      starts_at: new Date().toISOString(),
      expires_at: expires_at ?? null,
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
  const parsed = await parseBody(req, schemas.entitlement.update);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const { entitlement_id, status } = body;

  if (!entitlement_id || !status) {
    return NextResponse.json(
      { success: false, error: 'Missing entitlement_id and status' },
      { status: 400 },
    );
  }

  const updateData: Record<string, unknown> = {
    status,
    updated_at: new Date().toISOString(),
  };

  if (status === 'cancelled') {
    updateData.cancelled_at = new Date().toISOString();
  }

  // V47-C2: scope by guild so another owner cannot toggle entitlement
  // status (e.g. silently reactivate a refunded entitlement) by id alone.
  const { data, error } = await supabase
    .from('entitlements')
    .update(updateData)
    .eq('id', entitlement_id)
    .eq('guild_id', guildId)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, data });
}
