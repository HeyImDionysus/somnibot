import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { dbError } from '@/lib/api/response';
import { parseBody } from '@/lib/api/validation';
import { createAdminSupabase } from '@/lib/supabase/admin';

const exceptionActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('claim'), version: z.number().int().positive() }),
  z.object({
    action: z.enum(['resolve', 'compensate', 'dismiss']),
    version: z.number().int().positive(),
    resolutionCode: z.string().min(1).max(80),
    resolutionNote: z.string().min(1).max(2000),
  }),
  z.object({
    action: z.literal('risk_transition'),
    riskCaseId: z.string().uuid(),
    riskVersion: z.number().int().positive(),
    transition: z.enum([
      'confirm_fraud', 'record_dispute', 'record_chargeback', 'record_refund',
      'mark_duplicate', 'support_cancel', 'dismiss',
    ]),
    resolutionNote: z.string().min(1).max(2000),
  }),
]);

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: 'Invalid exception id' }, { status: 400 });
  }
  const parsed = await parseBody(request, exceptionActionSchema);
  if (!parsed.ok) return parsed.response;
  const admin = createAdminSupabase();

  if (parsed.data.action === 'risk_transition') {
    const { data: riskCase, error: riskReadError } = await admin
      .from('commerce_risk_cases')
      .select('id')
      .eq('id', parsed.data.riskCaseId)
      .eq('exception_id', id)
      .eq('guild_id', auth.ctx.guildId)
      .eq('version', parsed.data.riskVersion)
      .maybeSingle();
    if (riskReadError) return dbError(riskReadError, 'store/revenue-exceptions/risk-read');
    if (!riskCase) return NextResponse.json({ error: 'Risk case changed; reload before retrying' }, { status: 409 });
    const { data, error } = await admin.rpc('commerce_transition_risk_case', {
      p_guild_id: auth.ctx.guildId,
      p_risk_case_id: parsed.data.riskCaseId,
      p_expected_version: parsed.data.riskVersion,
      p_actor_id: auth.ctx.discordId,
      p_action: parsed.data.transition,
      p_resolution_note: parsed.data.resolutionNote,
    });
    if (error) {
      if (error.code === '40001') return NextResponse.json({ error: 'Risk case changed; reload before retrying' }, { status: 409 });
      if (error.code === '23514') return NextResponse.json({ error: 'That risk transition is not allowed' }, { status: 409 });
      if (error.code === 'P0002') return NextResponse.json({ error: 'Risk case not found' }, { status: 404 });
      return dbError(error, 'store/revenue-exceptions/risk');
    }
    const { error: auditError } = await admin.from('audit_logs').insert({
      guild_id: auth.ctx.guildId,
      actor_type: 'user',
      actor_id: auth.ctx.discordId,
      action: 'commerce.risk.transitioned',
      target_type: 'commerce_risk_case',
      target_id: data.id,
      details: { operation_id: data.operation_id, transition: parsed.data.transition, kind: data.kind },
    });
    if (auditError) return dbError(auditError, 'store/revenue-exceptions/risk-audit');
    return NextResponse.json({ success: true, data });
  }

  const toState = parsed.data.action === 'claim'
    ? 'in_progress'
    : parsed.data.action === 'resolve'
      ? 'resolved'
      : parsed.data.action === 'compensate'
        ? 'compensated'
        : 'dismissed';
  const { data, error } = await admin.rpc('commerce_transition_revenue_exception', {
    p_guild_id: auth.ctx.guildId,
    p_exception_id: id,
    p_expected_version: parsed.data.version,
    p_actor_id: auth.ctx.discordId,
    p_action: parsed.data.action,
    p_to_state: toState,
    p_resolution_code: parsed.data.action === 'claim' ? null : parsed.data.resolutionCode,
    p_resolution_note: parsed.data.action === 'claim' ? null : parsed.data.resolutionNote,
  });
  if (error) {
    if (error.code === '40001') return NextResponse.json({ error: 'Exception changed; reload before retrying' }, { status: 409 });
    if (error.code === 'P0002') return NextResponse.json({ error: 'Exception not found' }, { status: 404 });
    return dbError(error, 'store/revenue-exceptions/transition');
  }
  return NextResponse.json({ success: true, data });
}
