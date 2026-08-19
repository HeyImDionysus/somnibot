import { expect, test, type Page } from '@playwright/test';
import { extractLicensingPromptEnvelope } from '../src/lib/store/licensing-prompt';
import { LICENSING_STORE_HANDOFF_KEY } from '../src/lib/store/licensing-handoff';

const productId = '00000000-0000-4000-8000-000000000789';

function product(overrides: Record<string, unknown> = {}) {
  return {
    id: productId,
    guild_id: 'guild-qa',
    name: 'Completed Sentinel',
    description: 'An already-completed Rust plugin whose behavior must be preserved.',
    type: 'subscription',
    delivery_type: 'license_key',
    paypal_product_id: 'PROD-SANDBOX-789',
    price_cents: 1200,
    currency: 'USD',
    granted_role_ids: [],
    granted_channel_ids: [],
    active: false,
    sort_order: 0,
    metadata: {},
    created_at: '2026-08-19T12:00:00.000Z',
    updated_at: '2026-08-19T12:00:00.000Z',
    plans: [],
    product_license_config: [{
      product_id: productId,
      license_mode: 'portal_only',
      key_prefix: 'SMNI',
      max_devices: 5,
      heartbeat_interval_seconds: 120,
      sdk_cache_ttl_ms: 60000,
      offline_grace_period_seconds: 7200,
      feature_flags: ['alerts', 'exports'],
      require_discord_guild_membership: true,
      store_keys_hashed: true,
      rotation_policy: 'rotate-and-invalidate',
      self_service_device_removal: true,
    }],
    ...overrides,
  };
}

async function mockStore(page: Page, options: {
  readonly credentialsConfigured?: boolean;
  readonly failPolicyOnce?: boolean;
  readonly onProductPost?: (body: Record<string, unknown>) => void;
  readonly onPolicyPut?: (body: Record<string, unknown>) => void;
}) {
  let created = false;
  let savedProduct = product();
  let policyAttempts = 0;
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/store/products') {
      if (request.method() === 'POST') {
        const body = JSON.parse(request.postData() ?? '{}') as Record<string, unknown>;
        options.onProductPost?.(body);
        created = true;
        savedProduct = product({
          name: body.name,
          description: body.description,
          type: body.type,
          delivery_type: body.delivery_type,
          price_cents: body.price_cents,
          metadata: body.metadata,
          paypal_product_id: body.type === 'free' ? null : 'PROD-SANDBOX-789',
        });
        await route.fulfill({ json: { success: true, data: savedProduct } });
        return;
      }
      await route.fulfill({ json: { success: true, data: created ? [savedProduct] : [] } });
      return;
    }
    if (pathname.startsWith('/api/license/config/')) {
      const body = JSON.parse(request.postData() ?? '{}') as Record<string, unknown>;
      options.onPolicyPut?.(body);
      policyAttempts += 1;
      if (options.failPolicyOnce && policyAttempts === 1) {
        await route.fulfill({ status: 503, json: { success: false, error: 'Temporary policy failure' } });
        return;
      }
      const metadata = savedProduct.metadata && typeof savedProduct.metadata === 'object' && !Array.isArray(savedProduct.metadata)
        ? savedProduct.metadata as Record<string, unknown>
        : {};
      const completedProject = metadata.completed_project_licensing && typeof metadata.completed_project_licensing === 'object' && !Array.isArray(metadata.completed_project_licensing)
        ? metadata.completed_project_licensing as Record<string, unknown>
        : {};
      const existingConfig = savedProduct.product_license_config[0];
      savedProduct = product({
        ...savedProduct,
        metadata: {
          ...metadata,
          completed_project_licensing: { ...completedProject, policyPending: false },
        },
        product_license_config: [{
          ...existingConfig,
          key_prefix: body.key_prefix,
          max_devices: body.max_devices,
          heartbeat_interval_seconds: Number(body.heartbeat_interval_ms) / 1000,
          sdk_cache_ttl_ms: body.sdk_cache_ttl_ms,
          offline_grace_period_seconds: body.offline_grace_period_seconds,
          feature_flags: body.feature_flags,
          require_discord_guild_membership: body.require_discord_guild_membership,
          rotation_policy: body.rotation_policy,
          self_service_device_removal: body.self_service_device_removal,
        }],
      });
      await route.fulfill({ json: { success: true, data: product().product_license_config[0] } });
      return;
    }
    if (pathname === '/api/guild') {
      await route.fulfill({ json: { success: true, config: {
        store_enabled: true,
        paypal_enabled: options.credentialsConfigured ?? true,
        paypal_environment: 'sandbox',
        product_types_enabled: ['downloadable', 'license-key', 'subscription', 'free'],
      } } });
      return;
    }
    if (pathname === '/api/store/onboarding') {
      await route.fulfill({ json: { success: true, data: {
        guildId: 'guild-qa',
        environment: 'sandbox',
        apiBase: 'https://somnibot.example/api',
        credentialsConfigured: options.credentialsConfigured ?? true,
        webhookIdConfigured: options.credentialsConfigured ?? true,
        webhookUrl: 'https://somnibot.example/api/paypal/webhook',
        webhookUrlReady: options.credentialsConfigured ?? true,
        lastWebhook: null,
        checkedAt: '2026-08-19T12:00:00.000Z',
      } } });
      return;
    }
    if (pathname === '/api/store/control-room') {
      await route.fulfill({ json: { success: true, data: { summary: { paid: 0, licensed: 0, downloaded: 0, activated: 0, stuck: 0 }, customers: [], sampledOrders: 0, totalOrders: 0 } } });
      return;
    }
    await route.fulfill({ json: { success: true, data: [] } });
  });
}

