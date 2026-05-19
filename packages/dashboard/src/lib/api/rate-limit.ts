/**
 * Rate limiter for public API endpoints (license validation, etc.).
 *
 * Phase B: Prevents brute-force and abuse on public license endpoints.
 * Uses a sliding window approach with configurable window size and max hits.
 *
 * Uses Valkey/Redis when available (shared state across restarts and instances).
 * Falls back to in-memory store if Valkey is unavailable.
 */

import Valkey from 'iovalkey';

// ── Valkey connection (lazy singleton) ──────────────────────

let valkeyClient: Valkey | null = null;
let valkeyFailed = false;

function getValkey(): Valkey | null {
  if (valkeyFailed) return null;
  if (valkeyClient) return valkeyClient;

  const url = process.env.VALKEY_URL || process.env.REDIS_URL;
  if (!url) {
    valkeyFailed = true;
    return null;
  }

  try {
    valkeyClient = new Valkey(url, {
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      lazyConnect: true,
    });

    valkeyClient.on('error', () => {
      // Silently fall back to in-memory on connection errors
      valkeyFailed = true;
      valkeyClient?.disconnect();
      valkeyClient = null;
    });

    valkeyClient.connect().catch(() => {
      valkeyFailed = true;
      valkeyClient = null;
    });

    return valkeyClient;
  } catch {
    valkeyFailed = true;
    return null;
  }
}

// ── In-memory fallback ──────────────────────────────────────

interface RateLimitEntry {
  hits: number;
  windowStart: number;
}

const memStore = new Map<string, RateLimitEntry>();

const CLEANUP_INTERVAL = 5 * 60 * 1000;
let lastCleanup = Date.now();

function cleanup(windowMs: number): void {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL) return;
  lastCleanup = now;

  for (const [key, entry] of memStore) {
    if (now - entry.windowStart > windowMs * 2) {
      memStore.delete(key);
    }
  }
}

function checkRateLimitMemory(
  key: string,
  maxHits: number,
  windowMs: number,
): { limited: boolean; remaining: number; retryAfterMs: number } {
  cleanup(windowMs);

  const now = Date.now();
  const entry = memStore.get(key);

  if (!entry || now - entry.windowStart > windowMs) {
    memStore.set(key, { hits: 1, windowStart: now });
    return { limited: false, remaining: maxHits - 1, retryAfterMs: 0 };
  }

  entry.hits++;

  if (entry.hits > maxHits) {
    const retryAfterMs = windowMs - (now - entry.windowStart);
    return { limited: true, remaining: 0, retryAfterMs };
  }

  return { limited: false, remaining: maxHits - entry.hits, retryAfterMs: 0 };
}

// ── Valkey-backed check ─────────────────────────────────────

async function checkRateLimitValkey(
  client: Valkey,
  key: string,
  maxHits: number,
  windowMs: number,
): Promise<{ limited: boolean; remaining: number; retryAfterMs: number }> {
  const valkeyKey = `ratelimit:${key}`;
  const windowSec = Math.ceil(windowMs / 1000);

  try {
    const hits = await client.incr(valkeyKey);

    if (hits === 1) {
      // First hit in this window — set expiry
      await client.expire(valkeyKey, windowSec);
    }

    if (hits > maxHits) {
      const ttl = await client.ttl(valkeyKey);
      return { limited: true, remaining: 0, retryAfterMs: ttl > 0 ? ttl * 1000 : windowMs };
    }

    return { limited: false, remaining: maxHits - hits, retryAfterMs: 0 };
  } catch {
    // Valkey error — fall back to memory for this request
    return checkRateLimitMemory(key, maxHits, windowMs);
  }
}

// ── Public API ──────────────────────────────────────────────

/**
 * Check if a request should be rate-limited.
 *
 * @param key - Unique identifier (e.g., IP address, key hash, or combination)
 * @param maxHits - Maximum requests allowed in the window
 * @param windowMs - Window size in milliseconds
 * @returns { limited: boolean, remaining: number, retryAfterMs: number }
 */
export async function checkRateLimit(
  key: string,
  maxHits: number,
  windowMs: number,
): Promise<{ limited: boolean; remaining: number; retryAfterMs: number }> {
  const client = getValkey();
  if (client) {
    return checkRateLimitValkey(client, key, maxHits, windowMs);
  }
  return checkRateLimitMemory(key, maxHits, windowMs);
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
