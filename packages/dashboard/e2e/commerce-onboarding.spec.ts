import path from 'node:path';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const product = {
  id: '00000000-0000-4000-8000-000000000123',
  guild_id: 'guild-qa',
  name: 'Creator Pro',
  description: 'Licensed creator software',
  type: 'subscription',
  delivery_type: 'license_key',
  paypal_product_id: 'PROD-SANDBOX-123',
  price_cents: 1900,
  currency: 'USD',
  granted_role_ids: [],
  granted_channel_ids: [],
  active: false,
  sort_order: 0,
  metadata: {},
  created_at: '2026-08-10T12:00:00.000Z',
  updated_at: '2026-08-10T12:00:00.000Z',
  plans: [{
    id: '00000000-0000-4000-8000-000000000456',
    product_id: '00000000-0000-4000-8000-000000000123',
    name: 'Monthly Pro',
    paypal_plan_id: 'PLAN-SANDBOX-456',
    interval_unit: 'MONTH',
    interval_count: 1,
    price_cents: 1900,
    currency: 'USD',
    trial_days: 14,
    active: true,
  }],
  product_license_config: [{
    product_id: '00000000-0000-4000-8000-000000000123',
    license_mode: 'portal_only',
    key_prefix: 'SMNI',
    max_devices: 3,
    heartbeat_interval_seconds: 300,
    sdk_cache_ttl_ms: 60000,
    offline_grace_period_seconds: 86400,
    feature_flags: [],
    require_discord_guild_membership: true,
    store_keys_hashed: true,
    rotation_policy: 'rotate-and-invalidate',
    self_service_device_removal: true,
  }],
};

test('creator completes sandbox product onboarding without source-reading', async ({ page }) => {
  let created = false;
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/store/products') {
      if (request.method() === 'POST') {
        const submitted = request.postDataJSON();
        expect(submitted.active).toBe(false);
        expect(submitted.plans).toEqual([expect.objectContaining({
          name: 'Monthly Pro',
          interval_unit: 'MONTH',
          interval_count: 1,
          price_cents: 1900,
          trial_days: 14,
          active: true,
        })]);
        created = true;
        await route.fulfill({ json: { success: true, data: product, paypal_synced: true, plans_created: 1 } });
        return;
      }
      await route.fulfill({ json: { success: true, data: created ? [product] : [] } });
      return;
    }
    if (pathname.startsWith('/api/license/config/')) {
      await route.fulfill({ json: { success: true, data: product.product_license_config[0] } });
      return;
    }
    if (pathname === '/api/store/onboarding') {
      await route.fulfill({ json: { success: true, data: {
        environment: 'sandbox',
        apiBase: 'http://localhost:3013/api',
        credentialsConfigured: true,
        webhookIdConfigured: true,
        webhookUrl: 'https://dashboard.example.com/api/paypal/webhook',
        webhookUrlReady: true,
        lastWebhook: { result: 'success', processedAt: '2026-08-10T12:00:00.000Z', eventType: 'PAYMENT.CAPTURE.COMPLETED' },
        checkedAt: '2026-08-10T12:05:00.000Z',
      } } });
      return;
    }
    if (pathname === '/api/store/control-room') {
      await route.fulfill({ json: { success: true, data: { summary: { paid: 0, licensed: 0, downloaded: 0, activated: 0, stuck: 0 }, customers: [], sampledOrders: 0, totalOrders: 0 } } });
      return;
    }
    if (pathname === '/api/guild') {
      await route.fulfill({ json: { success: true, config: { store_enabled: true, paypal_enabled: true, paypal_environment: 'sandbox', grace_period_days: 3 } } });
      return;
    }
    if (pathname === '/api/roles' || pathname === '/api/channels') {
      await route.fulfill({ json: { success: true, data: [] } });
      return;
    }
    await route.fulfill({ json: { success: true, data: [] } });
  });

  await page.goto('/store');
  await expect(page.getByRole('heading', { name: 'Store', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New Product' }).click();
  await page.getByPlaceholder('Product name').fill('Creator Pro');
  await page.getByLabel('Price ($) *').fill('19.00');
  await page.getByLabel('Type').selectOption('subscription');
  const licensingMode = page.getByLabel('Licensing mode');
  await expect(licensingMode.locator('option')).toHaveText(['Dynamic', 'Static']);
  await licensingMode.selectOption('license_key');
  await expect(page.getByText('Product roles (optional)')).toBeVisible();
  await expect(page.getByText('Product channels (optional)')).toBeVisible();
  await page.getByLabel('Plan name').fill('Monthly Pro');
  await page.getByLabel('Price (USD)').fill('19.00');
  await page.getByLabel('Free trial (days)').fill('14');
  await page.getByRole('button', { name: 'Create' }).click();

  await expect(page.getByRole('heading', { name: 'Integrate Creator Pro' })).toBeVisible();
  await expect(page.getByText('PROD-SANDBOX-123')).toBeVisible();
  await expect(page.getByText('PLAN-SANDBOX-456')).toBeVisible();
  await expect(page.getByText('does not mint an administrator test key', { exact: false })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open Prompt Generator' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open Prompt Generator' })).toHaveAttribute('href', `/project-licensing?productId=${product.id}`);
  await expect(page.getByRole('button', { name: 'Copy licensing addendum' })).toHaveCount(0);
  const integrationPanel = page.locator('section[aria-labelledby="integration-heading"]');
  const paypalPolicyPanel = page.locator('section[aria-labelledby="paypal-processing-policy-heading"]');

  const evidence = process.env.COMMERCE_EVIDENCE_DIR
    ?? path.resolve(process.cwd(), '../../.omo/evidence/dashboard-commerce-self-service/visual');
  await mkdir(evidence, { recursive: true });
  await integrationPanel.scrollIntoViewIfNeeded();
  await writeFile(
    path.join(evidence, 'store-onboarding-desktop.png'),
    await page.screenshot(),
  );

  await page.getByLabel('Environment').selectOption('live');
  const savePolicy = page.getByRole('button', { name: 'Save PayPal policy' });
  await expect(savePolicy).toBeDisabled();
  await page.getByText('I confirm this switches checkout to Live PayPal', { exact: false }).click();
  await expect(savePolicy).toBeEnabled();
  await paypalPolicyPanel.scrollIntoViewIfNeeded();
  await writeFile(
    path.join(evidence, 'store-live-gate-desktop.png'),
    await page.screenshot(),
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: 'Integrate Creator Pro' })).toBeVisible();
  await integrationPanel.scrollIntoViewIfNeeded();
  await page.locator('#main-content').evaluate((element) => element.scrollBy(0, -180));
  await writeFile(
    path.join(evidence, 'store-onboarding-mobile.png'),
    await page.screenshot(),
  );
  await expect(stat(path.join(evidence, 'store-onboarding-desktop.png')).then((file) => file.size)).resolves.toBeGreaterThan(0);
  await expect(stat(path.join(evidence, 'store-live-gate-desktop.png')).then((file) => file.size)).resolves.toBeGreaterThan(0);
  await expect(stat(path.join(evidence, 'store-onboarding-mobile.png')).then((file) => file.size)).resolves.toBeGreaterThan(0);
});
