/**
 * Auth & rate-limit mock helpers for dashboard API tests.
 */
import { vi } from 'vitest';
import type { OwnerContext } from '@/lib/api/require-owner';

export const DEFAULT_OWNER_CTX: OwnerContext = {
  userId: 'user-uuid-1',
  discordId: '123456789012345678',
  guildId: 'guild-123',
};

/** Mock requireGuildOwner to return a successful auth context. */
export function mockAuthSuccess(
  requireGuildOwner: ReturnType<typeof vi.fn>,
  ctx: Partial<OwnerContext> = {},
): void {
  requireGuildOwner.mockResolvedValue({
    ok: true,
    ctx: { ...DEFAULT_OWNER_CTX, ...ctx },
  });
}

/** Mock requireGuildOwner to return an unauthorized response. */
export function mockAuthUnauthorized(
  requireGuildOwner: ReturnType<typeof vi.fn>,
): void {
  requireGuildOwner.mockResolvedValue({
    ok: false,
    response: new Response(
      JSON.stringify({ error: 'Unauthorized — no valid session' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    ),
  });
}

/** Mock requireGuildOwner to return a forbidden response. */
export function mockAuthForbidden(
  requireGuildOwner: ReturnType<typeof vi.fn>,
): void {
  requireGuildOwner.mockResolvedValue({
    ok: false,
    response: new Response(
      JSON.stringify({ error: 'Forbidden — you are not the guild owner' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    ),
  });
}

/** Mock checkAdminRateLimit to return a 429 response. */
export function mockRateLimited(
  checkAdminRateLimit: ReturnType<typeof vi.fn>,
): void {
  checkAdminRateLimit.mockResolvedValue(
    new Response(
      JSON.stringify({ error: 'Too many requests' }),
      { status: 429, headers: { 'Content-Type': 'application/json' } },
    ),
  );
}

/** Mock checkAdminRateLimit to pass (no rate limit). */
export function mockRateLimitPass(
  checkAdminRateLimit: ReturnType<typeof vi.fn>,
): void {
  checkAdminRateLimit.mockResolvedValue(null);
}
