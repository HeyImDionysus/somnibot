import { expect, test, type Page } from '@playwright/test';

const PORTAL_GUILD_ID = 'portal-responsive-guild';

async function seedPortalToken(page: Page, token: string): Promise<void> {
  await page.addInitScript(({ guildId, value }) => {
    sessionStorage.setItem('portal_guild', guildId);
    localStorage.setItem(`portal_token:${guildId}`, value);
  }, { guildId: PORTAL_GUILD_ID, value: token });
  await page.route('**/api/portal/requests', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [] }),
    });
  });
}

test.setTimeout(120_000);

test('customer portal reuses the dashboard session and scopes the token to its guild', async ({ page }) => {
  const guildId = 'guild-session-a';
  let exchangeBody: unknown;
  await page.route('/api/portal/config', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: { discord_application_id: 'discord-app' } }),
  }));
  await page.route('/api/portal/auth', async (route) => {
    exchangeBody = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { token: 'guild-a-token' } }),
    });
  });
  await page.route(/\/api\/portal\/(licenses|orders|downloads)$/, (route) => {
    expect(route.request().headers()['x-portal-token']).toBe('guild-a-token');
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [] }),
    });
  });

  await page.goto(`/portal?guild=${guildId}`);

  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign Out' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Licenses' }))
    .toHaveAttribute('href', `/portal/licenses?guild=${guildId}`);
  expect(exchangeBody).toEqual({ action: 'dashboard_session', guild_id: guildId });
  await expect.poll(() => page.evaluate((id) => localStorage.getItem(`portal_token:${id}`), guildId))
    .toBe('guild-a-token');
});

test('a fresh-tab portal deep link recovers its guild-scoped session', async ({ page }) => {
  const guildId = 'guild-deep-link';
  await page.addInitScript(({ id }) => {
    localStorage.setItem('portal_last_guild', id);
    localStorage.setItem(`portal_token:${id}`, 'deep-link-token');
  }, { id: guildId });
  await page.route('/api/portal/licenses', (route) => {
    expect(route.request().headers()['x-portal-token']).toBe('deep-link-token');
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [] }),
    });
  });

  await page.goto('/portal/licenses');

  await expect(page.getByRole('heading', { name: 'Your Licenses' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Orders' }))
    .toHaveAttribute('href', `/portal/orders?guild=${guildId}`);
});

test('portal sign out stays signed out instead of silently exchanging the dashboard session again', async ({ page }) => {
  const guildId = 'guild-logout';
  await page.addInitScript(({ id }) => {
    if (sessionStorage.getItem('portal_logout_test_seeded')) return;
    sessionStorage.setItem('portal_logout_test_seeded', '1');
    sessionStorage.setItem('portal_guild', id);
    localStorage.setItem(`portal_token:${id}`, 'logout-token');
  }, { id: guildId });
  let exchanges = 0;
  await page.route('/api/portal/config', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: { discord_application_id: 'discord-app' } }),
  }));
  await page.route('/api/portal/auth', (route) => {
    if (route.request().method() === 'DELETE') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true }),
      });
    }
    exchanges += 1;
    return route.fulfill({ status: 500, body: '{}' });
  });
  await page.route(/\/api\/portal\/(licenses|orders|downloads)$/, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, data: [] }),
  }));

  await page.goto(`/portal?guild=${guildId}`);
  await page.getByRole('button', { name: 'Sign Out' }).click();

  await expect(page.getByRole('button', { name: 'Sign in with Discord' })).toBeVisible();
  expect(exchanges).toBe(0);
  await expect.poll(() => page.evaluate((id) => localStorage.getItem(`portal_token:${id}`), guildId))
    .toBeNull();
  await expect.poll(() => page.evaluate(
    (id) => localStorage.getItem(`portal_auto_login_suppressed:${id}`),
    guildId,
  )).toBe('1');
});

