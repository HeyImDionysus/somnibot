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

  const { data, error } = await supabase
    .from('entitlements')
    .select('*, products(name)')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false });

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

  // Create a manual order first
  const { data: order, error: orderErr } = await supabase
    .from('orders')
    .insert({
      order_number: `INS-${Date.now().toString().slice(-5)}`,
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

  const { data, error } = await supabase
    .from('entitlements')
    .update(updateData)
    .eq('id', entitlement_id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, data });
}
