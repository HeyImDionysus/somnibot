import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { dbError } from '@/lib/api/response';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { merchantRowsToCsv } from '@/lib/store/commerce-operations';

const datasetSchema = z.enum([
  'orders', 'payments', 'refunds', 'subscriptions', 'fees', 'discounts',
  'disputes', 'free_claims', 'product_revenue', 'entitlements', 'reconciliation',
]);
type CsvValue = string | number | boolean | null;
type CsvRow = Readonly<Record<string, CsvValue>>;

function csvRows(value: unknown): CsvRow[] | null {
  const parsed = z.array(z.record(z.unknown())).safeParse(value);
  if (!parsed.success) return null;
  return parsed.data.map((row) => {
    const converted: Record<string, CsvValue> = {};
    for (const [key, cell] of Object.entries(row)) {
      converted[key] = cell === null
        || typeof cell === 'string'
        || typeof cell === 'number'
        || typeof cell === 'boolean'
        ? cell
        : JSON.stringify(cell);
    }
    return converted;
  });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ dataset: string }> },
) {
  const rateLimited = await checkAdminRateLimit(request, 'bulk');
  if (rateLimited) return rateLimited;
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const parsedDataset = datasetSchema.safeParse((await params).dataset);
  if (!parsedDataset.success) return NextResponse.json({ error: 'Unknown export dataset' }, { status: 404 });
  const dataset = parsedDataset.data;
  const admin = createAdminSupabase();
  let rows: CsvRow[];
  let columns: readonly string[];
  let sortColumn = 'id';

  if (dataset === 'orders') {
    const result = await admin.from('orders').select('id, order_number, customer_id, product_id, plan_id, amount_cents, discount_cents, currency, source, status, created_at, updated_at').eq('guild_id', auth.ctx.guildId).order('id');
    if (result.error) return dbError(result.error, 'store/exports/orders');
    rows = csvRows(result.data) ?? [];
    columns = ['id', 'order_number', 'customer_id', 'product_id', 'plan_id', 'amount_cents', 'discount_cents', 'currency', 'source', 'status', 'created_at', 'updated_at'];
  } else if (dataset === 'payments' || dataset === 'fees') {
    let query = admin.from('payments').select('id, order_id, customer_id, paypal_payment_id, paypal_resource_type, amount_cents, provider_fee_cents, provider_net_cents, currency, status, created_at').eq('guild_id', auth.ctx.guildId).order('id');
    if (dataset === 'fees') query = query.not('provider_fee_cents', 'is', null);
    const result = await query;
    if (result.error) return dbError(result.error, `store/exports/${dataset}`);
    rows = csvRows(result.data) ?? [];
    columns = ['id', 'order_id', 'customer_id', 'paypal_payment_id', 'paypal_resource_type', 'amount_cents', 'provider_fee_cents', 'provider_net_cents', 'currency', 'status', 'created_at'];
  } else if (dataset === 'refunds') {
    const result = await admin.from('payment_refunds').select('id, payment_id, order_id, paypal_refund_id, event_type, amount_cents, currency, created_at').eq('guild_id', auth.ctx.guildId).order('id');
    if (result.error) return dbError(result.error, 'store/exports/refunds');
    rows = csvRows(result.data) ?? [];
    columns = ['id', 'payment_id', 'order_id', 'paypal_refund_id', 'event_type', 'amount_cents', 'currency', 'created_at'];
  } else if (dataset === 'subscriptions') {
    const result = await admin.from('orders').select('id, order_number, customer_id, product_id, plan_id, paypal_subscription_id, amount_cents, currency, status, created_at, updated_at').eq('guild_id', auth.ctx.guildId).not('paypal_subscription_id', 'is', null).order('id');
    if (result.error) return dbError(result.error, 'store/exports/subscriptions');
    rows = csvRows(result.data) ?? [];
    columns = ['id', 'order_number', 'customer_id', 'product_id', 'plan_id', 'paypal_subscription_id', 'amount_cents', 'currency', 'status', 'created_at', 'updated_at'];
  } else if (dataset === 'discounts') {
    const result = await admin.from('orders').select('id, order_number, product_id, promotion_id, amount_cents, discount_cents, currency, status, created_at').eq('guild_id', auth.ctx.guildId).gt('discount_cents', 0).order('id');
    if (result.error) return dbError(result.error, 'store/exports/discounts');
    rows = csvRows(result.data) ?? [];
    columns = ['id', 'order_number', 'product_id', 'promotion_id', 'amount_cents', 'discount_cents', 'currency', 'status', 'created_at'];
  } else if (dataset === 'disputes') {
    const result = await admin.from('commerce_revenue_exceptions').select('id, source_kind, source_id, severity, state, owner_id, operation_id, order_id, customer_id, payment_id, title, resolution_code, detected_at, resolved_at').eq('guild_id', auth.ctx.guildId).eq('category', 'payment_dispute').order('id');
    if (result.error) return dbError(result.error, 'store/exports/disputes');
    rows = csvRows(result.data) ?? [];
    columns = ['id', 'source_kind', 'source_id', 'severity', 'state', 'owner_id', 'operation_id', 'order_id', 'customer_id', 'payment_id', 'title', 'resolution_code', 'detected_at', 'resolved_at'];
  } else if (dataset === 'free_claims') {
    const result = await admin.from('commerce_free_claims').select('request_id, customer_id, product_id, order_id, created_at').eq('guild_id', auth.ctx.guildId).order('request_id');
    if (result.error) return dbError(result.error, 'store/exports/free-claims');
    rows = csvRows(result.data) ?? [];
    columns = ['request_id', 'customer_id', 'product_id', 'order_id', 'created_at'];
    sortColumn = 'request_id';
  } else if (dataset === 'entitlements') {
    const result = await admin.from('entitlements').select('id, customer_id, product_id, plan_id, order_id, type, status, source, starts_at, expires_at, cancelled_at, grace_period_ends_at, updated_at').eq('guild_id', auth.ctx.guildId).order('id');
    if (result.error) return dbError(result.error, 'store/exports/entitlements');
    rows = csvRows(result.data) ?? [];
    columns = ['id', 'customer_id', 'product_id', 'plan_id', 'order_id', 'type', 'status', 'source', 'starts_at', 'expires_at', 'cancelled_at', 'grace_period_ends_at', 'updated_at'];
  } else if (dataset === 'reconciliation') {
    const result = await admin.from('reconciliation_runs').select('id, trigger, status, findings, fixes_applied, error_message, started_at, completed_at').eq('guild_id', auth.ctx.guildId).order('id');
    if (result.error) return dbError(result.error, 'store/exports/reconciliation');
    rows = csvRows(result.data) ?? [];
    columns = ['id', 'trigger', 'status', 'findings', 'fixes_applied', 'error_message', 'started_at', 'completed_at'];
  } else {
    const result = await admin.from('orders').select('product_id, amount_cents, discount_cents, currency, status').eq('guild_id', auth.ctx.guildId).in('status', ['completed', 'refunded']).order('product_id');
    if (result.error) return dbError(result.error, 'store/exports/product-revenue');
    const source = z.array(z.object({ product_id: z.string().uuid(), amount_cents: z.number().int(), discount_cents: z.number().int(), currency: z.string(), status: z.string() })).safeParse(result.data ?? []);
    if (!source.success) return NextResponse.json({ error: 'Revenue data is malformed' }, { status: 503 });
    const grouped = new Map<string, { gross: number; discounts: number; refunded: number; currency: string; orders: number }>();
    for (const order of source.data) {
      const value = grouped.get(order.product_id) ?? { gross: 0, discounts: 0, refunded: 0, currency: order.currency, orders: 0 };
      grouped.set(order.product_id, {
        gross: value.gross + order.amount_cents,
        discounts: value.discounts + order.discount_cents,
        refunded: value.refunded + (order.status === 'refunded' ? order.amount_cents : 0),
        currency: value.currency,
        orders: value.orders + 1,
      });
    }
    rows = [...grouped.entries()].map(([productId, value]) => ({ product_id: productId, order_count: value.orders, gross_cents: value.gross, discount_cents: value.discounts, refunded_cents: value.refunded, net_entitled_cents: value.gross - value.refunded, currency: value.currency }));
    columns = ['product_id', 'order_count', 'gross_cents', 'discount_cents', 'refunded_cents', 'net_entitled_cents', 'currency'];
    sortColumn = 'product_id';
  }

  const csv = merchantRowsToCsv(columns, rows, sortColumn);
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="somnibot-${dataset}.csv"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
