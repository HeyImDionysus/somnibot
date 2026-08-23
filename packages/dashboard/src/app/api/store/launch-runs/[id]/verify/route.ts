import { createHash } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { dbError } from '@/lib/api/response';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { evaluateLaunchRun, type LaunchStageKey, type LaunchStageState } from '@/lib/store/commerce-operations';
import { evaluateCommerceLaunchEvidence } from '@/lib/store/commerce-launch-evidence';
import { readSdkIntegrationReceiptMetadata } from '@/lib/store/sdk-contract-identity';
import { loadPayPalPolicy } from '@/lib/paypal-policy';

const runSchema = z.object({
  id: z.string().uuid(),
  product_id: z.string().uuid(),
  operation_id: z.string().uuid(),
  is_tutorial: z.boolean(),
  version: z.number().int().positive(),
});
const productSchema = z.object({
  id: z.string().uuid(),
  active: z.boolean(),
  type: z.enum(['one_time', 'subscription', 'free']),
  delivery_type: z.string(),
  price_cents: z.number().int().nonnegative(),
  metadata: z.record(z.unknown()).nullable().transform((metadata) => metadata ?? {}),
  updated_at: z.string(),
});

const webhookSchema = z.object({
  event_id: z.string(),
  event_type: z.string(),
  result: z.enum(['success', 'duplicate']),
  payload: z.object({
    resource: z.object({
      id: z.string().optional(),
      supplementary_data: z.object({
        related_ids: z.object({ order_id: z.string().optional() }).optional(),
      }).optional(),
    }),
  }),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const id = (await params).id;
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: 'Invalid launch run id' }, { status: 400 });
  const admin = createAdminSupabase();
  const { data: runData, error: runError } = await admin
    .from('commerce_product_launch_runs')
    .select('id, product_id, operation_id, is_tutorial, version')
    .eq('id', id)
    .eq('guild_id', auth.ctx.guildId)
    .maybeSingle();
  if (runError) return dbError(runError, 'store/launch-runs/verify/read');
  const run = runSchema.safeParse(runData);
  if (!run.success) return runData ? NextResponse.json({ error: 'Launch run is malformed' }, { status: 503 }) : NextResponse.json({ error: 'Launch run not found' }, { status: 404 });
  const [productResult, policyResult, filesResult, ordersResult] = await Promise.all([
    admin.from('products').select('id, active, type, delivery_type, price_cents, metadata, updated_at').eq('id', run.data.product_id).eq('guild_id', auth.ctx.guildId).maybeSingle(),
    admin.from('product_license_config').select('product_id, updated_at').eq('product_id', run.data.product_id).maybeSingle(),
    admin.from('product_files').select('id').eq('product_id', run.data.product_id).limit(100),
    admin.from('orders').select('id, product_id, status, paypal_order_id, updated_at').eq('guild_id', auth.ctx.guildId).eq('product_id', run.data.product_id).order('created_at', { ascending: false }).limit(500),
  ]);
  for (const [name, result] of [['product', productResult], ['policy', policyResult], ['files', filesResult], ['orders', ordersResult]] as const) {
    if (result.error) return dbError(result.error, `store/launch-runs/verify/${name}`);
  }
  const product = productSchema.safeParse(productResult.data);
  if (!product.success) return NextResponse.json({ error: 'Product verification data is malformed' }, { status: 503 });
  const orders = z.array(z.object({
    id: z.string().uuid(), product_id: z.string().uuid(), status: z.string(),
    paypal_order_id: z.string().nullable(), updated_at: z.string(),
  })).safeParse(ordersResult.data ?? []);
  if (!orders.success) return NextResponse.json({ error: 'Order verification data is malformed' }, { status: 503 });
  const orderIds = orders.data.map((order) => order.id);
  const emptyResult = Promise.resolve({ data: [], error: null });
  const [paymentsResult, entitlementsResult, keysResult, downloadsResult, refundsResult, cancellationsResult, freeClaimsResult] = await Promise.all([
    orderIds.length ? admin.from('payments').select('id, order_id, status, paypal_payment_id, paypal_event_id').eq('guild_id', auth.ctx.guildId).in('order_id', orderIds).limit(1000) : emptyResult,
    orderIds.length ? admin.from('entitlements').select('id, order_id, product_id, status').eq('guild_id', auth.ctx.guildId).in('order_id', orderIds).limit(1000) : emptyResult,
    orderIds.length ? admin.from('license_keys').select('id, order_id, status').eq('guild_id', auth.ctx.guildId).in('order_id', orderIds).limit(1000) : emptyResult,
    orderIds.length ? admin.from('commerce_download_deliveries').select('id, order_id').eq('guild_id', auth.ctx.guildId).in('order_id', orderIds).limit(1000) : emptyResult,
    orderIds.length ? admin.from('payment_refunds').select('id, order_id, payment_id, paypal_refund_id').eq('guild_id', auth.ctx.guildId).in('order_id', orderIds).limit(1000) : emptyResult,
    orderIds.length ? admin.from('portal_cancellation_operations').select('id, order_id, status').eq('guild_id', auth.ctx.guildId).in('order_id', orderIds).eq('status', 'completed').limit(1000) : emptyResult,
    orderIds.length ? admin.from('commerce_free_claims').select('request_id, order_id, product_id').eq('guild_id', auth.ctx.guildId).eq('product_id', run.data.product_id).in('order_id', orderIds).limit(1000) : emptyResult,
  ]);
  for (const [name, result] of [['payments', paymentsResult], ['entitlements', entitlementsResult], ['keys', keysResult], ['downloads', downloadsResult], ['refunds', refundsResult], ['cancellations', cancellationsResult], ['free-claims', freeClaimsResult]] as const) {
    if (result.error) return dbError(result.error, `store/launch-runs/verify/${name}`);
  }
  const payments = z.array(z.object({
    id: z.string().uuid(), order_id: z.string().uuid(), status: z.string(),
    paypal_payment_id: z.string().nullable(), paypal_event_id: z.string().nullable(),
  })).safeParse(paymentsResult.data ?? []);
  const entitlements = z.array(z.object({ id: z.string().uuid(), order_id: z.string().uuid(), product_id: z.string().uuid(), status: z.string() })).safeParse(entitlementsResult.data ?? []);
  const keys = z.array(z.object({ id: z.string().uuid(), order_id: z.string().uuid(), status: z.string() })).safeParse(keysResult.data ?? []);
  const downloads = z.array(z.object({ id: z.string().uuid(), order_id: z.string().uuid().nullable() })).safeParse(downloadsResult.data ?? []);
  const refunds = z.array(z.object({
    id: z.string().uuid(), order_id: z.string().uuid(), payment_id: z.string().uuid(), paypal_refund_id: z.string(),
  })).safeParse(refundsResult.data ?? []);
  const cancellations = z.array(z.object({ id: z.string().uuid(), order_id: z.string().uuid(), status: z.literal('completed') })).safeParse(cancellationsResult.data ?? []);
  const freeClaims = z.array(z.object({ request_id: z.string().uuid(), order_id: z.string().uuid(), product_id: z.string().uuid() })).safeParse(freeClaimsResult.data ?? []);
  if (!payments.success || !entitlements.success || !keys.success || !downloads.success || !refunds.success || !cancellations.success || !freeClaims.success) {
    return NextResponse.json({ error: 'Launch evidence is malformed' }, { status: 503 });
  }
  const paypalPolicy = await loadPayPalPolicy(admin, auth.ctx.guildId);
  const receipt = readSdkIntegrationReceiptMetadata(product.data.metadata);
  const dynamic = product.data.delivery_type === 'license_key';
  const { data: webhookData, error: webhookError } = await admin
    .from('webhook_events')
    .select('event_id, event_type, result, payload')
    .eq('guild_id', auth.ctx.guildId)
    .in('event_type', [
      'PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.SALE.COMPLETED',
      'PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED',
      'PAYMENT.SALE.REFUNDED', 'PAYMENT.SALE.REVERSED',
    ])
    .in('result', ['success', 'duplicate'])
    .order('processed_at', { ascending: false })
    .limit(2000);
  if (webhookError) return dbError(webhookError, 'store/launch-runs/verify/webhooks');
  const webhooks = z.array(webhookSchema).safeParse(webhookData ?? []);
  if (!webhooks.success) return NextResponse.json({ error: 'Webhook launch evidence is malformed' }, { status: 503 });
  const evaluated = evaluateCommerceLaunchEvidence({
    product: {
      id: product.data.id,
      active: product.data.active,
      type: product.data.type,
      deliveryType: product.data.delivery_type,
      priceCents: product.data.price_cents,
      policyConfigured: dynamic ? policyResult.data !== null : (filesResult.data?.length ?? 0) > 0,
      integrationVerified: dynamic ? receipt?.conformanceResult === 'passed' : (filesResult.data?.length ?? 0) > 0,
    },
    orders: orders.data.map((order) => ({ id: order.id, productId: order.product_id, status: order.status, paypalOrderId: order.paypal_order_id })),
    freeClaims: freeClaims.data.map((claim) => ({ id: claim.request_id, orderId: claim.order_id, productId: claim.product_id })),
    payments: payments.data.map((payment) => ({ id: payment.id, orderId: payment.order_id, status: payment.status, paypalPaymentId: payment.paypal_payment_id, paypalEventId: payment.paypal_event_id })),
    webhooks: webhooks.data.map((webhook) => ({
      eventId: webhook.event_id, eventType: webhook.event_type, result: webhook.result,
      resourceId: webhook.payload.resource.id ?? null,
      relatedOrderId: webhook.payload.resource.supplementary_data?.related_ids?.order_id ?? null,
    })),
    entitlements: entitlements.data.map((entitlement) => ({ id: entitlement.id, orderId: entitlement.order_id, productId: entitlement.product_id, status: entitlement.status })),
    fulfillments: [
      ...keys.data.map((key) => ({ id: key.id, orderId: key.order_id, kind: 'license' as const })),
      ...downloads.data.filter((download) => download.order_id !== null).map((download) => ({ id: download.id, orderId: download.order_id ?? '', kind: 'download' as const })),
      ...(product.data.delivery_type === 'access_pass' ? entitlements.data.map((entitlement) => ({ id: entitlement.id, orderId: entitlement.order_id, kind: 'access' as const })) : []),
    ],
    refunds: refunds.data.map((refund) => ({ id: refund.id, orderId: refund.order_id, paymentId: refund.payment_id, paypalRefundId: refund.paypal_refund_id })),
    cancellations: cancellations.data.map((cancellation) => ({ id: cancellation.id, orderId: cancellation.order_id, status: cancellation.status })),
  });
  const stages: Readonly<Record<LaunchStageKey, LaunchStageState>> = paypalPolicy.environment === 'sandbox'
    ? evaluated.stages
    : { ...evaluated.stages, sandbox_transaction: 'pending' };
  const evidence = {
    operation_id: run.data.operation_id,
    product_id: product.data.id,
    product_revision: product.data.updated_at,
    environment: paypalPolicy.environment,
    order_ids: orderIds,
    payment_ids: payments.data.map((payment) => payment.id),
    entitlement_ids: entitlements.data.map((entitlement) => entitlement.id),
    refund_ids: refunds.data.map((refund) => refund.id),
    cancellation_ids: cancellations.data.map((cancellation) => cancellation.id),
    witness: evaluated.witness,
    stages,
  };
  const hash = createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
  const evaluation = evaluateLaunchRun({ productActive: product.data.active, environment: paypalPolicy.environment, stages, receiptHash: hash });
  const { data, error } = await admin
    .from('commerce_product_launch_runs')
    .update({ stages, state: evaluation.state === 'ready' ? 'ready' : 'sandbox_verifying', launch_receipt: evidence, launch_receipt_hash: hash, verified_at: evaluation.state === 'ready' ? new Date().toISOString() : null, updated_by: auth.ctx.discordId, version: run.data.version + 1, updated_at: new Date().toISOString() })
    .eq('id', run.data.id)
    .eq('guild_id', auth.ctx.guildId)
    .eq('version', run.data.version)
    .select('*')
    .maybeSingle();
  if (error) return dbError(error, 'store/launch-runs/verify/update');
  if (!data) return NextResponse.json({ error: 'Launch run changed; reload before retrying' }, { status: 409 });
  return NextResponse.json({ success: true, data, evaluation, evidence });
}
