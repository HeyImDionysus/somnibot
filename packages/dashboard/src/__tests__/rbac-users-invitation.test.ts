/**
 * POST /api/rbac/users — consent-based invitation model.
 *
 * With direct-assignment-enabled=false (the shipped default) an add-member POST
 * must create a PENDING team_invitations row — never a live dashboard_user_roles
 * assignment — honoring max-pending-invitations and the DM toggle. Only when the
 * owner opts into direct assignment does the route write a live grant.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.CSRF_SECRET = 'test-csrf-secret-32chars-minimum';

import { NextRequest } from 'next/server';

const mockRequirePermission = vi.fn();
vi.mock('@/lib/rbac', () => ({
  requirePermission: (...args: unknown[]) => mockRequirePermission(...args),
  authErrorResponse: vi.fn(),
}));

const mockRateLimit = vi.fn();
vi.mock('@/lib/api/admin-rate-limit', () => ({
  checkAdminRateLimit: (...args: unknown[]) => mockRateLimit(...args),
}));

const mockParseBody = vi.fn();
vi.mock('@/lib/api/validation', () => ({
  parseBody: (...args: unknown[]) => mockParseBody(...args),
  schemas: {},
}));

const mockLoadTeamConfig = vi.fn();
const mockWriteTeamAudit = vi.fn();
vi.mock('@/lib/team-invitations', () => ({
  loadTeamConfig: (...args: unknown[]) => mockLoadTeamConfig(...args),
  writeTeamAudit: (...args: unknown[]) => mockWriteTeamAudit(...args),
}));

let adminMock: ReturnType<typeof createAdminMock>;
vi.mock('@/lib/supabase/admin', () => ({
  createAdminSupabase: () => adminMock.supabase,
}));

import { POST } from '../app/api/rbac/users/route';

// ── Table-dispatch supabase mock ────────────────────────────
type QueryResult = { data?: unknown; error?: unknown; count?: number };

function createAdminMock(config: Record<string, QueryResult[]>) {
  const queues: Record<string, QueryResult[]> = {};
  for (const [t, arr] of Object.entries(config)) queues[t] = [...arr];
  const inserts: Array<{ table: string; payload: unknown }> = [];
  const updates: Array<{ table: string; payload: unknown }> = [];

  const from = vi.fn((table: string) => {
    const result = queues[table]?.length ? queues[table].shift()! : { data: null, error: null };
    const chain: any = {};
    for (const m of ['select', 'eq', 'lt', 'gte', 'gt', 'order', 'limit', 'in', 'neq']) {
      chain[m] = vi.fn(() => chain);
    }
    chain.insert = vi.fn((payload: unknown) => { inserts.push({ table, payload }); return chain; });
    chain.update = vi.fn((payload: unknown) => { updates.push({ table, payload }); return chain; });
    chain.delete = vi.fn(() => chain);
    chain.single = vi.fn(() => Promise.resolve(result));
    chain.maybeSingle = vi.fn(() => Promise.resolve(result));
    chain.then = (resolve: (v: QueryResult) => unknown) => resolve(result);
    return chain;
  });

  return { supabase: { from }, inserts, updates };
}

function req(): NextRequest {
  return new NextRequest('http://localhost/api/rbac/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4' },
  });
}

const CONSENT_CONFIG = {
  directAssignmentEnabled: false,
  inviteDmEnabled: true,
  maxPendingInvitations: 25,
  invitationExpiryMs: 259_200_000,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimit.mockResolvedValue(null);
  mockRequirePermission.mockResolvedValue({
    guildId: 'guild-1',
    discordId: '111111111111111111',
    isOwner: true,
  });
  mockParseBody.mockResolvedValue({
    ok: true,
    data: { discord_id: '222222222222222222', role_id: '00000000-0000-0000-0000-000000000001' },
  });
  mockWriteTeamAudit.mockResolvedValue(undefined);
});

describe('POST /api/rbac/users — consent model', () => {
  it('creates a PENDING invitation (not a live assignment) under the default', async () => {
    mockLoadTeamConfig.mockResolvedValue(CONSENT_CONFIG);
    adminMock = createAdminMock({
      dashboard_roles: [{ data: { priority: 1, is_system: false }, error: null }],
      dashboard_user_roles: [{ data: null, error: null }], // no existing assignment
      team_invitations: [
        { count: 0 }, // pending count
        { data: { id: 'inv-1', dashboard_roles: { name: 'moderator' } }, error: null }, // insert
      ],
    });

    const res = await POST(req());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.mode).toBe('invitation');
    expect(json.data.id).toBe('inv-1');

    // Exactly one team_invitations insert, pending + DM-queued; no live grant.
    const invInsert = adminMock.inserts.find((i) => i.table === 'team_invitations');
    expect(invInsert).toBeTruthy();
    const payload = invInsert!.payload as Record<string, unknown>;
    expect(payload.status).toBe('pending');
    expect(payload.dm_status).toBe('queued');
    expect(payload.invited_by).toBe('111111111111111111');
    expect(typeof payload.expires_at).toBe('string');
    expect(adminMock.inserts.some((i) => i.table === 'dashboard_user_roles')).toBe(false);
    expect(mockWriteTeamAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'team.invite_sent', targetId: '222222222222222222' }),
    );
  });

  it('records dashboard-only delivery when invite-dm-enabled is false', async () => {
    mockLoadTeamConfig.mockResolvedValue({ ...CONSENT_CONFIG, inviteDmEnabled: false });
    adminMock = createAdminMock({
      dashboard_roles: [{ data: { priority: 1, is_system: false }, error: null }],
      dashboard_user_roles: [{ data: null, error: null }],
      team_invitations: [{ count: 0 }, { data: { id: 'inv-2' }, error: null }],
    });

    const res = await POST(req());
    expect(res.status).toBe(200);
    const payload = adminMock.inserts.find((i) => i.table === 'team_invitations')!.payload as Record<string, unknown>;
    expect(payload.dm_status).toBe('skipped');
    expect(payload.delivery_mode).toBe('dashboard');
  });

  it('rejects with 409 when max-pending-invitations is reached', async () => {
    mockLoadTeamConfig.mockResolvedValue({ ...CONSENT_CONFIG, maxPendingInvitations: 2 });
    adminMock = createAdminMock({
      dashboard_roles: [{ data: { priority: 1, is_system: false }, error: null }],
      dashboard_user_roles: [{ data: null, error: null }],
      team_invitations: [{ count: 2 }], // at the cap
    });

    const res = await POST(req());
    expect(res.status).toBe(409);
    expect(adminMock.inserts.some((i) => i.table === 'team_invitations')).toBe(false);
  });

  it('rejects with 409 when the member already holds the role', async () => {
    mockLoadTeamConfig.mockResolvedValue(CONSENT_CONFIG);
    adminMock = createAdminMock({
      dashboard_roles: [{ data: { priority: 1, is_system: false }, error: null }],
      dashboard_user_roles: [{ data: { id: 'existing-assignment' }, error: null }],
    });

    const res = await POST(req());
    expect(res.status).toBe(409);
    expect(adminMock.inserts.some((i) => i.table === 'team_invitations')).toBe(false);
  });

  it('surfaces a duplicate pending invitation (23505) as 409', async () => {
    mockLoadTeamConfig.mockResolvedValue(CONSENT_CONFIG);
    adminMock = createAdminMock({
      dashboard_roles: [{ data: { priority: 1, is_system: false }, error: null }],
      dashboard_user_roles: [{ data: null, error: null }],
      team_invitations: [{ count: 0 }, { data: null, error: { code: '23505' } }],
    });

    const res = await POST(req());
    expect(res.status).toBe(409);
  });

  it('writes a LIVE assignment when direct-assignment-enabled is true', async () => {
    mockLoadTeamConfig.mockResolvedValue({ ...CONSENT_CONFIG, directAssignmentEnabled: true });
    adminMock = createAdminMock({
      dashboard_roles: [{ data: { priority: 1, is_system: false }, error: null }],
      dashboard_user_roles: [{ data: { id: 'a1', dashboard_roles: { name: 'mod' } }, error: null }],
    });

    const res = await POST(req());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.mode).toBe('direct');
    expect(adminMock.inserts.some((i) => i.table === 'dashboard_user_roles')).toBe(true);
    expect(adminMock.inserts.some((i) => i.table === 'team_invitations')).toBe(false);
  });
});
