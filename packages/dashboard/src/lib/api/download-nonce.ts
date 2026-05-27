/**
 * Single-Use Download Nonce
 *
 * V5C-5 — Signed download URLs are single-use. Each URL carries a unique
 * nonce that is consumed on first download. Subsequent attempts with the
 * same nonce are rejected.
 *
 * Uses Valkey (via the rate-limit module's raw RESP client) when available.
 * Falls back to an in-memory Set with automatic expiry cleanup.
 */

import { checkRateLimit } from './rate-limit';

// ── In-memory fallback (single-instance only) ──

const usedNonces = new Map<string, number>(); // nonce → expiresAtMs
let lastNonceCleanup = Date.now();

function cleanupNonces(): void {
  const now = Date.now();
  if (now - lastNonceCleanup < 60_000) return; // clean every ~60s
  lastNonceCleanup = now;
  for (const [nonce, expiry] of usedNonces) {
    if (now > expiry) usedNonces.delete(nonce);
  }
}

/**
 * Attempt to consume a download nonce.
 *
 * @param nonce  - The UUID nonce from the signed URL
 * @param expUnix - URL expiry as Unix timestamp (seconds)
 * @returns true if this is the first use (consumed), false if already used
 */
export async function consumeDownloadNonce(nonce: string, expUnix: number): Promise<boolean> {
  // Calculate remaining TTL for the nonce (matches the URL expiry).
  // Add a 30s grace period so the nonce outlives the URL.
  const now = Math.floor(Date.now() / 1000);
  const ttlSeconds = Math.max(expUnix - now + 30, 60);

  // Try Valkey: use the rate-limit module's INCR as a SET-NX equivalent.
  // A nonce that increments to 1 is fresh; anything higher is a replay.
  try {
    const key = `download:nonce:${nonce}`;
    const result = await checkRateLimit(key, 1, ttlSeconds * 1000);
    // If not limited → first use (remaining >= 0 means hit count was 1)
    // If limited → replay (hit count exceeded 1)
    return !result.limited;
  } catch {
    // Valkey unavailable — fall through to memory
  }

  // In-memory fallback
  cleanupNonces();
  if (usedNonces.has(nonce)) return false;
  usedNonces.set(nonce, (expUnix + 30) * 1000);
  return true;
}
