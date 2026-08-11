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

interface CommunityApiOptions {
  readonly mappingReadback?: 'matching' | 'missing' | 'mismatched';
  readonly persistDefaults?: boolean;
  readonly mappingGate?: Promise<void>;
  readonly persistToggle?: boolean;
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function installCommunityApi(
  page: Page,
  state: CommunityState,
  options: CommunityApiOptions = {},
): Promise<void> {
  await page.route('**/api/reaction-roles', async (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      await fulfillJson(route, { success: true, data: state.mappings });
      return;
    }

    if (method === 'PUT') {
      const body: unknown = route.request().postDataJSON();
      if (typeof body !== 'object' || body === null || !('id' in body) || !('active' in body)
        || typeof body.id !== 'string' || typeof body.active !== 'boolean') {
        await fulfillJson(route, { success: false, error: 'Invalid toggle fixture' }, 400);
        return;
      }
      const current = state.mappings.find((mapping) => mapping.id === body.id);
      if (!current) {
        await fulfillJson(route, { success: false, error: 'Mapping not found' }, 404);
        return;
      }
      const updated = { ...current, active: body.active };
      if (options.persistToggle !== false) {
        state.mappings = state.mappings.map((mapping) => mapping.id === updated.id ? updated : mapping);
      }
      await fulfillJson(route, { success: true, data: updated });
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
    await options.mappingGate;
    const mappingReadback = options.mappingReadback ?? 'matching';
    if (mappingReadback === 'matching') state.mappings = [...state.mappings, mapping];
    if (mappingReadback === 'mismatched') {
      state.mappings = [...state.mappings, { ...mapping, role_id: '555555555555555555' }];
    }
    await fulfillJson(route, { success: true, data: mapping });
  });

  await page.route('**/api/guild', async (route) => {
    if (route.request().method() === 'GET') {
      await fulfillJson(route, { success: true, config: state.defaults });
      return;
    }

    if (options.persistDefaults !== false) state.defaults.reaction_roles_enabled = false;
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
  test.setTimeout(90_000);

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
    const mappingSwitch = page.getByRole('switch', { name: 'Toggle 📣 mapping' });
    await expect(mappingSwitch).toHaveAttribute('aria-checked', 'true');
    await mappingSwitch.click();
    await expect(page.getByText('Mapping status saved and read back')).toBeVisible();
    await expect(mappingSwitch).toHaveAttribute('aria-checked', 'false');

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

  test('Given a POST-only mapping response, when the collection readback is stale, then it does not claim a saved mapping was read back', async ({ page }) => {
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
    await installCommunityApi(page, state, { mappingReadback: 'missing' });

    await page.goto('/reaction-roles');
    await page.getByRole('button', { name: /Add Mapping/ }).click();
    await page.getByRole('button', { name: 'Channel *' }).click();
    await page.getByRole('button', { name: /role-picks/ }).click();
    await page.getByLabel('Discord message link *').fill(`https://discord.com/channels/${GUILD_ID}/${CHANNEL_ID}/${MESSAGE_ID}`);
    await page.getByLabel('Emoji *').fill('📣');
    await page.getByText('Select role to assign…', { exact: true }).click();
    await page.getByRole('button', { name: /Announcements/ }).click();
    await page.getByRole('button', { name: 'Save mapping' }).click();

    await expect(page.getByText('Reaction role saved; server readback is unavailable')).toBeVisible();
    await expect(page.getByText('Saved mapping read back')).not.toBeVisible();
  });

  test('Given the same mapping ID with different fields, when the collection is read back, then it does not claim the requested mapping was confirmed', async ({ page }) => {
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
    await installCommunityApi(page, state, { mappingReadback: 'mismatched' });

    await page.goto('/reaction-roles');
    await page.getByRole('button', { name: /Add Mapping/ }).click();
    await page.getByRole('button', { name: 'Channel *' }).click();
    await page.getByRole('button', { name: /role-picks/ }).click();
    await page.getByLabel('Discord message link *').fill(`https://discord.com/channels/${GUILD_ID}/${CHANNEL_ID}/${MESSAGE_ID}`);
    await page.getByLabel('Emoji *').fill('📣');
    await page.getByText('Select role to assign…', { exact: true }).click();
    await page.getByRole('button', { name: /Announcements/ }).click();
    await page.getByRole('button', { name: 'Save mapping' }).click();

    await expect(page.getByText('Reaction role saved; server readback is unavailable')).toBeVisible();
    await expect(page.getByText('Saved mapping read back')).not.toBeVisible();
  });

  test('Given a stale defaults readback, when an owner saves, then the draft stays visible and success is not claimed', async ({ page }) => {
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
    await installCommunityApi(page, state, { persistDefaults: false });

    await page.goto('/reaction-roles');
    await page.getByRole('checkbox', { name: 'Enable reaction roles' }).uncheck();
    await page.getByRole('button', { name: 'Save defaults' }).click();

    await expect(page.getByText('Defaults saved; server readback is unavailable')).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Enable reaction roles' })).not.toBeChecked();
    await expect(page.getByRole('button', { name: 'Save defaults' })).toBeVisible();
    await expect(page.getByText('Defaults saved and read back from this server')).not.toBeVisible();
  });

  test('Given a mapping request is pending, when save is clicked, then duplicate submission is unavailable', async ({ page }) => {
    let releaseMapping: (() => void) | null = null;
    const mappingGate = new Promise<void>((resolve) => {
      releaseMapping = resolve;
    });
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
    await installCommunityApi(page, state, { mappingGate });

    await page.goto('/reaction-roles');
    await page.getByRole('button', { name: /Add Mapping/ }).click();
    await page.getByRole('button', { name: 'Channel *' }).click();
    await page.getByRole('button', { name: /role-picks/ }).click();
    await page.getByLabel('Discord message link *').fill(`https://discord.com/channels/${GUILD_ID}/${CHANNEL_ID}/${MESSAGE_ID}`);
    await page.getByLabel('Emoji *').fill('📣');
    await page.getByText('Select role to assign…', { exact: true }).click();
    await page.getByRole('button', { name: /Announcements/ }).click();
    await page.getByRole('button', { name: 'Save mapping' }).click();

    await expect(page.getByRole('button', { name: 'Saving mapping…' })).toBeDisabled();
    const release = releaseMapping;
    if (!release) throw new Error('Mapping gate did not initialize');
    release();
    await expect(page.getByRole('button', { name: 'Saving mapping…' })).not.toBeVisible();
  });

  test('Given a stale active-state readback, when a mapping is toggled, then the dashboard keeps the confirmed state', async ({ page }) => {
    const existing: ReactionRoleMapping = {
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
      mappings: [existing],
    };
    await installCommunityApi(page, state, { persistToggle: false });

    await page.goto('/reaction-roles');
    const mappingSwitch = page.getByRole('switch', { name: 'Toggle 📣 mapping' });
    await mappingSwitch.click();

    await expect(page.getByText('Mapping status saved; server readback is unavailable')).toBeVisible();
    await expect(mappingSwitch).toHaveAttribute('aria-checked', 'true');
  });
});
