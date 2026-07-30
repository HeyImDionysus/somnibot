/**
 * GET  /api/reconciliation — Get recent reconciliation runs.
 * POST /api/reconciliation — Trigger a manual reconciliation run.
 *
 * Phase B.4: Admin-only.
 *
 * ── The POST is NOT a read-only report ────────────────────────────────────
 * It enqueues `run_reconciliation`, which the bot's action queue hands to
 * `services/reconciliation.ts`. That sweep EXPIRES entitlements whose grace
 * period has run out, deactivates the device sessions behind them, revokes the
 * roles they granted and resolves the matching alerts. So it is recorded as a
 * real, entitlement-affecting change, described in terms of what it may take
 * away rather than as "generated a report".
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { z } from 'zod';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { parseBody } from '@/lib/api/validation';
import { dbError } from '@/lib/api/response';
import { recordAdminChange } from '@/lib/admin-changes';

// V5 Audit P3-5: Non-optional version for parseBody (optional body handled via fallback)
const reconciliationTriggerSchema = z.object({
  trigger: z.enum(['manual', 'scheduled']).default('manual'),
}).strict();

export async function GET() {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();

  // Get the last 20 reconciliation runs for this guild
  const { data: runs } = await supabase
    .from('reconciliation_runs')
    .select('*')
    .eq('guild_id', guildId)
    .order('started_at', { ascending: false })
    .limit(20);

  // Get summary stats
  const lastCompleted = runs?.find(r => r.status === 'completed');
  const lastFailed = runs?.find(r => r.status === 'failed');
  const isRunning = runs?.some(r => r.status === 'running');

  return NextResponse.json({
    runs: runs ?? [],
    summary: {
      last_completed: lastCompleted?.completed_at ?? null,
      last_failed: lastFailed?.completed_at ?? null,
      is_running: isRunning ?? false,
      last_findings: lastCompleted?.findings ?? null,
    },
  });
}

export async function POST(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'bulk');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();

  // Check if a run is already in progress for this guild
  const { data: running, error: runningError } = await supabase
    .from('reconciliation_runs')
    .select('id')
    .eq('guild_id', guildId)
    .eq('status', 'running')
    .maybeSingle();

  if (runningError) {
    return dbError(runningError, 'reconciliation');
  }

  if (running) {
    return NextResponse.json(
      { success: false, error: 'A reconciliation run is already in progress' },
      { status: 409 },
    );
  }

  // V5 Audit P3-5: Use centralized parseBody for consistency.
  // Body is optional — default to 'manual' trigger if empty.
  let trigger = 'manual';
  const bodyText = await req.clone().text().catch(() => '');
  if (bodyText.length > 0) {
    const parsed = await parseBody(req, reconciliationTriggerSchema);
    if (!parsed.ok) return parsed.response;
    trigger = parsed.data.trigger ?? 'manual';
  }

  // Enqueue a reconciliation action for the bot to pick up
  const { error: queueError } = await supabase.from('bot_action_queue').insert({
    guild_id: guildId,
    action: 'run_reconciliation',
    payload: { trigger },
    status: 'pending',
  });

  if (queueError) {
    return dbError(queueError, 'reconciliation');
  }

  await recordAdminChange(
    {
      guildId,
      actorId: auth.ctx.discordId,
      action: 'commerce.reconciliation_queued',
      targetType: 'reconciliation run',
      targetId: null,
      description:
        'Queued a reconciliation sweep — the bot will re-check every subscription, '
        + 'entitlement and license against PayPal, and will revoke access whose grace '
        + 'period has run out',
      after: { trigger },
      blastRadius: 'high',
      undoReason:
        'a queued sweep cannot be recalled, and any access it revokes has to be '
        + 'granted again by hand',
    },
    supabase,
  );

  return NextResponse.json({ success: true, message: 'Reconciliation run queued' });
}
