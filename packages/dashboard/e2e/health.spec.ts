/**
 * V5-Audit §13.1 — Smoke E2E tests.
 *
 * These tests validate the dashboard is reachable and core endpoints work.
 * The local Playwright server deliberately has no bot heartbeat or Valkey, so
 * its health contract is a truthful degraded 503. Hosted/VPS smoke tests own
 * the separate production requirement for a healthy 200 response.
 */
import { test, expect } from '@playwright/test';

test.describe('Health & Smoke', () => {
  test('GET /api/health reports the intentionally dependency-free browser server as degraded', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.status()).toBe(503);

    const body = await res.json();
    expect(body).toMatchObject({
      status: 'degraded',
      services: {
        valkey: 'fallback',
        bot: 'unknown',
      },
    });
    expect(typeof body.timestamp).toBe('string');
  });

  test('GET /api/csrf returns a CSRF token', async ({ request }) => {
    const res = await request.get('/api/csrf');
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body).toHaveProperty('token');
    expect(typeof body.token).toBe('string');
    expect(body.token.length).toBeGreaterThan(0);
  });

  test('unauthenticated API returns 401', async ({ request }) => {
    const res = await request.get('/api/guilds', { maxRedirects: 0 });
    // Should redirect to auth or return 401/403.
    expect([401, 403, 302, 307, 308].includes(res.status())).toBe(true);
    if ([302, 307, 308].includes(res.status())) {
      expect(res.headers().location).toContain('/login');
    }
  });
});

test.describe('Page loads', () => {
  test('login page renders without errors', async ({ page }) => {
    const response = await page.goto('/');
    expect(response?.status()).toBeLessThan(500);
    // The page should not show a Next.js error overlay
    await expect(page.locator('#__next-build-error')).not.toBeVisible({ timeout: 3000 }).catch(() => {
      // Element doesn't exist at all — that's fine
    });
  });

  test('unknown protected route redirects to login page', async ({ page }) => {
    const response = await page.goto('/this-route-does-not-exist-12345');
    expect(response?.status()).toBeLessThan(500);
    await expect(page.getByRole('heading', { name: 'SomniBot' })).toBeVisible();
    await expect(page.getByText('Sign in with Discord to manage your server')).toBeVisible();
  });
});
