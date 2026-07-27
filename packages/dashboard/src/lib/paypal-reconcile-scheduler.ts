/**
 * In-process scheduler for the PayPal-truth reconciliation pass (Finding 1).
 *
 * Started once from `instrumentation.ts`, i.e. inside the long-lived
 * `dashboard` Node server that docker-compose.prod.yml runs as its own
 * container. That is the point: the bot may be down or crash-looping, and this
 * still runs, because the dashboard container has its own healthcheck and
 * restart policy.
 *
 * This adds no infrastructure. It is the same mechanism the bot already uses
 * for its 6-hourly entitlement reconciliation (`setInterval` in a long-lived
 * process), just hosted somewhere that does not depend on the bot being alive.
 *
 * Safety properties:
 *   - The pass takes a compare-and-set lease in `instance_settings`, so
 *     multiple dashboard replicas (or an external scheduler hitting
 *     POST /api/paypal/reconcile at the same time) cannot duplicate work.
 *   - The timer is `unref()`d, so it never keeps the process alive.
 *   - Every failure is swallowed and logged. Reconciliation must never be able
 *     to take the dashboard down.
 *   - Opt out entirely with PAYPAL_RECONCILE_DISABLED=1.
 */
import { createAdminSupabase } from '@/lib/supabase/admin';
import {
  DEFAULT_LEASE_MS,
  runPayPalReconciliation,
} from '@/lib/paypal-reconciliation';

/** Matches the bot's reconciliation cadence. */
const INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Let the server settle (and Supabase/PayPal config load) before the first pass. */
const INITIAL_DELAY_MS = 5 * 60 * 1000;

let started = false;
let running = false;

async function runOnce(): Promise<void> {
  // Cheap in-process guard on top of the DB lease: no point issuing PayPal
  // requests if this instance's previous pass is still going.
  if (running) return;
  running = true;
  try {
    const supabase = createAdminSupabase();
    const result = await runPayPalReconciliation(supabase, {
      requireLease: true,
      leaseMs: DEFAULT_LEASE_MS,
    });
    if (result.status === 'failed') {
      console.error(`[PayPalReconcile] Scheduled pass failed: ${result.reason}`);
    }
  } catch (err) {
    console.error(
      '[PayPalReconcile] Scheduled pass threw:',
      err instanceof Error ? err.message : err,
    );
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

  const initial = setTimeout(() => { void runOnce(); }, INITIAL_DELAY_MS);
  const interval = setInterval(() => { void runOnce(); }, INTERVAL_MS);

  // Never hold the process open; a shutdown should not wait on a timer.
  initial.unref?.();
  interval.unref?.();

  console.log(
    `[PayPalReconcile] Scheduler started — first pass in ${INITIAL_DELAY_MS / 60000}m, `
    + `then every ${INTERVAL_MS / 3600000}h`,
  );
}

/** Test hook: forget that the scheduler was started. */
export function resetPayPalReconcileSchedulerForTests(): void {
  started = false;
  running = false;
}
