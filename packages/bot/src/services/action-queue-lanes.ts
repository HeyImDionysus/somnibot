/**
 * Action Queue Lanes — commerce vs game segregation.
 *
 * `bot_action_queue` carries two very different kinds of work:
 *
 *   - COMMERCE lane: real-money fulfillment for the paid store — granting
 *     entitlements after a PayPal payment (fulfill_*), delivering a paid
 *     customer's receipt/license-key DM (deliver_receipt), and revoking
 *     Discord roles after refunds/cancellations (revoke_roles).
 *   - GAME lane: everything else — game-economy recovery jobs
 *     (market_item_reconcile), dashboard CRUD (roles/channels/embeds),
 *     bulk member operations, config reloads, sync repairs.
 *
 * Owner requirement: commerce jobs can NEVER be starved or delayed by
 * game-job floods. Two mechanisms enforce that:
 *
 *   1. Claim priority — pending sweeps ORDER BY lane so commerce rows are
 *      fetched and claimed before any game row (and, crucially, ahead of the
 *      batch LIMIT — an in-memory sort could not see a commerce row buried
 *      behind >LIMIT older game rows).
 *   2. Concurrency budgets — the Realtime INSERT path processes each event
 *      concurrently, so a game flood would otherwise consume every in-process
 *      slot. LaneScheduler gives each lane an independent budget; game tasks
 *      queue in-process (leaving their rows safely 'pending' and unclaimed)
 *      while commerce tasks are admitted under their own budget.
 *
 * Lane classification is enforced authoritatively by a database trigger
 * (migration 20260710020000_bot_action_queue_lanes.sql) so that NO producer —
 * bot, dashboard, DLQ retry, or future code — can enqueue a commerce action
 * into the game lane. COMMERCE_LANE_ACTIONS below is the TypeScript mirror of
 * the SQL list in public.bot_action_queue_lane_for_action(); keep the two in
 * lock-step (action-queue-lanes.test.ts pins this list; the integration test
 * pins the trigger).
 */

export type ActionQueueLane = 'commerce' | 'game';

/**
 * Lanes in priority order (commerce first). The lane values are deliberately
 * chosen so that lexicographic ASC order ('commerce' < 'game') IS priority
 * order — the pending sweep relies on `ORDER BY lane ASC` to surface commerce
 * rows ahead of the batch LIMIT. Guarded by a unit test.
 */
export const ACTION_QUEUE_LANES: readonly ActionQueueLane[] = ['commerce', 'game'];

/**
 * Action types that touch real money / paid customers. Mirror of the SQL
 * classification in public.bot_action_queue_lane_for_action() — keep in sync.
 *
 * - fulfill_*: entitlement grant/revoke pipeline for paid orders and
 *   subscriptions (giveaway fulfillment and winner notification also grant
 *   or report delivery of real product entitlements, so they ride commerce).
 * - deliver_receipt: persistent re-delivery of a paid customer's
 *   receipt/license-key DM.
 * - revoke_roles: entitlement revocation after refunds/cancellations —
 *   only ever queued by the commerce refund/webhook paths.
 * - reconcile_entitlement_roles: tokenized repair/cleanup of paid roles.
 */
export const COMMERCE_LANE_ACTIONS: ReadonlySet<string> = new Set([
  'fulfill_purchase',
  'fulfill_subscription',
  'fulfill_cancellation',
  'fulfill_suspension',
  'fulfill_giveaway_prize',
  'notify_giveaway_winner',
  'deliver_receipt',
  'revoke_roles',
  'reconcile_entitlement_roles',
]);

/** Classify an action type into its processing lane. */
export function laneForAction(action: string): ActionQueueLane {
  return COMMERCE_LANE_ACTIONS.has(action) ? 'commerce' : 'game';
}

/**
 * Per-lane in-process concurrency budgets for the Realtime/retry paths.
 * Independent budgets are the point: even with every game slot busy, a
 * commerce task is admitted immediately under the commerce budget.
 */
export const LANE_CONCURRENCY: Readonly<Record<ActionQueueLane, number>> = {
  commerce: 4,
  game: 4,
};

/**
 * Per-lane pending-depth alert thresholds (strictly-greater-than), replacing
 * the previous single ">100 pending" queue-depth threshold. Commerce is held
 * to a far tighter bar: >10 undelivered paid-fulfillment jobs means paying
 * customers are waiting on their goods — that is an incident, not a backlog.
 */
