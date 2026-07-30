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
  DEFAULT_COOLDOWN_MS: 6 * 60 * 60 * 1000,
  runPayPalReconciliation: mocks.run,
  recordScheduledReconciliationFailure: mocks.recordFailure,
}));

import {
  resetPayPalReconcileSchedulerForTests,
  runScheduledPayPalReconciliationOnce,
  startPayPalReconcileScheduler,
} from '@/lib/paypal-reconcile-scheduler';

describe('PayPal reconciliation scheduler failure visibility', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resetPayPalReconcileSchedulerForTests();
    mocks.recordFailure.mockResolvedValue(true);
    mocks.resolveFailure.mockResolvedValue(true);
  });

  afterEach(() => {
    resetPayPalReconcileSchedulerForTests();
    vi.useRealTimers();
  });

  it('delegates returned-failure visibility to the shared scheduled pass', async () => {
    const failed = {
      status: 'failed' as const,
      reason: 'transaction search returned 503',
      retriable: true,
    };
    mocks.run.mockResolvedValue(failed);

    await runScheduledPayPalReconciliationOnce();

    expect(mocks.run).toHaveBeenCalledWith(mocks.supabase, {
      leaseMs: 6 * 60 * 60 * 1000,
      cooldownMs: 6 * 60 * 60 * 1000,
      bypassCooldown: false,
      scheduledVisibility: true,
    });
    expect(mocks.recordFailure).not.toHaveBeenCalled();
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

  it('delegates successful alert resolution to the shared scheduled pass', async () => {
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

  it('retries a busy or cooldown skip after five minutes instead of twelve hours', async () => {
    vi.useFakeTimers();
    mocks.run
      .mockResolvedValueOnce({
        status: 'skipped',
        reason: 'another reconciliation pass completed recently',
      })
      .mockResolvedValueOnce({
        status: 'completed',
        windowStart: '2026-07-20T00:00:00.000Z',
        windowEnd: '2026-07-21T00:00:00.000Z',
        providerTransactions: 0,
        localPayments: 0,
        localRefunds: 0,
        missingLocalPayments: [],
        missingProviderPayments: [],
        amountMismatches: [],
        unsettledLocalPayments: [],
        alerted: false,
      });

    startPayPalReconcileScheduler();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(mocks.run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync((5 * 60 * 1000) - 1);
    expect(mocks.run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.run).toHaveBeenCalledTimes(2);
  });

  it('retries a retriable failure after five minutes', async () => {
    vi.useFakeTimers();
    mocks.run.mockResolvedValue({
      status: 'failed',
      reason: 'PayPal transaction search returned 503',
      retriable: true,
    });

    startPayPalReconcileScheduler();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(mocks.run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(mocks.run).toHaveBeenCalledTimes(2);
  });

  it('does not short-poll a non-retryable configuration skip', async () => {
    vi.useFakeTimers();
    mocks.run.mockResolvedValue({
      status: 'skipped',
      reason: 'PayPal credentials are not configured',
    });

    startPayPalReconcileScheduler();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(mocks.run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(mocks.run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync((6 * 60 * 60 * 1000) - (5 * 60 * 1000));
    expect(mocks.run).toHaveBeenCalledTimes(2);
  });
});
