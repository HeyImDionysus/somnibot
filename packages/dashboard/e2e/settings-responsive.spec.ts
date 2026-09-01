import { expect, test, type Page, type Route } from '@playwright/test';

type SettingSource = 'env' | 'db' | 'none';

interface SettingsFixture {
  readonly values: Record<string, string>;
  readonly sources: Record<string, SettingSource>;
  readonly statuses: Record<string, 'connected' | 'disconnected' | 'checking' | 'bot-side'>;
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

function createSettingsFixture(): SettingsFixture {
  return {
    values: {
      supabase_url: 'https://example.supabase.co',
      discord_application_id: '222222222222222222',
      discord_guild_id: '333333333333333333',
      paypal_client_id: 'paypal-environment-client',
      paypal_webhook_url: 'https://example.test/api/paypal/webhook',
      paypal_sandbox: 'true',
      lavalink_host: 'lavalink',
      lavalink_port: '2333',
    },
    sources: {
      supabase_url: 'env',
      supabase_anon_key: 'env',
      supabase_secret_key: 'env',
      discord_application_id: 'db',
      discord_bot_token: 'db',
      discord_guild_id: 'env',
      discord_client_secret: 'none',
      paypal_client_id: 'env',
      paypal_client_secret: 'env',
      paypal_webhook_id: 'env',
      paypal_webhook_url: 'env',
      paypal_sandbox: 'env',
      lavalink_host: 'env',
      lavalink_port: 'env',
      lavalink_password: 'env',
      valkey_url: 'env',
    },
    statuses: {
      supabase: 'connected',
      discord: 'connected',
      paypal: 'connected',
      lavalink: 'bot-side',
      valkey: 'bot-side',
    },
  };
}

async function installSettingsRoutes(page: Page, fixture = createSettingsFixture()): Promise<void> {
  await page.route('**/api/settings', (route) => fulfillJson(route, fixture));
  await page.route('**/api/guild', (route) => fulfillJson(route, {
    success: true,
    data: { bot_status: 'online', bot_activity_type: 'watching', bot_activity_text: 'the server' },
    guild: { bot_status: 'online', bot_activity_type: 'watching', bot_activity_text: 'the server' },
    config: {},
  }));
  await page.route('**/api/retention', (route) => fulfillJson(route, { retention_days: 180 }));
}

test.describe('Installation connection status', () => {
  test('maps desktop readback to masked connection status and Launcher authority', async ({ page }) => {
    await installSettingsRoutes(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/settings');

    await expect(page.getByText('5 of 5 connection sections configured')).toBeVisible();
    await expect(page.getByText('Connection state is visible here for diagnosis. The SomniBot Launcher is the authoritative place to change installation credentials, deployment, services, updates, and recovery settings.')).toBeVisible();
    await expect(page.getByText('Supabase', { exact: true })).toBeVisible();
    await expect(page.getByText('https://example.supabase.co', { exact: true })).toBeVisible();
    await expect(page.getByText('Saved installation value', { exact: true })).toHaveCount(2);
    await expect(page.getByText('222222222222222222', { exact: true })).toBeVisible();
    await expect(page.getByText('••••••••', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Open the SomniBot Launcher on the machine that owns this installation to change these values.').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save Discord' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Remove saved overrides' })).toHaveCount(0);
  });

  test('shows an actionable unavailable state when authoritative readback fails', async ({ page }) => {
    await page.route('**/api/settings', (route) => fulfillJson(route, { error: 'unavailable' }, 503));
    await page.route('**/api/guild', (route) => fulfillJson(route, { success: true, data: [], guild: {}, config: {} }));
    await page.route('**/api/retention', (route) => fulfillJson(route, { retention_days: 180 }));
    await page.goto('/settings');

    await expect(page.getByRole('heading', { name: 'Connection status unavailable' })).toBeVisible();
    await expect(page.getByText('Connection state is unknown because its authoritative readback could not be loaded. Retry with an installation-operator session. Manage installation connections in the SomniBot Launcher.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  });

  test('keeps masked connection readback within the mobile viewport', async ({ page }) => {
    await installSettingsRoutes(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/settings');

    await expect(page.getByText('5 of 5 connection sections configured')).toBeVisible();
    await expect(page.getByText('PayPal', { exact: true })).toBeVisible();
    await expect(page.getByText('https://example.test/api/paypal/webhook', { exact: true })).toBeVisible();
    await expect(page.getByText('••••••••', { exact: true }).first()).toBeVisible();
    await expect.poll(() => page.evaluate(() => (
      document.documentElement.scrollWidth <= document.documentElement.clientWidth
    ))).toBe(true);
  });
});