test('a stale portal token is replaced once from the existing dashboard session', async ({ page }) => {
  const guildId = 'guild-stale';
  await page.addInitScript(({ id }) => {
    sessionStorage.setItem('portal_guild', id);
    localStorage.setItem(`portal_token:${id}`, 'stale-token');
  }, { id: guildId });
  await page.route('/api/portal/config', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: { discord_application_id: 'discord-app' } }),
  }));
  await page.route('/api/portal/auth', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, data: { token: 'fresh-token' } }),
  }));
  await page.route(/\/api\/portal\/(licenses|orders|downloads)$/, (route) => route.fulfill({
    status: route.request().headers()['x-portal-token'] === 'stale-token' ? 401 : 200,
    contentType: 'application/json',
    body: JSON.stringify(route.request().headers()['x-portal-token'] === 'stale-token'
      ? { error: 'expired' }
      : { success: true, data: [] }),
  }));

  await page.goto(`/portal?guild=${guildId}`);

  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await expect.poll(() => page.evaluate((id) => localStorage.getItem(`portal_token:${id}`), guildId))
    .toBe('fresh-token');
});

test('a dashboard account without a customer record can still use explicit Discord login', async ({ page }) => {
  await page.route('/api/portal/config', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: { discord_application_id: 'discord-app' } }),
  }));
  await page.route('/api/portal/auth', (route) => route.fulfill({
    status: 404,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'No account found' }),
  }));

  await page.goto('/portal?guild=guild-other-customer');

  await expect(page.getByRole('button', { name: 'Sign in with Discord' })).toBeVisible();
});

for (const session of ['signed out', 'signed in'] as const) {
  for (const viewport of [
    { name: 'mobile', width: 375, height: 812 },
    { name: 'tablet', width: 768, height: 900 },
  ] as const) {
    test(`customer portal navigation reflows without horizontal scrolling on ${viewport.name} while ${session}`, async ({ page }) => {
      if (session === 'signed in') {
        await seedPortalToken(page, 'portal-responsive-session');
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

test('subscription cancellation and support requests are reachable and truthful on mobile', async ({ page }, testInfo) => {
  await seedPortalToken(page, 'portal-action-session');
  let requestCount = 0;
  let cancelRequestTiming: unknown;

  await page.route('**/api/portal/orders', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      controls: {
        self_service_cancellation: true,
        cancellation_timing: 'end-of-term',
        refund_requests_enabled: true,
        service_requests_enabled: true,
      },
      data: [{
        id: '11111111-1111-4111-8111-111111111111',
        order_number: 'ORD-1001',
        amount_cents: 100,
        discount_cents: 0,
        currency: 'USD',
        status: 'completed',
        source: 'paypal',
        can_self_service_cancel: true,
        created_at: '2026-08-17T00:00:00.000Z',
        products: { name: 'Final Release Subscription', type: 'subscription' },
        payments: [],
        entitlements: [{
          id: '22222222-2222-4222-8222-222222222222',
          status: 'active',
          type: 'subscription',
          expires_at: '2026-09-17T12:00:00.000Z',
          grace_period_ends_at: null,
          cancelled_at: null,
        }],
      }],
    }),
  }));
  await page.route('**/api/portal/cancel', async (route) => {
    cancelRequestTiming = (await route.request().postDataJSON()).cancellation_timing;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        deduped: false,
        data: {
          status: 'active',
          cancellation_timing: 'end-of-term',
          access_until: '2026-09-17T12:00:00.000Z',
          cancellation_scheduled_at: '2026-08-17T12:00:00.000Z',
        },
      }),
    });
  });
  await page.route('**/api/portal/requests', (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      });
    }
    if (route.request().method() !== 'POST') {
      return route.fallback();
    }

    requestCount += 1;
    return route.fulfill({
      status: requestCount === 1 ? 201 : 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, deduped: requestCount > 1 }),
    });
  });

  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/portal/orders', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Order History' })).toBeVisible();
  await testInfo.attach('orders-mobile-initial', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });

  await page.getByRole('button', { name: 'Cancel renewal' }).click();
  const cancelDialog = page.getByRole('alertdialog');
  await expect(cancelDialog).toContainText('access remains available through Sep 17, 2026');
  await testInfo.attach('orders-mobile-cancel-confirmation', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
  await cancelDialog.getByRole('button', { name: 'Cancel renewal' }).click();
  expect(cancelRequestTiming).toBe('end-of-term');
  await expect(page.getByRole('status')).toContainText('Renewal cancelled');
  await expect(page.getByRole('article').getByText('Renewal cancelled · Access through Sep 17, 2026')).toBeVisible();
  await testInfo.attach('orders-mobile-cancelled', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });

  await page.getByRole('button', { name: 'Request refund' }).click();
  await expect(page.getByLabel('What should the seller know? (optional)')).toBeFocused();
  await page.getByLabel('What should the seller know? (optional)').fill('Please review this test order.');
  await testInfo.attach('orders-mobile-refund-request', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
  await page.getByRole('button', { name: 'Send request' }).click();
  await expect(page.getByRole('status')).toContainText('does not automatically move money');

  await page.getByRole('button', { name: 'Request refund' }).click();
  await page.getByRole('button', { name: 'Send request' }).click();
  await expect(page.getByRole('status')).toContainText('No duplicate was created');
  await testInfo.attach('orders-mobile-request-deduped', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
  expect(requestCount).toBe(2);

  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
});

