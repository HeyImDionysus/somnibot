/**
 * /api/orders — Order list.
 *
 * GET: List orders with optional search
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { sanitizeSearch } from '@/lib/utils/sanitize-search';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';
import { isCanonicalPayPalResourceId } from '@/lib/paypal-resource-id';

type RefundUiState = 'pending' | 'provider_completed' | 'failed' | 'retry';
type RefundContext = 'provider' | 'local';
type CustomerDisplay = { discord_id: string; discord_username: string };
type RefundOperationStatus =
  | 'prepared'
  | 'pending'
  | 'provider_completed'
  | 'failed'
  | 'cancelled'
  | 'completed';

const REFUND_OPERATION_PAGE_SIZE = 1_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function malformedListResponse(message = 'Order list data could not be loaded') {
  return NextResponse.json({ success: false, error: message }, { status: 500 });
}

function deriveRefundUiState(status: RefundOperationStatus): RefundUiState | null {
  switch (status) {
    case 'prepared':
      return 'retry';
    case 'pending':
      return 'pending';
    case 'provider_completed':
      return 'provider_completed';
    case 'failed':
    case 'cancelled':
      return 'failed';
    case 'completed':
      return null;
  }
}

async function loadLatestRefundStates(
  supabase: ReturnType<typeof createAdminSupabase>,
  guildId: string,
  orderIds: string[],
): Promise<
  | {
      ok: true;
      states: Map<string, RefundUiState | null>;
      contexts: Map<string, RefundContext>;
    }
  | { ok: false; response: NextResponse }
> {
  const states = new Map<string, RefundUiState | null>();
  const contexts = new Map<string, RefundContext>();
  if (orderIds.length === 0) return { ok: true, states, contexts };

  const requestedOrderIds = new Set(orderIds);
  const seenAttemptIds = new Set<string>();
  for (let offset = 0; ; offset += REFUND_OPERATION_PAGE_SIZE) {
    const { data, error } = await supabase
      .from('commerce_admin_refund_operations')
      .select('attempt_id, order_id, guild_id, status, provider_required, created_at')
      .eq('guild_id', guildId)
      .in('order_id', orderIds)
      .order('created_at', { ascending: false })
      .order('attempt_id', { ascending: false })
      .range(offset, offset + REFUND_OPERATION_PAGE_SIZE - 1);

    if (error) return { ok: false, response: dbError(error, 'orders/refund-state') };
    if (!Array.isArray(data)) {
      return { ok: false, response: malformedListResponse('Order refund state could not be loaded') };
    }

    for (const value of data) {
      const row = asRecord(value);
      const attemptId = row?.attempt_id;
      const orderId = row?.order_id;
      const status = row?.status;
      const providerRequired = row?.provider_required;
      const createdAt = row?.created_at;
      if (
        !row
        || !isUuid(attemptId)
        || seenAttemptIds.has(attemptId)
        || !isUuid(orderId)
        || !requestedOrderIds.has(orderId)
        || row.guild_id !== guildId
        || !['prepared', 'pending', 'provider_completed', 'failed', 'cancelled', 'completed']
          .includes(status as string)
        || typeof providerRequired !== 'boolean'
        || (['pending', 'provider_completed', 'failed', 'cancelled'].includes(status as string)
          && providerRequired !== true)
        || typeof createdAt !== 'string'
        || !Number.isFinite(Date.parse(createdAt))
      ) {
        return { ok: false, response: malformedListResponse('Order refund state could not be loaded') };
      }
      seenAttemptIds.add(attemptId);
      if (!states.has(orderId)) {
        const state = deriveRefundUiState(status as RefundOperationStatus);
        states.set(orderId, state);
        if (state !== null) {
          contexts.set(orderId, providerRequired ? 'provider' : 'local');
        }
      }
    }

    if (data.length < REFUND_OPERATION_PAGE_SIZE || states.size === orderIds.length) break;
  }
  return { ok: true, states, contexts };
}

async function loadSafeProductNames(
  supabase: ReturnType<typeof createAdminSupabase>,
  guildId: string,
  productIds: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (productIds.length === 0) return names;

  const requestedProductIds = new Set(productIds);
  const { data, error } = await supabase
    .from('products')
    .select('id, guild_id, name')
    .eq('guild_id', guildId)
    .in('id', productIds)
    .limit(1_000);
  if (error || !Array.isArray(data)) {
    console.error('[Orders] Current-guild product names could not be loaded:', {
      guildId,
      code: error?.code,
    });
    return names;
  }

  for (const value of data) {
    const row = asRecord(value);
    if (
      !row
      || !isUuid(row.id)
      || !requestedProductIds.has(row.id)
      || row.guild_id !== guildId
      || typeof row.name !== 'string'
      || row.name.trim().length < 1
    ) continue;
    names.set(row.id, row.name);
  }
  return names;
}

async function loadSafeCustomerDisplays(
  supabase: ReturnType<typeof createAdminSupabase>,
  guildId: string,
  customerIds: string[],
): Promise<Map<string, CustomerDisplay>> {
  const displays = new Map<string, CustomerDisplay>();
  if (customerIds.length === 0) return displays;

  const requestedCustomerIds = new Set(customerIds);
  const { data, error } = await supabase
    .from('customers')
    .select('id, guild_id, discord_id, discord_username')
    .eq('guild_id', guildId)
    .in('id', customerIds)
    .limit(1_000);
  if (error || !Array.isArray(data)) {
    console.error('[Orders] Current-guild customer displays could not be loaded:', {
      guildId,
      code: error?.code,
    });
    return displays;
  }

  for (const value of data) {
    const row = asRecord(value);
    if (
      !row
      || !isUuid(row.id)
      || !requestedCustomerIds.has(row.id)
      || row.guild_id !== guildId
      || typeof row.discord_id !== 'string'
      || row.discord_id.trim().length < 1
      || typeof row.discord_username !== 'string'
      || row.discord_username.trim().length < 1
    ) continue;
    displays.set(row.id, {
      discord_id: row.discord_id,
      discord_username: row.discord_username,
    });
  }
  return displays;
}

async function loadMatchingCustomerIds(
  supabase: ReturnType<typeof createAdminSupabase>,
  guildId: string,
  search: string,
): Promise<
  | { ok: true; customerIds: string[] }
  | { ok: false; response: NextResponse }
> {
  const { data, error } = await supabase
    .from('customers')
    .select('id, guild_id')
    .eq('guild_id', guildId)
    .or(`discord_username.ilike.%${search}%,discord_id.eq.${search}`)
    .limit(1_000);
  if (error) return { ok: false, response: dbError(error, 'orders/customer-search') };
  if (!Array.isArray(data)) return { ok: false, response: malformedListResponse() };

  const customerIds = new Set<string>();
  for (const value of data) {
    const row = asRecord(value);
    if (!row || !isUuid(row.id) || row.guild_id !== guildId) continue;
    customerIds.add(row.id);
  }
  return { ok: true, customerIds: [...customerIds] };
}

async function loadEligibleRefundContexts(
  supabase: ReturnType<typeof createAdminSupabase>,
  guildId: string,
  orders: Record<string, unknown>[],
): Promise<Map<string, RefundContext>> {
  const contexts = new Map<string, RefundContext>();
  if (orders.length === 0) return contexts;

  const ordersById = new Map(orders.map((order) => [order.id as string, order]));
  const paymentRowsByOrder = new Map<string, Record<string, unknown>[]>();
  const seenPaymentIds = new Set<string>();
  let projectionMalformed = false;

  for (let offset = 0; ; offset += REFUND_OPERATION_PAGE_SIZE) {
    // Scope by already-authorized order IDs, then validate each child guild.
    // A guild filter here would hide a corrupt foreign child that the prepare
    // RPC counts and rejects, causing the UI to advertise an impossible action.
    const { data, error } = await supabase
      .from('payments')
      .select(
        'id, order_id, customer_id, guild_id, paypal_payment_id, amount_cents, currency, status, provider, paypal_resource_type',
      )
      .in('order_id', [...ordersById.keys()])
      .order('id', { ascending: true })
      .range(offset, offset + REFUND_OPERATION_PAGE_SIZE - 1);
    if (error || !Array.isArray(data)) {
      console.error('[Orders] Refund payment eligibility could not be loaded:', {
        guildId,
        code: error?.code,
      });
      return contexts;
    }

    for (const value of data) {
      const payment = asRecord(value);
      const paymentId = payment?.id;
      const orderId = payment?.order_id;
      if (
        !payment
        || !isUuid(paymentId)
        || seenPaymentIds.has(paymentId)
        || !isUuid(orderId)
        || !ordersById.has(orderId)
      ) {
        projectionMalformed = true;
        break;
      }
      seenPaymentIds.add(paymentId);
      const rows = paymentRowsByOrder.get(orderId) ?? [];
      rows.push(payment);
      paymentRowsByOrder.set(orderId, rows);
    }
    if (projectionMalformed) break;
    if (data.length < REFUND_OPERATION_PAGE_SIZE) break;
  }
  if (projectionMalformed) return contexts;

  for (const [orderId, order] of ordersById) {
    if (
      order.status !== 'completed'
      || !isUuid(order.customer_id)
      || !isUuid(order.product_id)
      || order.plan_id !== null
      || order.paypal_subscription_id !== null
      || (
        order.paypal_order_id !== null
        && !isCanonicalPayPalResourceId(order.paypal_order_id)
      )
      || !Number.isSafeInteger(order.amount_cents)
      || (order.amount_cents as number) < 0
      || typeof order.currency !== 'string'
      || !/^[A-Z]{3}$/.test(order.currency)
    ) continue;

    const paymentRows = paymentRowsByOrder.get(orderId) ?? [];
    if (paymentRows.length === 0) {
      if (
        order.amount_cents === 0
        && order.paypal_order_id === null
        && ['manual', 'giveaway', 'automation'].includes(order.source as string)
      ) contexts.set(orderId, 'local');
      continue;
    }

    let candidateCount = 0;
    let completedCount = 0;
    let settledCount = 0;
    let invalidCount = 0;
    for (const payment of paymentRows) {
      const status = payment.status;
      if (
        payment.guild_id !== guildId
        || payment.customer_id !== order.customer_id
        || payment.amount_cents !== order.amount_cents
        || payment.currency !== order.currency
        || payment.provider !== 'paypal'
        || payment.paypal_resource_type !== 'capture'
        || !isCanonicalPayPalResourceId(payment.paypal_payment_id)
        || !['completed', 'refunded', 'reversed', 'pending', 'failed'].includes(status as string)
      ) invalidCount += 1;
      if (status === 'completed' || status === 'refunded') candidateCount += 1;
      if (status === 'completed') completedCount += 1;
      if (status === 'completed' || status === 'refunded' || status === 'reversed') {
        settledCount += 1;
      }
    }

    if (
      (order.amount_cents as number) > 0
      && invalidCount === 0
      && candidateCount === 1
      && completedCount === 1
      && settledCount === candidateCount
    ) contexts.set(orderId, 'provider');
  }

  return contexts;
}

export async function GET(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'standard');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const { searchParams } = new URL(req.url);
  const search = searchParams.get('search');
  const status = searchParams.get('status');
  const limit = parseInt(searchParams.get('limit') ?? '50', 10);
  const offset = parseInt(searchParams.get('offset') ?? '0', 10);

  const sanitizedSearch = search ? sanitizeSearch(search) : '';
  let matchingCustomerIds: string[] = [];
  if (sanitizedSearch) {
    const customerSearch = await loadMatchingCustomerIds(supabase, guildId, sanitizedSearch);
    if (!customerSearch.ok) return customerSearch.response;
    matchingCustomerIds = customerSearch.customerIds;
  }

  let query = supabase
    .from('orders')
    .select('*', { count: 'exact' })
    .eq('guild_id', guildId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)
    .limit(1000);

  if (status) {
    query = query.eq('status', status);
  }

  if (sanitizedSearch) {
    const filters = [`order_number.ilike.%${sanitizedSearch}%`];
    if (matchingCustomerIds.length > 0) {
      filters.push(`customer_id.in.(${matchingCustomerIds.join(',')})`);
    }
    query = query.or(filters.join(','));
  }

  const { data, error, count } = await query;

  if (error) {
    return dbError(error, 'orders');
  }

  if (!Array.isArray(data) || !Number.isSafeInteger(count ?? 0) || (count ?? 0) < 0) {
    return malformedListResponse();
  }

  const orders: Record<string, unknown>[] = [];
  const orderIds: string[] = [];
  const productIds = new Set<string>();
  const customerIds = new Set<string>();
  for (const value of data) {
    const order = asRecord(value);
    if (!order || !isUuid(order.id) || order.guild_id !== guildId) {
      return malformedListResponse();
    }
    if (order.product_id !== null && !isUuid(order.product_id)) {
      return malformedListResponse();
    }
    if (order.customer_id !== null && !isUuid(order.customer_id)) {
      return malformedListResponse();
    }
    orders.push(order);
    orderIds.push(order.id);
    if (typeof order.product_id === 'string') productIds.add(order.product_id);
    if (typeof order.customer_id === 'string') customerIds.add(order.customer_id);
  }

  const refundProjection = await loadLatestRefundStates(supabase, guildId, orderIds);
  if (!refundProjection.ok) return refundProjection.response;
  const [productNames, customerDisplays, eligibleRefundContexts] = await Promise.all([
    loadSafeProductNames(supabase, guildId, [...productIds]),
    loadSafeCustomerDisplays(supabase, guildId, [...customerIds]),
    loadEligibleRefundContexts(supabase, guildId, orders),
  ]);

  const responseOrders = orders.map((order) => {
    const orderId = order.id as string;
    const productId = order.product_id;
    const customerId = order.customer_id;
    const productName = typeof productId === 'string' ? productNames.get(productId) : undefined;
    const customerDisplay = typeof customerId === 'string'
      ? customerDisplays.get(customerId)
      : undefined;
    const refundContext = refundProjection.states.has(orderId)
      ? refundProjection.contexts.get(orderId) ?? null
      : eligibleRefundContexts.get(orderId) ?? null;
    return {
      ...order,
      products: productName ? { name: productName } : null,
      customers: customerDisplay ?? null,
      refund_state: refundProjection.states.get(orderId) ?? null,
      refund_context: refundContext,
    };
  });

  return NextResponse.json({ success: true, data: responseOrders, total: count ?? 0 });
}
