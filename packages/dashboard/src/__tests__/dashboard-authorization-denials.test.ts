import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockCreateAdmin = vi.hoisted(() => vi.fn());
const mockCreateServer = vi.hoisted(() => vi.fn());
const mockResolveLauncherLocalAuth = vi.hoisted(() => vi.fn());
const requestHeaders = vi.hoisted(() => new Map<string, string>());
const mockHeaders = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: mockCreateAdmin }));
vi.mock('@/lib/supabase/server', () => ({ createServerSupabase: mockCreateServer }));
vi.mock('@/lib/api/launcher-local-auth', () => ({
  resolveLauncherLocalAuth: mockResolveLauncherLocalAuth,
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: () => mockHeaders(),
}));

import { AuthError, authErrorResponse, requirePermission } from '@/lib/rbac';
import { requireGuildOwner } from '@/lib/api/require-owner';

type AuditRow = {
  readonly guild_id: string | null;
  readonly actor_id: string;
  readonly action: string;
  readonly success: boolean;
  readonly occurrence_key: string;
  readonly unscoped_occurrence_key?: string;
  readonly details: Record<string, unknown>;
};

const DASHBOARD_DENIAL_DOMAINS = [
  'community-reaction-roles',
  'game-economy-casino',
  'game-economy-gathering',
  'moderation-anti-raid',
  'administration-audit',
  'administration-incidents',
  'community-scheduled-messages',
  'community-welcome-onboarding',
  'game-economy-crafting',
  'game-economy-heist',
  'game-economy-shop-market',
  'moderation-automod',
  'music-collaborative-queue',
  'administration-automations',
  'administration-rbac',
  'community-starboard',
  'game-economy-achievements-prestige',
  'game-economy-farming',
  'game-economy-lottery',
  'game-economy-trivia',
  'moderation-infractions-appeals',
  'community-statistics-channels',
  'game-economy-adventures',
  'game-economy-fishing',
  'game-economy-pets',
  'moderation-message-logging',
  'commerce-product-store',
  'administration-diagnostics',
] as const;

function readChain(data: unknown) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    limit: () => chain,
    single: async () => ({ data, error: null }),
    then: (resolve: (value: { data: unknown; error: null }) => unknown) => resolve({ data, error: null }),
  };
  return chain;
}

function configuredAdmin(auditRows: AuditRow[], auditAvailable = true) {
  const guildReads: unknown[] = [[], { id: 'guild-1', owner_discord_id: 'owner-1' }];
  const roleReads: unknown[] = [[{ guild_id: 'guild-1' }], []];
  return {
    from: (table: string) => {
      if (table === 'guild') return readChain(guildReads.shift() ?? null);
      if (table === 'dashboard_user_roles') return readChain(roleReads.shift() ?? []);
      if (table === 'audit_logs') {
        return {
          upsert: async (row: AuditRow) => {
            if (!auditAvailable) throw new Error('audit unavailable');
            const duplicate = row.guild_id === null
              ? auditRows.some((existing) =>
                existing.unscoped_occurrence_key === row.unscoped_occurrence_key,
              )
              : auditRows.some((existing) =>
                existing.guild_id === row.guild_id && existing.occurrence_key === row.occurrence_key,
              );
            if (!duplicate) {
              auditRows.push(row);
            }
            return { error: null };
          },
        };
      }
      return readChain([]);
    },
  };
}

