/**
 * Setup-Completion Watcher — unit tests (Wave 3 setup gate).
 *
 * Codex finding #2: a bot booted in setup-verification mode must transition to
 * full boot once the owner finalizes setup, WITHOUT a manual restart. This
 * watcher polls the setup gate and fires the transition exactly once when the
 * gate reports 'complete'.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// The watcher polls evaluateSetupGate — drive its result per test.
const evaluateSetupGate = vi.fn();
vi.mock('../services/setup-gate.js', () => ({
  evaluateSetupGate: (...args: unknown[]) => evaluateSetupGate(...args),
}));

import { startSetupCompletionWatcher } from '../services/setup-completion-watcher.js';

const supabase = {} as any;

describe('startSetupCompletionWatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does NOT transition while the gate is still in_progress', async () => {
    evaluateSetupGate.mockResolvedValue({ state: 'in_progress' });
    const onComplete = vi.fn();

    const watcher = startSetupCompletionWatcher(supabase, onComplete, { pollMs: 1000 });
    await vi.advanceTimersByTimeAsync(5000);

    expect(evaluateSetupGate).toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    watcher.stop();
  });

  it('transitions to full boot once the gate reports complete (no manual restart)', async () => {
    // First few polls: still in progress. Then setup finalizes → complete.
    evaluateSetupGate
      .mockResolvedValueOnce({ state: 'in_progress' })
      .mockResolvedValueOnce({ state: 'in_progress' })
      .mockResolvedValue({ state: 'complete' });
    const onComplete = vi.fn().mockResolvedValue(undefined);

    startSetupCompletionWatcher(supabase, onComplete, { pollMs: 1000 });
    await vi.advanceTimersByTimeAsync(3000);

    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('fires the transition exactly once and stops polling afterwards', async () => {
    evaluateSetupGate.mockResolvedValue({ state: 'complete' });
    const onComplete = vi.fn().mockResolvedValue(undefined);

    startSetupCompletionWatcher(supabase, onComplete, { pollMs: 1000 });
    await vi.advanceTimersByTimeAsync(10_000);

    // Even after many intervals, onComplete runs once and polling stops.
    expect(onComplete).toHaveBeenCalledTimes(1);
    const gateCallsAfterFire = evaluateSetupGate.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(evaluateSetupGate.mock.calls.length).toBe(gateCallsAfterFire);
  });

  it('keeps polling (does not crash) when a gate evaluation throws', async () => {
    evaluateSetupGate
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue({ state: 'complete' });
    const onComplete = vi.fn().mockResolvedValue(undefined);

    startSetupCompletionWatcher(supabase, onComplete, { pollMs: 1000 });
    await vi.advanceTimersByTimeAsync(3000);

    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('stop() halts polling before completion', async () => {
    evaluateSetupGate.mockResolvedValue({ state: 'in_progress' });
    const onComplete = vi.fn();

    const watcher = startSetupCompletionWatcher(supabase, onComplete, { pollMs: 1000 });
    await vi.advanceTimersByTimeAsync(2000);
    watcher.stop();
    const callsAtStop = evaluateSetupGate.mock.calls.length;

    await vi.advanceTimersByTimeAsync(5000);
    expect(evaluateSetupGate.mock.calls.length).toBe(callsAtStop);
    expect(onComplete).not.toHaveBeenCalled();
  });
});
