/**
 * POST /api/paypal/reconcile — run a PayPal-truth reconciliation pass.
 * GET  /api/paypal/reconcile — read the last pass's summary.
 *
 * ── Why this route exists (Finding 1) ──────────────────────────────────────
 * The requirement is that PayPal reconciliation must be runnable from
 * something that is NOT the bot process, so it still works when the bot is the
 * broken thing. The existing `POST /api/reconciliation` cannot serve: it does
 * not reconcile, it enqueues a `bot_action_queue` row for the bot — if the bot
 * is down, the button does nothing.
 *
 * ── Why here and not elsewhere ─────────────────────────────────────────────
 * The options the repo actually has were each checked:
 *
 *   - Vercel Cron — unavailable. `vercel.json` disables Git deployments and
 *     DEPLOYMENT.md states "Vercel is not required for launch"; production is
 *     `docker compose -f docker-compose.prod.yml up -d`.
 *   - pg_cron — present (four retention jobs) but `pg_net`/`http` is NOT
 *     installed anywhere in this project, so pg_cron can only run local SQL.
 *     It cannot call PayPal's API. Adding pg_net would be new infrastructure.
 *   - GitHub Actions schedule — neither workflow has a `schedule:` trigger, no
 *     workflow deploys anything, and none holds a production credential or
 *     calls a deployed URL. Using it would mean inventing this repo's first
 *     production-credential path.
 *   - The bot — explicitly disqualified: it is the thing that may be down.
 *
 * What is left is the one process that is already long-lived, already holds
 * the PayPal credentials, already serves the webhook, and restarts
 * independently of the bot: the `dashboard` container. docker-compose.prod.yml
 * runs it as `node packages/dashboard/server.js` with its own healthcheck and
 * restart policy. So the pass runs there — self-scheduled from
 * `instrumentation.ts`, and exposed here so it is ALSO triggerable by hand and
 * by any external scheduler (host cron, systemd timer, uptime monitor, or a
 * future CI schedule) with no new infrastructure.
 *
 * ── Auth ───────────────────────────────────────────────────────────────────
 * Either an authenticated guild owner (the dashboard "run now" path) or a
 * shared scheduler secret in `X-Reconcile-Secret` / `Authorization: Bearer`.
 * The secret is OPTIONAL config: when `PAYPAL_RECONCILE_SECRET` is unset the
 * machine path is disabled entirely rather than falling open.
 */
import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import {
  RECONCILE_LAST_RESULT_KEY,
  runPayPalReconciliation,
} from '@/lib/paypal-reconciliation';

/** Long enough for a multi-page PayPal transaction search. */
export const maxDuration = 300;

function constantTimeMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * True when the caller presented the scheduler secret.
 *
 * Returns false — never true — when no secret is configured, so an unset env
 * var closes the machine path instead of opening it.
 */
function hasSchedulerSecret(req: NextRequest): boolean {
  const expected = process.env.PAYPAL_RECONCILE_SECRET;
  if (!expected) return false;

  const header = req.headers.get('x-reconcile-secret');
  const bearer = req.headers.get('authorization');
  const provided = header
    ?? (bearer?.toLowerCase().startsWith('bearer ') ? bearer.slice(7) : null);
  if (!provided) return false;

  return constantTimeMatches(provided, expected);
}

async function authorize(
  req: NextRequest,
): Promise<
  { ok: true; scheduled: boolean; guildId: string | null }
  | { ok: false; response: NextResponse }
> {
  if (hasSchedulerSecret(req)) {
    return { ok: true, scheduled: true, guildId: null };
  }

  const auth = await requireGuildOwner();
  if (!auth.ok) return { ok: false, response: auth.response };
  return { ok: true, scheduled: false, guildId: auth.ctx.guildId };
}

export async function POST(req: NextRequest) {
  const auth = await authorize(req);
  if (!auth.ok) return auth.response;

  // Human-triggered runs go through the normal admin rate limit. A scheduled
  // caller is already fenced by the cross-process lease below.
  if (!auth.scheduled) {
    const rateLimited = await checkAdminRateLimit(req, 'bulk');
    if (rateLimited) return rateLimited;
  }

  const supabase = createAdminSupabase();

  try {
    const result = await runPayPalReconciliation(supabase, {
      // A scheduled caller respects the lease so overlapping schedulers (or
      // multiple dashboard replicas) do not duplicate work. An operator
      // pressing "run now" gets an answer immediately.
      requireLease: auth.scheduled,
      // The pass and alerts remain global, but an authenticated guild owner
      // must never receive another tenant's detailed findings.
      resultGuildId: auth.guildId ?? undefined,
    });

    if (result.status === 'failed') {
      // 503 for a transient provider/database failure so a scheduler retries;
      // 500 for a configuration problem no retry can fix.
      return NextResponse.json(
        { success: false, ...result },
        result.retriable
          ? { status: 503, headers: { 'Retry-After': '300' } }
          : { status: 500 },
      );
    }

    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    console.error('[PayPalReconcile] Pass threw:', err);
    return NextResponse.json(
      { success: false, error: 'Reconciliation failed' },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest) {
  const auth = await authorize(req);
  if (!auth.ok) return auth.response;

  const supabase = createAdminSupabase();
  const { data, error } = await supabase
    .from('instance_settings')
    .select('value, updated_at')
    .eq('key', RECONCILE_LAST_RESULT_KEY)
    .maybeSingle();

  if (error) {
    return NextResponse.json(
      { success: false, error: 'Could not read reconciliation state' },
      { status: 500 },
    );
  }

  let lastRun: unknown = null;
  if (typeof data?.value === 'string') {
    try {
      lastRun = JSON.parse(data.value);
    } catch {
      lastRun = null;
    }
  }

  return NextResponse.json({ success: true, lastRun });
}
