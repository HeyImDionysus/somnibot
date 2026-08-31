import { createHash } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { dbError } from '@/lib/api/response';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { evaluateLaunchRun, type LaunchStageKey, type LaunchStageState } from '@/lib/store/commerce-operations';
import { evaluateCommerceLaunchEvidence, latestLaunchProofTimestamp, launchProofAtOrAfter } from '@/lib/store/commerce-launch-evidence';
import { resolveSdkDeploymentOrigin, SDK_RECEIPT_METADATA_KEY } from '@/lib/store/sdk-contract-identity';
import { readVerifiedSdkIntegrationReceiptMetadata } from '@/lib/store/sdk-integration-provenance';
import { verifyLaunchSdkIntegration } from '@/lib/store/sdk-launch-integration';
import { loadPayPalPolicy } from '@/lib/paypal-policy';

const runSchema = z.object({
  id: z.string().uuid(),
  product_id: z.string().uuid(),
  operation_id: z.string().uuid(),
  is_tutorial: z.boolean(),
  version: z.number().int().positive(),
  verification_started_at: z.string().datetime({ offset: true }),
});
const productSchema = z.object({
  id: z.string().uuid(),
  active: z.boolean(),
  type: z.enum(['one_time', 'subscription', 'free']),
  delivery_type: z.string(),
  price_cents: z.number().int().nonnegative(),
  granted_role_ids: z.array(z.string()).default([]),
  granted_channel_ids: z.array(z.string()).default([]),
  metadata: z.record(z.unknown()).nullable().transform((metadata) => metadata ?? {}),
  updated_at: z.string().datetime({ offset: true }),
});