test('disabled portal controls hide unavailable customer actions', async ({ page }, testInfo) => {
  await seedPortalToken(page, 'portal-policy-session');
  await page.route('**/api/portal/orders', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      controls: {
        self_service_cancellation: false,
        cancellation_timing: 'end-of-term',
        refund_requests_enabled: false,
        service_requests_enabled: false,
      },
      data: [{
        id: '11111111-1111-4111-8111-111111111111',
        order_number: 'ORD-POLICY',
        amount_cents: 100,
        discount_cents: 0,
        currency: 'USD',
        status: 'completed',
        source: 'paypal',
        can_self_service_cancel: true,
        created_at: '2026-08-17T00:00:00.000Z',
        products: { name: 'Policy Controlled Subscription', type: 'subscription' },
        payments: [],
        entitlements: [{
          id: '22222222-2222-4222-8222-222222222222',
          status: 'active',
          type: 'subscription',
          expires_at: '2026-09-17T12:00:00.000Z',
          grace_period_ends_at: null,
          cancelled_at: null,
        }],
      }],
    }),
  }));

  await page.goto('/portal/orders', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('tbody').getByText('Policy Controlled Subscription')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel renewal' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Request refund' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Contact seller' })).toHaveCount(0);
  await testInfo.attach('orders-desktop-disabled-controls', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
});

test('immediate cancellation warns that access ends now', async ({ page }, testInfo) => {
  await seedPortalToken(page, 'portal-immediate-session');
  await page.route('**/api/portal/orders', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      controls: {
        self_service_cancellation: true,
        cancellation_timing: 'immediate',
        refund_requests_enabled: false,
        service_requests_enabled: false,
      },
      data: [{
        id: '11111111-1111-4111-8111-111111111111',
        order_number: 'ORD-IMMEDIATE',
        amount_cents: 100,
        discount_cents: 0,
        currency: 'USD',
        status: 'completed',
        source: 'paypal',
        can_self_service_cancel: true,
        created_at: '2026-08-17T00:00:00.000Z',
        products: { name: 'Immediate Subscription', type: 'subscription' },
        payments: [],
        entitlements: [{
          id: '22222222-2222-4222-8222-222222222222',
          status: 'active',
          type: 'subscription',
          expires_at: '2026-09-17T12:00:00.000Z',
          grace_period_ends_at: null,
          cancelled_at: null,
        }],
      }],
    }),
  }));

  await page.goto('/portal/orders', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Cancel renewal' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('your access ends immediately');
  await expect(dialog).not.toContainText('Sep 17, 2026');
  await testInfo.attach('orders-desktop-immediate-confirmation', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
});

test('a retained cancellation request reconfirms its original timing after policy changes', async ({ page }, testInfo) => {
  await seedPortalToken(page, 'portal-retained-cancellation-session');
  let confirmedTiming: unknown;
  await page.route('**/api/portal/orders', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      controls: {
        self_service_cancellation: true,
        cancellation_timing: 'immediate',
        refund_requests_enabled: false,
        service_requests_enabled: false,
      },
      data: [{
        id: '11111111-1111-4111-8111-111111111111',
        order_number: 'ORD-RETAINED',
        amount_cents: 100,
        discount_cents: 0,
        currency: 'USD',
        status: 'completed',
        source: 'paypal',
        can_self_service_cancel: true,
        created_at: '2026-08-17T00:00:00.000Z',
        products: { name: 'Retained Cancellation Subscription', type: 'subscription' },
        payments: [],
        entitlements: [{
          id: '22222222-2222-4222-8222-222222222222',
          status: 'active',
          type: 'subscription',
          expires_at: '2026-10-17T12:00:00.000Z',
          grace_period_ends_at: null,
          cancelled_at: null,
          portal_cancellation_timing: 'end-of-term',
          portal_cancellation_access_until: '2026-09-17T12:00:00.000Z',
        }],
      }],
    }),
  }));
  await page.route('**/api/portal/cancel', async (route) => {
    confirmedTiming = (await route.request().postDataJSON()).cancellation_timing;
    return route.fulfill({
      status: 502,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'The provider response is still uncertain.' }),
    });
  });

  await page.goto('/portal/orders', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Cancel renewal' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('access remains available through Sep 17, 2026');
  await expect(dialog).not.toContainText('access ends immediately');
  await testInfo.attach('orders-retained-cancellation-confirmation', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
  await dialog.getByRole('button', { name: 'Cancel renewal' }).click();
  expect(confirmedTiming).toBe('end-of-term');
  await expect(page.getByRole('alert').filter({ hasText: 'still uncertain' })).toBeVisible();
});

