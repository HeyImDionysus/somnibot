import { NextRequest, NextResponse } from 'next/server';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';

type StageState = 'complete' | 'pending' | 'unknown' | 'not_applicable';
const DOWNLOAD_LEDGER_AVAILABLE_AT_MS = Date.parse('2026-07-30T03:10:00.000Z');

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiresLicense(delivery: unknown): boolean {
  return delivery === 'license_key' || delivery === 'mixed';
}

function requiresDownload(delivery: unknown): boolean {
  return delivery === 'file' || delivery === 'link' || delivery === 'mixed';
}

function elapsedMs(iso: unknown, now: number): number {
  if (typeof iso !== 'string') return 0;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? Math.max(0, now - parsed) : 0;
}

export async function GET(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'standard');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;
  const supabase = createAdminSupabase();

  const { data: orderData, error: orderError, count } = await supabase
    .from('orders')
    .select(
      'id, order_number, customer_id, product_id, status, delivery_type_snapshot, created_at',
      { count: 'exact' },
    )
    .eq('guild_id', guildId)
    .in('status', ['completed', 'pending_review'])
    .order('created_at', { ascending: false })
    .limit(200);
  if (orderError) return dbError(orderError, 'store/control-room/orders');
  if (!Array.isArray(orderData)) {
    return NextResponse.json(
      { success: false, error: 'Store control-room order data is malformed' },
      { status: 500 },
    );
  }

  const orders = orderData.filter(isRecord);
  if (orders.length !== orderData.length) {
    return NextResponse.json(
      { success: false, error: 'Store control-room order data is malformed' },
      { status: 500 },
    );
  }
  const orderIds = orders
    .map((order) => order.id)
    .filter((id): id is string => typeof id === 'string');
  const customerIds = [...new Set(orders
    .map((order) => order.customer_id)
    .filter((id): id is string => typeof id === 'string'))];
  const productIds = [...new Set(orders
    .map((order) => order.product_id)
    .filter((id): id is string => typeof id === 'string'))];
  if (orderIds.length !== orders.length) {
    return NextResponse.json(
      { success: false, error: 'Store control-room order data is malformed' },
      { status: 500 },
    );
  }

  if (orders.length === 0) {
    return NextResponse.json({
      success: true,
      data: {
        summary: { paid: 0, licensed: 0, downloaded: 0, activated: 0, stuck: 0 },
        customers: [],
        sampledOrders: 0,
        totalOrders: count ?? 0,
        checkedAt: new Date().toISOString(),
      },
    });
  }

  const downloadsPromise = (async () => {
    const data: unknown[] = [];
    const pageSize = 1_000;
    for (let from = 0; ; from += pageSize) {
      const page = await supabase
        .from('commerce_download_deliveries')
        .select('id, order_id, customer_id, product_id, delivered_at')
        .eq('guild_id', guildId)
        .in('order_id', orderIds)
        .order('id', { ascending: true })
        .range(from, from + pageSize - 1);
      if (page.error) return { data: null, error: page.error };
      if (!Array.isArray(page.data)) {
        return { data: page.data, error: null };
      }
      data.push(...page.data);
      if (page.data.length < pageSize) return { data, error: null };
    }
  })();

  const [keys, entitlements, downloads, holds, customers, products] = await Promise.all([
    supabase
      .from('license_keys')
      .select('id, order_id, customer_id, product_id, status, activated_at, created_at')
      .eq('guild_id', guildId)
      .in('order_id', orderIds)
      .limit(500),
    supabase
      .from('entitlements')
      .select('id, order_id, customer_id, product_id, status, created_at')
      .eq('guild_id', guildId)
      .in('order_id', orderIds)
      .limit(500),
    downloadsPromise,
    supabase
      .from('commerce_fulfillment_holds')
      .select('order_id, hold_reason, held_at')
      .eq('guild_id', guildId)
      .in('order_id', orderIds)
      .limit(200),
    customerIds.length === 0
      ? Promise.resolve({ data: [], error: null })
      : supabase
          .from('customers')
          .select('id, guild_id, discord_id, discord_username')
          .eq('guild_id', guildId)
          .in('id', customerIds)
          .limit(200),
    productIds.length === 0
      ? Promise.resolve({ data: [], error: null })
      : supabase
          .from('products')
          .select('id, guild_id, name')
          .eq('guild_id', guildId)
          .in('id', productIds)
          .limit(200),
  ]);

  const dependencies = [
    ['keys', keys],
    ['entitlements', entitlements],
    ['downloads', downloads],
    ['holds', holds],
    ['customers', customers],
    ['products', products],
  ] as const;
  for (const [name, result] of dependencies) {
    if (result.error) return dbError(result.error, `store/control-room/${name}`);
    if (!Array.isArray(result.data) || !result.data.every(isRecord)) {
      return NextResponse.json(
        { success: false, error: `Store control-room ${name} data is malformed` },
        { status: 500 },
      );
    }
  }

  // The loop above runtime-validates every dependency as an object array.
  const keyRows = keys.data as Record<string, unknown>[];
  const entitlementRows = entitlements.data as Record<string, unknown>[];
  const downloadRows = downloads.data as Record<string, unknown>[];
  const holdRows = holds.data as Record<string, unknown>[];
  const customerRows = customers.data as Record<string, unknown>[];
  const productRows = products.data as Record<string, unknown>[];
  const keyByOrder = new Map(keyRows.map((row) => [row.order_id, row]));
  const entitlementByOrder = new Map(entitlementRows.map((row) => [row.order_id, row]));
  const downloadByOrder = new Map(downloadRows.map((row) => [row.order_id, row]));
  const holdByOrder = new Map(holdRows.map((row) => [row.order_id, row]));
  const customerById = new Map(customerRows.map((row) => [row.id, row]));
  const productById = new Map(productRows.map((row) => [row.id, row]));
  const now = Date.now();

  const rows = orders.map((order) => {
    const orderId = order.id as string;
    const key = keyByOrder.get(orderId);
    const entitlement = entitlementByOrder.get(orderId);
    const download = downloadByOrder.get(orderId);
    const hold = holdByOrder.get(orderId);
    const licenseRequired = requiresLicense(order.delivery_type_snapshot);
    const downloadRequired = requiresDownload(order.delivery_type_snapshot);
    const age = elapsedMs(order.created_at, now);
    const orderCreatedAtMs =
      typeof order.created_at === 'string' ? Date.parse(order.created_at) : Number.NaN;
    const downloadEvidenceAvailable =
      Number.isFinite(orderCreatedAtMs)
      && orderCreatedAtMs >= DOWNLOAD_LEDGER_AVAILABLE_AT_MS;
    const reasons: string[] = [];

    if (order.status === 'pending_review') reasons.push('Payment is held for operator review.');
    if (hold) reasons.push(`Fulfillment is held: ${String(hold.hold_reason).replaceAll('_', ' ')}.`);
    if (!entitlement && age > 15 * 60 * 1_000) {
      reasons.push('No entitlement was recorded within 15 minutes of payment.');
    }
    if (licenseRequired && !key && age > 15 * 60 * 1_000) {
      reasons.push('No license key was issued within 15 minutes of payment.');
    }
    if (
      downloadRequired
      && downloadEvidenceAvailable
      && !download
      && age > 24 * 60 * 60 * 1_000
    ) {
      reasons.push('No completed download was recorded within 24 hours.');
    }
    if (
      licenseRequired
      && key
      && key.status === 'pending_activation'
      && elapsedMs(key.created_at, now) > 24 * 60 * 60 * 1_000
    ) {
      reasons.push('The issued license has waited over 24 hours for activation.');
    }

    const customer = customerById.get(order.customer_id);
    const product = productById.get(order.product_id);
    return {
      orderId,
      orderNumber: order.order_number,
      customerId: order.customer_id,
      customerName: customer?.discord_username ?? customer?.discord_id ?? 'Unknown customer',
      productId: order.product_id,
      productName: product?.name ?? 'Unknown product',
      deliveryType: order.delivery_type_snapshot,
      createdAt: order.created_at,
      stages: {
        paid: order.status === 'completed' ? 'complete' : 'pending',
        licensed: licenseRequired ? (key ? 'complete' : 'pending') : 'not_applicable',
        downloaded: downloadRequired
          ? download
            ? 'complete'
            : downloadEvidenceAvailable
              ? 'pending'
              : 'unknown'
          : 'not_applicable',
        activated: licenseRequired
          ? (key?.activated_at ? 'complete' : 'pending')
          : 'not_applicable',
      } satisfies Record<'paid' | 'licensed' | 'downloaded' | 'activated', StageState>,
      entitlementStatus: entitlement?.status ?? null,
      stuck: reasons.length > 0,
      reasons,
    };
  });

  const summary = {
    paid: rows.filter((row) => row.stages.paid === 'complete').length,
    licensed: rows.filter((row) => row.stages.licensed === 'complete').length,
    downloaded: rows.filter((row) => row.stages.downloaded === 'complete').length,
    activated: rows.filter((row) => row.stages.activated === 'complete').length,
    stuck: rows.filter((row) => row.stuck).length,
  };

  return NextResponse.json({
    success: true,
    data: {
      summary,
      customers: rows,
      sampledOrders: rows.length,
      totalOrders: count ?? rows.length,
      checkedAt: new Date().toISOString(),
    },
  });
}
