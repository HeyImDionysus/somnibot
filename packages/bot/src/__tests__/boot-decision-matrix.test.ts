/**
 * Boot Decision Matrix — parameterized state-machine tests (Wave 3 setup gate).
 *
 * Codex has probed the startup/setup-gate logic across several rounds, each a
 * different (STARTUP SOURCE × CREDENTIAL/SETUP STATE × TRANSITION TRIGGER)
 * permutation. Rather than test individual cells, this suite enumerates the
 * COMPLETE matrix and asserts, for every reachable cell:
 *
 *   1. the right ACTION (idle_awaiting_setup / verification_boot / full_boot),
 *   2. that every NON-TERMINAL action names a transition-out (no terminal idle
 *      that never re-checks), and
 *   3. that each transition-out actually fires when its blocking condition
 *      clears — credentials saved → leave idle; setup finalized → reload the
 *      FINALIZED guild → full boot.
 *
 * The classification itself (setup-gate.test.ts) and the watcher lifecycle
 * (setup-completion-watcher.test.ts) are covered separately; here we assert the
 * matrix wiring that ties them together.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  bootActionForState,
  bootActionTransition,
  decideBoot,
  type BootAction,
  type BootTransition,
} from '../services/boot-decision.js';
import type { SetupGateEvaluation, SetupGateState } from '../services/setup-gate.js';
import { resolveFinalizedGuildId } from '../services/setup-verification-boot.js';

// ── The matrix axes ─────────────────────────────────────────────────────────

/** STARTUP SOURCE — how the process was launched. */
type StartupSource = 'launcher' | 'standalone' | 'env-configured' | 'bare-dev';

/**
 * CREDENTIAL/SETUP STATE — the observable rows/env that the gate classifies.
 * Each fixture pins the gate state it must resolve to, so the matrix is driven
 * by the same classification the real gate produces (see setup-gate.test.ts for
 * the row-level classification proofs).
 */
interface StateFixture {
  name: string;
  gateState: SetupGateState;
  /** True only for a genuine setup_completed_at row (confirmed completion). */
  completionConfirmed: boolean;
}

const STATE_FIXTURES: StateFixture[] = [
  { name: 'nothing', gateState: 'not_started', completionConfirmed: false },
  { name: 'supabase-only', gateState: 'not_started', completionConfirmed: false },
  { name: 'wizard discord_bot_token row (no completion)', gateState: 'in_progress', completionConfirmed: false },
  { name: 'env token, no wizard row, no completion', gateState: 'complete', completionConfirmed: false },
  { name: 'setup_completed_at present', gateState: 'complete', completionConfirmed: true },
];

/** The reachable (source × state) cells. Unreachable cells are documented, not asserted. */
interface MatrixCell {
  source: StartupSource;
  fixture: StateFixture;
  expectedAction: BootAction;
  expectedTransition: BootTransition;
}

function gateFor(fixture: StateFixture): SetupGateEvaluation {
  const shouldLogin = fixture.gateState !== 'not_started';
  const shouldRunFullInit = fixture.gateState === 'complete';
  return {
    state: fixture.gateState,
    shouldLogin,
    shouldRunFullInit,
    message: fixture.gateState === 'complete' ? null : 'Setup not complete',
    dashboardUrl: 'http://localhost:3456',
    completionConfirmed: fixture.completionConfirmed,
  };
}

function expectedActionForState(state: SetupGateState): BootAction {
  return state === 'not_started'
    ? 'idle_awaiting_setup'
    : state === 'in_progress'
      ? 'verification_boot'
      : 'full_boot';
}

function expectedTransitionForAction(action: BootAction): BootTransition {
  return action === 'idle_awaiting_setup'
    ? 'await_credentials'
    : action === 'verification_boot'
      ? 'await_completion'
      : 'none';
}

// Build the full reachable matrix. The launcher never boots 'not_started' (it
// forks only after collecting creds) and 'env-configured'/'bare-dev' never hold
// a wizard row, but every SOURCE can legitimately reach the states below in the
// standalone path, so we assert the action is a pure function of the state
// (which is the whole point of the single decision function).
const MATRIX: MatrixCell[] = [];
for (const source of ['launcher', 'standalone', 'env-configured', 'bare-dev'] as StartupSource[]) {
  for (const fixture of STATE_FIXTURES) {
    // Reachability filter: the launcher forks only after creds exist, so it is
    // never 'not_started'; env/bare deploys never carry a wizard credential row.
    if (source === 'launcher' && fixture.gateState === 'not_started') continue;
    if ((source === 'env-configured' || source === 'bare-dev') && fixture.gateState === 'in_progress') continue;
    const expectedAction = expectedActionForState(fixture.gateState);
    MATRIX.push({
      source,
      fixture,
      expectedAction,
      expectedTransition: expectedTransitionForAction(expectedAction),
    });
  }
}

