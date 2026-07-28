/**
 * In-process scheduler for the PayPal-truth reconciliation pass (Finding 1).
 *
 * Started once from `instrumentation.ts`, i.e. inside the long-lived
 * `dashboard` Node server that docker-compose.prod.yml runs as its own
 * container. That is the point: the bot may be down or crash-looping, and this
 * still runs, because the dashboard container has its own healthcheck and
 * restart policy.
 *
 * This adds no infrastructure. A completion-relative timeout starts each pass
 * six hours after the preceding attempt finishes, hosted somewhere that does
 * not depend on the bot being alive.
 *
 * Safety properties:
 *   - Every trigger takes the same DB-clock, exact-owner RPC lease, so multiple
 *     dashboard replicas, owner run-now requests, and external schedulers
 *     cannot duplicate work.
 *   - The timer is `unref()`d, so it never keeps the process alive.
 *   - Every failure is swallowed and logged. Reconciliation must never be able
 *     to take the dashboard down.
 *   - Opt out entirely with PAYPAL_RECONCILE_DISABLED=1.
 */
import { createAdminSupabase } from '@/lib/supabase/admin';
import {
  DEFAULT_COOLDOWN_MS,
  DEFAULT_LEASE_MS,
  recordScheduledReconciliationFailure,
  runPayPalReconciliation,
} from '@/lib/paypal-reconciliation';

/** Matches the bot's reconciliation cadence. */
const INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Let the server settle (and Supabase/PayPal config load) before the first pass. */
const INITIAL_DELAY_MS = 5 * 60 * 1000;

let started = false;
let running = false;
let nextRun: ReturnType<typeof setTimeout> | null = null;

export async function runScheduledPayPalReconciliationOnce(): Promise<void> {
  // Cheap in-process guard on top of the DB lease: no point issuing PayPal
  // requests if this instance's previous pass is still going.
  if (running) return;
  running = true;
  try {
    const supabase = createAdminSupabase();
    const result = await runPayPalReconciliation(supabase, {
      leaseMs: DEFAULT_LEASE_MS,
      cooldownMs: DEFAULT_COOLDOWN_MS,
      bypassCooldown: false,
      scheduledVisibility: true,
    });
    if (result.status === 'failed') {
      console.error(`[PayPalReconcile] Scheduled pass failed: ${result.reason}`);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(
      '[PayPalReconcile] Scheduled pass threw:',
      reason,
    );
    try {
      const supabase = createAdminSupabase();
      const visible = await recordScheduledReconciliationFailure(supabase, {
        status: 'failed',
        reason,
        retriable: true,
      });
      if (!visible) {
        console.error(
          '[PayPalReconcile] Thrown scheduler failure could not be persisted and alerted',
        );
      }
    } catch (visibilityError) {
      console.error(
        '[PayPalReconcile] Failed to make thrown scheduler failure visible:',
        visibilityError instanceof Error ? visibilityError.message : visibilityError,
      );
    }
  } finally {
    running = false;
  }
}

/**
 * Start the recurring pass. Idempotent — a second call is a no-op, so a hot
 * reload cannot stack timers.
 */
export function startPayPalReconcileScheduler(): void {
  if (started) return;
  if (process.env.PAYPAL_RECONCILE_DISABLED === '1') {
    console.log('[PayPalReconcile] Scheduler disabled by PAYPAL_RECONCILE_DISABLED');
    return;
  }
  started = true;

  scheduleNext(INITIAL_DELAY_MS);

  console.log(
    `[PayPalReconcile] Scheduler started — first pass in ${INITIAL_DELAY_MS / 60000}m, `
    + `then ${INTERVAL_MS / 3600000}h after each pass finishes`,
  );
}

function scheduleNext(delayMs: number): void {
  nextRun = setTimeout(async () => {
    nextRun = null;
    try {
      await runScheduledPayPalReconciliationOnce();
    } finally {
      // Arm only after the attempt settles. A fixed startup-relative interval
      // can fire 5h55m after the initial +5m claim, hit the 6h DB lease, and
      // accidentally turn the real cadence into roughly twelve hours.
      if (started) scheduleNext(INTERVAL_MS);
    }
  }, delayMs);

  // Never hold the process open; a shutdown should not wait on a timer.
  nextRun.unref?.();
}

/** Test hook: stop the timer and forget that the scheduler was started. */
export function resetPayPalReconcileSchedulerForTests(): void {
  if (nextRun) clearTimeout(nextRun);
  nextRun = null;
  started = false;
  running = false;
}
