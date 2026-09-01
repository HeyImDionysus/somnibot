import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ admin: vi.fn(), server: vi.fn(), local: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: mocks.admin }));
vi.mock('@/lib/supabase/server', () => ({ createServerSupabase: mocks.server }));
vi.mock('@/lib/api/launcher-local-auth', () => ({ resolveLauncherLocalAuth: mocks.local }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers({
    'x-guild-id': 'guild-1', 'x-somnibot-request-route': '/api/store/products',
    'x-somnibot-request-method': 'GET', 'x-somnibot-request-occurrence-id': 'request-1',
  }),
}));

import { getAuthContext, requirePermission } from '@/lib/rbac';

type AuditRow = {
  readonly guild_id: string;
  readonly actor_id: string;
  readonly action: string;
  readonly success: boolean;
  readonly occurrence_key: string;
  readonly details: Record<string, unknown>;
};

function assignment() {
  return {
    id: 'assignment-1', guild_id: 'guild-1', discord_id: 'staff-1', role_id: 'role-1',
    assigned_at: '2026-08-31T12:00:00Z',
    dashboard_roles: {
      id: 'role-1', guild_id: 'guild-1', updated_at: '2026-08-31T11:00:00Z',
      permissions: ['dashboard.manage_store'],
    },
  };
}

function setup(options: {
  readonly owner?: boolean;
  readonly verified?: boolean;
  readonly available?: boolean;
  readonly assignments?: ReturnType<typeof assignment>[];
} = {}) {
  const rows: AuditRow[] = [];
  const filters: [string, string, unknown][] = [];
  const assignments = options.assignments ?? [assignment()];
  mocks.server.mockResolvedValue({ auth: { getUser: async () => ({ data: { user: {
    id: 'user-1', user_metadata: { provider_id: 'staff-1' },
    identities: options.verified === false ? [] : [{ provider: 'discord', identity_data: { sub: 'staff-1' } }],
  } } }) } });
  mocks.admin.mockReturnValue({ from: (table: string) => {
    let ownerQuery = false;
    let roleLookup = false;
    const result = () => ({ error: null, data: table === 'guild'
      ? (ownerQuery ? (options.owner ? [{ id: 'guild-1', owner_discord_id: 'staff-1' }] : [])
        : { id: 'guild-1', owner_discord_id: 'owner-1' })
      : (roleLookup ? assignments : [{ guild_id: 'guild-1' }]) });
    const chain = {
      select: (columns: string) => { roleLookup = columns.includes('role_id'); return chain; },
      eq: (column: string, value: unknown) => {
        filters.push([table, column, value]); ownerQuery ||= column === 'owner_discord_id'; return chain;
      },
      limit: () => chain,
      single: async () => result(),
      then: (resolve: (value: ReturnType<typeof result>) => unknown) => resolve(result()),
      upsert: async (row: AuditRow, policy: { readonly ignoreDuplicates: boolean }) => {
        if (options.available === false) throw new Error('private database failure');
        if (!policy.ignoreDuplicates || !rows.some((existing) => existing.guild_id === row.guild_id
          && existing.occurrence_key === row.occurrence_key)) rows.push(row);
        return { error: null };
      },
    };
    return chain;
  } });
  return { rows, filters, assignments };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-31T14:10:00Z'));
  mocks.local.mockResolvedValue({ kind: 'not_configured' });
});
afterEach(() => vi.useRealTimers());

