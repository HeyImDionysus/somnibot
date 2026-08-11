import { expect, test, type Page, type Route } from '@playwright/test';

const ROLE = {
  id: 'role-helper',
  name: 'Helper',
  description: 'Limited helper access',
  permissions: ['dashboard.view_analytics'],
  is_system: false,
  priority: 5,
  dashboard_user_roles: [{ count: 0 }],
};

interface TeamControls {
  team_direct_assignment_enabled: boolean;
  team_invite_dm_enabled: boolean;
  team_max_pending_invitations: number;
  team_invitation_expiry_ms: number;
}

interface Invitation {
  id: string;
  discord_id: string;
  role_id: string;
  status: string;
  dm_status: string;
  delivery_mode: string | null;
  invited_by: string;
  expires_at: string;
  created_at: string;
  dashboard_roles: { name: string; description: string; priority: number };
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function installTeamApi(
  page: Page,
  state: {
    controls: TeamControls;
    invitations: Invitation[];
    patches: Array<Record<string, unknown>>;
    userMutationError?: string;
  },
) {
  await page.route('**/api/csrf', (route) => fulfillJson(route, { token: 'team-browser-csrf-token' }));
  await page.route('**/api/rbac/roles', (route) => fulfillJson(route, { success: true, data: [ROLE] }));

  await page.route('**/api/rbac/users', async (route) => {
    if (route.request().method() === 'GET') {
      await fulfillJson(route, { success: true, data: [] });
      return;
    }

    const body = route.request().postDataJSON() as { discord_id: string; role_id: string };
    expect(body).toEqual({ discord_id: '223456789012345695', role_id: ROLE.id });
    if (state.userMutationError) {
      await fulfillJson(route, { success: false, error: state.userMutationError }, 409);
      return;
    }
    state.invitations = [{
      id: 'inv-browser-proof',
      discord_id: body.discord_id,
      role_id: body.role_id,
      status: 'pending',
      dm_status: 'queued',
      delivery_mode: null,
      invited_by: 'owner-browser-proof',
      expires_at: '2030-01-04T00:00:00.000Z',
      created_at: '2030-01-01T00:00:00.000Z',
      dashboard_roles: { name: ROLE.name, description: ROLE.description, priority: ROLE.priority },
    }];
    await fulfillJson(route, { success: true, mode: 'invitation', data: state.invitations[0] });
  });

  await page.route('**/api/rbac/invitations', (route) =>
    fulfillJson(route, { success: true, data: state.invitations }),
  );
  // Playwright's single-star glob does not cross `/`; resend has both an id
  // and an action segment, so give it its own route rather than leaking to
  // the live handler during the browser proof.
  await page.route('**/api/rbac/invitations/*/*', async (route) => {
    expect(route.request().url()).toMatch(/\/resend$/);
    expect(route.request().method()).toBe('POST');
    if (state.invitations[0]) state.invitations[0].dm_status = 'queued';
    await fulfillJson(route, {
      success: true,
      mode: 'dm',
      message: 'The invitation is queued for one more DM attempt.',
    });
  });
  await page.route('**/api/rbac/invitations/*', async (route) => {
    expect(route.request().method()).toBe('DELETE');
    state.invitations = [];
    await fulfillJson(route, { success: true });
  });

  await page.route('**/api/guild', async (route) => {
    if (route.request().method() === 'GET') {
      await fulfillJson(route, { success: true, data: state.controls });
      return;
    }

    expect(route.request().method()).toBe('PATCH');
    const patch = route.request().postDataJSON() as Record<string, unknown>;
    state.patches.push(patch);
    Object.assign(state.controls, patch);
    await fulfillJson(route, { success: true, data: state.controls });
  });
}

test.describe('Team invitation browser flow', () => {
  test.setTimeout(120_000);

  test('persists three owner control changes across full page readbacks', async ({ page }) => {
    const state = {
      controls: {
        team_direct_assignment_enabled: false,
        team_invite_dm_enabled: true,
        team_max_pending_invitations: 25,
        team_invitation_expiry_ms: 259_200_000,
      },
      invitations: [] as Invitation[],
      patches: [] as Array<Record<string, unknown>>,
    };
    await installTeamApi(page, state);
    await page.goto('/settings/team');
    await expect(page.getByRole('heading', { name: 'Team', exact: true })).toBeVisible();

    const direct = page.getByRole('checkbox', { name: /Add people without asking them first/ });
    await direct.check();
    await expect.poll(() => state.patches.length).toBe(1);
    await page.reload();
    await expect(direct).toBeChecked();

    const dm = page.getByRole('checkbox', { name: /DM the invitation/ });
    await dm.uncheck();
    await expect.poll(() => state.patches.length).toBe(2);
    await page.reload();
    await expect(dm).not.toBeChecked();

    const cap = page.getByRole('spinbutton', { name: /Most invitations pending at once/ });
    await cap.fill('12');
    await cap.blur();
    await expect.poll(() => state.patches.length).toBe(3);
    await page.reload();
    await expect(cap).toHaveValue('12');

    expect(state.patches).toEqual([
      { team_direct_assignment_enabled: true },
      { team_invite_dm_enabled: false },
      { team_max_pending_invitations: 12 },
    ]);
  });

  test('sends a consent invitation and revokes it with visible feedback', async ({ page }, testInfo) => {
    const state = {
      controls: {
        team_direct_assignment_enabled: false,
        team_invite_dm_enabled: true,
        team_max_pending_invitations: 25,
        team_invitation_expiry_ms: 259_200_000,
      },
      invitations: [] as Invitation[],
      patches: [] as Array<Record<string, unknown>>,
    };
    await installTeamApi(page, state);
    await page.goto('/settings/team');
    await expect(page.getByRole('button', { name: 'Add Member' })).toBeVisible();

    await page.getByRole('button', { name: 'Add Member' }).click();
    await page.getByPlaceholder('Discord User ID…').fill('223456789012345695');
    await page.getByRole('combobox', { name: '' }).last().selectOption(ROLE.id);
    await page.getByRole('button', { name: 'Assign Role' }).click();

    await expect(page.getByText('Invitation sent — the member gains access once they accept')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Pending Invitations' })).toBeVisible();
    await expect(page.getByText('223456789012345695')).toBeVisible();
    await expect(page.getByText('⏳ DM queued')).toBeVisible();

    await page.getByRole('button', { name: 'Resend', exact: true }).click();
    await expect(page.getByText('The invitation is queued for one more DM attempt.')).toBeVisible();

    await page.getByRole('button', { name: 'Revoke', exact: true }).click();
    const revokeDialog = page.getByRole('alertdialog');
    await expect(revokeDialog).toContainText('223456789012345695');
    await expect(revokeDialog).toContainText('can no longer grant dashboard access');
    await page.screenshot({ path: testInfo.outputPath('team-invitation-revoke-confirmation.png'), fullPage: true });
    await revokeDialog.getByRole('button', { name: 'Revoke invitation' }).click();
    await expect(page.getByText('Invitation revoked')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Pending Invitations' })).not.toBeVisible();
  });

  test('keeps RBAC invitation fields when the API rejects the mutation', async ({ page }) => {
    const state = {
      controls: {
        team_direct_assignment_enabled: false,
        team_invite_dm_enabled: true,
        team_max_pending_invitations: 25,
        team_invitation_expiry_ms: 259_200_000,
      },
      invitations: [] as Invitation[],
      patches: [] as Array<Record<string, unknown>>,
      userMutationError: 'This member cannot receive dashboard access until they join the server.',
    };
    await installTeamApi(page, state);
    await page.goto('/settings/team');
    await page.getByRole('button', { name: 'Add Member' }).click();

    const memberId = page.getByRole('textbox', { name: 'Member Discord ID' });
    const role = page.getByRole('combobox', { name: 'Dashboard role' });
    await memberId.fill('223456789012345695');
    await role.selectOption(ROLE.id);
    await page.getByRole('button', { name: 'Assign Role' }).click();

    await expect(page.getByText(state.userMutationError, { exact: true }).first()).toBeVisible();
    await expect(memberId).toHaveValue('223456789012345695');
    await expect(role).toHaveValue(ROLE.id);
    await expect(page.getByRole('heading', { name: 'Add Team Member' })).toBeVisible();
  });
});
