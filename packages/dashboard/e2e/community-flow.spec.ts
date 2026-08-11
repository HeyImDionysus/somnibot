import { expect, test, type Page, type Route } from '@playwright/test';

const GUILD_ID = '111111111111111111';
const CHANNEL_ID = '222222222222222222';
const MESSAGE_ID = '333333333333333333';
const ROLE_ID = '444444444444444444';

interface ReactionRoleMapping {
  readonly id: string;
  readonly guild_id: string;
  readonly channel_id: string;
  readonly message_id: string;
  readonly emoji: string;
  readonly role_id: string;
  readonly exclusive_group: string | null;
  readonly require_role: string | null;
  readonly require_level: number | null;
  readonly max_per_group: number | null;
  readonly remove_on_unreact: boolean;
  readonly log_actions: boolean;
  readonly active: boolean;
  readonly created_at: string;
}

interface CommunityState {
  defaults: {
    reaction_roles_enabled: boolean;
    default_style: string;
    default_max_per_group: number;
    default_require_level: number;
    default_remove_on_unreact: boolean;
    ticket_transcript_enabled: boolean;
    ticket_dm_transcript: boolean;
  };
  mappings: ReactionRoleMapping[];
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function installCommunityApi(page: Page, state: CommunityState): Promise<void> {
  await page.route('**/api/reaction-roles', async (route) => {
    if (route.request().method() === 'GET') {
      await fulfillJson(route, { success: true, data: state.mappings });
      return;
    }

    const mapping: ReactionRoleMapping = {
      id: 'mapping-browser-proof',
      guild_id: GUILD_ID,
      channel_id: CHANNEL_ID,
      message_id: MESSAGE_ID,
      emoji: '📣',
      role_id: ROLE_ID,
      exclusive_group: null,
      require_role: null,
      require_level: null,
      max_per_group: null,
      remove_on_unreact: true,
      log_actions: false,
      active: true,
      created_at: '2030-01-01T00:00:00.000Z',
    };
    state.mappings = [...state.mappings, mapping];
    await fulfillJson(route, { success: true, data: mapping });
  });

  await page.route('**/api/guild', async (route) => {
    if (route.request().method() === 'GET') {
      await fulfillJson(route, { success: true, config: state.defaults });
      return;
    }

    state.defaults.reaction_roles_enabled = false;
    await fulfillJson(route, { success: true });
  });

  await page.route('**/api/channels', (route) => fulfillJson(route, {
    success: true,
    channels: [{
      id: CHANNEL_ID,
      name: 'role-picks',
      type: 0,
      position: 0,
      parent_id: null,
      botPermissions: '1024',
      manageableByBot: true,
    }],
    categories: [],
    snapshotAt: '2030-01-01T00:00:00.000Z',
    awaitingSnapshot: false,
  }));

  await page.route('**/api/roles', (route) => fulfillJson(route, {
    success: true,
    data: [{ id: ROLE_ID, name: 'Announcements', color: 0, managed: false, position: 1 }],
  }));

  await page.route('**/api/tickets/panels', (route) => fulfillJson(route, {
    success: true,
    data: [{
      id: 'ticket-panel-browser-proof',
      guild_id: GUILD_ID,
      name: 'Support',
      channel_id: CHANNEL_ID,
      message_id: null,
      panel_message: { title: 'Support' },
      input_mode: 'buttons',
      ticket_types: [],
      manager_roles: [],
      open_category_id: CHANNEL_ID,
      closed_category_id: null,
      transcript_channel_id: null,
      dm_transcript_to_creator: false,
      max_open_per_user: 1,
      inactivity_warn_hours: 0,
      inactivity_close_hours: 0,
      feedback_prompt_enabled: false,
      introduction_message: null,
      active: true,
      created_at: '2030-01-01T00:00:00.000Z',
    }],
  }));

  await page.route('**/api/tickets?**', (route) => fulfillJson(route, {
    success: true,
    data: [],
    total: 0,
  }));
}

test.describe('Community self-service browser flow', () => {
  test.setTimeout(30_000);

  test('Given a live channel, when an owner stages a role mapping, then it saves from a message link and reads it back', async ({ page }) => {
    const state: CommunityState = {
      defaults: {
        reaction_roles_enabled: true,
        default_style: 'buttons',
        default_max_per_group: 0,
        default_require_level: 0,
        default_remove_on_unreact: true,
        ticket_transcript_enabled: false,
        ticket_dm_transcript: false,
      },
      mappings: [],
    };
    await installCommunityApi(page, state);

    await page.goto('/reaction-roles');
    await page.getByRole('button', { name: /Add Mapping/ }).click();
    await page.getByRole('button', { name: 'Channel *' }).click();
    await page.getByRole('button', { name: /role-picks/ }).click();
    await page.getByLabel('Discord message link *').fill(
      `https://discord.com/channels/${GUILD_ID}/${CHANNEL_ID}/${MESSAGE_ID}`,
    );
    await expect(page.getByText('Role message in #role-picks', { exact: true })).toBeVisible();
    await page.getByLabel('Emoji *').fill('📣');
    await page.getByText('Select role to assign…', { exact: true }).click();
    await page.getByRole('button', { name: /Announcements/ }).click();
    await page.getByRole('button', { name: 'Save mapping' }).click();

    await expect(page.getByRole('button', { name: 'Save mapping' })).not.toBeVisible();
    await expect(page.getByText('Role message in #role-picks', { exact: true })).toBeVisible();
    await expect(page.getByText('Announcements')).toBeVisible();

    await page.getByRole('checkbox', { name: 'Enable reaction roles' }).uncheck();
    await expect(page.getByRole('button', { name: 'Save defaults' })).toBeVisible();
    await page.getByRole('button', { name: 'Save defaults' }).click();
    await expect(page.getByText(/Defaults saved/)).toBeVisible();
  });

  test('Given a stale channel snapshot, when community pages render, then they explain the deployment and stale-target boundaries', async ({ page }) => {
    const state: CommunityState = {
      defaults: {
        reaction_roles_enabled: true,
        default_style: 'buttons',
        default_max_per_group: 0,
        default_require_level: 0,
        default_remove_on_unreact: true,
        ticket_transcript_enabled: false,
        ticket_dm_transcript: false,
      },
      mappings: [],
    };
    await installCommunityApi(page, state);
    await page.route('**/api/channels', (route) => fulfillJson(route, {
      success: true,
      channels: [{ id: CHANNEL_ID, name: 'role-picks', type: 0, position: 0 }],
      categories: [],
      snapshotAt: 'not-a-timestamp',
      awaitingSnapshot: false,
    }));

    await page.goto('/tickets');
    await expect(page.getByText('Channel: #role-picks')).toBeVisible();
    await expect(page.getByText(/snapshot is stale/i)).toBeVisible();

    await page.goto('/channels');
    await expect(page).toHaveURL(/\/channels$/);
    await expect(page.getByRole('heading', { name: 'Channel management' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open channel setup' })).toHaveAttribute('href', '/server-setup?step=3');
    await expect(page.getByRole('heading', { name: 'Deploy and verify deliberately' })).toBeVisible();
  });
});
