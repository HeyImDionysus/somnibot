import { expect, test, type Page, type Route } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type GuildConfig = Record<string, boolean | number | string | null>;

const MUSIC_CONFIG = {
  music_enabled: true,
  music_default_volume: 50,
  dj_role_id: null,
  music_auto_leave_minutes: 5,
  music_auto_destroy_minutes: 30,
  max_queue_length: 5000,
  allow_duplicates: true,
  per_user_queue_cap: 50,
  vote_skip_threshold_percent: 50,
  self_skip_enabled: true,
  requester_move_enabled: true,
  priority_voting_enabled: true,
} as const;

const ENABLED_IDLE_MUSIC = {
  enabled: true,
  nowPlaying: null,
  queue: { length: 0, duration: 0 },
  listeners: 0,
  recentTracks: [],
} as const;

const testDir = path.dirname(fileURLToPath(import.meta.url));
const visualEvidenceDir = path.resolve(testDir, '../../../../../..', '.omo/evidence/dashboard-economy-truth/visual');
const shellWidthAtNarrowBreakpoint = 615;

async function captureBreakpoints(page: Page, name: string, focusHeading?: string): Promise<void> {
  await mkdir(visualEvidenceDir, { recursive: true });
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width: width === 375 ? shellWidthAtNarrowBreakpoint : width, height: 900 });
    await page.getByRole('main').evaluate((element) => { element.scrollTop = 0; });
    if (width === 375) {
      await page.getByRole('main').screenshot({ path: path.join(visualEvidenceDir, `${name}-route-pane-375.png`) });
    } else {
      await page.screenshot({ path: path.join(visualEvidenceDir, `${name}-${width}.png`) });
    }
    if (focusHeading) {
      await page.getByRole('heading', { name: focusHeading }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(visualEvidenceDir, `${name}-status-${width}.png`) });
    }
  }
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function installShellRoutes(page: Page): Promise<void> {
  await page.route('**/api/guilds', (route) => fulfillJson(route, { success: true, guilds: [] }));
  await page.route('**/api/dashboard/feature-status', (route) => fulfillJson(route, {
    success: true,
    data: {
      config: { economy_enabled: true, music_enabled: true },
      bot: { online: true, staleSecs: 0 },
      runtimeFeatures: ['music'],
    },
  }));
  await page.route('**/api/health', (route) => fulfillJson(route, { status: 'degraded' }, 503));
  await page.route('**/api/counts', (route) => fulfillJson(route, { success: true, data: {} }));
}

async function installGuildRoute(page: Page, config: GuildConfig): Promise<void> {
  await page.route('**/api/guild', async (route) => {
    if (route.request().method() === 'GET') {
      await fulfillJson(route, { success: true, config, guild: { id: 'guild-economy-proof' } });
      return;
    }
    Object.assign(config, route.request().postDataJSON());
    await fulfillJson(route, { success: true });
  });
}

test.beforeEach(async ({ page }) => {
  await installShellRoutes(page);
});

test('reads back concurrent authoritative games state when a PATCH fails and keeps zero editable', async ({ page }) => {
  const config: GuildConfig = {
    economy_games_enabled: true,
    economy_daily_loss_limit: 5000,
    economy_coinflip_max_bet: 500,
    economy_slots_max_bet: 500,
    economy_blackjack_max_bet: 1000,
    economy_lottery_enabled: false,
    economy_lottery_schedule: 'weekly',
    economy_lottery_ticket_price: 100,
    economy_lottery_max_tickets: 10,
  };
  await page.route('**/api/guild', async (route) => {
    if (route.request().method() === 'PATCH') {
      config.economy_daily_loss_limit = 7200;
      config.economy_lottery_ticket_price = 125;
      await fulfillJson(route, { error: 'Rejected for browser proof' }, 500);
      return;
    }
    await fulfillJson(route, { success: true, config, guild: { id: 'guild-economy-proof' } });
  });
  await page.goto('/economy/games', { waitUntil: 'domcontentloaded' });

  const lossLimit = page.getByRole('spinbutton', { name: /Daily Loss Limit/ });
  await lossLimit.fill('0');
  await expect(lossLimit).toHaveValue('0');
  await lossLimit.blur();
  await expect(lossLimit).toBeEnabled({ timeout: 20_000 });
  await expect(lossLimit).toHaveValue('7200');
  await expect(page.getByRole('spinbutton', { name: /Ticket Price/ })).toHaveValue('125');
  await expect(page.getByText(/restored the last confirmed value/i)).toBeVisible();
});

test('games switches respond to keyboard activation and meet the 44px target', async ({ page }) => {
  const config: GuildConfig = {
    economy_games_enabled: true,
    economy_daily_loss_limit: 5000,
    economy_coinflip_max_bet: 500,
    economy_slots_max_bet: 500,
    economy_blackjack_max_bet: 1000,
    economy_lottery_enabled: false,
    economy_lottery_schedule: 'weekly',
    economy_lottery_ticket_price: 100,
    economy_lottery_max_tickets: 10,
  };
  await installGuildRoute(page, config);
  await page.goto('/economy/games', { waitUntil: 'domcontentloaded' });

  const toggle = page.getByRole('switch', { name: 'Enable Mini-Games' });
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-checked', 'false', { timeout: 20_000 });
  const box = await toggle.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(44);
  expect(box?.height).toBeGreaterThanOrEqual(44);
  await captureBreakpoints(page, 'games-confirmed');
});

