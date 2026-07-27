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
import { readRowBefore, recordAdminChange } from '@/lib/admin-changes';
import { getGracePeriodDays } from '@somnibot/shared';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/**
 * Name the customer the way the owner knows them, falling back to the id.
 * An entitlement change takes away (or hands out) access someone paid for, so
 * "customer 8f3a…" alone is not good enough on the Admin Changes page.
 */
function customerLabel(username: unknown, customerId: string): string {
  return typeof username === 'string' && username.trim() !== ''
    ? `customer ${username}`
    : `customer ${customerId}`;
}

/** Read an embedded `products(name)` / `customers(discord_username)` field. */
function embedded(row: Record<string, unknown> | undefined, key: string, field: string): unknown {
  const value = row?.[key];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return (value as Record<string, unknown>)[field];
  }
  return undefined;
}

/**
 * Why an entitlement change never carries an undo button.
 *
 * The undo route replays a row update, but `entitlements` is deliberately
 * absent from `UNDO_TABLE_COLUMNS`: the lifecycle is owned by
 * `commerce_update_entitlement_status_admin`, which refuses to resurrect
 * cancelled or expired PAID access precisely so a stray click cannot hand back
 * something the customer no longer paid for. The Discord roles and channel
 * access that travel with the entitlement have already been changed too.
 */
const ENTITLEMENT_UNDO_REASON =
  'entitlement access is guarded by its own lifecycle rules and the Discord roles have '
  + 'already changed — set the status back by hand if this was a mistake';

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

  // The grant schema defaults omitted Discord ID lists to [], but the atomic
  // grant RPC requires the request sets to exactly equal the product's
  // canonical sets — so a defaulted [] would reject every role-bearing
  // product. An omitted list means "grant the product's canonical access"
  // (resolved from the product row below, mirroring the bot's giveaway
  // fulfillment); an explicit list is forwarded verbatim so the RPC's
  // authority check stays the judge. Distinguish the two on the raw body
  // before Zod applies its defaults.
  const rawBody: unknown = await req.clone().json().catch(() => null);
  const rawBodyKeys = rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody)
    ? Object.keys(rawBody as Record<string, unknown>)
    : [];
  const roleIdsProvided = rawBodyKeys.includes('granted_role_ids');
  const channelIdsProvided = rawBodyKeys.includes('granted_channel_ids');

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
  // `discord_username` / `name` are read here so the recorded change can say
  // WHO was given WHAT rather than pairing two UUIDs.
  const { data: customer } = await supabase
    .from('customers')
    .select('id, discord_username')
    .eq('id', customerId)
    .eq('guild_id', guildId)
    .maybeSingle();

  if (!customer) {
    return NextResponse.json({ success: false, error: 'Customer not found' }, { status: 404 });
  }

  const { data: product } = await supabase
    .from('products')
    .select('id, name, granted_role_ids, granted_channel_ids')
    .eq('id', product_id)
    .eq('guild_id', guildId)
    .maybeSingle();

  if (!product) {
    return NextResponse.json({ success: false, error: 'Product not found' }, { status: 404 });
  }

  const grantedRoleIds = roleIdsProvided
    ? granted_role_ids
    : (product.granted_role_ids ?? []);
  const grantedChannelIds = channelIdsProvided
    ? granted_channel_ids
    : (product.granted_channel_ids ?? []);

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
  ) => Promise<{
    data: unknown;
    error: { message: string; code?: string } | null;
  }>;
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
      p_granted_role_ids: grantedRoleIds,
      p_granted_channel_ids: grantedChannelIds,
    },
  );

  if (error) {
    // The RPC raises 23514 when the requested grant contradicts the
    // authoritative catalog contract (role/channel sets that differ from the
    // product's canonical sets, type/plan shape, or guild/customer/product
    // identity). That is a caller conflict, not an internal failure — same
    // mapping as the PUT lifecycle handler below.
    if (error.code === '23514') {
      return NextResponse.json(
        {
          success: false,
          error: "This grant conflicts with the product's canonical access contract",
        },
        { status: 409 },
      );
    }
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

  const entitlementId = (grant as Record<string, unknown>).entitlement_id as string;

  // The grant creates a zero-value order row alongside the entitlement. Saying
  // so out loud matters: an owner scanning their change history must not read
  // "order created" as "someone paid me".
  await recordAdminChange(
    {
      guildId,
      actorId: auth.ctx.discordId,
      action: 'commerce.entitlement_granted',
      targetType: 'customer entitlement',
      targetId: entitlementId,
      description:
        `Granted ${customerLabel(customer.discord_username, customerId)} access to the `
        + `store product "${product.name ?? product_id}" by hand — this was a free grant, `
        + 'not a purchase, and no money changed hands',
      after: {
        entitlement_id: entitlementId,
        order_id: (grant as Record<string, unknown>).order_id,
        product_id,
        type,
        source,
        expires_at: expires_at ?? null,
        granted_role_ids: grantedRoleIds,
        granted_channel_ids: grantedChannelIds,
      },
      blastRadius: 'high',
      undoReason:
        'a manual grant cannot be taken back by an undo — revoke the entitlement from '
        + "the customer's page instead",
    },
    supabase,
  );

  return NextResponse.json({
    success: true,
    data: {
      id: entitlementId,
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

  // Prior status + the names this change is about, read BEFORE the transition.
  // Afterwards `status` is the new value, so an "before" captured then would
  // record the change as having changed nothing.
  // Prior status + the names this change is about, read BEFORE the transition.
  // Afterwards `status` is the new value, so a "before" captured then would
  // record the change as having changed nothing.
  const before = await readRowBefore(
    supabase,
    'entitlements',
    { id: entitlement_id, guild_id: guildId },
    'id, status, product_id, customer_id, expires_at, products(name), customers(discord_username)',
  );

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

  const who = customerLabel(embedded(before, 'customers', 'discord_username'), customerId);
  const productName = embedded(before, 'products', 'name');
  const what = typeof productName === 'string' && productName !== ''
    ? `the store product "${productName}"`
    : 'a store product';
  const priorStatus = typeof before?.status === 'string' ? before.status : null;

  await recordAdminChange(
    {
      guildId,
      actorId: auth.ctx.discordId,
      action: status === 'revoked'
        ? 'commerce.entitlement_revoked'
        : 'commerce.entitlement_status_changed',
      targetType: 'customer entitlement',
      targetId: entitlement_id,
      description: (() => {
        // `revoked` is an API alias that persists as `expired`; describing it as
        // "expired" would hide that a person chose to take the access away.
        if (status === 'revoked') {
          return `Revoked ${who}'s access to ${what} — the roles, downloads and license `
            + 'keys that came with it are removed';
        }
        if (status === 'grace_period') {
          return `Put ${who}'s access to ${what} into a grace period ending `
            + `${gracePeriodEndsAt} — access is revoked automatically if it is not `
            + 'recovered by then';
        }
        if (status === 'active') {
          return `Reactivated ${who}'s access to ${what}`;
        }
        return `Marked ${who}'s access to ${what} as ${status}`;
      })(),
      before: priorStatus ? { status: priorStatus } : undefined,
      after: {
        status: persistedStatus,
        ...(gracePeriodEndsAt ? { grace_period_ends_at: gracePeriodEndsAt } : {}),
      },
      // Entitlements are paid access; every transition here gives it or takes
      // it away.
      blastRadius: 'high',
      undoReason: ENTITLEMENT_UNDO_REASON,
    },
    supabase,
  );

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
