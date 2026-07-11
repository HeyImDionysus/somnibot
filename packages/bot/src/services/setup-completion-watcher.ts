/**
 * Setup-Completion Watcher (Wave 3 setup gate)
 *
 * When the bot boots in setup-verification mode (`in_progress`), the desktop
 * launcher does NOT restart it when the dashboard writes `setup_completed_at`,
 * and the setup page only advances to its "done" step. Without a watcher the
 * owner finishes setup but the bot stays gated (no GuildRouter features,
 * commands, presence, diagnostics) until a manual restart.
 *
 * This watcher polls the setup gate; once it reports a CONFIRMED 'complete'
 * (an actual setup_completed_at row, not the read-failure fallback), it invokes
 * the supplied `onComplete` transition exactly once so the SAME process can tear
 * down the verification-only services and run the full boot in-place. A
 * transient read error that merely *looks* complete (token present) must not
 * fire the transition — see the completionConfirmed check below.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '@somnibot/shared';
import { evaluateSetupGate } from './setup-gate.js';

const log = createLogger('SetupWatch');

/** Default cadence for polling the setup gate while in verification mode. */
export const SETUP_COMPLETION_POLL_MS = 15_000;

export interface SetupCompletionWatcher {
  /** Stop polling (idempotent). Called on transition and on shutdown. */
  stop(): void;
}

/**
 * Start polling the setup gate. When it reports 'complete', stop polling and
 * invoke `onComplete` once. Returns a handle so the caller can stop the poller
 * during graceful shutdown.
 *
 * `onComplete` is fired at most once; a throwing/rejecting `onComplete` is
 * logged and does not restart the poller (the transition either succeeded or
 * will be retried on the next process start).
 */
export function startSetupCompletionWatcher(
  supabase: SupabaseClient,
  onComplete: () => void | Promise<void>,
  opts: { pollMs?: number } = {},
): SetupCompletionWatcher {
  const pollMs = opts.pollMs ?? SETUP_COMPLETION_POLL_MS;
  let fired = false;
  // Once stop() is called the watcher stays stopped for good: clearing the
  // interval only prevents FUTURE ticks, but a tick already suspended inside
  // `await evaluateSetupGate` can still resume afterwards. This flag lets that
  // in-flight callback bail after the await so a stopped/replaced watcher never
  // fires onComplete (e.g. after shutdown, or after another watcher took over).
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stop = (): void => {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  timer = setInterval(async () => {
    // Guard BEFORE the await: skip if already fired or stopped, so overlapping
    // slow polls do not pile up into the async section below.
    if (fired || stopped) return;
    let gate;
    try {
      gate = await evaluateSetupGate(supabase);
    } catch (err) {
      log.warn('Setup-completion check failed (will retry)', { error: String(err) });
      return;
    }
    // Re-check AFTER the await: while this poll was awaiting the gate, stop()
    // may have run (shutdown/replacement) or a concurrent slow poll may have
    // already fired the transition. Either way this callback must not run
    // onComplete a second time or after shutdown — the lifecycle guarantee is
    // "once stopped, stays stopped; onComplete fires at most once".
    if (fired || stopped) return;
    // Only transition on an UNAMBIGUOUS completion. evaluateSetupGate degrades
    // to `state: 'complete'` on a transient read failure when DISCORD_TOKEN is
    // present (so an already-finalized bot still boots on a blip) — but in
    // verification mode the token is always present by design, so a transient
    // read error would otherwise fire the full boot before the owner actually
    // finished setup, re-enabling the noisy feature init this gate suppresses.
    // completionConfirmed is true only when a real setup_completed_at row was
    // read, which is the signal we require here.
    if (gate.state !== 'complete' || !gate.completionConfirmed) return;

    fired = true;
    stop();
    log.info('Setup finalized — transitioning from verification mode to full boot');
    try {
      await onComplete();
    } catch (err) {
      log.error('Full-boot transition failed after setup completion', { error: String(err) });
    }
  }, pollMs);
  timer.unref?.();

  return { stop };
}

/**
 * Watch for Discord CREDENTIALS to arrive while the bot idles in the
 * 'not_started' awaiting-setup state (codex round-4 finding #2).
 *
 * A standalone / process-manager boot started with ONLY Supabase credentials
 * classifies as 'not_started': there is no Discord token to log in with, so the
 * process idles reporting HTTP 200 `awaiting_setup`. The dashboard's
 * verify-discord step later writes `discord_bot_token` to instance_settings —
 * but nothing in-process reloads it, and because health is 200 a supervisor
 * won't restart the bot either, so first-time setup is stuck forever.
 *
 * This watcher polls the gate; the moment it leaves 'not_started' (a token
 * arrived, so the state becomes 'in_progress' or 'complete') it fires
 * `onCredentials` exactly once so the boot sequence can continue in-process —
 * loading config and proceeding into verification/full boot without a manual
 * restart. It shares the completion-watcher's lifecycle guarantees: once
 * stopped it stays stopped, `onCredentials` fires at most once, and an in-flight
 * poll cannot fire after stop().
 */
export function startAwaitingSetupWatcher(
  supabase: SupabaseClient,
  onCredentials: () => void | Promise<void>,
  opts: { pollMs?: number } = {},
): SetupCompletionWatcher {
  const pollMs = opts.pollMs ?? SETUP_COMPLETION_POLL_MS;
  let fired = false;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stop = (): void => {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  timer = setInterval(async () => {
    if (fired || stopped) return;
    let gate;
    try {
      gate = await evaluateSetupGate(supabase);
    } catch (err) {
      log.warn('Awaiting-setup credential check failed (will retry)', { error: String(err) });
      return;
    }
    if (fired || stopped) return;
    // Still no token to log in with — keep waiting. Any non-'not_started' state
    // means a Discord token has appeared (in_progress once the wizard stored it,
    // or complete for an env/finalized deploy), so the process can proceed.
    if (gate.state === 'not_started') return;

    fired = true;
    stop();
    log.info('Discord credentials detected — leaving awaiting-setup idle to continue boot', {
      state: gate.state,
    });
    try {
      await onCredentials();
    } catch (err) {
      log.error('Boot continuation after credentials arrived failed', { error: String(err) });
    }
  }, pollMs);
  timer.unref?.();

  return { stop };
}