test('grace-period cancellation uses the grace deadline', async ({ page }, testInfo) => {
  await seedPortalToken(page, 'portal-grace-session');
  await page.route('**/api/portal/orders', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      controls: {
        self_service_cancellation: true,
        cancellation_timing: 'end-of-term',
        refund_requests_enabled: false,
        service_requests_enabled: false,
      },
      data: [{
        id: '11111111-1111-4111-8111-111111111111',
        order_number: 'ORD-GRACE',
        amount_cents: 100,
        discount_cents: 0,
        currency: 'USD',
        status: 'completed',
        source: 'paypal',
        can_self_service_cancel: true,
        created_at: '2026-08-17T00:00:00.000Z',
        products: { name: 'Grace Subscription', type: 'subscription' },
        payments: [],
        entitlements: [{
          id: '22222222-2222-4222-8222-222222222222',
          status: 'grace_period',
          type: 'subscription',
          expires_at: '2026-08-01T12:00:00.000Z',
          grace_period_ends_at: '2026-09-20T12:00:00.000Z',
          cancelled_at: null,
        }],
      }],
    }),
  }));

  await page.goto('/portal/orders', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Cancel renewal' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('Sep 20, 2026');
  await expect(dialog).not.toContainText('Aug 1, 2026');
  await testInfo.attach('orders-desktop-grace-confirmation', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
});

test('cancelled grace-period readback uses the grace deadline', async ({ page }, testInfo) => {
  await seedPortalToken(page, 'portal-grace-readback-session');
  await page.route('**/api/portal/orders', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      controls: {
        self_service_cancellation: true,
        cancellation_timing: 'end-of-term',
        refund_requests_enabled: false,
        service_requests_enabled: false,
      },
      data: [{
        id: '11111111-1111-4111-8111-111111111111',
        order_number: 'ORD-GRACE-READBACK',
        amount_cents: 100,
        discount_cents: 0,
        currency: 'USD',
        status: 'completed',
        source: 'paypal',
        can_self_service_cancel: true,
        created_at: '2026-08-17T00:00:00.000Z',
        products: { name: 'Grace Readback Subscription', type: 'subscription' },
        payments: [],
        entitlements: [{
          id: '22222222-2222-4222-8222-222222222222',
          status: 'cancelled',
          type: 'subscription',
          expires_at: '2026-08-01T12:00:00.000Z',
          grace_period_ends_at: '2026-09-20T12:00:00.000Z',
          cancelled_at: '2026-08-17T12:00:00.000Z',
          portal_cancellation_access_until: '2026-09-20T12:00:00.000Z',
        }],
      }],
    }),
  }));

  await page.goto('/portal/orders', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('table').getByText('Renewal cancelled · Access through Sep 20, 2026')).toBeVisible();
  await expect(page.getByText(/Access through Aug 1, 2026/)).toHaveCount(0);
  await testInfo.attach('orders-desktop-terminal-cancellation-readback', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
});

test('order load failure does not claim that purchase history is empty', async ({ page }) => {
  await seedPortalToken(page, 'portal-order-failure-session');
  await page.route('**/api/portal/orders', (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'Order history could not be loaded.' }),
  }));

  await page.goto('/portal/orders', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Order history could not be loaded.')).toBeVisible();
  await expect(page.getByText('No orders yet.')).toHaveCount(0);
});

