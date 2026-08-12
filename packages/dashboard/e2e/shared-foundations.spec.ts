import { expect, test, type Page, type Route } from '@playwright/test';

const CUSTOM_ROLE = {
  id: 'role-browser-proof',
  name: 'Browser proof role',
  description: 'Exercises shared dashboard controls',
  permissions: ['dashboard.view_analytics'],
  is_system: false,
  priority: 5,
  dashboard_user_roles: [{ count: 0 }],
} as const;

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function installSharedFoundationRoutes(page: Page): Promise<void> {
  let invitationRequests = 0;
  let pendingInvitations: unknown[] = [];
  await page.route('**/api/rbac/roles*', async (route) => {
    if (route.request().method() === 'DELETE') {
      await fulfillJson(route, { success: true });
      return;
    }
    await fulfillJson(route, { success: true, data: [CUSTOM_ROLE] });
  });
  await page.route('**/api/rbac/users*', async (route) => {
    if (route.request().method() === 'POST') {
      invitationRequests += 1;
      if (invitationRequests === 2) {
        await fulfillJson(route, { error: 'Could not send invitation' }, 400);
        return;
      }
      const requestBody: unknown = route.request().postDataJSON();
      expect(requestBody).toEqual({
        discord_id: '223456789012345695',
        role_id: CUSTOM_ROLE.id,
      });
      pendingInvitations = [{
        id: 'invitation-browser-proof',
        discord_id: '223456789012345695',
        role_id: CUSTOM_ROLE.id,
        status: 'pending',
        dm_status: 'queued',
        delivery_mode: 'dm',
        invited_by: 'owner-browser-proof',
        expires_at: '2026-08-14T12:00:00.000Z',
        created_at: '2026-08-11T12:00:00.000Z',
        dashboard_roles: {
          name: CUSTOM_ROLE.name,
          description: CUSTOM_ROLE.description,
          priority: CUSTOM_ROLE.priority,
        },
      }];
      await fulfillJson(route, { success: true, mode: 'invitation' });
      return;
    }
    await fulfillJson(route, { success: true, data: [] });
  });
  await page.route('**/api/rbac/invitations*', (route) =>
    fulfillJson(route, { success: true, data: pendingInvitations }),
  );
  await page.route('**/api/guild', (route) => fulfillJson(route, { success: true, data: {} }));
  await page.route('**/api/guilds', (route) => fulfillJson(route, { success: true, data: [] }));
}