async function fillCompletedProject(page: Page) {
  await page.goto('/project-licensing');
  await page.getByLabel('Project name').fill('Completed Sentinel');
  await page.getByLabel('Completed project context').fill('An already-completed Rust plugin whose behavior must be preserved.');
}

test('completed project handoff survives reload and creates an inactive product with exact policy', async ({ page }) => {
  let productPayload: Record<string, unknown> | null = null;
  let policyPayload: Record<string, unknown> | null = null;
  await mockStore(page, {
    onProductPost: (body) => { productPayload = body; },
    onPolicyPut: (body) => { policyPayload = body; },
  });
  await fillCompletedProject(page);
  await page.getByLabel('Billing model').selectOption('multiple');
  await page.getByLabel('Plans and licensed capabilities').fill('Monthly Standard and annual Pro require review.');
  await page.getByLabel('Max installations').fill('5');
  await page.getByLabel('Heartbeat seconds').fill('120');
  await page.getByLabel('Offline grace seconds').fill('7200');
  await page.getByLabel('Structured feature flags').fill('alerts, exports, alerts');
  await page.getByRole('button', { name: 'Use in Store' }).click();

  await expect(page).toHaveURL(/\/store\?licensingHandoff=1$/);
  await expect(page.getByPlaceholder('Product name')).toHaveValue('Completed Sentinel');
  await expect(page.getByLabel('Type')).toHaveValue('subscription');
  await expect(page.getByLabel('Licensing mode')).toHaveValue('license_key');
  await expect(page.getByLabel('Maximum devices')).toHaveValue('5');
  await expect(page.getByLabel('Heartbeat interval (ms)')).toHaveValue('120000');
  await expect(page.getByLabel('Offline grace (seconds)')).toHaveValue('7200');
  await expect(page.getByLabel('SDK feature flags')).toHaveValue('alerts, exports');
  await expect(page.getByText('Plan notes to review:', { exact: true }).locator('..')).toContainText('Monthly Standard and annual Pro');
  await page.reload();
  await expect(page.getByPlaceholder('Product name')).toHaveValue('Completed Sentinel');

  await page.getByLabel('Price ($) *').fill('12.00');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: 'Integrate Completed Sentinel' })).toBeVisible();
  expect(productPayload).toMatchObject({ active: false, type: 'subscription', delivery_type: 'license_key', price_cents: 1200 });
  expect(policyPayload).toMatchObject({
    max_devices: 5,
    heartbeat_interval_ms: 120_000,
    offline_grace_period_seconds: 7200,
    feature_flags: ['alerts', 'exports'],
  });
  expect(await page.evaluate((key) => window.sessionStorage.getItem(key), LICENSING_STORE_HANDOFF_KEY)).toBeNull();

  await page.getByRole('link', { name: 'Open Prompt Generator' }).click();
  await expect(page.getByText('Loaded authoritative Store product Completed Sentinel.')).toBeVisible();
  const prompt = await page.locator('section[aria-labelledby="generated-prompt-heading"] pre').innerText();
  expect(extractLicensingPromptEnvelope(prompt)).toMatchObject({
    project: {
      productId,
      apiBase: 'https://somnibot.example/api',
      context: 'An already-completed Rust plugin whose behavior must be preserved.',
    },
    billing: {
      model: 'subscription',
      plansAndFeatures: 'Monthly Standard and annual Pro require review.',
    },
    dynamicPolicy: {
      maxInstallations: 5,
      heartbeatSeconds: 120,
      offlineGraceSeconds: 7200,
      featureFlags: ['alerts', 'exports'],
    },
  });
});

test('authoritative product loading locks manual edits until the public API readback completes', async ({ page }) => {
  let releaseProducts: (() => void) | null = null;
  const productsReady = new Promise<void>((resolve) => { releaseProducts = resolve; });
  await page.route('**/api/store/onboarding', async (route) => {
    await route.fulfill({ json: { success: true, data: {
      guildId: 'guild-qa',
      apiBase: 'https://public.somnibot.example/api',
    } } });
  });
  await page.route('**/api/store/products', async (route) => {
    await productsReady;
    await route.fulfill({ json: { success: true, data: [product()] } });
  });

  await page.goto(`/project-licensing?productId=${productId}`);
  await expect(page.getByText('Loading the authoritative Store product and public API base…')).toBeVisible();
  await expect(page.getByLabel('Project name')).toBeDisabled();
  releaseProducts?.();
  await expect(page.getByLabel('Project name')).toHaveValue('Completed Sentinel');
  await expect(page.getByText('Loaded authoritative Store product Completed Sentinel.', { exact: false })).toBeVisible();
});

