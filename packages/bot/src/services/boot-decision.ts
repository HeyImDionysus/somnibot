/**
 * Boot Decision Matrix (Wave 3 setup gate — coherent state machine)
 *
 * Codex has flagged the startup/setup-gate logic across several rounds, each a
 * different STARTUP PERMUTATION. Rather than patch individual branches, this
 * module enumerates the COMPLETE boot decision matrix and reduces it to a single
 * pure decision function plus an explicit transition-out contract, so the boot
 * sequence (packages/bot/src/index.ts) is one coherent state machine instead of
 * scattered conditionals.
 *
 * ── The axes ──────────────────────────────────────────────────────────────
 *
 * STARTUP SOURCE (how the process was launched):
 *   - desktop launcher   — forks the bot AFTER collecting Discord creds, syncs
 *                          them to Supabase (raw `discord_bot_token` row), and
 *                          watches health. Never boots 'not_started'.
 *   - standalone / docker / process-manager — env-configured, or started with
 *                          ONLY Supabase creds (token arrives later via the
 *                          dashboard wizard's verify-discord step).
 *   - bare / dev         — `tsx src/index.ts`, usually fully env-configured.
 *
 * CREDENTIAL / SETUP STATE (classified by evaluateSetupGate):
 *   - nothing                         → 'not_started'
 *   - Supabase-only (no token yet)    → 'not_started'
 *   - wizard `discord_bot_token` row, no completion row → 'in_progress'
 *   - token in env, no wizard row, no completion row    → 'complete' (env-configured)
 *   - `setup_completed_at` present    → 'complete' (confirmed)
 *
 * ACTION (how far to boot):
 *   - 'idle_awaiting_setup' — no token to log in with; report a clean
 *                             awaiting-setup health state (HTTP 200) and WAIT.
 *   - 'verification_boot'   — log in just enough for the wizard's bot-online /
 *                             guild-detected checks; SKIP heavy per-guild init.
 *   - 'full_boot'           — normal full feature init.
 *
 * ── The matrix (source × state → action) ────────────────────────────────────
 *
 *   SOURCE            STATE          ACTION               TRANSITION-OUT
 *   ───────────────────────────────────────────────────────────────────────────
 *   any               not_started    idle_awaiting_setup  poll gate; when a token
 *                                                         appears (→ in_progress
 *                                                         or complete) continue
 *                                                         the boot in-process.
 *   launcher/standalone in_progress  verification_boot    completion-watcher: on a
 *                                                         CONFIRMED setup_completed_at
 *                                                         reload finalized config
 *                                                         (incl. guild) → full_boot.
 *   env-configured    complete       full_boot            terminal (running).
 *   launcher/standalone complete     full_boot            terminal (running).
 *   (read-failure     complete*      full_boot            terminal — never gate a
 *    fallback, token                                      possibly-finalized bot on
 *    present)                                             a transient blip.)
 *
 * The KEY INVARIANT the whole matrix must satisfy: every non-terminal action
 * (idle_awaiting_setup, verification_boot) has an explicit transition-out that
 * fires when its blocking condition clears — there is NO terminal idle that
 * never re-checks. `bootActionTransition()` names that transition for each
 * action so the boot sequence wires exactly one watcher per non-terminal state.
 */

import type { SetupGateEvaluation, SetupGateState } from './setup-gate.js';

/** How far the boot sequence should proceed for a given setup state. */
export type BootAction = 'idle_awaiting_setup' | 'verification_boot' | 'full_boot';

/**
 * The transition that unblocks a non-terminal action, or 'none' for a terminal
 * (running) action. Names which watcher the boot sequence must wire.
 */
export type BootTransition =
  /** No transition needed — the bot is (or is becoming) fully running. */
  | 'none'
  /**
   * Poll the gate; when a Discord token appears (state leaves 'not_started'),
   * continue the boot in-process. Wired by startAwaitingSetupWatcher.
   */
  | 'await_credentials'
  /**
   * Poll the gate; on a CONFIRMED completion, reload the finalized config
   * (including the guild id) and run the full boot in-process. Wired by
   * startSetupCompletionWatcher.
   */
  | 'await_completion';

/**
 * Map a setup-gate state to the boot action. Pure and total over the three
 * gate states — the single source of truth for "how far do we boot?".
 *
 *   not_started → idle_awaiting_setup (no token; cannot log in)
 *   in_progress → verification_boot   (login for the wizard; skip heavy init)
 *   complete    → full_boot           (normal feature init)
 */
export function bootActionForState(state: SetupGateState): BootAction {
  switch (state) {
    case 'not_started':
      return 'idle_awaiting_setup';
    case 'in_progress':
      return 'verification_boot';
    case 'complete':
      return 'full_boot';
  }
}

/**
 * The transition-out for a boot action. This is what guarantees no terminal
 * idle: the two non-terminal actions each name the watcher that unblocks them.
 *
 *   idle_awaiting_setup → await_credentials (token arrives → continue boot)
 *   verification_boot    → await_completion  (setup finalized → full boot)
 *   full_boot            → none              (terminal / running)
 */
export function bootActionTransition(action: BootAction): BootTransition {
  switch (action) {
    case 'idle_awaiting_setup':
      return 'await_credentials';
    case 'verification_boot':
      return 'await_completion';
    case 'full_boot':
      return 'none';
  }
}

export interface BootDecision {
  action: BootAction;
  transition: BootTransition;
  /** True when the process should attempt a Discord login now. */
  shouldLogin: boolean;
  /** True when the process should run the heavy per-guild feature init now. */
  shouldRunFullInit: boolean;
}

/**
 * Decide the complete boot behaviour from a setup-gate evaluation: the action,
 * its transition-out, and whether to log in / run full init. Derives everything
 * from the gate state so `index.ts` never re-derives boot semantics inline.
 *
 * `shouldLogin` / `shouldRunFullInit` are cross-checked against the gate's own
 * flags (which come from the same classification) so the two stay consistent.
 */
export function decideBoot(gate: SetupGateEvaluation): BootDecision {
  const action = bootActionForState(gate.state);
  return {
    action,
    transition: bootActionTransition(action),
    shouldLogin: gate.shouldLogin,
    shouldRunFullInit: gate.shouldRunFullInit,
  };
}
