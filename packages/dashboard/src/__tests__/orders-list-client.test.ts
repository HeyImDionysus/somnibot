import { describe, expect, it, vi } from 'vitest';
import {
  parseOrderListPayload,
  runLatestOrderListLoad,
} from '@/lib/api/order-list-client';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('order list refund-state hydration', () => {
  it('hydrates every durable refund UI state and omits null states', () => {
    expect(parseOrderListPayload(true, {
      success: true,
      total: 5,
      data: [
        { id: 'order-pending', refund_state: 'pending', refund_context: 'provider' },
        { id: 'order-provider-completed', refund_state: 'provider_completed', refund_context: 'provider' },
        { id: 'order-failed', refund_state: 'failed', refund_context: 'provider' },
        { id: 'order-retry', refund_state: 'retry', refund_context: 'local' },
        { id: 'order-ready', refund_state: null, refund_context: null },
      ],
    })).toEqual({
      ok: true,
      total: 5,
      orders: [
        { id: 'order-pending', refund_state: 'pending', refund_context: 'provider' },
        { id: 'order-provider-completed', refund_state: 'provider_completed', refund_context: 'provider' },
        { id: 'order-failed', refund_state: 'failed', refund_context: 'provider' },
        { id: 'order-retry', refund_state: 'retry', refund_context: 'local' },
        { id: 'order-ready', refund_state: null, refund_context: null },
      ],
      refundStates: {
        'order-pending': 'pending',
        'order-provider-completed': 'provider_completed',
        'order-failed': 'failed',
        'order-retry': 'retry',
      },
    });
  });

  it.each([
    ['missing state', { id: 'order-1' }],
    ['unknown state', { id: 'order-1', refund_state: 'creating', refund_context: null }],
    ['missing context', { id: 'order-1', refund_state: null }],
    ['unknown context', { id: 'order-1', refund_state: null, refund_context: 'remote' }],
    ['pending local context', { id: 'order-1', refund_state: 'pending', refund_context: 'local' }],
    ['retry without context', { id: 'order-1', refund_state: 'retry', refund_context: null }],
    ['non-object order', null],
  ])('fails closed for %s', (_label, candidate) => {
    expect(parseOrderListPayload(true, {
      success: true,
      total: 1,
      data: [candidate],
    })).toEqual({ ok: false, error: 'Order list response was malformed' });
  });
});

describe('orders page latest-started load sequencing', () => {
  it('does not let a stale pre-refund success overwrite a newer refunded response', async () => {
    const sequence = { current: 0 };
    const stale = deferred<string[]>();
    const fresh = deferred<string[]>();
    let orders: string[] = [];
    let loading = false;
    const handlers = {
      onStart: () => { loading = true; },
      onSuccess: (value: string[]) => { orders = value; },
      onFailure: vi.fn(),
      onFinish: () => { loading = false; },
    };

    const staleRun = runLatestOrderListLoad(sequence, () => stale.promise, handlers);
    const freshRun = runLatestOrderListLoad(sequence, () => fresh.promise, handlers);
    fresh.resolve(['refunded']);
    await expect(freshRun).resolves.toBe(true);
    stale.resolve(['completed']);
    await expect(staleRun).resolves.toBeNull();

    expect(orders).toEqual(['refunded']);
    expect(handlers.onFailure).not.toHaveBeenCalled();
    expect(loading).toBe(false);
  });

  it('does not let a stale failure clear fresh data, toast, or change loading', async () => {
    const sequence = { current: 0 };
    const stale = deferred<string[]>();
    const fresh = deferred<string[]>();
    let orders = ['initial'];
    let loading = false;
    let falseToasts = 0;
    const handlers = {
      onStart: () => { loading = true; },
      onSuccess: (value: string[]) => { orders = value; },
      onFailure: () => {
        orders = [];
        falseToasts += 1;
      },
      onFinish: () => { loading = false; },
    };

    const staleRun = runLatestOrderListLoad(sequence, () => stale.promise, handlers);
    const freshRun = runLatestOrderListLoad(sequence, () => fresh.promise, handlers);
    fresh.resolve(['refunded']);
    await expect(freshRun).resolves.toBe(true);
    stale.reject(new Error('stale network failure'));
    await expect(staleRun).resolves.toBeNull();

    expect(orders).toEqual(['refunded']);
    expect(falseToasts).toBe(0);
    expect(loading).toBe(false);
  });
});
