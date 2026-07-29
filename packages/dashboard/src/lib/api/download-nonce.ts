/**
 * Single-Use Download Nonce
 *
 * V5C-5 — Signed download URLs are single-use. Each URL carries a unique
 * nonce that is consumed on first download. Subsequent attempts with the
 * same nonce are rejected.
 *
 * Uses one authoritative Valkey SET-NX key shared across every dashboard
 * replica. If Valkey is unavailable, consumption is unavailable too: silently
 * switching to process-local memory would make an already-consumed nonce fresh
 * again during an outage or recovery.
 */

import {
  consumeSingleUseValkeyKey,
  type SingleUseValkeyResult,
} from './rate-limit';

/**
 * Attempt to consume a download nonce.
 *
 * @param nonce  - The UUID nonce from the signed URL
 * @param expUnix - URL expiry as Unix timestamp (seconds)
 * @returns consumed, replay, or unavailable (never a process-local fallback)
 */
export async function consumeDownloadNonce(
  nonce: string,
  expUnix: number,
): Promise<SingleUseValkeyResult> {
  // Calculate remaining TTL for the nonce (matches the URL expiry).
  // Add a 30s grace period so the nonce outlives the URL.
  const now = Math.floor(Date.now() / 1000);
  const ttlSeconds = Math.max(expUnix - now + 30, 60);
  // Preserve the legacy checkRateLimit key shape so a rolling deployment
  // shares nonce state with an older dashboard replica. The old path applied
  // this prefix internally before INCR; SET NX on the same key treats an old
  // value as consumed, and an old INCR treats the new "1" value as a replay.
  return consumeSingleUseValkeyKey(`ratelimit:download:nonce:${nonce}`, ttlSeconds);
}
