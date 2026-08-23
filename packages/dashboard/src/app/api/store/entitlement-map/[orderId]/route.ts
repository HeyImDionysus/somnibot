import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { dbError } from '@/lib/api/response';
import { createAdminSupabase } from '@/lib/supabase/admin';
import {
  buildEntitlementGraph,
  type AccessNodeKind,
} from '@/lib/store/commerce-operations';
import { readCompletedProjectLicensingMetadata } from '@/lib/store/licensing-handoff';

const previewSchema = z.enum(['refund', 'revoke', 'cancel']);
const orderSchema = z.object({
  id: z.string().uuid(),
  customer_id: z.string().uuid(),
  product_id: z.string().uuid(),
  plan_id: z.string().uuid().nullable(),
  status: z.string(),
  updated_at: z.string(),
  products: z.object({ name: z.string(), updated_at: z.string(), metadata: z.unknown() }).nullable(),
});
const paymentSchema = z.object({ id: z.string().uuid(), status: z.string(), created_at: z.string() });
const entitlementSchema = z.object({
  id: z.string().uuid(),
  status: z.string(),
  granted_role_ids: z.array(z.string()).nullable(),
  granted_channel_ids: z.array(z.string()).nullable(),
  updated_at: z.string(),
});
const keySchema = z.object({ id: z.string().uuid(), status: z.string(), activated_at: z.string().nullable() });
const sessionSchema = z.object({ id: z.string().uuid(), license_key_id: z.string().uuid(), active: z.boolean(), device_name: z.string().nullable() });
const downloadSchema = z.object({ id: z.string().uuid(), file_id: z.string().uuid().nullable() });
const auditSchema = z.object({
  id: z.string().uuid(),
  action: z.string(),
  success: z.boolean().nullable(),
  details: z.record(z.unknown()).nullable(),
  timestamp: z.string(),
});