test('non-provider subscription grants do not offer PayPal cancellation', async ({ page }, testInfo) => {
  await seedPortalToken(page, 'portal-manual-grant-session');
  await page.route('**/api/portal/orders', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      controls: {
        self_service_cancellation: true,
        cancellation_timing: 'end-of-term',
        refund_requests_enabled: false,
        service_requests_enabled: true,
      },
      data: [{
        id: '11111111-1111-4111-8111-111111111111',
        order_number: 'ORD-MANUAL-GRANT',
        amount_cents: 0,
        discount_cents: 0,
        currency: 'USD',
        status: 'completed',
        source: 'manual',
        can_self_service_cancel: false,
        created_at: '2026-08-17T00:00:00.000Z',
        products: { name: 'Manual Subscription Grant', type: 'subscription' },
        payments: [],
        entitlements: [{
          id: '22222222-2222-4222-8222-222222222222',
          status: 'active',
          type: 'subscription',
          expires_at: '2026-09-17T12:00:00.000Z',
          grace_period_ends_at: null,
          cancelled_at: null,
        }],
      }],
    }),
  }));

  await page.goto('/portal/orders', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('table').getByText('Manual Subscription Grant')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel renewal' })).toHaveCount(0);
  await testInfo.attach('orders-desktop-manual-grant-no-cancellation', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
});

test('license load failure does not claim that the account has no licenses', async ({ page }, testInfo) => {
  await seedPortalToken(page, 'portal-license-load-failure');
  await page.route('**/api/portal/licenses', (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'Licenses could not be loaded.' }),
  }));

  await page.goto('/portal/licenses', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Licenses could not be loaded.')).toBeVisible();
  await expect(page.getByText(/No licenses yet/)).toHaveCount(0);
  await testInfo.attach('licenses-desktop-load-failed', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
});

([
  { name: 'mobile', width: 375, height: 812 },
  { name: 'desktop', width: 1440, height: 900 },
] as const).forEach((viewport) => test(`license rotation and device removal are reachable behind explicit confirmations on ${viewport.name}`, async ({ page }, testInfo) => {
  await seedPortalToken(page, 'portal-license-session');
  let licenseReads = 0;
  let rotateCalls = 0;
  let removeCalls = 0;

  await page.route('**/api/portal/licenses', (route) => {
    licenseReads += 1;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: [{
          id: '33333333-3333-4333-8333-333333333333',
          key_prefix: 'SMNI',
          key_suffix: rotateCalls > 0 ? 'WXYZ' : 'ABCD',
          status: 'active',
          max_devices: 2,
          expires_at: null,
          created_at: '2026-08-17T00:00:00.000Z',
          products: {
            name: 'Final Release License',
            type: 'one_time',
            product_license_config: [{
              rotation_policy: 'rotate-and-invalidate',
              self_service_device_removal: true,
            }],
          },
          entitlements: [{ status: 'active', type: 'one_time', expires_at: null }],
          license_sessions: [{
            id: '44444444-4444-4444-8444-444444444444',
            device_name: 'Test workstation',
            device_fingerprint: 'device-fingerprint',
            ip_address: null,
            active: removeCalls === 0,
            first_seen_at: '2026-08-17T00:00:00.000Z',
            last_seen_at: '2026-08-17T00:00:00.000Z',
          }],
        }],
      }),
    });
  });
  await page.route('**/api/portal/licenses/*/rotate', (route) => {
    rotateCalls += 1;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, alreadyRotated: false, newKeySuffix: 'WXYZ' }),
    });
  });
  await page.route('**/api/portal/licenses/sessions/*', (route) => {
    removeCalls += 1;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true }),
    });
  });

  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.goto('/portal/licenses', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /Final Release License/ }).click();
  await testInfo.attach(`licenses-${viewport.name}-expanded`, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
  await page.getByRole('button', { name: 'Rotate key' }).click();
  const rotateDialog = page.getByRole('alertdialog');
  await expect(rotateDialog).toContainText('current key stops working immediately');
  await testInfo.attach(`licenses-${viewport.name}-rotate-confirmation`, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
  await rotateDialog.getByRole('button', { name: 'Rotate key' }).click();
  await expect(page.getByRole('status')).toContainText('replacement ending in WXYZ');
  await testInfo.attach(`licenses-${viewport.name}-rotated`, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
  expect(rotateCalls).toBe(1);

  await page.getByRole('button', { name: 'Remove device' }).click();
  const removeDialog = page.getByRole('alertdialog');
  await expect(removeDialog).toContainText('can be activated again later');
  await testInfo.attach(`licenses-${viewport.name}-remove-confirmation`, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
  await removeDialog.getByRole('button', { name: 'Remove device' }).click();
  await expect(page.getByRole('status')).toContainText('signed out and its license seat is now available');
  await testInfo.attach(`licenses-${viewport.name}-device-removed`, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
  expect(removeCalls).toBe(1);
  expect(licenseReads).toBe(3);
  await expect(page.getByText('0/2 devices')).toBeVisible();
  await expect(page.getByText('No active sessions.')).toBeVisible();

  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
}));

test('server-supported non-active license key states expose rotation', async ({ page }, testInfo) => {
  await seedPortalToken(page, 'portal-rotatable-key-states');
  await page.route('**/api/portal/licenses', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      data: ['pending_activation', 'suspended'].map((status, index) => ({
        id: `${index + 3}3333333-3333-4333-8333-333333333333`,
        key_prefix: 'SMNI',
        key_suffix: index === 0 ? 'PEND' : 'SUSP',
        status,
        max_devices: 3,
        expires_at: null,
        created_at: '2026-08-17T00:00:00.000Z',
        products: {
          name: index === 0 ? 'Pending Activation License' : 'Suspended License',
          type: 'one_time',
          product_license_config: {
            rotation_policy: 'rotate-and-invalidate',
            self_service_device_removal: true,
          },
        },
        entitlements: [{ status: 'active', type: 'one_time', expires_at: null }],
        license_sessions: [],
      })),
    }),
  }));

  await page.goto('/portal/licenses', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /Pending Activation License/ }).click();
  await expect(page.getByRole('button', { name: 'Rotate key' })).toBeVisible();
  await page.getByRole('button', { name: /Suspended License/ }).click();
  await expect(page.getByRole('button', { name: 'Rotate key' })).toBeVisible();
  await testInfo.attach('licenses-desktop-suspended-rotation', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
});

