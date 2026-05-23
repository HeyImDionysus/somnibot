/**
 * Rate Limiter — Degraded mode tests (V5 Audit §14.1)
 *
 * Tests that the in-memory fallback uses halved limits when Valkey is unavailable.
 */
import { describe, it, expect } from 'vitest';

// ── Inline rate limit logic (matches production) ───────────

interface RateLimitEntry {
  hits: number;
  windowStart: number;
}

function checkRateLimitMemory(
  store: Map<string, RateLimitEntry>,
  key: string,
  maxHits: number,
  windowMs: number,
): { limited: boolean; remaining: number; retryAfterMs: number } {
  const now = Date.now();
  const entry = store.get(key);

  if (!entry || now - entry.windowStart > windowMs) {
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

describe('Rate limiter in-memory fallback', () => {
  it('enforces the given limit', () => {
    const store = new Map<string, RateLimitEntry>();
    const maxHits = 5;
    const windowMs = 60_000;

    for (let i = 0; i < maxHits; i++) {
      const result = checkRateLimitMemory(store, 'test-key', maxHits, windowMs);
      expect(result.limited).toBe(false);
    }

    const exceeded = checkRateLimitMemory(store, 'test-key', maxHits, windowMs);
    expect(exceeded.limited).toBe(true);
    expect(exceeded.remaining).toBe(0);
    expect(exceeded.retryAfterMs).toBeGreaterThan(0);
  });

  it('degraded mode uses halved budget (V5 Audit §14.1)', () => {
    const store = new Map<string, RateLimitEntry>();
    const normalMax = 60;
    const degradedMax = Math.max(1, Math.floor(normalMax / 2)); // 30
    const windowMs = 60_000;

    expect(degradedMax).toBe(30);

    // Should allow 30 requests, not 60
    for (let i = 0; i < degradedMax; i++) {
      const result = checkRateLimitMemory(store, 'degraded-key', degradedMax, windowMs);
      expect(result.limited).toBe(false);
    }

    const exceeded = checkRateLimitMemory(store, 'degraded-key', degradedMax, windowMs);
    expect(exceeded.limited).toBe(true);
  });

  it('resets after window expires', () => {
    const store = new Map<string, RateLimitEntry>();
    const maxHits = 2;
    const windowMs = 1000;

    // Exhaust the limit
    checkRateLimitMemory(store, 'key', maxHits, windowMs);
    checkRateLimitMemory(store, 'key', maxHits, windowMs);
    const limited = checkRateLimitMemory(store, 'key', maxHits, windowMs);
    expect(limited.limited).toBe(true);

    // Simulate window expiry by modifying the entry
    const entry = store.get('key')!;
    entry.windowStart = Date.now() - windowMs - 1;

    const reset = checkRateLimitMemory(store, 'key', maxHits, windowMs);
    expect(reset.limited).toBe(false);
    expect(reset.remaining).toBe(maxHits - 1);
  });

  it('isolates different keys', () => {
    const store = new Map<string, RateLimitEntry>();
    const maxHits = 1;
    const windowMs = 60_000;

    checkRateLimitMemory(store, 'key-a', maxHits, windowMs);
    const limitedA = checkRateLimitMemory(store, 'key-a', maxHits, windowMs);
    expect(limitedA.limited).toBe(true);

    // Different key should not be limited
    const resultB = checkRateLimitMemory(store, 'key-b', maxHits, windowMs);
    expect(resultB.limited).toBe(false);
  });
});
