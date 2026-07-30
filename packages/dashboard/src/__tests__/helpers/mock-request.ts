/**
 * NextRequest builder for tests.
 */
import { NextRequest } from 'next/server';

interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  searchParams?: Record<string, string>;
}

/**
 * Build a NextRequest for testing route handlers.
 *
 * Usage:
 *   const req = buildRequest('/api/orders/123/refund', { method: 'POST', body: { reason: 'test' } });
 *   const res = await POST(req, { params: Promise.resolve({ id: '123' }) });
 */
export function buildRequest(path: string, opts: RequestOptions = {}): NextRequest {
  const url = new URL(path, 'http://localhost:3000');

  if (opts.searchParams) {
    for (const [key, value] of Object.entries(opts.searchParams)) {
      url.searchParams.set(key, value);
    }
  }

  const init: RequestInit = {
    method: opts.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': '127.0.0.1',
      ...opts.headers,
    },
  };

  if (opts.body && opts.method !== 'GET') {
    init.body = JSON.stringify(opts.body);
  }

  return new NextRequest(
    url,
    init as ConstructorParameters<typeof NextRequest>[1],
  );
}
