import { NextRequest, NextResponse } from 'next/server';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';

type StageState = 'complete' | 'pending' | 'unknown' | 'not_applicable';
const DOWNLOAD_LEDGER_CUTOVER_KEY = 'commerce_download_ledger_available_at';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiresLicense(delivery: unknown): boolean {
  // Fulfillment mints and accepts license payloads ONLY for the exact
  // license_key delivery type; classifying mixed as license-bearing made
  // every completed mixed order read "missing license" and stuck after 15
  // minutes for a key that will never exist.
  return delivery === 'license_key';
}

function requiresDownload(delivery: unknown, frozenRequirement: unknown): boolean {
  if (typeof frozenRequirement === 'boolean') return frozenRequirement;
  // Only legacy file/link contracts are unambiguous without the frozen flag.
  // A legacy mixed bundle may contain only licence + Discord benefits.
  return delivery === 'file' || delivery === 'link';
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
      'id, order_number, customer_id, product_id, status, delivery_type_snapshot, download_required_snapshot, created_at, updated_at',
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

  const downloadsPromise = supabase.rpc('get_latest_commerce_download_deliveries', {
    p_guild_id: guildId,
    p_order_ids: orderIds,
  });

  // Issuance evidence must cover EVERY sampled order. Key rotation keeps the
  // full history — several license_keys rows per order — so a single flat query
  // with a row cap sized to the ORDER sample (200) let rotated keys consume the
  // cap and drop every key for some other sampled order, which the pipeline
  // then reported as "never issued". Page until exhausted instead, ordered so
  // the FIRST row seen per order is its newest key. The page bound is a
  // runaway-data backstop far above any real rotation volume; hitting it is
  // logged, never silent.
  const KEY_PAGE_SIZE = 1000;
  const KEY_MAX_PAGES = 20;
  const liveKeysPromise = (async (): Promise<{
    data: Record<string, unknown>[] | null;
    error: { message: string } | null;
  }> => {
    const rows: Record<string, unknown>[] = [];
    for (let page = 0; page < KEY_MAX_PAGES; page++) {
      const { data, error } = await supabase
        .from('license_keys')
        .select('id, order_id, customer_id, product_id, status, activated_at, created_at')
        .eq('guild_id', guildId)
        .in('order_id', orderIds)
        .order('order_id', { ascending: true })
        .order('created_at', { ascending: false })
        .range(page * KEY_PAGE_SIZE, (page + 1) * KEY_PAGE_SIZE - 1);
      if (error) return { data: null, error };
      rows.push(...((data ?? []) as Record<string, unknown>[]));
      if (!data || data.length < KEY_PAGE_SIZE) return { data: rows, error: null };
    }
    console.warn(
      `[control-room] license_keys pagination hit the ${KEY_MAX_PAGES * KEY_PAGE_SIZE}-row backstop `
      + `for guild ${guildId}; issuance evidence beyond it is not loaded.`,
    );
    return { data: rows, error: null };
  })();

  const [keys, entitlements, downloads, holds, customers, products, downloadCutover] = await Promise.all([
    liveKeysPromise,
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
    supabase
      .from('instance_settings')
      .select('value')
      .eq('key', DOWNLOAD_LEDGER_CUTOVER_KEY)
      .maybeSingle(),
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
  if (downloadCutover.error) {
    return dbError(downloadCutover.error, 'store/control-room/download-cutover');
  }
  if (downloadCutover.data !== null && !isRecord(downloadCutover.data)) {
    return NextResponse.json(
      { success: false, error: 'Store control-room download cutover data is malformed' },
      { status: 500 },
    );
  }

  // The loop above runtime-validates every dependency as an object array.
  const keyRows = keys.data as Record<string, unknown>[];
  const entitlementRows = entitlements.data as Record<string, unknown>[];
  const downloadRows = downloads.data as Record<string, unknown>[];
  const holdRows = holds.data as Record<string, unknown>[];
  const customerRows = customers.data as Record<string, unknown>[];
  const productRows = products.data as Record<string, unknown>[];
  const downloadCutoverAtMs = isRecord(downloadCutover.data)
    && typeof downloadCutover.data.value === 'string'
    ? Date.parse(downloadCutover.data.value)
    : Number.NaN;
  // First-wins on purpose: rows arrive ordered (order_id asc, created_at desc),
  // so the first row per order is its NEWEST key — the one whose status should
  // drive lifecycle/health display. A last-wins Map over rotation history would
  // show the oldest rotated-away key instead.
  const keyByOrder = new Map<unknown, Record<string, unknown>>();
  for (const row of keyRows) {
    if (!keyByOrder.has(row.order_id)) keyByOrder.set(row.order_id, row);
  }
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
    const downloadRequired = requiresDownload(
      order.delivery_type_snapshot,
      order.download_required_snapshot,
    );
    const age = elapsedMs(order.created_at, now);
    const orderCreatedAtMs =
      typeof order.created_at === 'string' ? Date.parse(order.created_at) : Number.NaN;
    // Ledger coverage is decided at FULFILLMENT time, not order creation: an
    // order created before the deliveries cutover but completed after it
    // delivers entirely in the evidence-recording era, so a missing download
    // must still flag. The entitlement write IS the fulfillment transition;
    // an order with no entitlement falls back to creation time and is
    // already flagged by the no-entitlement rule above.
    const entitlementCreatedAtMs =
      typeof entitlement?.created_at === 'string'
        ? Date.parse(entitlement.created_at)
        : Number.NaN;
    const fulfillmentAnchorMs = Number.isFinite(entitlementCreatedAtMs)
      ? entitlementCreatedAtMs
      : orderCreatedAtMs;
    const downloadEvidenceAvailable =
      Number.isFinite(fulfillmentAnchorMs)
      && Number.isFinite(downloadCutoverAtMs)
      && fulfillmentAnchorMs >= downloadCutoverAtMs;
    const reasons: string[] = [];

    if (order.status === 'pending_review') reasons.push('Payment is held for operator review.');
    if (hold) reasons.push(`Fulfillment is held: ${String(hold.hold_reason).replaceAll('_', ' ')}.`);
    // Post-payment SLAs only start once payment actually COMPLETED: a
    // pending_review order is expectedly unfulfilled (the branch above
    // already explains the hold) and must not read as a delivery failure.
    const paymentCompleted = order.status === 'completed';
    // The 15-minute clocks start at the COMPLETED transition, not order
    // creation: an order held in review for an hour and then approved gets
    // its full window. orders.updated_at is the durable upper bound of that
    // transition (later updates can only restart the clock — conservative,
    // never premature); creation time remains the fallback.
    const paymentAge = elapsedMs(
      paymentCompleted && typeof order.updated_at === 'string'
        ? order.updated_at
        : order.created_at,
      now,
    );
    if (paymentCompleted && !entitlement && paymentAge > 15 * 60 * 1_000) {
      reasons.push('No entitlement was recorded within 15 minutes of payment.');
    }
    if (paymentCompleted && licenseRequired && !key && paymentAge > 15 * 60 * 1_000) {
      reasons.push('No license key was issued within 15 minutes of payment.');
    }
    // The 24-hour download window starts when the customer can actually
    // download — at FULFILLMENT. An order pending for a day and then
    // fulfilled must get its full advertised window, not be stuck instantly.
    const fulfillmentAge = elapsedMs(
      typeof entitlement?.created_at === 'string' ? entitlement.created_at : order.created_at,
      now,
    );
    if (
      paymentCompleted
      && downloadRequired
      && downloadEvidenceAvailable
      && !download
      && fulfillmentAge > 24 * 60 * 60 * 1_000
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