describe('boot decision matrix — action per (source × state)', () => {
  it.each(MATRIX)(
    '$source × "$fixture.name" → $expectedAction (transition-out: $expectedTransition)',
    ({ fixture, expectedAction, expectedTransition }) => {
      const decision = decideBoot(gateFor(fixture));
      expect(decision.action).toBe(expectedAction);
      expect(decision.transition).toBe(expectedTransition);
      // Login/full-init flags stay consistent with the action.
      expect(decision.shouldLogin).toBe(expectedAction !== 'idle_awaiting_setup');
      expect(decision.shouldRunFullInit).toBe(expectedAction === 'full_boot');
    },
  );
});

describe('boot decision matrix — the no-terminal-idle invariant', () => {
  const ALL_STATES: SetupGateState[] = ['not_started', 'in_progress', 'complete'];

  it.each(ALL_STATES)('state "%s" maps to a total action', (state) => {
    const action = bootActionForState(state);
    expect(['idle_awaiting_setup', 'verification_boot', 'full_boot']).toContain(action);
  });

  it('every NON-TERMINAL action has a transition-out (no idle that never re-checks)', () => {
    const nonTerminal: BootAction[] = ['idle_awaiting_setup', 'verification_boot'];
    for (const action of nonTerminal) {
      const transition = bootActionTransition(action);
      // A non-terminal action must not be 'none' — it must name the watcher
      // that unblocks it when its blocking condition clears.
      expect(transition).not.toBe('none');
    }
  });

  it('idle_awaiting_setup transitions out on await_credentials', () => {
    expect(bootActionTransition('idle_awaiting_setup')).toBe('await_credentials');
  });

  it('verification_boot transitions out on await_completion', () => {
    expect(bootActionTransition('verification_boot')).toBe('await_completion');
  });

  it('full_boot is terminal (running) — no transition-out', () => {
    expect(bootActionTransition('full_boot')).toBe('none');
  });
});

// ── Transition trigger: finalize submits a (possibly different) guild ─────────
// Codex round-4 finding #1: the verification→full-boot transition must honor the
// FINALIZED discord_guild_id, not the stale env one. resolveFinalizedGuildId
// reads the row directly (loadConfigFromDatabase only fills MISSING env vars, so
// it cannot override a guild already set in env).

function makeGuildIdSupabase(
  value: string | null | undefined,
  opts: { error?: unknown; throws?: boolean } = {},
) {
  return {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: (_col: string, _key: string) => ({
          maybeSingle: async () => {
            if (opts.throws) throw new Error('network down');
            if (opts.error) return { data: null, error: opts.error };
            return { data: value === undefined ? null : { value }, error: null };
          },
        }),
      }),
    }),
  } as any;
}

describe('finalize-with-different-guild → resolveFinalizedGuildId (round-4 finding #1)', () => {
  it('returns the finalized guild id from instance_settings', async () => {
    const supabase = makeGuildIdSupabase('999000111');
    expect(await resolveFinalizedGuildId(supabase)).toBe('999000111');
  });

  it('returns the FINALIZED guild even when a DIFFERENT stale id sits in env', async () => {
    // The launcher started with DISCORD_GUILD_ID=stale-old in env; finalize wrote
    // a different guild. The resolver reads the row directly, so the stale env
    // value is irrelevant — it never gates the result.
    const prev = process.env.DISCORD_GUILD_ID;
    process.env.DISCORD_GUILD_ID = 'stale-old-guild';
    try {
      const supabase = makeGuildIdSupabase('brand-new-guild');
      expect(await resolveFinalizedGuildId(supabase)).toBe('brand-new-guild');
    } finally {
      if (prev === undefined) delete process.env.DISCORD_GUILD_ID;
      else process.env.DISCORD_GUILD_ID = prev;
    }
  });

  it('takes the first non-blank entry from a comma-separated multi-guild value', async () => {
    const supabase = makeGuildIdSupabase(' , g-primary , g-secondary ');
    expect(await resolveFinalizedGuildId(supabase)).toBe('g-primary');
  });

  it('returns null (keep current) when the row is absent, blank, errored, or throws', async () => {
    expect(await resolveFinalizedGuildId(makeGuildIdSupabase(undefined))).toBeNull();
    expect(await resolveFinalizedGuildId(makeGuildIdSupabase(''))).toBeNull();
    expect(await resolveFinalizedGuildId(makeGuildIdSupabase('   '))).toBeNull();
    expect(await resolveFinalizedGuildId(makeGuildIdSupabase(null, { error: { code: 'PGRST301' } }))).toBeNull();
    expect(await resolveFinalizedGuildId(makeGuildIdSupabase(null, { throws: true }))).toBeNull();
  });
});

