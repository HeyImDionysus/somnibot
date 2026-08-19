import { expect, test, type Page, type Route } from '@playwright/test';

type SettingSource = 'env' | 'db' | 'none';

interface SettingsFixture {
  values: Record<string, string>;
  sources: Record<string, SettingSource>;
  statuses: Record<string, string>;
  lockedFields: string[];
  environmentFallbacks: Record<string, boolean>;
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

function createSettingsFixture(): SettingsFixture {
  return {
    values: {
      supabase_url: 'https://example.supabase.co',
      supabase_anon_key: '••••••••',
      supabase_secret_key: '••••••••',
      discord_application_id: '222222222222222222',
      discord_bot_token: '••••••••',
      discord_guild_id: '333333333333333333',
      discord_client_secret: '••••••••',
      paypal_client_id: 'paypal-environment-client',
      paypal_client_secret: '••••••••',
      paypal_webhook_id: '••••••••',
      paypal_webhook_url: 'https://example.test/api/paypal/webhook',
      paypal_sandbox: 'true',
      lavalink_host: 'lavalink',
      lavalink_port: '2333',
      lavalink_password: '••••••••',
      valkey_url: '••••••••',
    },
    sources: {
      supabase_url: 'env',
      supabase_anon_key: 'env',
      supabase_secret_key: 'env',
      discord_application_id: 'db',
      discord_bot_token: 'db',
      discord_guild_id: 'env',
      discord_client_secret: 'env',
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
    lockedFields: ['supabase_url', 'supabase_anon_key', 'supabase_secret_key'],
    environmentFallbacks: {
      supabase_url: true,
      supabase_anon_key: true,
      supabase_secret_key: true,
      discord_application_id: true,
      discord_bot_token: true,
      discord_guild_id: true,
      discord_client_secret: true,
      paypal_client_id: true,
      paypal_client_secret: true,
      paypal_webhook_id: true,
      paypal_webhook_url: true,
      paypal_sandbox: true,
      lavalink_host: true,
      lavalink_port: true,
      lavalink_password: true,
      valkey_url: true,
    },
  };
}

async function installSettingsRoutes(page: Page) {
  const fixture = createSettingsFixture();
  const writes: Array<{ method: string; body: unknown }> = [];

  await page.route('**/api/settings', async (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      await fulfillJson(route, fixture);
      return;
    }

    const body: unknown = route.request().postDataJSON();
    writes.push({ method, body });
    if (method === 'PUT') {
      const payload = body as { values: Record<string, string> };
      Object.assign(fixture.values, payload.values);
      for (const key of Object.keys(payload.values)) fixture.sources[key] = 'db';
      await fulfillJson(route, {
        ok: true,
        restartRequired: true,
        appliesAfter: 'bot-and-dashboard-restart',
      });
      return;
    }

    if (method === 'DELETE') {
      const payload = body as { keys: string[] };
      for (const key of payload.keys) {
        fixture.sources[key] = 'env';
        if (key === 'discord_application_id') fixture.values[key] = '111111111111111111';
      }
      await fulfillJson(route, {
        ok: true,
        restartRequired: true,
        appliesAfter: 'bot-and-dashboard-restart',
      });
      return;
    }

    await fulfillJson(route, { error: 'Unsupported method' }, 405);
  });
  await page.route('**/api/guild', (route) => fulfillJson(route, {
    success: true,
    data: {
      bot_status: 'online',
      bot_activity_type: 'watching',
      bot_activity_text: 'the server',
    },
    guild: {
      bot_status: 'online',
      bot_activity_type: 'watching',
      bot_activity_text: 'the server',
    },
    config: {},
  }));
  await page.route('**/api/retention', (route) => fulfillJson(route, {
    retention_days: 180,
  }));

  return { fixture, writes };
}

test.describe('Installation settings', () => {
  test.setTimeout(120_000);

  test('saves only changed fields and removes saved overrides', async ({ page }, testInfo) => {
    const { writes } = await installSettingsRoutes(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/settings');

    const applicationId = page.getByLabel('Application ID');
    await expect(applicationId).toBeEnabled();
    await expect(applicationId).toHaveValue('222222222222222222');
    await expect(page.getByLabel('Project URL')).toBeDisabled();
    await expect(page.getByText('Deployment only')).toHaveCount(3);

    await applicationId.fill('444444444444444444');
    await page.getByRole('button', { name: 'Save Discord' }).click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0]).toEqual({
      method: 'PUT',
      body: {
        section: 'discord',
        values: { discord_application_id: '444444444444444444' },
      },
    });
    await expect(applicationId).toHaveValue('444444444444444444');

    await page.getByRole('button', { name: 'Remove saved overrides' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Remove saved overrides?' });
    await expect(dialog).toBeVisible();
    await testInfo.attach('settings-desktop-reset-confirmation', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
    await dialog.getByRole('button', { name: 'Remove saved overrides' }).click();
    await expect.poll(() => writes.length).toBe(2);
    expect(writes[1]).toEqual({
      method: 'DELETE',
      body: {
        section: 'discord',
        keys: ['discord_application_id', 'discord_bot_token'],
      },
    });
    await expect(applicationId).toHaveValue('111111111111111111');
  });

  test('keeps secret editing and connection cards usable at 375px', async ({ page }, testInfo) => {
    await installSettingsRoutes(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/settings');

    const changeButtons = page.getByRole('button', { name: 'Change' });
    await expect(changeButtons.first()).toBeVisible();
    await changeButtons.first().click();
    const secretInput = page.getByLabel('Bot Token');
    await expect(secretInput).toBeFocused();
    await expect(secretInput).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Cancel' }).first()).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await testInfo.attach('settings-mobile-secret-edit', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
    await secretInput.fill('replacement-token');
    await page.getByRole('button', { name: 'Cancel' }).first().click();
    await expect(page.getByRole('button', { name: 'Save Discord' })).toBeDisabled();
  });

  test('removes a saved override even when no deployment fallback exists', async ({ page }) => {
    const { fixture, writes } = await installSettingsRoutes(page);
    fixture.sources.valkey_url = 'db';
    fixture.environmentFallbacks.valkey_url = false;
    await page.goto('/settings');

    await page.getByRole('button', { name: 'Remove saved overrides' }).last().click();
    const dialog = page.getByRole('alertdialog', { name: 'Remove saved overrides?' });
    await dialog.getByRole('button', { name: 'Remove saved overrides' }).click();

    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0]).toEqual({
      method: 'DELETE',
      body: { section: 'valkey', keys: ['valkey_url'] },
    });
  });
});