test('disabled license policies hide rotation and device removal', async ({ page }, testInfo) => {
  await seedPortalToken(page, 'portal-license-policy-session');
  await page.route('**/api/portal/licenses', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      data: [{
        id: '33333333-3333-4333-8333-333333333333',
        key_prefix: 'SMNI',
        key_suffix: 'ABCD',
        status: 'active',
        max_devices: 2,
        expires_at: null,
        created_at: '2026-08-17T00:00:00.000Z',
        products: {
          name: 'Policy Controlled License',
          type: 'one_time',
            product_license_config: {
              rotation_policy: 'disabled',
              self_service_device_removal: false,
            },
        },
        entitlements: [{ status: 'active', type: 'one_time', expires_at: null }],
        license_sessions: [{
          id: '44444444-4444-4444-8444-444444444444',
          device_name: 'Test workstation',
          device_fingerprint: 'device-fingerprint',
          ip_address: null,
          active: true,
          first_seen_at: '2026-08-17T00:00:00.000Z',
          last_seen_at: '2026-08-17T00:00:00.000Z',
        }],
      }],
    }),
  }));

  await page.goto('/portal/licenses', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /Policy Controlled License/ }).click();
  await expect(page.getByRole('button', { name: 'Rotate key' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Remove device' })).toHaveCount(0);
  await testInfo.attach('licenses-desktop-disabled-controls', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
});

test('terminal license entitlements hide key rotation', async ({ page }, testInfo) => {
  await seedPortalToken(page, 'portal-terminal-license');
  await page.route('**/api/portal/licenses', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      data: [{
        id: '33333333-3333-4333-8333-333333333333',
        key_prefix: 'SMNI',
        key_suffix: 'ABCD',
        status: 'active',
        max_devices: 2,
        expires_at: null,
        created_at: '2026-08-17T00:00:00.000Z',
        products: {
          name: 'Cancelled Access License',
          type: 'one_time',
          product_license_config: {
            rotation_policy: 'rotate-and-invalidate',
            self_service_device_removal: true,
          },
        },
        entitlements: [{ status: 'cancelled', type: 'one_time' }],
        license_sessions: [],
      }],
    }),
  }));

  await page.goto('/portal/licenses', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /Cancelled Access License/ }).click();
  await expect(page.getByRole('button', { name: 'Rotate key' })).toHaveCount(0);
  await testInfo.attach('licenses-desktop-terminal-entitlement', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
});