type AccessNode = {
  readonly id: string;
  readonly kind: AccessNodeKind;
  readonly label: string;
  readonly state: 'active' | 'pending' | 'failed' | 'expired' | 'revoked' | 'unknown';
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orderId: string }> },
) {
  const rateLimited = await checkAdminRateLimit(request, 'standard');
  if (rateLimited) return rateLimited;
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { orderId } = await params;
  if (!z.string().uuid().safeParse(orderId).success) {
    return NextResponse.json({ error: 'Invalid order id' }, { status: 400 });
  }
  const previewParsed = previewSchema.safeParse(request.nextUrl.searchParams.get('preview'));
  const previewAction = previewParsed.success ? previewParsed.data : null;
  const admin = createAdminSupabase();
  const { data: orderData, error: orderError } = await admin
    .from('orders')
    .select('id, customer_id, product_id, plan_id, status, updated_at, products(name, updated_at, metadata)')
    .eq('id', orderId)
    .eq('guild_id', auth.ctx.guildId)
    .maybeSingle();
  if (orderError) return dbError(orderError, 'store/entitlement-map/order');
  const parsedOrder = orderSchema.safeParse(orderData);
  if (!parsedOrder.success) {
    return orderData
      ? NextResponse.json({ error: 'Order relationship data is malformed' }, { status: 503 })
      : NextResponse.json({ error: 'Order not found' }, { status: 404 });
  }
  const order = parsedOrder.data;
  const [paymentResult, entitlementResult, keysResult, downloadResult, policyResult, auditResult, exceptionResult] = await Promise.all([
    admin.from('payments').select('id, status, created_at').eq('guild_id', auth.ctx.guildId).eq('order_id', order.id).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    admin.from('entitlements').select('id, status, granted_role_ids, granted_channel_ids, updated_at').eq('guild_id', auth.ctx.guildId).eq('order_id', order.id).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    admin.from('license_keys').select('id, status, activated_at').eq('guild_id', auth.ctx.guildId).eq('order_id', order.id).order('created_at', { ascending: false }).limit(100),
    admin.from('commerce_download_deliveries').select('id, file_id').eq('guild_id', auth.ctx.guildId).eq('order_id', order.id).order('delivered_at', { ascending: false }).limit(100),
    admin.from('product_license_config').select('updated_at').eq('product_id', order.product_id).maybeSingle(),
    admin.from('audit_logs').select('id, action, success, details, timestamp').eq('guild_id', auth.ctx.guildId).or(`target_id.eq.${order.id},details->>order_id.eq.${order.id}`).order('timestamp', { ascending: true }).limit(500),
    admin.from('commerce_revenue_exceptions').select('id, category, severity, state, operation_id, title').eq('guild_id', auth.ctx.guildId).eq('order_id', order.id).order('detected_at', { ascending: true }).limit(100),
  ]);
  for (const [name, result] of [
    ['payments', paymentResult], ['entitlements', entitlementResult], ['keys', keysResult],
    ['downloads', downloadResult], ['policy', policyResult], ['audit', auditResult],
    ['exceptions', exceptionResult],
  ] as const) {
    if (result.error) return dbError(result.error, `store/entitlement-map/${name}`);
  }
  const payment = paymentResult.data ? paymentSchema.safeParse(paymentResult.data) : null;
  const entitlement = entitlementResult.data ? entitlementSchema.safeParse(entitlementResult.data) : null;
  const keys = z.array(keySchema).safeParse(keysResult.data ?? []);
  const downloads = z.array(downloadSchema).safeParse(downloadResult.data ?? []);
  const audits = z.array(auditSchema).safeParse(auditResult.data ?? []);
  if ((payment && !payment.success) || (entitlement && !entitlement.success)
    || !keys.success || !downloads.success || !audits.success) {
    return NextResponse.json({ error: 'Entitlement evidence is malformed' }, { status: 503 });
  }
  const access: AccessNode[] = [];
  const entitlementRow = entitlement?.success ? entitlement.data : null;
  const entitlementActive = entitlementRow?.status === 'active' || entitlementRow?.status === 'grace_period';
  for (const roleId of entitlementRow?.granted_role_ids ?? []) {
    access.push({ id: `role:${roleId}`, kind: 'discord_role', label: `Discord role ${roleId}`, state: entitlementActive ? 'active' : 'revoked' });
  }
  for (const channelId of entitlementRow?.granted_channel_ids ?? []) {
    access.push({ id: `channel:${channelId}`, kind: 'private_channel', label: `Private channel ${channelId}`, state: entitlementActive ? 'active' : 'revoked' });
  }
  const keyIds = keys.data.map((key) => key.id);
  const sessionsResult = keyIds.length
    ? await admin.from('license_sessions').select('id, license_key_id, active, device_name').in('license_key_id', keyIds).limit(10_000)
    : { data: [], error: null };
  if (sessionsResult.error) return dbError(sessionsResult.error, 'store/entitlement-map/sessions');
  const sessions = z.array(sessionSchema).safeParse(sessionsResult.data ?? []);
  if (!sessions.success) return NextResponse.json({ error: 'Installation evidence is malformed' }, { status: 503 });
  for (const key of keys.data) {
    access.push({ id: key.id, kind: 'license', label: 'License key', state: key.status === 'active' || key.status === 'pending_activation' ? 'active' : key.status === 'revoked' ? 'revoked' : 'expired' });
    for (const session of sessions.data.filter((candidate) => candidate.license_key_id === key.id)) {
      access.push({ id: session.id, kind: 'installation', label: session.device_name ?? 'Installation', state: session.active ? 'active' : 'revoked' });
    }
  }
  for (const download of downloads.data) {
    access.push({ id: download.id, kind: 'download', label: download.file_id ? `Download ${download.file_id}` : 'Download', state: 'active' });
  }
  const metadata = readCompletedProjectLicensingMetadata(order.products?.metadata);
  const rails = metadata?.rails;
  if (rails?.hostedAccess) access.push({ id: `hosted:${order.id}`, kind: 'hosted_access', label: 'Hosted access', state: entitlementActive ? 'active' : 'revoked' });
  if (rails?.updates) access.push({ id: `updates:${order.id}`, kind: 'update_access', label: 'Update access', state: entitlementActive ? 'active' : 'revoked' });
  const capabilities = (metadata?.capabilities ?? []).map((capability) => ({
    key: capability.key,
    name: capability.name,
    granted: capability.grantingPlans.length === 0
      || capability.grantingPlans.some((plan) => plan.planId === order.plan_id),
  }));
  const graph = buildEntitlementGraph({
    order: { id: order.id, customerId: order.customer_id, status: order.status, productId: order.product_id, planId: order.plan_id },
    payment: payment?.success ? { id: payment.data.id, status: payment.data.status } : null,
    entitlement: entitlementRow ? { id: entitlementRow.id, status: entitlementRow.status } : null,
    capabilities,
    access,
    operationHistory: audits.data.map((audit) => ({
      operationId: typeof audit.details?.operation_id === 'string' ? audit.details.operation_id : audit.id,
      action: audit.action,
      state: audit.success === false ? 'failed' : 'complete',
    })),
    previewAction,
    productRevision: order.products?.updated_at ?? order.updated_at,
    policyRevision: typeof policyResult.data?.updated_at === 'string' ? policyResult.data.updated_at : 'not-configured',
  });
  return NextResponse.json({
    success: true,
    data: {
      ...graph,
      conflicts: exceptionResult.data ?? [],
      evidence: {
        orderUpdatedAt: order.updated_at,
        entitlementUpdatedAt: entitlementRow?.updated_at ?? null,
        checkedAt: new Date().toISOString(),
      },
    },
  });
}
