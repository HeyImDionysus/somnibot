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

  it('transitions to full boot once the gate reports a CONFIRMED complete (no manual restart)', async () => {
    // First few polls: still in progress. Then setup finalizes → confirmed complete.
    evaluateSetupGate
      .mockResolvedValueOnce({ state: 'in_progress', completionConfirmed: false })
      .mockResolvedValueOnce({ state: 'in_progress', completionConfirmed: false })
      .mockResolvedValue({ state: 'complete', completionConfirmed: true });
    const onComplete = vi.fn().mockResolvedValue(undefined);

    startSetupCompletionWatcher(supabase, onComplete, { pollMs: 1000 });
    await vi.advanceTimersByTimeAsync(3000);

    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('fires the transition exactly once and stops polling afterwards', async () => {
    evaluateSetupGate.mockResolvedValue({ state: 'complete', completionConfirmed: true });
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
      .mockResolvedValue({ state: 'complete', completionConfirmed: true });
    const onComplete = vi.fn().mockResolvedValue(undefined);

    startSetupCompletionWatcher(supabase, onComplete, { pollMs: 1000 });
    await vi.advanceTimersByTimeAsync(3000);

    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  // ── Codex round-2 finding #5: do not treat poll read failures as completion ──
  // In verification mode DISCORD_TOKEN is always present, so a transient
  // read error makes evaluateSetupGate degrade to state:'complete' with
  // completionConfirmed:false. The watcher must NOT fire the full-boot
  // transition on that unconfirmed signal — only on a genuine completed row.
  it('does NOT transition on an UNCONFIRMED complete (transient read failure fallback)', async () => {
    // Every poll returns the read-failure fallback: complete-looking but not
    // confirmed. The owner has not actually finished setup.
    evaluateSetupGate.mockResolvedValue({ state: 'complete', completionConfirmed: false });
    const onComplete = vi.fn().mockResolvedValue(undefined);

    const watcher = startSetupCompletionWatcher(supabase, onComplete, { pollMs: 1000 });
    await vi.advanceTimersByTimeAsync(10_000);

    // Polled repeatedly, but never fired the premature transition.
    expect(evaluateSetupGate).toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    watcher.stop();
  });

  it('transitions only once the unconfirmed blip clears into a confirmed completion', async () => {
    // A transient read-failure fallback first (must be ignored), then the real
    // finalized row arrives (confirmed) → transition fires exactly once.
    evaluateSetupGate
      .mockResolvedValueOnce({ state: 'complete', completionConfirmed: false })
      .mockResolvedValueOnce({ state: 'complete', completionConfirmed: false })
      .mockResolvedValue({ state: 'complete', completionConfirmed: true });
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
