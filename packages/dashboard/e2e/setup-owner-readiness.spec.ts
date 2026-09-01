import { expect, test } from '@playwright/test';

test.describe('Launcher-owned setup handoff', () => {
  test('directs installation setup to the Launcher without rendering credential controls', async ({ page }) => {
    await page.goto('/setup');

    await expect(page.getByText('Launcher-owned setup', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Continue setup in the SomniBot Launcher' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'This page is read-only' })).toBeVisible();
    await expect(page.getByText('The dashboard does not accept or store setup credentials and cannot run setup or migration actions.')).toBeVisible();
    await expect(page.getByText('Open the SomniBot Launcher on the installation host.')).toBeVisible();
    await expect(page.getByText('Complete the Launcher setup and readiness checks there.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Go to dashboard login' })).toHaveAttribute('href', '/login');
    await expect(page.getByRole('link', { name: 'Server setup' })).toHaveAttribute('href', '/server-setup');
    await expect(page.locator('input, textarea, select, button[type="submit"]')).toHaveCount(0);
  });

  test('keeps the Launcher handoff usable without horizontal overflow on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/setup');

    await expect(page.getByRole('heading', { name: 'Continue setup in the SomniBot Launcher' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Go to dashboard login' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Server setup' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => (
      document.documentElement.scrollWidth <= document.documentElement.clientWidth
    ))).toBe(true);
  });
});
