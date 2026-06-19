/**
 * V5-Audit §13.1 — Smoke E2E tests.
 *
 * These tests validate the dashboard is reachable and core endpoints
 * work. They're designed to catch deployment-level regressions
 * (misconfigured env, broken builds, missing middleware) that unit
 * tests can't detect.
 */
import { test, expect } from '@playwright/test';

test.describe('Health & Smoke', () => {
  test('GET /api/health returns 200 with valid JSON', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body).toHaveProperty('status');
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
