import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { dbError } from '@/lib/api/response';
import { createAdminSupabase } from '@/lib/supabase/admin';

const querySchema = z.object({
  state: z.enum(['open', 'in_progress', 'resolved', 'compensated', 'dismissed']).optional(),
  severity: z.enum(['info', 'warning', 'critical']).optional(),
  category: z.enum([
    'unattributed_paypal_event', 'reconciliation_difference', 'stalled_fulfillment',
    'failed_role_delivery', 'failed_license_delivery', 'download_problem',
    'refund_discrepancy', 'cancellation_discrepancy', 'payment_dispute',
    'fraud_hold', 'customer_identity_conflict',
  ]).optional(),
});

export async function GET(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'standard');
  if (rateLimited) return rateLimited;
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const parsed = querySchema.safeParse({
    state: request.nextUrl.searchParams.get('state') ?? undefined,
    severity: request.nextUrl.searchParams.get('severity') ?? undefined,
    category: request.nextUrl.searchParams.get('category') ?? undefined,
  });
  if (!parsed.success) return NextResponse.json({ error: 'Invalid exception filter' }, { status: 400 });
  const admin = createAdminSupabase();
  let query = admin
    .from('commerce_revenue_exceptions')
    .select('id, source_kind, source_id, category, severity, state, owner_id, operation_id, order_id, customer_id, payment_id, entitlement_id, title, safe_detail, evidence, resolution_code, resolution_note, version, detected_at, updated_at, resolved_at, commerce_revenue_exception_events(id, actor_id, action, from_state, to_state, detail, created_at), commerce_risk_cases(id, kind, state, fulfillment_action, entitlement_action, customer_notification, owner_id, version, resolution_note, updated_at, commerce_risk_effect_actions(id, operation_id, effect_kind, requested_action, state, attempt_count, last_error, updated_at))')
    .eq('guild_id', auth.ctx.guildId)
    .order('detected_at', { ascending: true })
    .limit(500);
  if (parsed.data.state) query = query.eq('state', parsed.data.state);
  if (parsed.data.severity) query = query.eq('severity', parsed.data.severity);
  if (parsed.data.category) query = query.eq('category', parsed.data.category);
  const { data, error } = await query;
  if (error) return dbError(error, 'store/revenue-exceptions/list');
  const rows = data ?? [];
  return NextResponse.json({
    success: true,
    data: rows,
    summary: {
      total: rows.length,
      open: rows.filter((row) => row.state === 'open').length,
      critical: rows.filter((row) => row.severity === 'critical' && row.state !== 'resolved').length,
      unowned: rows.filter((row) => row.owner_id === null && ['open', 'in_progress'].includes(row.state)).length,
    },
    checkedAt: new Date().toISOString(),
  });
}
