/**
 * Setup-Completion Watcher — unit tests (Wave 3 setup gate).
 *
 * Codex finding #2: a bot booted in setup-verification mode must transition to
 * full boot once the owner finalizes setup, WITHOUT a manual restart. This
 * watcher polls the setup gate and fires the transition exactly once when the
 * gate reports 'complete'.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
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
    vi.resetAllMocks();
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

  // ── Codex round-3 finding #2: a stopped watcher must not fire completion ──
  // clearInterval only prevents FUTURE ticks; a tick already suspended inside
  // `await evaluateSetupGate` can still resume. If stop() runs while a poll is
  // in flight and that poll then observes a CONFIRMED complete, the watcher must
  // NOT call onComplete — once stopped, it stays stopped (no post-shutdown /
  // post-replacement transition).
  it('does NOT fire onComplete when stop() is called while a poll is in flight', async () => {
    let releaseGate!: (v: unknown) => void;
    // First poll hangs until we release it; by then stop() has been called.
    evaluateSetupGate.mockImplementationOnce(
      () => new Promise((resolve) => { releaseGate = resolve; }),
    );
    const onComplete = vi.fn().mockResolvedValue(undefined);

    const watcher = startSetupCompletionWatcher(supabase, onComplete, { pollMs: 1000 });
    // Kick off the first poll (it suspends on the pending gate promise).
    await vi.advanceTimersByTimeAsync(1000);
    expect(evaluateSetupGate).toHaveBeenCalledTimes(1);

    // Stop the watcher while that poll is still awaiting the gate.
    watcher.stop();

    // Now the in-flight gate resolves to a CONFIRMED completion.
    releaseGate({ state: 'complete', completionConfirmed: true });
    await vi.advanceTimersByTimeAsync(0);

    // The post-await guard must have suppressed the transition.
    expect(onComplete).not.toHaveBeenCalled();

    // And it stays stopped — no future polls or fires.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onComplete).not.toHaveBeenCalled();
    expect(evaluateSetupGate).toHaveBeenCalledTimes(1);
  });

  // ── Codex round-3 finding #2: overlapping slow polls fire onComplete once ──
  // If two polls overlap (each slower than pollMs) and BOTH observe a confirmed
  // completion, the post-await `fired` re-check must ensure onComplete runs
  // exactly once — not once per overlapping poll.
  it('fires onComplete exactly once even when slow polls overlap', async () => {
    const gates: Array<(v: unknown) => void> = [];
    // Every poll returns a promise we resolve manually, so several can be
    // in flight simultaneously (each slower than the 1000ms interval).
    evaluateSetupGate.mockImplementation(
      () => new Promise((resolve) => { gates.push(resolve); }),
    );
    const onComplete = vi.fn().mockResolvedValue(undefined);

    startSetupCompletionWatcher(supabase, onComplete, { pollMs: 1000 });

    // Start two overlapping polls before either resolves.
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(gates.length).toBeGreaterThanOrEqual(2);

    // Resolve BOTH in-flight polls with a confirmed completion.
    gates[0]({ state: 'complete', completionConfirmed: true });
    gates[1]({ state: 'complete', completionConfirmed: true });
    await vi.advanceTimersByTimeAsync(0);

    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
