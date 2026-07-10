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
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';


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
    .order('created_at', { ascending: false })
    .limit(500);

  if (error) {
    return dbError(error, 'customers/entitlements');
  }

  return NextResponse.json({ success: true, data: data ?? [] });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

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
      order_number: `ORD-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`,
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
    return dbError(orderErr ?? { message: 'Failed to create order' }, 'customers/entitlements');
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
    return dbError(error, 'customers/entitlements');
  }

  return NextResponse.json({ success: true, data });
}

export async function PUT(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

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

  // W2: the entitlements_grace_period_has_deadline CHECK requires every
  // grace_period row to carry a deadline — a deadline-less row is invisible
  // to the reconciliation sweep (it would decay forever). Manual/admin
  // transitions into grace get the same default window as
  // EntitlementService.suspend (3 days).
  if (status === 'grace_period') {
    const graceEnds = new Date();
    graceEnds.setDate(graceEnds.getDate() + 3);
    updateData.grace_period_ends_at = graceEnds.toISOString();
  } else if (status === 'active') {
    // Mirrors EntitlementService.reactivate: returning to active clears the
    // grace deadline. Terminal statuses keep it as a trace of when the
    // window lapsed (parity with revoke() and the reconciliation sweep).
    updateData.grace_period_ends_at = null;
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
    return dbError(error, 'customers/entitlements');
  }

  // W2 review: manual status changes must replicate the
  // EntitlementService.suspend/reactivate alert lifecycle — otherwise a
  // manual suspension raises no operator alert and a manual reactivation
  // strands the 'entitlement_grace_period' alert unresolved forever. Alert
  // writes are non-fatal: the status change above has already committed.
  if (status === 'grace_period') {
    // Same deduped raise as EntitlementService.suspend: the partial unique
    // index uniq_alerts_unresolved_entitlement_grace permits one unresolved
    // alert per entitlement, so a 23505 means it already exists (dedupe
    // success — e.g. re-entering grace, or racing the bot's suspend()).
    const { error: alertError } = await supabase.from('alerts').insert({
      guild_id: guildId,
      alert_type: 'entitlement_grace_period',
      severity: 'warning',
      title: 'Paid entitlement entered payment grace period',
      message:
        `Entitlement ${entitlement_id} was manually moved into a grace period ending ` +
        `${updateData.grace_period_ends_at}. If payment is not recovered by then, ` +
        'access will be revoked automatically.',
      metadata: {
        entitlement_id,
        customer_id: data?.customer_id ?? null,
        product_id: data?.product_id ?? null,
        order_id: data?.order_id ?? null,
        grace_period_ends_at: updateData.grace_period_ends_at,
        source: 'dashboard.entitlements.update',
      },
    });
    if (alertError && alertError.code !== '23505') {
      console.error(
        '[customers/entitlements] Failed to write grace-period alert:',
        alertError.message,
      );
    }
  } else {
    // Every other status this route allows (active, cancelled, expired,
    // revoked, pending) means the entitlement is no longer in grace —
    // resolve any outstanding alert. Same entitlement-scoped filters as
    // EntitlementService.reactivate/revoke and the reconciliation sweep;
    // a no-op when none exists.
    const { error: alertError } = await supabase
      .from('alerts')
      .update({
        resolved: true,
        resolved_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('guild_id', guildId)
      .eq('alert_type', 'entitlement_grace_period')
      .eq('metadata->>entitlement_id', entitlement_id)
      .eq('resolved', false);
    if (alertError) {
      console.error(
        '[customers/entitlements] Failed to resolve grace-period alert:',
        alertError.message,
      );
    }
  }

  return NextResponse.json({ success: true, data });
}
