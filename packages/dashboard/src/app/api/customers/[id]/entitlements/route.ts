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
import { getGracePeriodDays } from '@somnibot/shared';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

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

  const {
    request_id,
    product_id,
    type,
    plan_id,
    source,
    expires_at,
    granted_role_ids,
    granted_channel_ids,
  } = body;

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

  if (type === 'subscription') {
    const { data: plan, error: planError } = await supabase
      .from('plans')
      .select('id')
      .eq('id', plan_id)
      .eq('product_id', product_id)
      .eq('guild_id', guildId)
      .eq('active', true)
      .maybeSingle();

    if (planError) {
      return dbError(planError, 'customers/entitlements');
    }
    if (!plan) {
      return NextResponse.json(
        { success: false, error: 'Active subscription plan not found for product' },
        { status: 404 },
      );
    }
  }

  // The order and entitlement are one provenance contract. Two separate REST
  // inserts left a completed zero-dollar order behind if the second write (or
  // the process between writes) failed. The security-definer RPC validates the
  // same guild/customer/product contract again inside one transaction and uses
  // requestId as its replay identity, so a lost-response retry is exact.
  // PostgreSQL renders UUIDs canonically in lowercase. Normalize caller input
  // before comparing the returned replay identity so uppercase-but-valid UUIDs
  // do not turn a successful atomic grant into a false malformed-response 500.
  const requestId = request_id.toLowerCase();
  const rpc = supabase.rpc as unknown as (
    name: string,
    params: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
  const { data: grantRows, error } = await rpc(
    'commerce_create_noncommerce_entitlement',
    {
      p_request_id: requestId,
      p_guild_id: guildId,
      p_customer_id: customerId,
      p_product_id: product_id,
      p_source: source,
      p_type: type,
      p_plan_id: plan_id ?? null,
      p_expires_at: expires_at ?? null,
      p_granted_role_ids: granted_role_ids,
      p_granted_channel_ids: granted_channel_ids,
    },
  );

  if (error) {
    return dbError(error, 'customers/entitlements');
  }

  const grant = Array.isArray(grantRows) && grantRows.length === 1
    ? grantRows[0]
    : null;
  if (
    !grant
    || typeof grant !== 'object'
    || !isUuid((grant as Record<string, unknown>).entitlement_id)
    || (grant as Record<string, unknown>).order_id !== requestId
    || (grant as Record<string, unknown>).request_id !== requestId
  ) {
    return dbError(
      { message: 'Atomic noncommerce grant RPC returned malformed identity evidence' },
      'customers/entitlements',
    );
  }

  return NextResponse.json({
    success: true,
    data: {
      id: (grant as Record<string, unknown>).entitlement_id,
      order_id: (grant as Record<string, unknown>).order_id,
      request_id: requestId,
    },
  });
}

