/**
 * In-memory rate limiter for public API endpoints (license validation, etc.).
 *
 * Phase B: Prevents brute-force and abuse on public license endpoints.
 * Uses a sliding window approach with configurable window size and max hits.
 *
 * NOTE: This is per-instance. For multi-instance deployments, use Redis/Valkey.
 * For a single Vercel deployment, this provides good-enough protection.
 */

interface RateLimitEntry {
  hits: number;
  windowStart: number;
}

const store = new Map<string, RateLimitEntry>();

// Cleanup stale entries every 5 minutes
const CLEANUP_INTERVAL = 5 * 60 * 1000;
let lastCleanup = Date.now();

function cleanup(windowMs: number): void {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL) return;
  lastCleanup = now;

  for (const [key, entry] of store) {
    if (now - entry.windowStart > windowMs * 2) {
      store.delete(key);
    }
  }
}

/**
 * Check if a request should be rate-limited.
 *
 * @param key - Unique identifier (e.g., IP address, key hash, or combination)
 * @param maxHits - Maximum requests allowed in the window
 * @param windowMs - Window size in milliseconds
 * @returns { limited: boolean, remaining: number, retryAfterMs: number }
 */
export function checkRateLimit(
  key: string,
  maxHits: number,
  windowMs: number,
): { limited: boolean; remaining: number; retryAfterMs: number } {
  cleanup(windowMs);

  const now = Date.now();
  const entry = store.get(key);

  if (!entry || now - entry.windowStart > windowMs) {
    // New window
    store.set(key, { hits: 1, windowStart: now });
    return { limited: false, remaining: maxHits - 1, retryAfterMs: 0 };
  }

  entry.hits++;

  if (entry.hits > maxHits) {
    const retryAfterMs = windowMs - (now - entry.windowStart);
    return { limited: true, remaining: 0, retryAfterMs };
  }

  return { limited: false, remaining: maxHits - entry.hits, retryAfterMs: 0 };
}

/**
 * Pre-configured rate limits for different endpoint types.
 */
export const rateLimits = {
  /** License validation: 30 requests per minute per IP */
  licenseValidate: (ip: string) =>
    checkRateLimit(`license:validate:${ip}`, 30, 60_000),

  /** License heartbeat: 20 per minute per IP */
  licenseHeartbeat: (ip: string) =>
    checkRateLimit(`license:heartbeat:${ip}`, 20, 60_000),

  /** License deactivation: 10 per minute per IP */
  licenseDeactivate: (ip: string) =>
    checkRateLimit(`license:deactivate:${ip}`, 10, 60_000),

  /** Failed key attempts: 5 per minute per IP (stricter) */
  licenseFailedAttempt: (ip: string) =>
    checkRateLimit(`license:failed:${ip}`, 5, 60_000),

  /** Per-key rate limit: 60 requests per minute per key hash */
  licensePerKey: (keyHash: string) =>
    checkRateLimit(`license:key:${keyHash}`, 60, 60_000),
} as const;
