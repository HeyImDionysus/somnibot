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

function getClientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0]?.trim() ?? 'unknown';
  }
  return request.headers.get('x-real-ip') ?? 'unknown';
}

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
