/**
 * One-shot occurrence fence — "has this exact event already been handled?"
 *
 * Discord re-delivers. A gateway RESUME replays events, an interaction can
 * arrive twice, and a member double-clicking a button produces two identical
 * requests. Anything that pays out, charges, or creates a Discord object has to
 * be able to tell "this is the same occurrence" from "this is a new one".
 *
 * Four separate fences had grown up to answer that, each with different
 * behaviour on failure:
 *
 *   * message-log      — in-memory Map only (lost on restart)
 *   * automod-engine   — Valkey, FAIL-OPEN (a Valkey outage processes twice)
 *   * games-manager    — Valkey, FAIL-SAFE (a Valkey outage refuses the action)
 *   * gathering        — inline Valkey claim, no fallback
 *
 * Those are three incompatible answers to the same question, and which one a
 * feature got was an accident of when it was written. This consolidates them.
 *
 * ── Fail-open vs fail-safe is the caller's decision ───────────────────────
 * It cannot be decided here, because the right answer depends entirely on what
 * happens next:
 *
 *   * Paying coins, granting an item, creating a channel → FAIL-SAFE. Refusing
 *     a legitimate action is an inconvenience; paying twice is a real loss.
 *   * Logging a deleted message, mirroring an audit row → FAIL-OPEN. A
 *     duplicate log line is noise; silently dropping the only record of a
 *     moderation event is worse.
 *
 * So `onUnavailable` is required, not defaulted — a caller must state which
 * kind of operation this is.
 */
import type Valkey from 'iovalkey';
import { createLogger } from '@somnibot/shared';

const log = createLogger('OccurrenceFence');

/** Result of trying to claim an occurrence. */
export type ClaimResult =
  /** This caller owns the occurrence — proceed. */
  | 'claimed'
  /** Already handled — this is a redelivery. Do nothing. */
  | 'replay'
  /**
   * The fence itself is unavailable. Returned only when the caller asked to
   * fail open; fail-safe callers get 'replay' so they decline.
   */
  | 'no-fence';

export interface ClaimOptions {
  /**
   * What to do when the fence cannot be consulted:
   *   'proceed' → 'no-fence' (fail open — duplicate work beats losing the event)
   *   'decline' → 'replay'   (fail safe — refusing beats doing it twice)
   */
  onUnavailable: 'proceed' | 'decline';
  /** How long the claim is remembered. Default 15 minutes. */
  ttlMs?: number;
}

/**
 * Bounded in-process fallback, used when Valkey is unreachable.
 *
 * A restart still loses it — which is precisely why it is a FALLBACK and not
 * the mechanism. It closes the common case (a redelivery seconds later during
 * a brief Valkey blip) without pretending to be durable.
 */
const memoryClaims = new Map<string, number>();
const MAX_MEMORY_CLAIMS = 5_000;

function pruneMemoryClaims(now: number): void {
  for (const [key, expiry] of memoryClaims) {
    if (expiry <= now) memoryClaims.delete(key);
  }
  // Hard cap regardless of expiry, so a Valkey outage under load cannot grow
  // this without bound. Oldest-inserted go first (Map preserves order).
  while (memoryClaims.size > MAX_MEMORY_CLAIMS) {
    const oldest = memoryClaims.keys().next().value;
    if (oldest === undefined) break;
    memoryClaims.delete(oldest);
  }
}

/** Claim in memory. Returns true when THIS caller won the claim. */
function claimInMemory(key: string, ttlMs: number): boolean {
  const now = Date.now();
  pruneMemoryClaims(now);
  const existing = memoryClaims.get(key);
  if (existing !== undefined && existing > now) return false;
  memoryClaims.set(key, now + ttlMs);
  return true;
}

/**
 * Claim an occurrence exactly once.
 *
 * `key` must identify the OCCURRENCE, not the actor — an interaction id, a
 * message id, or a message id plus its edit timestamp. Keying on the member
 * would fence out their next legitimate action.
 */
export async function claimOccurrence(
  valkey: Valkey | null | undefined,
  key: string,
  options: ClaimOptions,
): Promise<ClaimResult> {
  const ttlMs = options.ttlMs ?? 900_000;
  const declineOnFailure = options.onUnavailable === 'decline';

  if (!valkey) {
    // No cache wired at all (unit fixtures, degraded boot). The in-memory
    // fallback still gives single-process protection.
    return claimInMemory(key, ttlMs)
      ? (declineOnFailure ? 'claimed' : 'no-fence')
      : 'replay';
  }

  try {
    // SET NX PX is the whole fence: atomic, self-expiring, and the return value
    // distinguishes "I claimed it" from "someone already had it".
    const result = await valkey.set(key, '1', 'PX', ttlMs, 'NX');
    return result === 'OK' ? 'claimed' : 'replay';
  } catch (err) {
    log.warn('Occurrence fence unavailable', {
      key,
      onUnavailable: options.onUnavailable,
      error: (err as Error)?.message ?? String(err),
    });

    // Valkey is down. Try the in-process fallback first — it catches the common
    // "redelivered a moment later" case even during an outage.
    if (!claimInMemory(key, ttlMs)) return 'replay';

    // Nothing had claimed it. Now the caller's policy decides: a money path
    // declines rather than risk paying twice; a logging path proceeds rather
    // than lose the only record.
    return declineOnFailure ? 'replay' : 'no-fence';
  }
}

/**
 * Release a claim.
 *
 * For callers that claim BEFORE doing work and want a genuine failure to be
 * retryable rather than fenced out for the full TTL.
 */
export async function releaseOccurrence(
  valkey: Valkey | null | undefined,
  key: string,
): Promise<void> {
  memoryClaims.delete(key);
  if (!valkey) return;
  try {
    await valkey.del(key);
  } catch (err) {
    // A stale claim expires on its own; failing to release is not worth
    // surfacing to a caller that is already handling an error.
    log.debug('Could not release occurrence claim', { key, error: String(err) });
  }
}

/** Test-only: drop all in-memory claims. */
export function resetOccurrenceFenceForTests(): void {
  memoryClaims.clear();
}
