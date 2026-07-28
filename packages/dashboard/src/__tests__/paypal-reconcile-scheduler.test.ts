import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  supabase: { from: vi.fn() },
  run: vi.fn(),
  recordFailure: vi.fn(),
  resolveFailure: vi.fn(),
}));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminSupabase: vi.fn(() => mocks.supabase),
}));

vi.mock('@/lib/paypal-reconciliation', () => ({
  DEFAULT_LEASE_MS: 6 * 60 * 60 * 1000,
  runPayPalReconciliation: mocks.run,
  recordScheduledReconciliationFailure: mocks.recordFailure,
  resolveScheduledReconciliationFailure: mocks.resolveFailure,
}));

import {
  resetPayPalReconcileSchedulerForTests,
  runScheduledPayPalReconciliationOnce,
  startPayPalReconcileScheduler,
} from '@/lib/paypal-reconcile-scheduler';

describe('PayPal reconciliation scheduler failure visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPayPalReconcileSchedulerForTests();
    mocks.recordFailure.mockResolvedValue(true);
    mocks.resolveFailure.mockResolvedValue(true);
  });

  afterEach(() => {
    resetPayPalReconcileSchedulerForTests();
    vi.useRealTimers();
  });

  it('persists and alerts a returned monitor failure', async () => {
    const failed = {
      status: 'failed' as const,
      reason: 'transaction search returned 503',
      retriable: true,
    };
    mocks.run.mockResolvedValue(failed);

    await runScheduledPayPalReconciliationOnce();

    expect(mocks.run).toHaveBeenCalledWith(mocks.supabase, {
      requireLease: true,
      leaseMs: 6 * 60 * 60 * 1000,
    });
    expect(mocks.recordFailure).toHaveBeenCalledWith(mocks.supabase, failed);
    expect(mocks.resolveFailure).not.toHaveBeenCalled();
  });

  it('persists and alerts a thrown monitor failure instead of logging only', async () => {
    mocks.run.mockRejectedValue(new Error('scheduler exploded'));

    await runScheduledPayPalReconciliationOnce();

    expect(mocks.recordFailure).toHaveBeenCalledWith(
      mocks.supabase,
      expect.objectContaining({
        status: 'failed',
        reason: 'scheduler exploded',
        retriable: true,
      }),
    );
  });

  it('resolves standing scheduler-failure alerts after a completed pass', async () => {
    mocks.run.mockResolvedValue({
      status: 'completed',
      windowStart: '2026-07-20T00:00:00.000Z',
      windowEnd: '2026-07-21T00:00:00.000Z',
      providerTransactions: 0,
      localPayments: 0,
      missingLocalPayments: [],
      missingProviderPayments: [],
      amountMismatches: [],
      unsettledLocalPayments: [],
      alerted: false,
    });

    await runScheduledPayPalReconciliationOnce();

    expect(mocks.resolveFailure).toHaveBeenCalledWith(mocks.supabase);
    expect(mocks.recordFailure).not.toHaveBeenCalled();
  });

  it('schedules the next attempt six hours after the initial pass completes', async () => {
    vi.useFakeTimers();
    mocks.run.mockResolvedValue({
      status: 'completed',
      windowStart: '2026-07-20T00:00:00.000Z',
      windowEnd: '2026-07-21T00:00:00.000Z',
      providerTransactions: 0,
      localPayments: 0,
      missingLocalPayments: [],
      missingProviderPayments: [],
      amountMismatches: [],
      unsettledLocalPayments: [],
      alerted: false,
    });

    startPayPalReconcileScheduler();

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(mocks.run).toHaveBeenCalledTimes(1);

    // A startup-relative 6h interval would fire five minutes too early here,
    // collide with the retained 6h lease, and defer real work until ~12h.
    await vi.advanceTimersByTimeAsync((6 * 60 * 60 * 1000) - 1);
    expect(mocks.run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.run).toHaveBeenCalledTimes(2);
  });
});
