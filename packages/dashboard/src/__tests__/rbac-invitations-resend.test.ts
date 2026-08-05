/** POST /api/rbac/invitations/[id]/resend — one pending delivery retry. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockRequirePermission = vi.fn();
const mockLoadTeamConfig = vi.fn();
const mockWriteTeamAudit = vi.fn();
vi.mock('@/lib/rbac', () => ({ requirePermission: (...args: unknown[]) => mockRequirePermission(...args) }));
vi.mock('@/lib/team-invitations', () => ({
  loadTeamConfig: (...args: unknown[]) => mockLoadTeamConfig(...args),
  writeTeamAudit: (...args: unknown[]) => mockWriteTeamAudit(...args),
}));
const mockRateLimit = vi.fn();
vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: (...args: unknown[]) => mockRateLimit(...args) }));

let adminMock: ReturnType<typeof createAdminMock>;
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: () => adminMock.supabase }));

type QueryResult = { data?: unknown; error?: unknown };

function createAdminMock(config: Record<string, QueryResult[]>) {
  const queues: Record<string, QueryResult[]> = {};
  for (const [table, results] of Object.entries(config)) queues[table] = [...results];
  const updates: Array<{ table: string; payload: unknown; filters: Record<string, unknown> }> = [];
  const from = vi.fn((table: string) => {
    const result = queues[table]?.length ? queues[table].shift()! : { data: null, error: null };
    const filters: Record<string, unknown> = {};
    const chain: any = {};
    for (const method of ['select', 'eq', 'gt', 'lt', 'order', 'limit']) {
      chain[method] = vi.fn((key: string, value: unknown) => {
        if (method !== 'select' && method !== 'order' && method !== 'limit') filters[key] = value;
        return chain;
      });
    }
    chain.update = vi.fn((payload: unknown) => {
      updates.push({ table, payload, filters });
      return chain;
    });
    chain.maybeSingle = vi.fn(() => Promise.resolve(result));
    chain.single = vi.fn(() => Promise.resolve(result));
    chain.then = (resolve: (value: QueryResult) => unknown) => resolve(result);
    return chain;
  });
  return { supabase: { from }, updates };
}

function req(): NextRequest {
  return new NextRequest('http://localhost/api/rbac/invitations/inv-1/resend', {
    method: 'POST',
    headers: { 'x-forwarded-for': '10.0.0.1' },
  });
}

function ctx(id = 'inv-1') {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimit.mockResolvedValue(null);
  mockRequirePermission.mockResolvedValue({ guildId: 'guild-1', discordId: 'owner-1', isOwner: true });
  mockLoadTeamConfig.mockResolvedValue({
    directAssignmentEnabled: false,
    inviteDmEnabled: true,
    maxPendingInvitations: 25,
    invitationExpiryMs: 259_200_000,
  });
  mockWriteTeamAudit.mockResolvedValue(undefined);
});

describe('POST /api/rbac/invitations/[id]/resend', () => {
  it('re-queues exactly one pending invitation without changing its expiry', async () => {
    adminMock = createAdminMock({
      team_invitations: [{ data: {
        id: 'inv-1', guild_id: 'guild-1', discord_id: 'member-1', role_id: 'role-1',
        status: 'pending', expires_at: '2030-01-01T00:00:00.000Z',
      }, error: null }],
    });
    const { POST } = await import('../app/api/rbac/invitations/[id]/resend/route');
    const response = await POST(req(), ctx());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.mode).toBe('dm');
    const update = adminMock.updates.find((item) => item.table === 'team_invitations');
    expect(update?.payload).toEqual({ dm_status: 'queued', delivery_mode: null });
    expect(update?.filters.status).toBe('pending');
    expect(mockWriteTeamAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'team.invite_resent', correlationId: 'team-invitation:inv-1' }));
  });

  it('suppresses delivery when invite DMs are disabled', async () => {
    mockLoadTeamConfig.mockResolvedValue({
      directAssignmentEnabled: false, inviteDmEnabled: false, maxPendingInvitations: 25, invitationExpiryMs: 259_200_000,
    });
    adminMock = createAdminMock({
      team_invitations: [{ data: {
        id: 'inv-1', guild_id: 'guild-1', discord_id: 'member-1', role_id: 'role-1',
        status: 'pending', expires_at: '2030-01-01T00:00:00.000Z',
      }, error: null }],
    });
    const { POST } = await import('../app/api/rbac/invitations/[id]/resend/route');
    const response = await POST(req(), ctx());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.mode).toBe('dashboard');
    expect(adminMock.updates[0]?.payload).toEqual({ dm_status: 'skipped', delivery_mode: 'dashboard' });
  });

  it('does not reopen a terminal or expired invitation', async () => {
    adminMock = createAdminMock({ team_invitations: [{ data: null, error: null }] });
    const { POST } = await import('../app/api/rbac/invitations/[id]/resend/route');
    const response = await POST(req(), ctx());
    const body = await response.json();
    expect(response.status).toBe(409);
    expect(body.message).toMatch(/fresh invitation/i);
    expect(mockWriteTeamAudit).not.toHaveBeenCalled();
  });
});
