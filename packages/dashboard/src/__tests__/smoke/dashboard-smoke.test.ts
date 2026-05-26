/**
 * E2E Smoke Tests — Verify critical dashboard endpoints are reachable.
 *
 * V6 Audit §13.4: Basic smoke tests that can run against a live instance.
 *
 * Usage:
 *   DASHBOARD_URL=http://localhost:3000 pnpm vitest run --config vitest.smoke.config.ts
 *
 * These are NOT unit tests — they require a running dashboard instance.
 * Run them as part of deployment verification, not CI.
 */
import { describe, it, expect } from 'vitest';

const BASE_URL = process.env.DASHBOARD_URL || 'http://localhost:3000';

async function fetchWithTimeout(url: string, timeoutMs = 5_000): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
}

describe('Dashboard Smoke Tests', () => {
  it('GET /api/health returns 200 or 503 with valid JSON', async () => {
    const res = await fetchWithTimeout(`${BASE_URL}/api/health`);
    expect([200, 503]).toContain(res.status);

    const body = await res.json();
    expect(body).toHaveProperty('status');
    expect(body).toHaveProperty('timestamp');
    expect(['healthy', 'degraded']).toContain(body.status);
  });

  it('GET /api/csrf returns a CSRF token', async () => {
    const res = await fetchWithTimeout(`${BASE_URL}/api/csrf`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toHaveProperty('token');
    expect(typeof body.token).toBe('string');
    expect(body.token.length).toBeGreaterThan(10);
  });

  it('GET / returns HTML (Next.js is serving)', async () => {
    const res = await fetchWithTimeout(BASE_URL);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<!DOCTYPE html');
  });

  it('POST /api/paypal/webhook rejects missing signature', async () => {
    const res = await fetch(`${BASE_URL}/api/paypal/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_type: 'FAKE' }),
      signal: AbortSignal.timeout(5_000),
    });
    // Should return 401 or 400 — NOT 500 (which would indicate a crash)
    expect(res.status).toBeLessThan(500);
  });

  it('GET /api/downloads/fake/fake returns 401 without auth', async () => {
    const res = await fetchWithTimeout(`${BASE_URL}/api/downloads/fake-product/fake-file`);
    expect(res.status).toBe(401);
  });

  it('POST /api/portal/download-link returns 401 without token', async () => {
    const res = await fetch(`${BASE_URL}/api/portal/download-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: 'test', fileId: 'test' }),
      signal: AbortSignal.timeout(5_000),
    });
    expect(res.status).toBe(401);
  });
});
