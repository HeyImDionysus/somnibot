import { afterEach, describe, expect, it, vi } from 'vitest';
import { MassActionHoldService } from '../features/automations/mass-action-hold.js';

function query(result: unknown) {
  const chain: any = {};
  for (const method of ['select', 'eq', 'order', 'limit']) {
    chain[method] = vi.fn(() => chain);
  }
  chain.then = (resolve: (value: unknown) => unknown) => resolve(result);
  return chain;
}

function harness(approved: Array<{ id: string }> = []) {
  let statusHandler: ((status: string) => void) | null = null;
  let changeHandler: ((payload: any) => void) | null = null;
  const realtimeChannel = {
    on: vi.fn((_event, _filter, handler) => {
      changeHandler = handler;
      return realtimeChannel;
    }),
    subscribe: vi.fn((handler) => {
      statusHandler = handler;
      return realtimeChannel;
    }),
  };
  const supabase = {
    from: vi.fn(() => query({ data: approved, error: null })),
    channel: vi.fn(() => realtimeChannel),
    removeChannel: vi.fn(),
  };
  const service = new MassActionHoldService(supabase as any, { id: 'g1' } as any);
  return {
    service,
    supabase,
    realtimeChannel,
    status: (value: string) => statusHandler?.(value),
    change: (payload: any) => changeHandler?.(payload),
  };
}

describe('MassActionHoldService subscription recovery', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not report readiness until Realtime confirms SUBSCRIBED', async () => {
    vi.useFakeTimers();
    const { service, status } = harness();
    let ready = false;
    const subscribing = service.subscribe(vi.fn()).then(() => {
      ready = true;
    });

    await Promise.resolve();
    expect(ready).toBe(false);
    status('SUBSCRIBED');
    await subscribing;
    expect(ready).toBe(true);
    service.unsubscribe();
  });

  it('polls approved holds during a Realtime delivery gap and stops after unsubscribe', async () => {
    vi.useFakeTimers();
    const { service, supabase, status } = harness([{ id: 'hold-approved' }]);
    const onApproved = vi.fn();
    const subscribing = service.subscribe(onApproved);
    status('SUBSCRIBED');
    await subscribing;

    await vi.advanceTimersByTimeAsync(30_000);
    expect(onApproved).toHaveBeenCalledWith('hold-approved');
    expect(supabase.from).toHaveBeenCalledWith('automation_mass_action_holds');

    service.unsubscribe();
    onApproved.mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onApproved).not.toHaveBeenCalled();
    expect(supabase.removeChannel).toHaveBeenCalledTimes(1);
  });
});