describe('dashboard authorization denial auditing', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    requestHeaders.clear();
    requestHeaders.set('x-guild-id', 'guild-1');
    requestHeaders.set('x-somnibot-request-route', '/api/incidents');
    requestHeaders.set('x-somnibot-request-method', 'PATCH');
    requestHeaders.set('x-somnibot-request-occurrence-id', 'request-1');
    mockHeaders.mockResolvedValue({ get: (name: string) => requestHeaders.get(name) ?? null });
    mockResolveLauncherLocalAuth.mockResolvedValue({ kind: 'not_configured' });
    mockCreateServer.mockResolvedValue({
      auth: {
        getUser: async () => ({
          data: { user: { id: 'user-1', identities: [{ provider: 'discord', identity_data: { sub: 'member-1' } }] } },
        }),
      },
    });
  });

  it('writes one occurrence-keyed denial row with request metadata for a repeated forbidden permission request', async () => {
    // Given
    const auditRows: AuditRow[] = [];
    mockCreateAdmin.mockReturnValue(configuredAdmin(auditRows));

    // When
    await expect(requirePermission('dashboard.manage_incidents')).rejects.toBeInstanceOf(AuthError);
    await expect(requirePermission('dashboard.manage_incidents')).rejects.toBeInstanceOf(AuthError);

    // Then
    expect(auditRows).toEqual([
      expect.objectContaining({
        guild_id: 'guild-1',
        actor_id: 'member-1',
        action: 'dashboard.authorization_denied',
        success: false,
        occurrence_key: 'dashboard.authorization_denied:request-1',
        details: expect.objectContaining({
          route: '/api/incidents',
          method: 'PATCH',
          required_permission: 'dashboard.manage_incidents',
          reason: 'permission_denied',
          status: 403,
        }),
      }),
    ]);
  });

  it('preserves the contracted forbidden response when the audit writer is unavailable', async () => {
    // Given
    mockCreateAdmin.mockReturnValue(configuredAdmin([], false));

    // When
    try {
      await requirePermission('dashboard.manage_incidents');
      throw new Error('expected a forbidden response');
    } catch (error) {
      const response = authErrorResponse(error);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'Forbidden' });
    }
  });

  it('writes a null-guild unauthenticated denial without changing the 401 body', async () => {
    // Given
    const auditRows: AuditRow[] = [];
    mockCreateAdmin.mockReturnValue(configuredAdmin(auditRows));
    mockCreateServer.mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: null } }) },
    });

    // When
    try {
      await requirePermission('dashboard.manage_incidents');
      throw new Error('expected an unauthorized response');
    } catch (error) {
      const response = authErrorResponse(error);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'Unauthorized' });
    }
    expect(auditRows).toEqual([
      expect.objectContaining({
        guild_id: null,
        actor_id: 'anonymous',
        action: 'dashboard.authorization_denied',
        success: false,
        occurrence_key: 'dashboard.authorization_denied:request-1',
        unscoped_occurrence_key: 'dashboard.authorization_denied:request-1',
        details: expect.objectContaining({
          route: '/api/incidents',
          method: 'PATCH',
          required_permission: 'dashboard.manage_incidents',
          reason: 'unauthenticated',
          status: 401,
        }),
      }),
    ]);
  });

  it('writes one null-guild denial for repeated guards in the same request occurrence', async () => {
    const auditRows: AuditRow[] = [];
    mockCreateAdmin.mockReturnValue(configuredAdmin(auditRows));
    mockCreateServer.mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: null } }) },
    });

    await expect(requirePermission('dashboard.manage_incidents')).rejects.toMatchObject({ status: 401 });
    await expect(requirePermission('dashboard.manage_incidents')).rejects.toMatchObject({ status: 401 });

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.unscoped_occurrence_key).toBe('dashboard.authorization_denied:request-1');
  });

  it('keeps the unauthenticated 401 body when request metadata is unavailable', async () => {
    mockCreateServer.mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: null } }) },
    });
    mockHeaders.mockRejectedValueOnce(new Error('request metadata unavailable'));

    try {
      await requirePermission('dashboard.manage_incidents');
      throw new Error('expected an unauthorized response');
    } catch (error) {
      const response = authErrorResponse(error);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'Unauthorized' });
    }
  });

  it('keeps the unauthenticated 401 body when audit client construction fails', async () => {
    mockCreateServer.mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: null } }) },
    });
    mockCreateAdmin.mockImplementation(() => {
      throw new Error('audit admin client unavailable');
    });

    try {
      await requirePermission('dashboard.manage_incidents');
      throw new Error('expected an unauthorized response');
    } catch (error) {
      const response = authErrorResponse(error);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'Unauthorized' });
    }
  });

  it('writes one denial row for every dashboard fleet domain fixture', async () => {
    // Given
    const auditRows: AuditRow[] = [];

    // When
    for (const domain of DASHBOARD_DENIAL_DOMAINS) {
      requestHeaders.set('x-somnibot-request-route', `/api/${domain}`);
      requestHeaders.set('x-somnibot-request-occurrence-id', `request-${domain}`);
      mockCreateAdmin.mockReturnValue(configuredAdmin(auditRows));
      await expect(requirePermission('dashboard.manage_incidents')).rejects.toBeInstanceOf(AuthError);
    }

    // Then
    expect(auditRows).toHaveLength(DASHBOARD_DENIAL_DOMAINS.length);
    expect(auditRows.every((row) => row.action === 'dashboard.authorization_denied' && row.success === false)).toBe(true);
    expect(auditRows.map((row) => row.details.route)).toEqual(
      DASHBOARD_DENIAL_DOMAINS.map((domain) => `/api/${domain}`),
    );
  });

  it('writes the shared denial audit without changing an owner guard 403 response', async () => {
    // Given
    const auditRows: AuditRow[] = [];
    mockCreateAdmin.mockReturnValue(configuredAdmin(auditRows));

    // When
    const denied = await requireGuildOwner();

    // Then
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.response.status).toBe(403);
      expect(await denied.response.json()).toEqual({ error: 'Forbidden — you are not the guild owner' });
    }
    expect(auditRows).toEqual([
      expect.objectContaining({
        guild_id: null,
        actor_id: 'member-1',
        action: 'dashboard.authorization_denied',
        details: expect.objectContaining({
          route: '/api/incidents',
          method: 'PATCH',
          required_permission: 'guild.owner',
          reason: 'not_guild_owner',
          status: 403,
        }),
      }),
    ]);
  });
});
