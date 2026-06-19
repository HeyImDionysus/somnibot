import { expect, test, type Page } from '@playwright/test';

const READY_STATUS = {
  supabaseConnected: true,
  databaseInitialized: true,
  botOnline: true,
  guildDetected: true,
  guildId: 'guild-123',
  guildName: 'Somni Test Guild',
  dashboardUrl: 'https://somnibot.tailnet.test',
  operatorDashboardUrl: 'http://localhost:3456',
  publicCallbackBaseUrl: 'https://somnibot.tailnet.test',
  paypalWebhookUrl: 'https://somnibot.tailnet.test/api/paypal/webhook',
  paypalWebhookReady: true,
  paypalWebhookError: null,
  publicCallbackRequired: true,
  publicCallbackReady: true,
  publicCallbackError: null,
  discordClientId: '123456789012345678',
  discordCredentialsPresent: true,
  setupCompleted: false,
};

async function mockCsrf(page: Page) {
  await page.route('**/api/csrf', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ token: 'csrf-e2e-token' }),
    });
  });
}

test.describe('Owner setup browser readiness', () => {
  test('walks the regular-local ready path and finalizes with PayPal values', async ({ page }) => {
    const finalizeRequests: unknown[] = [];

    await mockCsrf(page);
    await page.route('**/api/setup', async (route) => {
      const request = route.request();

      if (request.method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(READY_STATUS),
        });
        return;
      }

      expect(request.headers()['x-csrf-token']).toBe('csrf-e2e-token');
      const body = request.postDataJSON();
      finalizeRequests.push(body);
      expect(body).toEqual({
        action: 'finalize',
        credentials: {
          paypal_client_id: 'paypal-client-id',
          paypal_client_secret: 'paypal-client-secret',
          paypal_webhook_id: 'WH-browser-proof',
          paypal_webhook_url: READY_STATUS.paypalWebhookUrl,
          paypal_sandbox: 'true',
        },
      });

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          authConfigured: true,
          authError: null,
          setupLocked: true,
        }),
      });
    });

    await page.goto('/setup');

    await expect(page.getByRole('region', { name: 'Setup readiness' })).toBeVisible();
    await expect(page.getByText('Public callback ready')).toBeVisible();
    await expect(page.getByText('https://somnibot.tailnet.test', { exact: true })).toBeVisible();
    await expect(page.getByText('PayPal webhook URL ready')).toBeVisible();
    await expect(page.getByText(READY_STATUS.paypalWebhookUrl)).toBeVisible();
    await expect(page.getByText('Bot runtime online')).toBeVisible();
    await expect(page.getByText('Somni Test Guild detected')).toBeVisible();

    await expect(page.getByRole('heading', { name: 'Invite Bot to Your Server' })).toBeVisible();
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByRole('heading', { name: 'Connect PayPal' })).toBeVisible();

    await page.getByPlaceholder('AfDP...').fill('paypal-client-id');
    await page.getByPlaceholder('EIAf...').fill('paypal-client-secret');
    await page.getByPlaceholder('WH-...').fill('WH-browser-proof');
    await expect(page.locator('input[type="url"]')).toHaveValue(READY_STATUS.paypalWebhookUrl);

    await page.getByRole('button', { name: /Continue/ }).click();
    await page.getByRole('button', { name: 'Finalize Setup' }).click();

    await expect(page.getByRole('heading', { name: 'SomniBot is Ready!' })).toBeVisible();
    expect(finalizeRequests).toHaveLength(1);
  });

  test('keeps the unsafe public callback wall visible and blocks false finalization', async ({ page }) => {
    await mockCsrf(page);
    await page.route('**/api/setup', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...READY_STATUS,
          botOnline: false,
          guildDetected: true,
          guildId: 'guild-123',
          guildName: 'Somni Test Guild',
          dashboardUrl: 'http://localhost:3456',
          operatorDashboardUrl: 'http://localhost:3456',
          publicCallbackBaseUrl: 'http://localhost:3456',
          paypalWebhookUrl: null,
          paypalWebhookReady: false,
          paypalWebhookError: 'PayPal webhook URL must use HTTPS before it can be marked ready.',
          publicCallbackReady: false,
          publicCallbackError: 'Public callback URL must use HTTPS before setup can finalize.',
        }),
      });
    });

    await page.goto('/setup');

    await expect(page.getByText('Public callback blocked')).toBeVisible();
    await expect(page.getByText('Public callback URL must use HTTPS before setup can finalize.')).toBeVisible();
    await expect(page.getByText('PayPal webhook waiting on callback')).toBeVisible();
    await expect(page.getByText('Bot runtime waiting')).toBeVisible();
    await expect(page.getByText('Somni Test Guild detected')).toBeVisible();

    await expect(page.getByRole('heading', { name: 'Invite Bot to Your Server' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Finalize Setup' })).toBeDisabled();
    await expect(page.getByRole('heading', { name: 'SomniBot is Ready!' })).not.toBeVisible();
  });

  test('updates readiness panel when invite polling detects the guild', async ({ page }) => {
    let statusReads = 0;

    await mockCsrf(page);
    await page.route('**/api/setup', async (route) => {
      const request = route.request();

      if (request.method() === 'GET') {
        statusReads += 1;
        const guildDetected = statusReads > 1;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ...READY_STATUS,
            guildDetected,
            guildId: guildDetected ? 'guild-123' : null,
            guildName: guildDetected ? 'Somni Test Guild' : null,
          }),
        });
        return;
      }

      expect(request.postDataJSON()).toEqual({
        action: 'generate-invite',
        clientId: READY_STATUS.discordClientId,
      });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          inviteUrl: 'https://discord.com/oauth2/authorize?client_id=123456789012345678',
        }),
      });
    });

    await page.goto('/setup');

    await expect(page.getByText('Guild not detected')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Connect PayPal' })).toBeVisible();

    await page.getByRole('button', { name: /Continue/ }).click();
    await expect(page.getByRole('heading', { name: 'Invite Bot to Your Server' })).toBeVisible();

    await page.getByRole('button', { name: 'Invite SomniBot to Discord' }).click();
    await expect(page.getByText('Waiting for bot to join a server...')).toBeVisible();
    await expect(page.getByText('Somni Test Guild detected')).toBeVisible({ timeout: 7_000 });
    await expect(page.getByRole('button', { name: 'Finalize Setup' })).toBeEnabled();
  });
});