test('expired grace-period license entitlements hide key rotation', async ({ page }, testInfo) => {
  await seedPortalToken(page, 'portal-expired-grace-license');
  await page.route('**/api/portal/licenses', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      data: [{
        id: '33333333-3333-4333-8333-333333333333',
        key_prefix: 'SMNI',
        key_suffix: 'ABCD',
        status: 'active',
        max_devices: 2,
        expires_at: null,
        created_at: '2026-08-17T00:00:00.000Z',
        products: {
          name: 'Expired Grace License',
          type: 'one_time',
          product_license_config: {
            rotation_policy: 'rotate-and-invalidate',
            self_service_device_removal: true,
          },
        },
        entitlements: [{
          status: 'grace_period',
          type: 'one_time',
          grace_period_ends_at: '2020-01-01T00:00:00.000Z',
        }],
        license_sessions: [],
      }],
    }),
  }));

  await page.goto('/portal/licenses', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /Expired Grace License/ }).click();
  await expect(page.getByRole('button', { name: 'Rotate key' })).toHaveCount(0);
  await testInfo.attach('licenses-desktop-expired-grace-no-rotation', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
});

test('expired active license entitlements hide key rotation', async ({ page }, testInfo) => {
  await seedPortalToken(page, 'portal-expired-active-license');
  await page.route('**/api/portal/licenses', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      data: [{
        id: '33333333-3333-4333-8333-333333333333',
        key_prefix: 'SMNI',
        key_suffix: 'ABCD',
        status: 'active',
        max_devices: 2,
        expires_at: null,
        created_at: '2026-08-17T00:00:00.000Z',
        products: {
          name: 'Expired Active License',
          type: 'one_time',
          product_license_config: {
            rotation_policy: 'rotate-and-invalidate',
            self_service_device_removal: true,
          },
        },
        entitlements: [{
          status: 'active',
          type: 'one_time',
          expires_at: '2020-01-01T00:00:00.000Z',
          grace_period_ends_at: null,
        }],
        license_sessions: [],
      }],
    }),
  }));

  await page.goto('/portal/licenses', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /Expired Active License/ }).click();
  await expect(page.getByRole('button', { name: 'Rotate key' })).toHaveCount(0);
  await testInfo.attach('licenses-desktop-expired-active-no-rotation', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
});

test('rotation success remains truthful when license refresh fails', async ({ page }, testInfo) => {
  await seedPortalToken(page, 'portal-license-refresh-session');
  let licenseReads = 0;
  await page.route('**/api/portal/licenses', (route) => {
    licenseReads += 1;
    if (licenseReads > 1) {
      return route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Too many requests' }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: [{
          id: '33333333-3333-4333-8333-333333333333',
          key_prefix: 'SMNI',
          key_suffix: 'ABCD',
          status: 'active',
          max_devices: 2,
          expires_at: null,
          created_at: '2026-08-17T00:00:00.000Z',
          products: {
            name: 'Refresh Test License',
            type: 'one_time',
            product_license_config: [{
              rotation_policy: 'rotate-and-invalidate',
              self_service_device_removal: true,
            }],
          },
          entitlements: [{ status: 'active', type: 'one_time', expires_at: null }],
          license_sessions: [],
        }],
      }),
    });
  });
  await page.route('**/api/portal/licenses/*/rotate', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, alreadyRotated: false, newKeySuffix: 'WXYZ' }),
  }));

  await page.goto('/portal/licenses', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /Refresh Test License/ }).click();
  await page.getByRole('button', { name: 'Rotate key' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Rotate key' }).click();
  await expect(page.getByRole('status')).toContainText('The old key stopped working');
  await expect(page.getByRole('status')).toContainText('could not be refreshed');
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect(licenseReads).toBe(2);
  await testInfo.attach('licenses-desktop-rotation-refresh-failed', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
});

test('device removal success remains truthful when license refresh fails', async ({ page }) => {
  await seedPortalToken(page, 'portal-device-refresh-session');
  let licenseReads = 0;
  await page.route('**/api/portal/licenses', (route) => {
    licenseReads += 1;
    if (licenseReads > 1) {
      return route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Too many requests' }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: [{
          id: '33333333-3333-4333-8333-333333333333',
          key_prefix: 'SMNI',
          key_suffix: 'ABCD',
          status: 'active',
          max_devices: 2,
          expires_at: null,
          created_at: '2026-08-17T00:00:00.000Z',
          products: {
            name: 'Device Refresh License',
            type: 'one_time',
            product_license_config: {
              rotation_policy: 'rotate-and-invalidate',
              self_service_device_removal: true,
            },
          },
          entitlements: [{ status: 'active', type: 'one_time', expires_at: null }],
          license_sessions: [{
            id: '44444444-4444-4444-8444-444444444444',
            device_name: 'Test workstation',
            device_fingerprint: 'device-fingerprint',
            ip_address: null,
            active: true,
            first_seen_at: '2026-08-17T00:00:00.000Z',
            last_seen_at: '2026-08-17T00:00:00.000Z',
          }],
        }],
      }),
    });
  });
  await page.route('**/api/portal/licenses/sessions/*', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, deduped: false }),
  }));

  await page.goto('/portal/licenses', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /Device Refresh License/ }).click();
  await page.getByRole('button', { name: 'Remove device' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove device' }).click();
  await expect(page.getByRole('status')).toContainText('signed out and its license seat is now available');
  await expect(page.getByRole('status')).toContainText('could not be refreshed');
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect(licenseReads).toBe(2);
});