const webhookSchema = z.object({
  event_id: z.string(),
  event_type: z.string(),
  result: z.enum(['success', 'duplicate']),
  payload: z.object({
    resource: z.object({
      id: z.string().optional(),
      billing_agreement_id: z.string().optional(),
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
    .select('id, product_id, operation_id, is_tutorial, version, verification_started_at')
    .eq('id', id)
    .eq('guild_id', auth.ctx.guildId)
    .maybeSingle();
  if (runError) return dbError(runError, 'store/launch-runs/verify/read');
  const run = runSchema.safeParse(runData);
  if (!run.success) return runData ? NextResponse.json({ error: 'Launch run is malformed' }, { status: 503 }) : NextResponse.json({ error: 'Launch run not found' }, { status: 404 });
  const [productResult, policyResult, filesResult, checkoutIntentsResult, freeClaimsResult] = await Promise.all([
    admin.from('products').select('*, plans(*), product_files(*)').eq('id', run.data.product_id).eq('guild_id', auth.ctx.guildId).maybeSingle(),
    admin.from('product_license_config').select('*').eq('product_id', run.data.product_id).maybeSingle(),
    admin.from('product_files').select('*').eq('product_id', run.data.product_id).limit(100),
    admin.from('commerce_checkout_intents').select('token, order_id, product_id, created_at').eq('guild_id', auth.ctx.guildId).eq('product_id', run.data.product_id).eq('launch_run_id', run.data.id).gte('created_at', run.data.verification_started_at).limit(500),
    admin.from('commerce_free_claims').select('request_id, order_id, product_id, created_at').eq('guild_id', auth.ctx.guildId).eq('product_id', run.data.product_id).eq('launch_run_id', run.data.id).gte('created_at', run.data.verification_started_at).limit(500),
  ]);
  for (const [name, result] of [['product', productResult], ['policy', policyResult], ['files', filesResult], ['checkout-intents', checkoutIntentsResult], ['free-claims', freeClaimsResult]] as const) {
    if (result.error) return dbError(result.error, `store/launch-runs/verify/${name}`);
  }
  const product = productSchema.safeParse(productResult.data);
  if (!product.success) return NextResponse.json({ error: 'Product verification data is malformed' }, { status: 503 });
  const dynamic = product.data.delivery_type === 'license_key';
  const accessPass = product.data.delivery_type === 'access_pass';
  const files = z.array(z.object({ id: z.string().uuid(), created_at: z.string().datetime({ offset: true }) })).safeParse(filesResult.data ?? []);
  if (!files.success) return NextResponse.json({ error: 'Product file verification data is malformed' }, { status: 503 });
  const policy = z.object({ product_id: z.string().uuid(), updated_at: z.string().datetime({ offset: true }) }).nullable().safeParse(policyResult.data);
  const checkoutIntents = z.array(z.object({
    token: z.string().uuid(), order_id: z.string().uuid().nullable(), product_id: z.string().uuid(), created_at: z.string(),
  })).safeParse(checkoutIntentsResult.data ?? []);
  const freeClaims = z.array(z.object({
    request_id: z.string().uuid(), order_id: z.string().uuid(), product_id: z.string().uuid(), created_at: z.string(),
  })).safeParse(freeClaimsResult.data ?? []);
  if (!policy.success || !checkoutIntents.success || !freeClaims.success) {
    return NextResponse.json({ error: 'Launch identity evidence is malformed' }, { status: 503 });
  }
  const policyRevision = dynamic ? policy.data?.updated_at ?? null : null;
  const proofAfter = latestLaunchProofTimestamp([run.data.verification_started_at, product.data.updated_at, ...(policyRevision ? [policyRevision] : []), ...files.data.map((file) => file.created_at)]);
  const currentIntents = checkoutIntents.data.filter((intent) => launchProofAtOrAfter(intent.created_at, proofAfter));
  const currentClaims = freeClaims.data.filter((claim) => launchProofAtOrAfter(claim.created_at, proofAfter));
  const orderIds = [...new Set([
    ...currentIntents.flatMap((intent) => intent.order_id ? [intent.order_id] : []),
    ...currentClaims.map((claim) => claim.order_id),
  ])];
  const ordersResult = orderIds.length
    ? await admin.from('orders').select('id, product_id, status, paypal_order_id, paypal_subscription_id, created_at').eq('guild_id', auth.ctx.guildId).eq('product_id', run.data.product_id).in('id', orderIds).gte('created_at', proofAfter).limit(500)
    : { data: [], error: null };
  if (ordersResult.error) return dbError(ordersResult.error, 'store/launch-runs/verify/orders');
  const orders = z.array(z.object({
    id: z.string().uuid(), product_id: z.string().uuid(), status: z.string(),
    paypal_order_id: z.string().nullable(), paypal_subscription_id: z.string().nullable(), created_at: z.string().datetime({ offset: true }),
  })).safeParse(ordersResult.data ?? []);
  if (!orders.success) return NextResponse.json({ error: 'Order verification data is malformed' }, { status: 503 });
  const currentOrders = orders.data.filter((order) => orderIds.includes(order.id) && launchProofAtOrAfter(order.created_at, proofAfter));
  const verifiedOrderIds = currentOrders.map((order) => order.id);
  const emptyResult = Promise.resolve({ data: [], error: null });
  const [paymentsResult, entitlementsResult, keysResult, downloadsResult, refundsResult, cancellationsResult, outwardResult, rolesResult] = await Promise.all([
    verifiedOrderIds.length ? admin.from('payments').select('id, order_id, status, paypal_payment_id, paypal_event_id').eq('guild_id', auth.ctx.guildId).in('order_id', verifiedOrderIds).limit(1000) : emptyResult,
    verifiedOrderIds.length ? admin.from('entitlements').select('id, order_id, product_id, status').eq('guild_id', auth.ctx.guildId).in('order_id', verifiedOrderIds).limit(1000) : emptyResult,
    verifiedOrderIds.length ? admin.from('license_keys').select('id, order_id, status').eq('guild_id', auth.ctx.guildId).in('order_id', verifiedOrderIds).limit(1000) : emptyResult,
    verifiedOrderIds.length ? admin.from('commerce_download_deliveries').select('id, order_id, product_id, file_id, delivered_at').eq('guild_id', auth.ctx.guildId).eq('product_id', product.data.id).in('order_id', verifiedOrderIds).limit(1000) : emptyResult,
    verifiedOrderIds.length ? admin.from('payment_refunds').select('id, order_id, payment_id, paypal_refund_id').eq('guild_id', auth.ctx.guildId).in('order_id', verifiedOrderIds).limit(1000) : emptyResult,
    verifiedOrderIds.length ? admin.from('portal_cancellation_operations').select('id, order_id, status').eq('guild_id', auth.ctx.guildId).in('order_id', verifiedOrderIds).eq('status', 'completed').limit(1000) : emptyResult,
    verifiedOrderIds.length ? admin.from('commerce_fulfillment_outward_intents').select('id, order_id, intent_kind, state, sent_at, outward_generation_id').eq('guild_id', auth.ctx.guildId).in('order_id', verifiedOrderIds).eq('intent_kind', 'receipt_dm').limit(1000) : emptyResult,
    accessPass && verifiedOrderIds.length ? admin.from('commerce_role_delivery_intents').select('id, order_id, product_id, entitlement_id, permanent_role_ids, completed_role_ids, delivery_confirmed_at, completed_channel_ids, channel_delivery_confirmed_at, state, outward_generation_id').eq('guild_id', auth.ctx.guildId).eq('product_id', product.data.id).in('order_id', verifiedOrderIds).limit(1000) : emptyResult,
  ]);
  for (const [name, result] of [['payments', paymentsResult], ['entitlements', entitlementsResult], ['keys', keysResult], ['downloads', downloadsResult], ['refunds', refundsResult], ['cancellations', cancellationsResult], ['outward', outwardResult], ['roles', rolesResult]] as const) {
    if (result.error) return dbError(result.error, `store/launch-runs/verify/${name}`);
  }
  const payments = z.array(z.object({
    id: z.string().uuid(), order_id: z.string().uuid(), status: z.string(),
    paypal_payment_id: z.string().nullable(), paypal_event_id: z.string().nullable(),
  })).safeParse(paymentsResult.data ?? []);
  const entitlements = z.array(z.object({ id: z.string().uuid(), order_id: z.string().uuid(), product_id: z.string().uuid(), status: z.string() })).safeParse(entitlementsResult.data ?? []);
  const keys = z.array(z.object({ id: z.string().uuid(), order_id: z.string().uuid(), status: z.string() })).safeParse(keysResult.data ?? []);
  const downloads = z.array(z.object({ id: z.string().uuid(), order_id: z.string().uuid().nullable(), product_id: z.string().uuid(), file_id: z.string().uuid().nullable(), delivered_at: z.string().datetime({ offset: true }) })).safeParse(downloadsResult.data ?? []);
  const refunds = z.array(z.object({
    id: z.string().uuid(), order_id: z.string().uuid(), payment_id: z.string().uuid(), paypal_refund_id: z.string(),
  })).safeParse(refundsResult.data ?? []);
  const cancellations = z.array(z.object({ id: z.string().uuid(), order_id: z.string().uuid(), status: z.literal('completed') })).safeParse(cancellationsResult.data ?? []);
  const outward = z.array(z.object({ id: z.string().uuid(), order_id: z.string().uuid(), intent_kind: z.string(), state: z.string(), sent_at: z.string().datetime({ offset: true }).nullable(), outward_generation_id: z.string().uuid().nullable().default(null) })).safeParse(outwardResult.data ?? []);
  const roles = z.array(z.object({ id: z.string().uuid(), order_id: z.string().uuid(), product_id: z.string().uuid(), entitlement_id: z.string().uuid(), permanent_role_ids: z.array(z.string()), completed_role_ids: z.array(z.string()), delivery_confirmed_at: z.string().datetime({ offset: true }).nullable(), completed_channel_ids: z.array(z.string()).default([]), channel_delivery_confirmed_at: z.string().datetime({ offset: true }).nullable().default(null), state: z.string(), outward_generation_id: z.string().uuid().nullable() })).safeParse(rolesResult.data ?? []);
  if (!payments.success || !entitlements.success || !keys.success || !downloads.success || !refunds.success || !cancellations.success || !outward.success || !roles.success) {
    return NextResponse.json({ error: 'Launch evidence is malformed' }, { status: 503 });
  }
  const paypalPolicy = await loadPayPalPolicy(admin, auth.ctx.guildId);
  const policyConfigured = dynamic ? policy.data !== null : accessPass
    ? product.data.granted_role_ids.length + product.data.granted_channel_ids.length > 0 : files.data.length > 0;
  let integrationVerified = policyConfigured;
  if (dynamic || 'completed_project_licensing' in product.data.metadata || SDK_RECEIPT_METADATA_KEY in product.data.metadata) {
    try {
      integrationVerified = policyConfigured && await verifyLaunchSdkIntegration({ ...productResult.data, product_files: filesResult.data, product_license_config: dynamic ? policyResult.data : null }, resolveSdkDeploymentOrigin(process.env));
    } catch (error) {
      console.error('[store/launch-runs/verify] SDK contract generation failed:', error instanceof Error ? error.message : 'unknown error');
      return NextResponse.json({ error: 'Saved licensing policy could not produce an SDK contract' }, { status: 503 });
    }
  }
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
      policyConfigured,
      integrationVerified,
    },
    orders: currentOrders.map((order) => ({ id: order.id, productId: order.product_id, status: order.status, paypalOrderId: order.paypal_order_id, paypalSubscriptionId: order.paypal_subscription_id })),
    freeClaims: currentClaims.map((claim) => ({ id: claim.request_id, orderId: claim.order_id, productId: claim.product_id })),
    payments: payments.data.map((payment) => ({ id: payment.id, orderId: payment.order_id, status: payment.status, paypalPaymentId: payment.paypal_payment_id, paypalEventId: payment.paypal_event_id })),
    webhooks: webhooks.data.map((webhook) => ({
      eventId: webhook.event_id, eventType: webhook.event_type, result: webhook.result,
      resourceId: webhook.payload.resource.id ?? null,
      relatedOrderId: webhook.payload.resource.supplementary_data?.related_ids?.order_id ?? null,
      billingAgreementId: webhook.payload.resource.billing_agreement_id ?? null,
    })),
    entitlements: entitlements.data.map((entitlement) => ({ id: entitlement.id, orderId: entitlement.order_id, productId: entitlement.product_id, status: entitlement.status })),
    fulfillments: [
      ...outward.data.filter((delivery) => delivery.intent_kind === 'receipt_dm' && keys.data.some((key) => key.order_id === delivery.order_id))
        .map((delivery) => ({ id: delivery.id, orderId: delivery.order_id, kind: 'license' as const, deliveryState: delivery.state, sentAt: delivery.sent_at })),
      ...downloads.data.filter((download) => download.product_id === product.data.id && download.order_id !== null && launchProofAtOrAfter(download.delivered_at, proofAfter) && files.data.some((file) => file.id === download.file_id))
        .map((download) => ({ id: download.id, orderId: download.order_id ?? '', kind: 'download' as const })),
      ...roles.data.flatMap((role) => role.product_id === product.data.id && role.outward_generation_id !== null
        && launchProofAtOrAfter(role.delivery_confirmed_at, proofAfter)
        && product.data.granted_role_ids.every((id) => role.permanent_role_ids.includes(id) && role.completed_role_ids.includes(id))
        && (product.data.granted_channel_ids.length === 0 || (launchProofAtOrAfter(role.channel_delivery_confirmed_at, proofAfter)
          && product.data.granted_channel_ids.every((id) => role.completed_channel_ids.includes(id))))
        && entitlements.data.some((entitlement) => entitlement.id === role.entitlement_id && entitlement.order_id === role.order_id && entitlement.product_id === role.product_id)
        ? outward.data.filter((delivery) => delivery.order_id === role.order_id && delivery.outward_generation_id === role.outward_generation_id && delivery.intent_kind === 'receipt_dm' && launchProofAtOrAfter(delivery.sent_at, role.delivery_confirmed_at ?? proofAfter)
          && (product.data.granted_channel_ids.length === 0 || launchProofAtOrAfter(delivery.sent_at, role.channel_delivery_confirmed_at ?? proofAfter)))
          .map((delivery) => ({ id: role.id, orderId: role.order_id, kind: 'access' as const, deliveryState: delivery.state, sentAt: delivery.sent_at })) : []),
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
    policy_revision: policyRevision,
    sdk_integration_receipt: await readVerifiedSdkIntegrationReceiptMetadata(product.data.metadata),
    verification_started_at: run.data.verification_started_at,
    proof_after: proofAfter,
    environment: paypalPolicy.environment,
    order_ids: verifiedOrderIds,
    payment_ids: payments.data.map((payment) => payment.id),
    entitlement_ids: entitlements.data.map((entitlement) => entitlement.id),
    refund_ids: refunds.data.map((refund) => refund.id),
    cancellation_ids: cancellations.data.map((cancellation) => cancellation.id),
    outward_deliveries: outward.data,
    role_deliveries: roles.data,
    file_ids: files.data.map((file) => file.id),
    witness: evaluated.witness,
    stages,
  };
  const hash = createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
  const evaluation = evaluateLaunchRun({ productActive: product.data.active, environment: paypalPolicy.environment, stages, receiptHash: hash });
  const { data, error } = await admin.rpc('commerce_verify_product_launch', {
    p_guild_id: auth.ctx.guildId, p_actor_id: auth.ctx.discordId, p_launch_run_id: run.data.id,
    p_expected_version: run.data.version, p_product_revision: product.data.updated_at,
    p_policy_revision: policyRevision, p_stages: stages,
    p_receipt: evidence, p_receipt_hash: hash, p_ready: evaluation.state === 'ready',
  });
  if (error) return dbError(error, 'store/launch-runs/verify/update');
  if (!data) return NextResponse.json({ error: 'Launch run changed; reload before retrying' }, { status: 409 });
  return NextResponse.json({ success: true, data, evaluation, evidence });
}
