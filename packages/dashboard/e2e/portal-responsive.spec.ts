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

test('subscription cancellation and support requests are reachable and truthful on mobile', async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem('portal_token', 'portal-action-session'));
  let requestCount = 0;

  await page.route('**/api/portal/orders', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      data: [{
        id: '11111111-1111-4111-8111-111111111111',
        order_number: 'ORD-1001',
        amount_cents: 100,
        discount_cents: 0,
        currency: 'USD',
        status: 'completed',
        source: 'paypal',
        created_at: '2026-08-17T00:00:00.000Z',
        products: { name: 'Final Release Subscription', type: 'subscription' },
        payments: [],
        entitlements: [{
          id: '22222222-2222-4222-8222-222222222222',
          status: 'active',
          type: 'subscription',
          expires_at: '2026-09-17T12:00:00.000Z',
          cancelled_at: null,
        }],
      }],
    }),
  }));
  await page.route('**/api/portal/cancel', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      deduped: false,
      data: {
        status: 'active',
        access_until: '2026-09-17T12:00:00.000Z',
        cancellation_scheduled_at: '2026-08-17T12:00:00.000Z',
      },
    }),
  }));
  await page.route('**/api/portal/requests', (route) => {
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
  await expect(page.getByRole('status')).toContainText('Renewal cancelled');
  await expect(page.getByRole('article').getByText('Renewal cancelled · Access through Sep 17, 2026')).toBeVisible();
  await testInfo.attach('orders-mobile-cancelled', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });

  await page.getByRole('button', { name: 'Request refund' }).click();
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

([
  { name: 'mobile', width: 375, height: 812 },
  { name: 'desktop', width: 1440, height: 900 },
] as const).forEach((viewport) => test(`license rotation and device removal are reachable behind explicit confirmations on ${viewport.name}`, async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem('portal_token', 'portal-license-session'));
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
          products: { name: 'Final Release License', type: 'one_time' },
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
  await expect(page.getByRole('status')).toContainText('can no longer use this license');
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
