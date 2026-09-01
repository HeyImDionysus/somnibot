import { expect, test, type Page, type Route } from '@playwright/test';

interface ControlCenterOptions {
  readonly canManageAdoption: boolean;
}

async function fulfillJson(route: Route, body: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

function controlCenterPayload(options: ControlCenterOptions, query: string | null): unknown {
  return {
    success: true,
    data: {
      guild: {
        id: 'guild-control-center',
        name: 'Control Center Guild',
        setup_completed: true,
      },
      attentionViews: [{
        id: 'owner',
        items: [{
          id: 'owner-runtime',
          label: 'Operational state',
          description: 'Confirm the deployed runtime and recovery evidence.',
          href: '/diagnostics',
          permission: 'dashboard.view_diagnostics',
          priority: 'critical',
        }],
      }],
      destinations: [{
        id: 'diagnostics',
        label: 'Diagnostics',
        description: 'Runtime health and recovery evidence',
        href: '/diagnostics',
        domain: 'Operations',
        keywords: ['health', 'recovery'],
        permission: 'dashboard.view_diagnostics',
      }],
      searchResults: query === null ? [] : [{
        kind: 'documentation',
        id: 'docs:recovery',
        label: 'Recovery guidance',
        description: 'Open recovery evidence',
        href: '/diagnostics',
      }],
      searchDegraded: false,
      canManageAdoption: options.canManageAdoption,
      deployment: {
        version: '1.2.3',
        exactSha: '0123456789abcdef0123456789abcdef01234567',
        bootId: 'boot-control-center',
        snapshotAt: '2026-08-31T12:00:00.000Z',
      },
    },
  };
}

async function installRoutes(page: Page, options: ControlCenterOptions): Promise<void> {
  await page.route('**/api/rbac/invitations/mine', (route) =>
    fulfillJson(route, { success: true, data: [] }));
  await page.route('**/api/guild', (route) => fulfillJson(route, {
    guild: {
      id: 'guild-control-center',
      name: 'Control Center Guild',
      bot_joined_at: '2026-08-31T12:00:00.000Z',
      setup_completed: true,
      setup_confirmed_at: '2026-08-31T12:00:00.000Z',
      bot_role_position: 2,
    },
    config: {},
    totalRoles: 3,
  }));
  await page.route('**/api/guilds', (route) =>
    fulfillJson(route, { success: true, data: [] }));
  await page.route('**/api/dashboard/stats', (route) => fulfillJson(route, {
    botOnline: true,
    memberCount: 3,
    trackedMembers: 3,
    activeTickets: 0,
    openInfractions: 0,
    revenueThisMonth: 0,
    activeGiveaways: 0,
    eventsToday: 0,
    uptime: '1h',
    uptimeSeconds: 3600,
    wsPing: 42,
    activeVoice: 0,
    valkeyConnected: true,
    memoryMb: 128,
    lastSnapshot: '2026-08-31T12:00:00.000Z',
    recentEvents: [],
  }));
  await page.route('**/api/diagnostics', (route) => fulfillJson(route, {
    success: true,
    data: {
      bot: {
        online: true,
        onlineSourceAt: '2026-08-31T12:00:00.000Z',
        onlineSourceAgeSecs: 1,
        metricsAvailable: true,
        metricsStale: false,
        metricsSnapshotAt: '2026-08-31T12:00:00.000Z',
        metricsAgeSecs: 1,
      },
    },
  }));
  await page.route('**/api/dashboard/adoption', (route) => fulfillJson(route, {
    success: true,
    data: {
      state: {
        mode: 'guided',
        tutorialVisible: true,
        selectedTrackIds: ['core', 'recovery'],
        verifiedTrackIds: [],
        trackStates: {},
      },
      updatedAt: '2026-08-31T12:00:00.000Z',
      verifications: [],
    },
  }));
  await page.route('**/api/dashboard/control-center*', (route) => {
    const query = new URL(route.request().url()).searchParams.get('q');
    return fulfillJson(route, controlCenterPayload(options, query));
  });
}

test.describe('Dashboard control center', () => {
  test('supports keyboard search and exposes authorized dashboard context', async ({ page }) => {
    await installRoutes(page, { canManageAdoption: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/dashboard');

    await expect(page.getByRole('heading', { name: 'Control Center Guild control center' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Current attention' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Operational state/ })).toHaveAttribute('href', '/diagnostics');
    await expect(page.getByRole('complementary', { name: 'Guild context' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Adoption and readiness map' })).toBeVisible();

    const search = page.getByLabel('Search this dashboard');
    await page.keyboard.press('/');
    await expect(search).toBeFocused();
    await search.fill('recovery');

    await expect(page.getByRole('link', { name: /Recovery guidance/ })).toHaveAttribute('href', '/diagnostics');
    await expect(page.locator('p[aria-live="polite"]').filter({ hasText: '1 authorized results' })).toHaveText('1 authorized results');
  });

  test('keeps a non-owner adoption map read-only within a mobile viewport', async ({ page }) => {
    await installRoutes(page, { canManageAdoption: false });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/dashboard');

    await expect(page.getByLabel('Working mode')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Hide guidance' })).toBeDisabled();
    await expect(page.getByRole('checkbox', { name: /Core bot connection/ })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Save adoption map' })).toHaveCount(0);
    await expect(page.getByText('Only the server owner can change this map.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Configure' }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open test' }).first()).toBeVisible();
    await expect.poll(() => page.evaluate(() => (
      document.documentElement.scrollWidth <= document.documentElement.clientWidth
    ))).toBe(true);
  });
});