export async function PUT(
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

  // `revoked` is an operator action, not a legal entitlements.status value.
  // Keep the API alias for callers, but persist the same terminal state used
  // by EntitlementService.revoke('revoked') instead of surfacing a raw CHECK
  // violation from the database.
  const persistedStatus = status === 'revoked' ? 'expired' : status;

  let gracePeriodEndsAt: string | null = null;

  // W2: the entitlements_grace_period_has_deadline CHECK requires every
  // grace_period row to carry a deadline — a deadline-less row is invisible
  // to the reconciliation sweep (it would decay forever). Manual/admin
  // transitions into grace honor the guild's configured window
  // (guild_config.grace_period_days) via the same shared helper the bot's
  // suspension flow (commerce-fulfillment → EntitlementService.suspend) uses,
  // so an operator's configured deadline is applied no matter which surface
  // starts the grace period — with the same DEFAULT_GRACE_PERIOD_DAYS fallback
  // when unset.
  if (status === 'grace_period') {
    const graceDays = await getGracePeriodDays(supabase, guildId);
    const graceEnds = new Date();
    graceEnds.setDate(graceEnds.getDate() + graceDays);
    gracePeriodEndsAt = graceEnds.toISOString();
  }

  // Lock, classify, and transition in one database operation. In particular,
  // an owner must not resurrect cancelled/expired paid access while its order
  // remains completed; only the verified payment/subscription recovery flow
  // may do that. The RPC also binds the URL customer id, closing the old route
  // mismatch where /customers/A could update an entitlement owned by B.
  const rpc = supabase.rpc as unknown as (
    name: string,
    params: Record<string, unknown>,
  ) => Promise<{
    data: unknown;
    error: { message: string; code?: string } | null;
  }>;
  const { data: statusRows, error } = await rpc(
    'commerce_update_entitlement_status_admin',
    {
      p_entitlement_id: entitlement_id,
      p_customer_id: customerId,
      p_guild_id: guildId,
      p_status: persistedStatus,
      p_grace_period_ends_at: gracePeriodEndsAt,
    },
  );

  if (error) {
    if (error.code === '23514') {
      return NextResponse.json(
        {
          success: false,
          error: 'This entitlement transition conflicts with its authoritative lifecycle',
        },
        { status: 409 },
      );
    }
    return dbError(error, 'customers/entitlements');
  }

  const statusRow = Array.isArray(statusRows) ? statusRows[0] : statusRows;
  if (
    !statusRow
    || typeof statusRow !== 'object'
    || (statusRow as Record<string, unknown>).entitlement_id !== entitlement_id
    || (statusRow as Record<string, unknown>).customer_id !== customerId
    || (statusRow as Record<string, unknown>).status !== persistedStatus
  ) {
    return dbError(
      { message: 'Atomic entitlement status RPC returned malformed identity evidence' },
      'customers/entitlements',
    );
  }
  const data = statusRow as Record<string, unknown>;

  // W2 review: manual status changes must replicate the
  // EntitlementService.suspend/reactivate alert lifecycle — otherwise a
  // manual suspension raises no operator alert and a manual reactivation
  // strands the 'entitlement_grace_period' alert unresolved forever. Alert
  // writes are non-fatal: the status change above has already committed.
  if (status === 'grace_period') {
    const alertMessage =
      `Entitlement ${entitlement_id} was manually moved into a grace period ending ` +
      `${gracePeriodEndsAt}. If access is not recovered by then, ` +
      'access will be revoked automatically.';
    const alertMetadata = {
      entitlement_id,
      customer_id: data.customer_id ?? null,
      product_id: data.product_id ?? null,
      order_id: data.order_id ?? null,
      grace_period_ends_at: gracePeriodEndsAt,
      source: 'dashboard.entitlements.update',
    };

    // Same deduped raise as EntitlementService.suspend: the partial unique
    // index uniq_alerts_unresolved_entitlement_grace permits one unresolved
    // alert per entitlement, so a 23505 means one already exists (e.g. the
    // entitlement was already in grace, or this races the bot's suspend()).
    const { error: alertError } = await supabase.from('alerts').insert({
      guild_id: guildId,
      alert_type: 'entitlement_grace_period',
      severity: 'warning',
      title: 'Entitlement entered grace period',
      message: alertMessage,
      metadata: alertMetadata,
    });
    if (alertError && alertError.code === '23505') {
      // Codex W2: the PUT above already wrote a NEW grace_period_ends_at, so the
      // pre-existing unresolved alert now carries a stale deadline in its
      // message/metadata. Refresh it in place (same entitlement-scoped filter as
      // the resolve branch) so operators see the current revocation time rather
      // than the old one. Non-fatal — the status change has already committed.
      const { error: refreshError } = await supabase
        .from('alerts')
        .update({
          message: alertMessage,
          metadata: alertMetadata,
          severity: 'warning',
          updated_at: new Date().toISOString(),
        })
        .eq('guild_id', guildId)
        .eq('alert_type', 'entitlement_grace_period')
        .eq('metadata->>entitlement_id', entitlement_id)
        .eq('resolved', false);
      if (refreshError) {
        console.error(
          '[customers/entitlements] Failed to refresh duplicate grace-period alert:',
          refreshError.message,
        );
      }
    } else if (alertError) {
      console.error(
        '[customers/entitlements] Failed to write grace-period alert:',
        alertError.message,
      );
    }
  } else {
    // Every other status this route allows (active, cancelled, expired,
    // revoked -> expired, pending) means the entitlement is no longer in grace —
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
