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
import { sweepProviderMoneyRecovery } from '@/app/api/paypal/webhook/handlers';

/** Matches the bot's reconciliation cadence. */
const INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Let the server settle (and Supabase/PayPal config load) before the first pass. */
const INITIAL_DELAY_MS = 5 * 60 * 1000;
/** Retry lease/cooldown collisions promptly without creating a hot loop. */
const SKIPPED_RETRY_MS = 5 * 60 * 1000;

let started = false;
let running = false;
let nextRun: ReturnType<typeof setTimeout> | null = null;

export async function runScheduledPayPalReconciliationOnce(): Promise<
  Awaited<ReturnType<typeof runPayPalReconciliation>> | null
> {
  // Cheap in-process guard on top of the DB lease: no point issuing PayPal
  // requests if this instance's previous pass is still going.
  if (running) return null;
  running = true;
  try {
    const supabase = createAdminSupabase();
    const recoveryResults = await sweepProviderMoneyRecovery(supabase, 20);
    const recoveryFailures = recoveryResults.filter((entry) => entry.error);
    if (recoveryFailures.length > 0) {
      console.error(
        `[PayPalReconcile] ${recoveryFailures.length} provider recovery task(s) remain retryable/manual`,
      );
    }
    const result = await runPayPalReconciliation(supabase, {
      leaseMs: DEFAULT_LEASE_MS,
      cooldownMs: DEFAULT_COOLDOWN_MS,
      bypassCooldown: false,
      scheduledVisibility: true,
    });
    if (result.status === 'failed') {
      console.error(`[PayPalReconcile] Scheduled pass failed: ${result.reason}`);
    }
    return result;
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
    return {
      status: 'failed',
      reason,
      retriable: true,
    };
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
    let delayMs = INTERVAL_MS;
    try {
      const result = await runScheduledPayPalReconciliationOnce();
      const isLeaseCollision = result?.status === 'skipped'
        && (
          result.reason === 'another reconciliation pass is running'
          || result.reason === 'another reconciliation pass completed recently'
        );
      const isRetriableFailure = result?.status === 'failed' && result.retriable;
      if (isLeaseCollision || isRetriableFailure) delayMs = SKIPPED_RETRY_MS;
    } finally {
      // Arm only after the attempt settles. A fixed startup-relative interval
      // can fire 5h55m after the initial +5m claim, hit the 6h DB lease, and
      // accidentally turn the real cadence into roughly twelve hours.
      if (started) scheduleNext(delayMs);
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