describe('real staff permission observation', () => {
  it('records only the selected guild and verified staff permission decision', async () => {
    // Given a scoped staff role and verified provider identity.
    const { rows, filters } = setup();
    // When the actual permission guard succeeds.
    await requirePermission('dashboard.manage_store');
    // Then the authoritative observation is authorization, not action completion.
    expect(rows).toEqual([expect.objectContaining({
      guild_id: 'guild-1', actor_id: 'staff-1', action: 'dashboard.authorization_allowed', success: true,
      details: expect.objectContaining({ required_permission: 'dashboard.manage_store',
        rbac_identity: expect.stringMatching(/^[a-f0-9]{64}$/), authorization_only: true }),
    })]);
    expect(filters).toContainEqual(['dashboard_user_roles', 'guild_id', 'guild-1']);
    expect(filters).toContainEqual(['dashboard_user_roles', 'discord_id', 'staff-1']);
  });

  it('records expected denial with current staff identity and no allowed proof', async () => {
    // Given staff without the requested permission.
    const { rows } = setup();
    // When the guard rejects the actual request.
    await expect(requirePermission('dashboard.manage_team')).rejects.toMatchObject({ status: 403 });
    // Then failure is the expected authorization result.
    expect(rows).toEqual([expect.objectContaining({ action: 'dashboard.authorization_denied', success: false,
      details: expect.objectContaining({ required_permission: 'dashboard.manage_team',
        rbac_identity: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    })]);
  });

  it.each(['owner', 'no_permission'] as const)('excludes %s shortcuts', async (kind) => {
    // Given a shortcut without a specific limited-staff authorization decision.
    const role = assignment();
    const { rows } = setup({ owner: kind === 'owner', assignments: [role] });
    // When authorization is requested.
    await requirePermission(kind === 'no_permission' ? null : 'dashboard.manage_store');
    // Then it supplies no staff activation proof.
    expect(rows).toHaveLength(0);
  });

  it('records a specific check for non-owner staff assigned full access', async () => {
    const role = assignment();
    role.dashboard_roles.permissions = ['dashboard.full_access'];
    const { rows } = setup({ assignments: [role] });
    await requirePermission('dashboard.manage_store');
    expect(rows).toEqual([expect.objectContaining({ action: 'dashboard.authorization_allowed',
      details: expect.objectContaining({ required_permission: 'dashboard.manage_store' }),
    })]);
  });

  it('does not trust editable actor metadata', async () => {
    // Given an actor claim without a verified identity.
    const { rows } = setup({ verified: false });
    // When authorization is requested.
    await expect(requirePermission('dashboard.manage_store')).rejects.toMatchObject({ status: 401 });
    // Then no staff allowed proof can be recorded.
    expect(rows.every((row) => row.action === 'dashboard.authorization_denied')).toBe(true);
    expect(rows.every((row) => row.details.rbac_identity === undefined)).toBe(true);
  });

  it('does not create proof merely by resolving authentication', async () => {
    // Given verified assigned staff.
    const { rows } = setup();
    // When no specific permission is checked.
    await getAuthContext();
    // Then no proof was produced.
    expect(rows).toHaveLength(0);
  });

  it('deduplicates repeated permission checks within the hour', async () => {
    // Given one unchanged identity and hour bucket.
    const { rows } = setup();
    // When the same permission guard is used repeatedly.
    await Promise.all(Array.from({ length: 5 }, () => requirePermission('dashboard.manage_store')));
    // Then only one occurrence is retained.
    expect(rows).toHaveLength(1);
  });

  it('records a fresh observation in the next hour bucket', async () => {
    const { rows } = setup();
    await requirePermission('dashboard.manage_store');
    vi.setSystemTime(new Date('2026-08-31T15:10:00Z'));
    await requirePermission('dashboard.manage_store');
    expect(rows).toHaveLength(2);
    expect(rows[1]?.occurrence_key).not.toEqual(rows[0]?.occurrence_key);
  });

  it.each(['guild', 'actor', 'role_guild', 'role_id'] as const)('omits proof with mismatched %s assignment data', async (kind) => {
    const role = assignment();
    if (kind === 'guild') role.guild_id = 'guild-other';
    if (kind === 'actor') role.discord_id = 'staff-other';
    if (kind === 'role_guild') role.dashboard_roles.guild_id = 'guild-other';
    if (kind === 'role_id') role.dashboard_roles.id = 'role-other';
    const { rows } = setup({ assignments: [role] });
    await requirePermission('dashboard.manage_store');
    expect(rows).toHaveLength(0);
  });

  it.each(['assignment', 'permissions', 'role_revision'] as const)('invalidates identity after %s changes', async (kind) => {
    // Given a previous permission observation.
    const { rows, assignments } = setup();
    await requirePermission('dashboard.manage_store');
    const prior = rows[0]?.details.rbac_identity;
    const role = assignments[0];
    if (!role) throw new Error('missing fixture');
    if (kind === 'assignment') role.id = 'replacement-assignment';
    if (kind === 'permissions') role.dashboard_roles.permissions.push('dashboard.view_audit');
    if (kind === 'role_revision') role.dashboard_roles.updated_at = '2026-08-31T14:11:00Z';
    // When the current guard observes changed authority.
    await requirePermission('dashboard.manage_store');
    // Then old proof no longer matches the current identity.
    expect(rows).toHaveLength(2);
    expect(rows[1]?.details.rbac_identity).not.toEqual(prior);
  });

  it('leaves authorization unchanged when best-effort audit storage fails', async () => {
    // Given a functioning permission lookup but unavailable audit writer.
    const { rows } = setup({ available: false });
    // When authorization succeeds.
    await expect(requirePermission('dashboard.manage_store')).resolves.toMatchObject({ isOwner: false });
    // Then missing audit does not become proof or fail the protected request.
    expect(rows).toHaveLength(0);
  });
});