test('games replaces the page with normalized authoritative readback', async ({ page }) => {
  const config: GuildConfig = {
    economy_games_enabled: true,
    economy_daily_loss_limit: 5000,
    economy_coinflip_max_bet: 500,
    economy_slots_max_bet: 500,
    economy_blackjack_max_bet: 1000,
    economy_lottery_enabled: false,
    economy_lottery_schedule: 'weekly',
    economy_lottery_ticket_price: 100,
    economy_lottery_max_tickets: 10,
  };
  await page.route('**/api/guild', async (route) => {
    if (route.request().method() === 'PATCH') {
      config.economy_daily_loss_limit = 5500;
      config.economy_lottery_ticket_price = 125;
      await fulfillJson(route, { success: true });
      return;
    }
    await fulfillJson(route, { success: true, config, guild: { id: 'guild-economy-proof' } });
  });
  await page.goto('/economy/games', { waitUntil: 'domcontentloaded' });

  const lossLimit = page.getByRole('spinbutton', { name: /Daily Loss Limit/ });
  await lossLimit.fill('6000');
  await lossLimit.blur();
  await expect(lossLimit).toHaveValue('5500');
  await expect(page.getByRole('spinbutton', { name: /Ticket Price/ })).toHaveValue('125');
  await expect(page.getByText(/economy_daily_loss_limit confirmed as 5500/i)).toBeVisible();
});

test('music distinguishes disconnected diagnostics and exposes recovery with last checked time', async ({ page }) => {
  await page.route('**/api/music', (route) => fulfillJson(route, {
    success: true,
    data: MUSIC_CONFIG,
  }));
  await page.route('**/api/roles', (route) => fulfillJson(route, { success: true, data: [] }));
  await page.route('**/api/music/now-playing', (route) => fulfillJson(route, {
    success: true,
    data: ENABLED_IDLE_MUSIC,
  }));
  await page.route('**/api/diagnostics', (route) => fulfillJson(route, {
    success: true,
    data: {
      bot: { staleSecs: 0, snapshotAt: new Date().toISOString() },
      lavalink: { nodes: [{ connected: false }] },
    },
  }));
  await page.goto('/music', { waitUntil: 'domcontentloaded' });

  await expect(page.getByText(/configured.*disconnected/i)).toBeVisible();
  await expect(page.getByText(/Last checked/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /Check Lavalink again/i })).toBeVisible();
  await expect(page.getByRole('main').getByText(/restart the Lavalink service/i)).toBeVisible();
  await captureBreakpoints(page, 'music-disconnected', 'Lavalink Node');
});

test('music treats a connected node from stale diagnostics as unverified', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route('**/api/music', (route) => fulfillJson(route, { success: true, data: MUSIC_CONFIG }));
  await page.route('**/api/roles', (route) => fulfillJson(route, { success: true, data: [] }));
  await page.route('**/api/music/now-playing', (route) => fulfillJson(route, {
    success: true,
    data: ENABLED_IDLE_MUSIC,
  }));
  await page.route('**/api/diagnostics', (route) => fulfillJson(route, {
    success: true,
    data: {
      bot: { staleSecs: 5, snapshotAt: new Date(Date.now() - 180_000).toISOString() },
      lavalink: { nodes: [{ connected: true }] },
    },
  }));
  await page.goto('/music', { waitUntil: 'domcontentloaded' });

  await expect(page.getByText(/health snapshot is stale.*readiness is unverified/i)).toBeVisible();
  await expect(page.getByText(/Health snapshot:/i)).toBeVisible();
  await expect(page.getByRole('main').getByText(/restart the Lavalink service/i)).toBeVisible();
  await page.getByRole('heading', { name: 'Lavalink Node' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(visualEvidenceDir, 'music-stale-1280.png') });
});

test('music load failure exposes recovery without editable default settings', async ({ page }) => {
  await page.route('**/api/music', (route) => fulfillJson(route, {
    success: false,
    error: 'Saved music configuration could not be read',
  }, 503));
  await page.route('**/api/roles', (route) => fulfillJson(route, { success: true, data: [] }));
  await page.route('**/api/music/now-playing', (route) => fulfillJson(route, {
    success: true,
    data: ENABLED_IDLE_MUSIC,
  }));
  await page.route('**/api/diagnostics', (route) => fulfillJson(route, {
    success: true,
    data: {
      bot: { staleSecs: 0, snapshotAt: new Date().toISOString() },
      lavalink: { nodes: [{ connected: false }] },
    },
  }));
  await page.goto('/music', { waitUntil: 'domcontentloaded' });

  const recoveryPanel = page.getByRole('main').getByRole('alert').filter({
    has: page.getByRole('heading', { name: 'Music settings unavailable' }),
  });
  await expect(recoveryPanel).toContainText('Saved music configuration could not be read');
  await expect(page.getByRole('button', { name: 'Retry loading settings' })).toBeVisible();
  await expect(page.getByRole('spinbutton')).toHaveCount(0);
  await expect(page.getByRole('switch')).toHaveCount(0);
});
