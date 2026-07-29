/**
 * Admin API Rate Limiting
 *
 * V17 Behavioral Audit — Item 8
 *
 * Rate-limits dashboard admin API endpoints to prevent abuse.
 * Uses the existing checkRateLimit infrastructure (Valkey + memory fallback).
 */

import { NextResponse } from 'next/server';
import { checkRateLimit } from './rate-limit';
import { getClientIp } from './client-ip';

/**
 * Pre-configured admin rate limit presets.
 *
 * "standard" — 60 requests/minute (most dashboard endpoints)
 * "write"    — 30 requests/minute (config changes, creates, deletes)
 * "bulk"     — 10 requests/minute (bulk operations, deploys)
 */
type RateLimitPreset = 'standard' | 'write' | 'bulk';

const PRESETS: Record<RateLimitPreset, { maxHits: number; windowMs: number }> = {
  standard: { maxHits: 60, windowMs: 60_000 },
  write: { maxHits: 30, windowMs: 60_000 },
  bulk: { maxHits: 10, windowMs: 60_000 },
};

/**
 * Check admin rate limit for an API route.
 * Returns null if allowed, or a NextResponse if rate-limited.
 *
 * Usage in a route handler:
 *   const limited = await checkAdminRateLimit(request, 'write');
 *   if (limited) return limited;
 */
export async function checkAdminRateLimit(
  request: Request,
  preset: RateLimitPreset = 'standard',
  routeKey?: string,
): Promise<NextResponse | null> {
  // This module used to carry its own copy of the derivation, reading index 0
  // of X-Forwarded-For — the value the CLIENT supplied — and falling back to a
  // client-suppliable `x-real-ip`. Because this function guards EVERY admin
  // route, that one duplicate made the entire admin surface's rate limiting
  // bypassable by rotating a single header. There is now exactly one definition
  // of "the client's address" in the dashboard.
  const ip = getClientIp(request);
  const route = routeKey ?? new URL(request.url).pathname;
  const key = `admin:${route}:${ip}`;

  const { maxHits, windowMs } = PRESETS[preset];
  const result = await checkRateLimit(key, maxHits, windowMs);

  if (result.limited) {
    return NextResponse.json(
      {
        error: 'Too many requests',
        retryAfterMs: result.retryAfterMs,
      },
      {
        status: 429,
        headers: {
          'Retry-After': String(Math.ceil(result.retryAfterMs / 1000)),
          'X-RateLimit-Remaining': '0',
        },
      },
    );
  }

  return null;
}
