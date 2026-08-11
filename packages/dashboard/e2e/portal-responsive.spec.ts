import { expect, test } from '@playwright/test';

test.setTimeout(120_000);

for (const session of ['signed out', 'signed in'] as const) {
  for (const viewport of [
    { name: 'mobile', width: 375, height: 812 },
    { name: 'tablet', width: 768, height: 900 },
  ] as const) {
    test(`customer portal navigation reflows without horizontal scrolling on ${viewport.name} while ${session}`, async ({ page }) => {
      if (session === 'signed in') {
        await page.addInitScript(() => localStorage.setItem('portal_token', 'portal-responsive-session'));
        await page.route(/\/api\/portal\/(licenses|orders|downloads)(?:\?.*)?$/, (route) =>
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ success: true, data: [] }),
          }),
        );
      }

      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/portal', { waitUntil: 'domcontentloaded' });

      const expectedHeading = session === 'signed in' ? 'Welcome back' : 'Customer Portal';
      await expect(page.getByRole('heading', { name: expectedHeading })).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Customer portal' })).toBeVisible();
      if (session === 'signed in') {
        await expect(page.getByRole('button', { name: 'Sign Out' })).toBeVisible();
      }

      const dimensions = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));

      expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
    });
  }
}
