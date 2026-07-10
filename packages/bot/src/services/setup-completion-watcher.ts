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
  let timer: ReturnType<typeof setInterval> | null = null;

  const stop = (): void => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  timer = setInterval(async () => {
    if (fired) return;
    let gate;
    try {
      gate = await evaluateSetupGate(supabase);
    } catch (err) {
      log.warn('Setup-completion check failed (will retry)', { error: String(err) });
      return;
    }
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