test.describe('Shared dashboard accessibility foundations', () => {
  test.setTimeout(120_000);

  test.beforeEach(async ({ page }) => {
    await installSharedFoundationRoutes(page);
  });

  test('keeps compact tablet widths on the off-canvas navigation layout', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto('/settings/team');

    const trigger = page.locator('button[aria-controls="dashboard-navigation"]');
    await expect(trigger).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Dashboard navigation' })).not.toBeVisible();
    await expect(page.locator('#dashboard-content')).toHaveCSS('padding-top', '56px');
  });

  test('provides an off-canvas mobile navigation and a skip route to main content', async ({ page }, testInfo) => {
    // Given: the dashboard at a narrow viewport.
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/settings/team');

    // When: keyboard focus enters the page.
    await page.keyboard.press('Tab');

    // Then: the skip link reaches main content before the navigation trigger.
    const skipLink = page.getByRole('link', { name: 'Skip to main content' });
    await expect(skipLink).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#main-content')).toBeFocused();

    // When: the labeled navigation trigger opens the drawer.
    const trigger = page.locator('button[aria-controls="dashboard-navigation"]');
    await expect(trigger).toHaveAccessibleName('Open dashboard navigation');
    await expect(trigger).toHaveAttribute('aria-controls', 'dashboard-navigation');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await trigger.click();

    // Then: the navigation is modal, backgrounds are inert, and focus wraps both ways.
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(trigger).toHaveAccessibleName('Close dashboard navigation');
    const drawer = page.getByRole('dialog', { name: 'Dashboard navigation' });
    const drawerClose = drawer.getByRole('button', { name: 'Close dashboard navigation' });
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveAttribute('aria-modal', 'true');
    await expect(page.locator('#dashboard-content')).toHaveJSProperty('inert', true);
    await expect(drawerClose).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(drawer.getByRole('link', { name: 'Settings', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(drawerClose).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath('mobile-navigation.png'), fullPage: true });

    // When: the exposed backdrop is clicked.
    await page.getByTestId('dashboard-navigation-backdrop').click({ position: { x: 300, y: 400 } });

    // Then: the drawer closes, background interaction returns, and focus is restored.
    await expect(drawer).not.toBeVisible();
    await expect(page.locator('#dashboard-content')).toHaveJSProperty('inert', false);
    await expect(trigger).toBeFocused();

    // When: the active dashboard route changes while the drawer is open.
    await trigger.click();
    await page.evaluate(() => window.history.pushState({}, '', '/dashboard'));

    // Then: the route closes the modal drawer and restores its trigger.
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(drawer).not.toBeVisible();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger).toBeFocused();

    // When: the drawer is reopened and dismissed with Escape.
    await trigger.click();
    await page.keyboard.press('Escape');

    // Then: Escape closes it back to the same trigger.
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger).toBeFocused();

    await page.emulateMedia({ reducedMotion: 'reduce' });
    const transitionDuration = await trigger.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).transitionDuration),
    );
    expect(transitionDuration).toBeLessThanOrEqual(0.001);
  });

  test('traps confirmation focus, restores its trigger, and announces toast results', async ({ page }, testInfo) => {
    // Given: the team page with one deletable role.
    await page.goto('/settings/team');
    await expect(page.getByRole('navigation', { name: 'Dashboard navigation' })).toBeVisible();
    await expect(page.locator('button[aria-controls="dashboard-navigation"]')).toBeHidden();
    await page.getByRole('button', { name: 'Roles' }).click();
    const deleteTrigger = page.getByRole('button', { name: 'Delete' });

    // When: the destructive confirmation opens.
    await deleteTrigger.click();

    // Then: the safe action receives focus and Tab stays within the dialog.
    const dialog = page.getByRole('alertdialog', { name: 'Delete Role' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Delete' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Close confirmation dialog' })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: 'Delete' })).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath('confirmation-focus-trap.png'), fullPage: true });

    // When: Escape closes the dialog.
    await page.keyboard.press('Escape');

    // Then: focus returns to the exact control that opened it.
    await expect(dialog).not.toBeVisible();
    await expect(deleteTrigger).toBeFocused();

    // When: a successful invitation produces a toast at a narrow viewport.
    await page.setViewportSize({ width: 320, height: 640 });
    await page.getByRole('button', { name: 'Members' }).click();
    await page.getByRole('button', { name: 'Add Member' }).click();
    await page.getByPlaceholder('Discord User ID…').fill('223456789012345695');
    await page.getByRole('combobox').last().selectOption(CUSTOM_ROLE.id);
    const invitationResponse = page.waitForResponse((response) =>
      response.url().includes('/api/rbac/users')
      && response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Assign Role' }).click();
    expect((await invitationResponse).status()).toBe(200);

    // Then: the result is a polite status with a named close action and no overflow.
    const toast = page.getByRole('status').filter({ hasText: 'Invitation sent' });
    await expect(toast).toContainText('Invitation sent');
    await expect(toast.getByRole('button', { name: /Dismiss .* notification/ })).toBeVisible();
    const box = await toast.boundingBox();
    expect(box?.x).toBeGreaterThanOrEqual(0);
    expect(box ? box.x + box.width : Number.POSITIVE_INFINITY).toBeLessThanOrEqual(320);
    await page.screenshot({ path: testInfo.outputPath('toast-narrow-viewport.png'), fullPage: true });

    // When: a failed invitation produces the error result variant.
    await toast.getByRole('button', { name: /Dismiss .* notification/ }).click();
    await page.getByRole('button', { name: 'Add Member' }).click();
    await page.getByPlaceholder('Discord User ID…').fill('323456789012345695');
    await page.getByRole('combobox').last().selectOption(CUSTOM_ROLE.id);
    const failedInvitationResponse = page.waitForResponse((response) =>
      response.url().includes('/api/rbac/users')
      && response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Assign Role' }).click();
    expect((await failedInvitationResponse).status()).toBe(400);

    // Then: the failure is assertive and still has a named dismissal action.
    const errorToast = page.getByRole('alert').filter({
      has: page.getByRole('button', { name: 'Dismiss Could not send invitation notification' }),
    });
    await expect(errorToast).toContainText('Could not send invitation');
    await expect(
      errorToast.getByRole('button', { name: /Dismiss .* notification/ }),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('toast-error-alert.png'), fullPage: true });
  });
});