export const LANE_PENDING_DEPTH_THRESHOLDS: Readonly<Record<ActionQueueLane, number>> = {
  commerce: 10,
  game: 100,
};

/** Alert severity per lane — commerce depth is always critical. */
export const LANE_DEPTH_ALERT_SEVERITY: Readonly<
  Record<ActionQueueLane, 'critical' | 'warning'>
> = {
  commerce: 'critical',
  game: 'warning',
};

/**
 * `alerts.alert_type` for a lane's pending-depth alert. Deduped by the
 * partial unique index uniq_alerts_unresolved_action_queue_depth (at most one
 * unresolved alert per guild per lane) — keep the values in sync with the
 * index predicate in migration 20260710020000.
 */
export function laneDepthAlertType(lane: ActionQueueLane): string {
  return `action_queue_depth_${lane}`;
}

/**
 * Per-lane concurrency limiter (hand-off semaphore).
 *
 * Each lane has an independent budget; tasks over budget wait FIFO in
 * process. Slot hand-off happens directly from the releasing task to the
 * next waiter — a newly arriving task can never steal a slot from a waiter
 * (which would let concurrency exceed the budget between release and
 * wake-up).
 */
export class LaneScheduler {
  private readonly budgets: Readonly<Record<ActionQueueLane, number>>;
  private readonly active: Record<ActionQueueLane, number> = { commerce: 0, game: 0 };
  private readonly waiters: Record<ActionQueueLane, Array<() => void>> = {
    commerce: [],
    game: [],
  };
  private drainWaiters: Array<() => void> = [];
  private retryTimers = new Set<ReturnType<typeof setTimeout>>();
  private closed = false;

  constructor(budgets: Readonly<Record<ActionQueueLane, number>> = LANE_CONCURRENCY) {
    this.budgets = budgets;
  }

  /** Number of tasks currently running in the lane. */
  activeCount(lane: ActionQueueLane): number {
    return this.active[lane];
  }

  /** Number of tasks waiting for a slot in the lane. */
  queuedCount(lane: ActionQueueLane): number {
    return this.waiters[lane].length;
  }

  /**
   * Run `task` under the lane's budget. Waits for a slot if the lane is
   * saturated; always releases the slot, including when the task throws.
   */
  async run<T>(lane: ActionQueueLane, task: () => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('LaneScheduler is closed');
    await this.acquire(lane);
    try {
      return await task();
    } finally {
      this.release(lane);
    }
  }

  /**
   * Own a delayed retry so close() can cancel it before audit/client teardown.
   * The queue row is already durably pending and will be recovered by the next
   * listener sweep.
   */
  schedule(
    lane: ActionQueueLane,
    delayMs: number,
    task: () => Promise<void>,
    onError: (error: unknown) => void,
  ): boolean {
    if (this.closed) return false;
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      this.run(lane, task).catch(onError);
    }, delayMs);
    timer.unref?.();
    this.retryTimers.add(timer);
    return true;
  }

  /** Reject new work, cancel delayed retries, and let admitted work drain. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
  }

  /** Resolve only after every running and FIFO-waiting task has settled. */
  drain(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.drainWaiters.push(resolve);
    });
  }

  private acquire(lane: ActionQueueLane): Promise<void> {
    if (this.active[lane] < this.budgets[lane]) {
      this.active[lane]++;
      return Promise.resolve();
    }
    // Saturated — wait for a hand-off. The releaser transfers its slot
    // without decrementing the active count, so the budget is never
    // transiently exceeded or leaked.
    return new Promise<void>((resolve) => {
      this.waiters[lane].push(resolve);
    });
  }

  private release(lane: ActionQueueLane): void {
    const next = this.waiters[lane].shift();
    if (next) {
      next(); // hand the slot to the next FIFO waiter; active count unchanged
    } else {
      this.active[lane]--;
      if (this.isIdle()) {
        const waiters = this.drainWaiters.splice(0);
        for (const resolve of waiters) resolve();
      }
    }
  }

  private isIdle(): boolean {
    return (
      this.active.commerce === 0
      && this.active.game === 0
      && this.waiters.commerce.length === 0
      && this.waiters.game.length === 0
    );
  }
}
