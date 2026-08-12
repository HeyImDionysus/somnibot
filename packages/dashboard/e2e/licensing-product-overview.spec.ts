import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test('licensing reads back both Static and Dynamic Store products', async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/store/products') {
      await route.fulfill({ json: { success: true, data: [
        {
          id: 'safe-paste',
          name: 'SafePaste',
          type: 'one_time',
          delivery_type: 'license_key',
          active: true,
          granted_role_ids: [],
          granted_channel_ids: [],
          plans: [],
          product_files: [],
          product_license_config: [{ max_devices: 2, heartbeat_interval_seconds: 300, offline_grace_period_seconds: 86400 }],
        },
        {
          id: 'creator-assets',
          name: 'Creator Assets',
          type: 'subscription',
          delivery_type: 'file',
          active: true,
          granted_role_ids: ['buyer-role'],
          granted_channel_ids: ['private-channel'],
          plans: [{ id: 'monthly-plan', active: true }],
          product_files: [{ id: 'master-archive' }],
          product_license_config: [],
        },
      ] } });
      return;
    }
    if (pathname === '/api/license/health') {
      await route.fulfill({ json: { success: true, data: { state: 'empty' } } });
      return;
    }
    await route.fulfill({ json: { success: true, data: [] } });
  });

  await page.goto('/licenses');
  await expect(page.getByRole('heading', { name: 'Licensing', exact: true })).toBeVisible();
  const overview = page.locator('section[aria-labelledby="product-licensing-heading"]');
  await expect(overview.getByText('SafePaste')).toBeVisible();
  await expect(overview.getByText('Creator Assets')).toBeVisible();
  await expect(overview.getByText(/^dynamic$/i)).toBeVisible();
  await expect(overview.getByText(/^static$/i)).toBeVisible();
  await expect(overview.getByText('2 Discord benefit(s)')).toBeVisible();
  await expect(overview.getByText('1 protected master file(s)', { exact: false })).toBeVisible();

  const evidence = process.env.LICENSING_PROMPT_EVIDENCE_DIR
    ?? path.resolve(process.cwd(), '../../.omo/evidence/project-licensing/visual');
  await mkdir(evidence, { recursive: true });
  for (const viewport of [
    { width: 1280, height: 900, name: 'desktop' },
    { width: 375, height: 812, name: 'mobile' },
  ]) {
    await page.setViewportSize(viewport);
    await page.locator('#main-content').evaluate((element) => element.scrollTo({ top: 0 }));
    await expect(page.getByRole('heading', { name: 'Licensing', exact: true })).toBeInViewport();
    const overflow = await page.locator('#main-content').evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
    await writeFile(path.join(evidence, `licensing-overview-${viewport.name}.png`), await page.screenshot());
  }
});