test('a pending seller request cannot be replaced or edited before it settles', async ({ page }, testInfo) => {
  await seedPortalToken(page, 'portal-request-pending-session');
  await page.route('**/api/portal/orders', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      controls: {
        self_service_cancellation: false,
        cancellation_timing: 'end-of-term',
        refund_requests_enabled: true,
        service_requests_enabled: true,
      },
      data: [{
        id: '11111111-1111-4111-8111-111111111111',
        order_number: 'ORD-PENDING-REQUEST',
        amount_cents: 100,
        discount_cents: 0,
        currency: 'USD',
        status: 'completed',
        source: 'purchase',
        can_self_service_cancel: false,
        created_at: '2026-08-17T00:00:00.000Z',
        products: { name: 'Pending Request Product' },
        payments: [],
        entitlements: [],
      }],
    }),
  }));
  let releaseRequest: (() => void) | undefined;
  const heldRequest = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  await page.route('**/api/portal/requests', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      });
      return;
    }
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }

    await heldRequest;
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, deduped: false }),
    });
  });

  await page.goto('/portal/orders', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Request refund' }).click();
  const reason = page.getByLabel('What should the seller know? (optional)');
  await reason.fill('Keep this exact draft attached to the pending request.');
  await page.getByRole('button', { name: 'Send request' }).click();

  await expect(reason).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Request refund' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Contact seller' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  await testInfo.attach('orders-pending-request-locked', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });

  releaseRequest?.();
  await expect(page.getByRole('status')).toContainText('does not automatically move money');
});

test('an in-flight rotation dialog ignores Escape and backdrop dismissal', async ({ page }, testInfo) => {
  await seedPortalToken(page, 'portal-rotation-pending-session');
  await page.route('**/api/portal/licenses', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      data: [{
        id: '33333333-3333-4333-8333-333333333333',
        key_prefix: 'SMNI',
        key_suffix: 'ABCD',
        status: 'active',
        max_devices: 2,
        expires_at: null,
        created_at: '2026-08-17T00:00:00.000Z',
        products: {
          name: 'Pending Rotation License',
          type: 'one_time',
          product_license_config: {
            rotation_policy: 'rotate-and-invalidate',
            self_service_device_removal: true,
          },
        },
        entitlements: [{ status: 'active', type: 'one_time', expires_at: null, grace_period_ends_at: null }],
        license_sessions: [],
      }],
    }),
  }));
  let releaseRotation: (() => void) | undefined;
  const heldRotation = new Promise<void>((resolve) => {
    releaseRotation = resolve;
  });
  await page.route('**/api/portal/licenses/*/rotate', async (route) => {
    await heldRotation;
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Rotation could not be completed.' }),
    });
  });

  await page.goto('/portal/licenses', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /Pending Rotation License/ }).click();
  await page.getByRole('button', { name: 'Rotate key' }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByRole('button', { name: 'Rotate key' }).click();
  await expect(dialog).toHaveAttribute('aria-busy', 'true');
  await expect(dialog).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await page.locator('.fixed.inset-0').click({ position: { x: 4, y: 4 } });
  await expect(dialog).toBeVisible();
  await testInfo.attach('licenses-rotation-processing-locked', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });

  releaseRotation?.();
  const cancel = dialog.getByRole('button', { name: 'Cancel' });
  await expect(dialog).not.toHaveAttribute('aria-busy', 'true');
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Close confirmation dialog' })).toBeFocused();
  await expect(page.getByRole('alert').filter({ hasText: 'Rotation could not be completed.' })).toBeVisible();
});
