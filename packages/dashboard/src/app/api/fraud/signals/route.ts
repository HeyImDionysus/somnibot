/**
 * GET /api/fraud/signals — List fraud signals with filtering.
 * PATCH /api/fraud/signals — Update signal status (investigate, confirm, dismiss).
 *
 * ── Deciding a signal enforces nothing ────────────────────────────────────
 * Confirming or dismissing a signal writes status/resolution fields and
 * nothing else. Nothing reads that decision to block a customer, cancel an
 * order or move money; the only downstream consumer is the critical-burst
 * counter (bot `services/fraud-detection.ts` and `api/license/validate`),
 * which counts `status = 'open'` critical signals in the last hour to decide
 * whether to auto-raise an incident. Dismissing therefore quiets an alarm — it
 * does not punish anyone — and the recorded description says exactly that, so
 * an owner never assumes "confirmed" already dealt with the fraudster.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requirePermission, authErrorResponse } from '@/lib/rbac';
import { z } from 'zod';
import { parseBody } from '@/lib/api/validation';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';
import { readRowBefore, recordAdminChange } from '@/lib/admin-changes';

const fraudSignalUpdate = z.object({
  id: z.string().uuid(),
  status: z.enum(['pending', 'confirmed', 'dismissed', 'auto_resolved']).optional(),
  resolution_note: z.string().max(1000).optional().nullable(),
});

export async function GET(request: NextRequest) {
  try {
    const ctx = await requirePermission('dashboard.view_fraud');
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');
    const severity = searchParams.get('severity');
    const signalType = searchParams.get('type');
    const page = parseInt(searchParams.get('page') || '1');
    const pageSize = parseInt(searchParams.get('pageSize') || '50');

    const admin = createAdminSupabase();
    let query = admin
      .from('fraud_signals')
      .select('*', { count: 'exact' })
      .eq('guild_id', ctx.guildId)
      .order('created_at', { ascending: false })
      .range((page - 1) * pageSize, page * pageSize - 1)
      .limit(1000);

    if (status) query = query.eq('status', status);
    if (severity) query = query.eq('severity', severity);
    if (signalType) query = query.eq('signal_type', signalType);

    const { data, count, error } = await query;
    if (error) return dbError(error, 'fraud/signals');

    // Summary stats
    const { data: stats } = await admin
      .from('fraud_signals')
      .select('status, severity')
      .eq('guild_id', ctx.guildId)
      .limit(1000);

    const summary = {
      total: (stats || []).length,
      open: (stats || []).filter(s => s.status === 'open').length,
      investigating: (stats || []).filter(s => s.status === 'investigating').length,
      critical: (stats || []).filter(s => s.severity === 'critical' && s.status !== 'dismissed' && s.status !== 'auto_resolved').length,
      confirmed: (stats || []).filter(s => s.status === 'confirmed').length,
    };

    return NextResponse.json({
      success: true,
      data,
      summary,
      pagination: { page, pageSize, total: count || 0, totalPages: Math.ceil((count || 0) / pageSize) },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: msg === 'Unauthorized' ? 401 : 403 });
  }
}

export async function PATCH(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;

  try {
    const ctx = await requirePermission('dashboard.manage_fraud');
    const parsed = await parseBody(request, fraudSignalUpdate);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    const admin = createAdminSupabase();

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.status) updates.status = body.status;
    if (body.resolution_note !== undefined) updates.resolution_note = body.resolution_note;

    if (body.status === 'confirmed' || body.status === 'dismissed' || body.status === 'auto_resolved') {
      updates.resolved_by = ctx.discordId;
      updates.resolved_at = new Date().toISOString();
    }

    // Prior status and the signal's identity, read before the update replaces
    // them.
    const before = await readRowBefore(
      admin,
      'fraud_signals',
      { id: body.id, guild_id: ctx.guildId },
      'id, status, signal_type, severity, resolution_note',
    );

    const { data, error } = await admin
      .from('fraud_signals')
      .update(updates)
      .eq('id', body.id)
      .eq('guild_id', ctx.guildId)
      .select()
      .single();

    if (error) return dbError(error, 'fraud/signals');

    const signalName = typeof before?.signal_type === 'string'
      ? `"${before.signal_type}"`
      : '';
    const severity = typeof before?.severity === 'string' ? `${before.severity} ` : '';
    const subject = `the ${severity}${signalName ? `${signalName} ` : ''}fraud signal`;

    await recordAdminChange(
      {
        guildId: ctx.guildId,
        actorId: ctx.discordId,
        action: body.status ? `fraud.signal_${body.status}` : 'fraud.signal_annotated',
        targetType: 'fraud signal',
        targetId: body.id,
        description: body.status
          ? `Marked ${subject} as ${body.status} — this is a review decision only: it `
            + 'does not block the customer, cancel their order or move any money'
          : `Added a resolution note to ${subject}`,
        before: before
          ? { status: before.status, resolution_note: before.resolution_note }
          : undefined,
        after: updates,
        blastRadius: 'medium',
        undoReason:
          'fraud signal decisions are outside the dashboard undo system — set the '
          + 'status back by hand if this was a mistake',
      },
      admin,
    );

    return NextResponse.json({ success: true, data });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: msg === 'Unauthorized' ? 401 : 403 });
  }
}
