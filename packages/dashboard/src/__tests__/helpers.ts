/**
 * Shared test utilities for dashboard API tests.
 */
import { vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

function createQueryChain() {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    neq: vi.fn().mockReturnThis(),
    gt: vi.fn().mockReturnThis(),
    lt: vi.fn().mockReturnThis(),
    gte: vi.fn().mockReturnThis(),
    lte: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: null }),
    single: vi.fn().mockResolvedValue({ data: null }),
    insert: vi.fn().mockResolvedValue({ error: null }),
    update: vi.fn().mockReturnThis(),
    upsert: vi.fn().mockResolvedValue({ error: null }),
    delete: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    range: vi.fn().mockReturnThis(),
    match: vi.fn().mockReturnThis(),
    then: undefined as unknown as ReturnType<typeof vi.fn>,
  };
  // Remove undefined entries
  delete (chain as Record<string, unknown>).then;
  return chain;
}

export function createMockSupabase() {
  const _query = createQueryChain();
  const _tables: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {};

  const mock = {
    from: vi.fn().mockImplementation((table: string) => {
      return _tables[table] ?? _query;
    }),
    rpc: vi.fn(),
    auth: { getUser: vi.fn(), getSession: vi.fn() },
    _query,
    _tables,
  };
  return mock;
}

export function registerTable(mock: ReturnType<typeof createMockSupabase>, table: string) {
  const chain = createQueryChain();
  mock._tables[table] = chain;
  return chain;
}

export function buildRequest(
  path: string,
  opts: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    searchParams?: Record<string, string>;
  } = {},
): NextRequest {
  let url = `http://localhost${path}`;
  if (opts.searchParams) {
    const sp = new URLSearchParams(opts.searchParams);
    url += `?${sp.toString()}`;
  }
  return new NextRequest(url, {
    method: opts.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': '1.2.3.4',
      ...(opts.headers ?? {}),
    },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
}

/**
 * Mock `checkAdminRateLimit` to pass (return null = not rate limited).
 */
export function mockRateLimitPass(fn: ReturnType<typeof vi.fn>) {
  fn.mockResolvedValue(null);
}

/**
 * Mock `checkAdminRateLimit` to reject with 429.
 */
export function mockRateLimited(fn: ReturnType<typeof vi.fn>) {
  fn.mockResolvedValue(
    NextResponse.json(
      { error: 'Too many requests', retryAfterMs: 60000 },
      { status: 429, headers: { 'Retry-After': '60', 'X-RateLimit-Remaining': '0' } },
    ),
  );
}

/**
 * Mock `requireGuildOwner` to return success with a default guild context.
 */
export function mockAuthSuccess(fn: ReturnType<typeof vi.fn>, ctx?: { userId?: string; discordId?: string; guildId?: string }) {
  fn.mockResolvedValue({
    ok: true,
    ctx: {
      userId: ctx?.userId ?? 'user-1',
      discordId: ctx?.discordId ?? '123456789',
      guildId: ctx?.guildId ?? 'guild-1',
    },
  });
}

/**
 * Mock `requireGuildOwner` to return 401 Unauthorized.
 */
export function mockAuthUnauthorized(fn: ReturnType<typeof vi.fn>) {
  fn.mockResolvedValue({
    ok: false,
    response: NextResponse.json(
      { error: 'Unauthorized — no valid session' },
      { status: 401 },
    ),
  });
}
