/**
 * Shared test utilities for dashboard API tests.
 */
import { vi } from 'vitest';

export function createMockSupabase() {
  const mock = {
    from: vi.fn(),
    auth: { getUser: vi.fn(), getSession: vi.fn() },
  };
  return mock;
}

export function registerTable(mock: ReturnType<typeof createMockSupabase>, _table: string) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    neq: vi.fn().mockReturnThis(),
    gt: vi.fn().mockReturnThis(),
    lt: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: null }),
    single: vi.fn().mockResolvedValue({ data: null }),
    insert: vi.fn().mockResolvedValue({ error: null }),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
  };
  mock.from.mockReturnValue(chain);
  return chain;
}

export function buildRequest(path: string, opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  return new Request(`http://localhost${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': '1.2.3.4',
      ...(opts.headers ?? {}),
    },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
}
