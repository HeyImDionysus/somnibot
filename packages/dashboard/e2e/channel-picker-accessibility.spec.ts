import { expect, test, type Page, type Route } from '@playwright/test';

async function fulfillJson(route: Route, body: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function installRoutes(page: Page): Promise<() => number> {
  let createRequests = 0;
  await page.route('**/api/external-webhook-relays', async (route) => {
    if (route.request().method() === 'POST') {
      createRequests += 1;
      await fulfillJson(route, { success: true, data: { receiver_url: 'https://example.invalid/receiver' } });
      return;
    }
    await fulfillJson(route, { success: true, data: { relays: [], deliveries: [] } });
  });
  await page.route('**/api/channels', (route) => fulfillJson(route, {
    success: true,
    awaitingSnapshot: false,
    snapshotVersion: 2,
    snapshotAt: new Date().toISOString(),
    channels: [
      {
        id: 'channel-general',
        name: 'general',
        type: 0,
        position: 1,
        manageableByBot: true,
        botPermissions: '3072',
      },
      {
        id: 'channel-no-send',
        name: 'read-only',
        type: 0,
        position: 2,
        manageableByBot: true,
        botPermissions: '1024',
      },
      {
        id: 'channel-alerts',
        name: 'alerts',
        type: 0,
        position: 3,
        manageableByBot: true,
        botPermissions: '3072',
      },
    ],
    categories: [],
  }));
  await page.route('**/api/guild', (route) => fulfillJson(route, { success: true, data: {} }));
  await page.route('**/api/guilds', (route) => fulfillJson(route, { success: true, data: [] }));
  return () => createRequests;
}

test('supports labelled listbox navigation and field-local recovery', async ({ page }, testInfo) => {
  // Given: an authoritative channel snapshot containing two usable options and one unavailable option.
  const createRequestCount = await installRoutes(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/webhook-relays');
  await page.getByRole('button', { name: 'New relay' }).click();
  const trigger = page.getByRole('combobox', { name: 'Discord destination' });

  // Then: the native trigger is labelled and controls a listbox popup.
  await expect(trigger).toHaveAttribute('type', 'button');
  await expect(trigger).toHaveAttribute('aria-haspopup', 'listbox');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  const listboxId = await trigger.getAttribute('aria-controls');
  expect(listboxId).toBeTruthy();

  // When: keyboard navigation opens the picker and crosses an unavailable option.
  await trigger.press('ArrowDown');
  const listbox = page.getByRole('listbox', { name: 'Discord destination options' });
  await expect(listbox).toBeVisible();
  const general = listbox.getByRole('option', { name: 'general' });
  const alerts = listbox.getByRole('option', { name: 'alerts' });
  const unavailable = listbox.getByRole('option', { name: /read-only/ });
  await expect(general).toBeFocused();
  await expect(unavailable).toBeDisabled();
  await general.press('ArrowDown');
  await expect(alerts).toBeFocused();

  // Then: Escape closes the listbox and restores the exact trigger.
  await alerts.press('Escape');
  await expect(listbox).not.toBeVisible();
  await expect(trigger).toBeFocused();

  // When: the form is submitted without a selected destination.
  await page.getByLabel('Relay name').fill('Accessibility relay');
  await page.getByLabel('Source label').fill('Browser proof');
  await page.getByRole('button', { name: 'Create relay' }).click();

  // Then: the field exposes and references its adjacent error without issuing the mutation.
  const error = page.getByRole('alert').filter({ hasText: 'Choose a destination from a fresh live Discord snapshot.' });
  await expect(error).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-invalid', 'true');
  const describedBy = await trigger.getAttribute('aria-describedby');
  expect(describedBy?.split(' ')).toContain(await error.getAttribute('id'));
  expect(createRequestCount()).toBe(0);

  // When: a valid option is selected and then cleared with the adjacent native control.
  await trigger.click();
  await listbox.getByRole('option', { name: 'general' }).click();
  await expect(error).not.toBeVisible();
  await page.getByRole('button', { name: 'Clear channel selection' }).click();

  // Then: clearing does not submit or dismiss the form, and the mobile control remains in bounds.
  expect(createRequestCount()).toBe(0);
  await expect(page.getByRole('heading', { name: 'Create webhook relay' })).toBeVisible();
  const triggerBox = await trigger.boundingBox();
  expect(triggerBox?.x).toBeGreaterThanOrEqual(0);
  expect(triggerBox ? triggerBox.x + triggerBox.width : Number.POSITIVE_INFINITY).toBeLessThanOrEqual(375);
  await page.screenshot({ path: testInfo.outputPath('channel-picker-mobile.png'), fullPage: true });
});
