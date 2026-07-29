/**
 * /api/alerts — Active alerts and alert history.
 *
 * GET:  List alerts (filterable by status, type, severity)
 * PATCH: Acknowledge or resolve an alert by ID
 *
 * Phase C: Real diagnostics & alerting.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { z } from 'zod';
import { parseBody } from '@/lib/api/validation';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';
import { recordAdminChange, readRowBefore, undoByRestoring } from '@/lib/admin-changes';

const alertActionSchema = z.object({
  id: z.string().uuid(),
  action: z.enum(['acknowledge', 'resolve']),
});
export async function GET(req: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const { searchParams } = new URL(req.url);

  // V11 Audit H-4: Validate and whitelist all query params before passing
  // to Supabase filter methods.
  const VALID_STATUSES = ['active', 'resolved', 'all'] as const;

  // These are the ONLY three values anything writes to `alerts.severity` —
  // `OwnerAlertSeverity` in the bot's alert-service, the same union in
  // alert-manager, and the dashboard's own inserts (which run incident
  // severities through `toAlertSeverity`, collapsing 'outage' to 'critical').
  //
  // The list previously read ['critical','high','medium','low','info'], which
  // was wrong in both directions and failed silently either way:
  //   - 'warning' — the MOST written severity, and the one several money-path
  //     alerts use (paypal_capture_denied, paypal_webhook_processing_error) —
  //     was rejected. A rejected value falls through to `null` below, so the
  //     filter was DROPPED and the caller got unfiltered results back rather
  //     than an error. Asking for warnings returned everything.
  //   - 'high' / 'medium' / 'low' were accepted but can never match a row, so
  //     those filters always returned empty.
  const VALID_SEVERITIES = ['info', 'warning', 'critical'] as const;

  const rawStatus = searchParams.get('status') ?? 'active';
  const status = VALID_STATUSES.includes(rawStatus as typeof VALID_STATUSES[number]) ? rawStatus : 'active';
  const alertType = searchParams.get('type')?.slice(0, 64).replace(/[^a-z0-9_.-]/gi, '') || null;
  // An unrecognised severity is REFUSED rather than ignored. Falling through to
  // `null` dropped the filter and returned every alert — so a caller asking for
  // one severity silently received all of them and had no way to tell. That
  // silence is what let the whitelist drift out of step with the writers for as
  // long as it did. Answering 400 makes the next mismatch immediate and obvious.
  const rawSeverity = searchParams.get('severity');
  if (rawSeverity !== null
      && !VALID_SEVERITIES.includes(rawSeverity as typeof VALID_SEVERITIES[number])) {
    return NextResponse.json(
      {
        error: 'Invalid severity',
        detail: `severity must be one of: ${VALID_SEVERITIES.join(', ')}`,
      },
      { status: 400 },
    );
  }
  const severity = rawSeverity;
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') ?? '50', 10)));

  let query = supabase
    .from('alerts')
    .select('*')
    .eq('guild_id', guildId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (status === 'active') {
    query = query.eq('resolved', false);
  } else if (status === 'resolved') {
    query = query.eq('resolved', true);
  }

  if (alertType) {
    query = query.eq('alert_type', alertType);
  }

  if (severity) {
    query = query.eq('severity', severity);
  }

  const { data, error } = await query;

  if (error) {
    return dbError(error, 'alerts');
  }

  // Separate active and resolved for convenience
  const active = (data ?? []).filter((a) => !a.resolved);
  const resolved = (data ?? []).filter((a) => a.resolved);

  return NextResponse.json({
    success: true,
    data: {
      alerts: data ?? [],
      activeCount: active.length,
      resolvedCount: resolved.length,
    },
  });
}

export async function PATCH(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId, discordId } = auth.ctx;

  const supabase = createAdminSupabase();

  const parsed = await parseBody(req, alertActionSchema);
  if (!parsed.ok) return parsed.response;
  const { id, action } = parsed.data;

  // Prior state, read BEFORE the write. This is the one route in this group
  // whose undo is genuinely replayable: `alerts` is on the undo allowlist and
  // acknowledged/resolved are exactly the admin-action columns it permits, so
  // restoring them puts the alert back on the active list. Reading afterwards
  // would capture the values we just wrote and make the undo a no-op.
  const before = await readRowBefore(
    supabase,
    'alerts',
    { id, guild_id: guildId },
    'id, title, alert_type, acknowledged, acknowledged_at, resolved, resolved_at',
  );
  const alertLabel = (before?.title as string | undefined)
    ?? (before?.alert_type as string | undefined)
    ?? 'this alert';

  if (action === 'acknowledge') {
    const now = new Date().toISOString();
    const { error } = await supabase
      .from('alerts')
      .update({
        acknowledged: true,
        acknowledged_at: now,
        updated_at: now,
      })
      .eq('id', id)
      .eq('guild_id', guildId);

    if (error) {
      return dbError(error, 'alerts');
    }

    // `updated_at` is deliberately not restored — it is a bookkeeping stamp,
    // not a setting the owner chose, and the recorder treats it the same way.
    const restorable = before !== undefined
      && 'acknowledged' in before && 'acknowledged_at' in before;
    await recordAdminChange({
      guildId,
      actorId: discordId,
      action: 'alerts.acknowledged',
      targetType: 'alert',
      targetId: id,
      description: `Acknowledged the alert "${alertLabel}"`,
      before: restorable
        ? { acknowledged: before.acknowledged, acknowledged_at: before.acknowledged_at }
        : undefined,
      after: { acknowledged: true, acknowledged_at: now },
      blastRadius: 'low',
      ...(restorable
        ? {
            undo: undoByRestoring(
              'alerts',
              { id, guild_id: guildId },
              { acknowledged: before.acknowledged, acknowledged_at: before.acknowledged_at },
            ),
          }
        : {
            undoReason:
              'the alert could not be read before the change, so there is nothing to restore',
          }),
    }, supabase);

    return NextResponse.json({ success: true });
  }

  if (action === 'resolve') {
    const now = new Date().toISOString();
    const { error } = await supabase
      .from('alerts')
      .update({
        resolved: true,
        resolved_at: now,
        updated_at: now,
      })
      .eq('id', id)
      .eq('guild_id', guildId);

    if (error) {
      return dbError(error, 'alerts');
    }

    const restorable = before !== undefined
      && 'resolved' in before && 'resolved_at' in before;
    await recordAdminChange({
      guildId,
      actorId: discordId,
      action: 'alerts.resolved',
      targetType: 'alert',
      targetId: id,
      description: `Marked the alert "${alertLabel}" resolved`,
      before: restorable
        ? { resolved: before.resolved, resolved_at: before.resolved_at }
        : undefined,
      after: { resolved: true, resolved_at: now },
      blastRadius: 'low',
      ...(restorable
        ? {
            undo: undoByRestoring(
              'alerts',
              { id, guild_id: guildId },
              { resolved: before.resolved, resolved_at: before.resolved_at },
            ),
          }
        : {
            undoReason:
              'the alert could not be read before the change, so there is nothing to restore',
          }),
    }, supabase);

    return NextResponse.json({ success: true });
  }

  return NextResponse.json(
    { success: false, error: `Unknown action: ${action}. Use 'acknowledge' or 'resolve'.` },
    { status: 400 },
  );
}