test('undecided billing blocks creation until chosen and explicit cancellation clears the handoff', async ({ page }) => {
  await mockStore(page, {});
  await fillCompletedProject(page);
  await page.getByRole('button', { name: 'Use in Store' }).click();
  await expect(page.getByLabel('Type')).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Create' })).toBeDisabled();
  await page.getByLabel('Type').selectOption('one_time');
  await expect(page.getByRole('button', { name: 'Create' })).toBeEnabled();
  await page.getByRole('button', { name: 'Cancel' }).click();
  expect(await page.evaluate((key) => window.sessionStorage.getItem(key), LICENSING_STORE_HANDOFF_KEY)).toBeNull();
});

test('handoff remains through recoverable policy failure and clears after verified retry', async ({ page }) => {
  let productCreates = 0;
  let recoveredPolicy: Record<string, unknown> | null = null;
  await mockStore(page, {
    failPolicyOnce: true,
    onProductPost: () => { productCreates += 1; },
    onPolicyPut: (body) => { recoveredPolicy = body; },
  });
  await fillCompletedProject(page);
  await page.getByLabel('Billing model').selectOption('one_time');
  await page.getByLabel('Max installations').fill('5');
  await page.getByLabel('Heartbeat seconds').fill('120');
  await page.getByLabel('Offline grace seconds').fill('7200');
  await page.getByLabel('Structured feature flags').fill('alerts, exports');
  await page.getByRole('button', { name: 'Use in Store' }).click();
  await page.getByLabel('Price ($) *').fill('12.00');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByText('Product preserved; setup needs a retry')).toBeVisible();
  expect(await page.evaluate((key) => window.sessionStorage.getItem(key), LICENSING_STORE_HANDOFF_KEY)).not.toBeNull();
  await page.reload();
  await expect(page.getByText('Product preserved; setup needs a retry')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Inactive' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'New Product' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Create' })).toHaveCount(0);
  expect(productCreates).toBe(1);
  await page.getByRole('button', { name: 'Retry license policy' }).click();
  await expect(page.getByText('License policy saved and verified')).toBeVisible();
  expect(await page.evaluate((key) => window.sessionStorage.getItem(key), LICENSING_STORE_HANDOFF_KEY)).toBeNull();
  expect(recoveredPolicy).toMatchObject({
    max_devices: 5,
    heartbeat_interval_ms: 120_000,
    offline_grace_period_seconds: 7200,
    feature_flags: ['alerts', 'exports'],
  });
  expect(productCreates).toBe(1);
});

test('free static handoff needs no PayPal and remains usable without responsive overflow', async ({ page }) => {
  let submitted: Record<string, unknown> | null = null;
  await mockStore(page, {
    credentialsConfigured: false,
    onProductPost: (body) => { submitted = body; },
  });
  await fillCompletedProject(page);
  await page.getByRole('radio', { name: /static/i }).click();
  await page.getByLabel('Billing model').selectOption('free');
  await page.getByLabel('Output formats').fill('PDF and ZIP');
  await page.getByRole('button', { name: 'Use in Store' }).click();
  await expect(page.getByLabel('Type')).toHaveValue('free');
  await expect(page.getByLabel('Price ($) *')).toHaveValue('0.00');
  await expect(page.getByLabel('Price ($) *')).toBeDisabled();
  await expect(page.getByLabel('Licensing mode')).toHaveValue('file');

  for (const viewport of [{ width: 1280, height: 900 }, { width: 375, height: 812 }]) {
    await page.setViewportSize(viewport);
    const widths = await page.locator('#main-content').evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }));
    expect(widths.scroll).toBeLessThanOrEqual(widths.client);
  }
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: 'Integrate Completed Sentinel' })).toBeVisible();
  expect(submitted).toMatchObject({ type: 'free', price_cents: 0, active: false, delivery_type: 'file' });
  await expect(page.getByText('PayPal is not required.')).toBeVisible();
  await page.getByRole('link', { name: 'Open Prompt Generator' }).click();
  await expect(page.getByText('Loaded authoritative Store product Completed Sentinel.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use in Store' })).toBeDisabled();
  const prompt = await page.locator('section[aria-labelledby="generated-prompt-heading"] pre').innerText();
  expect(extractLicensingPromptEnvelope(prompt)).toMatchObject({
    billing: { model: 'free' },
    staticPolicy: { outputFormats: 'PDF and ZIP' },
  });
});