// ── Transition trigger: credentials saved after an idle wait ──────────────────
// Codex round-4 finding #2: a 'not_started' idle must not be terminal. The
// awaiting-setup watcher polls the gate and fires when a token appears (state
// leaves 'not_started'), so the boot continues in-process.

describe('credentials-saved-after-idle → startAwaitingSetupWatcher (round-4 finding #2)', () => {
  let startAwaitingSetupWatcher: typeof import('../services/setup-completion-watcher.js')['startAwaitingSetupWatcher'];
  const gate = vi.fn();

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    gate.mockReset();
    vi.doMock('../services/setup-gate.js', () => ({
      evaluateSetupGate: (...a: unknown[]) => gate(...a),
    }));
    ({ startAwaitingSetupWatcher } = await import('../services/setup-completion-watcher.js'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock('../services/setup-gate.js');
  });

  const supabase = {} as any;

  it('does NOT fire while still not_started (idle keeps waiting)', async () => {
    gate.mockResolvedValue({ state: 'not_started' });
    const onCredentials = vi.fn();
    const w = startAwaitingSetupWatcher(supabase, onCredentials, { pollMs: 1000 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(gate).toHaveBeenCalled();
    expect(onCredentials).not.toHaveBeenCalled();
    w.stop();
  });

  it('fires once when a token arrives and the state becomes in_progress', async () => {
    gate
      .mockResolvedValueOnce({ state: 'not_started' })
      .mockResolvedValue({ state: 'in_progress', completionConfirmed: false });
    const onCredentials = vi.fn().mockResolvedValue(undefined);
    startAwaitingSetupWatcher(supabase, onCredentials, { pollMs: 1000 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(onCredentials).toHaveBeenCalledTimes(1);
  });

  it('fires when the state becomes complete (env/finalized creds appear)', async () => {
    gate
      .mockResolvedValueOnce({ state: 'not_started' })
      .mockResolvedValue({ state: 'complete', completionConfirmed: true });
    const onCredentials = vi.fn().mockResolvedValue(undefined);
    startAwaitingSetupWatcher(supabase, onCredentials, { pollMs: 1000 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(onCredentials).toHaveBeenCalledTimes(1);
  });

  it('fires the continuation at most once and stops polling afterwards', async () => {
    gate.mockResolvedValue({ state: 'in_progress' });
    const onCredentials = vi.fn().mockResolvedValue(undefined);
    startAwaitingSetupWatcher(supabase, onCredentials, { pollMs: 1000 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onCredentials).toHaveBeenCalledTimes(1);
    const callsAtFire = gate.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(gate.mock.calls.length).toBe(callsAtFire);
  });

  it('does not fire after stop() even if a poll was in flight', async () => {
    let release!: (v: unknown) => void;
    gate.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    const onCredentials = vi.fn().mockResolvedValue(undefined);
    const w = startAwaitingSetupWatcher(supabase, onCredentials, { pollMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(gate).toHaveBeenCalledTimes(1);
    w.stop();
    release({ state: 'in_progress' });
    await vi.advanceTimersByTimeAsync(0);
    expect(onCredentials).not.toHaveBeenCalled();
  });

  it('keeps polling when a gate evaluation throws (transient)', async () => {
    gate
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue({ state: 'in_progress' });
    const onCredentials = vi.fn().mockResolvedValue(undefined);
    startAwaitingSetupWatcher(supabase, onCredentials, { pollMs: 1000 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(onCredentials).toHaveBeenCalledTimes(1);
  });
});
