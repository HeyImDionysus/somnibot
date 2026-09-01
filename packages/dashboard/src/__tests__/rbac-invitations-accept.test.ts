/**
 * POST /api/rbac/invitations/[id]/accept — acceptance binds to the invited id.
 *
 * Only the signed-in Discord identity matching invitation.discord_id may accept
 * (accept-foreign-invitation is deny → 404, no leak). Acceptance claims the
 * pending row atomically before writing the grant, and a replay on an already
 * accepted invitation is idempotent. Revoked/expired invitations can never be
 * accepted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.CSRF_SECRET = 'test-csrf-secret-32chars-minimum';

const mockGetSession = vi.fn();
const mockWriteTeamAudit = vi.fn();
vi.mock('@/lib/team-invitations', () => ({
  getSessionIdentity: (...args: unknown[]) => mockGetSession(...args),
  writeTeamAudit: (...args: unknown[]) => mockWriteTeamAudit(...args),
}));

const mockRequireAuth = vi.fn();
vi.mock('@/lib/api/require-owner', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
}));

const mockRateLimit = vi.fn();
vi.mock('@/lib/api/admin-rate-limit', () => ({
  checkAdminRateLimit: (...args: unknown[]) => mockRateLimit(...args),
}));

let adminMock: ReturnType<typeof createAdminMock>;
vi.mock('@/lib/supabase/admin', () => ({
  createAdminSupabase: () => adminMock.supabase,
}));

import { POST } from '../app/api/rbac/invitations/[id]/accept/route';

type QueryResult = { data?: unknown; error?: unknown; count?: number };

function createAdminMock(config: Record<string, QueryResult[]>) {
  const queues: Record<string, QueryResult[]> = {};
  for (const [t, arr] of Object.entries(config)) queues[t] = [...arr];
  const inserts: Array<{ table: string; payload: unknown }> = [];
  const updates: Array<{ table: string; payload: unknown }> = [];
  const rpc = vi.fn(() => Promise.resolve(
    queues.accept_team_invitation_atomic?.shift() ?? { data: null, error: null },
  ));

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

  return { supabase: { from, rpc }, inserts, updates, rpc };
}

const SESSION = { userId: 'u1', discordId: '222222222222222222' };
const future = () => new Date(Date.now() + 3_600_000).toISOString();
const past = () => new Date(Date.now() - 1_000).toISOString();

function ctx(id = 'inv-1') {
  return { params: Promise.resolve({ id }) };
}
function req(): Request {
  return new Request('http://localhost/api/rbac/invitations/inv-1/accept', {
    method: 'POST',
    headers: { 'x-forwarded-for': '1.2.3.4' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimit.mockResolvedValue(null);
  mockGetSession.mockResolvedValue(SESSION);
  mockRequireAuth.mockResolvedValue({ ok: true, userId: SESSION.userId, discordId: SESSION.discordId });
  mockWriteTeamAudit.mockResolvedValue(undefined);
});

describe('POST /api/rbac/invitations/[id]/accept', () => {
  it('accepts the invitee\'s own pending invitation and creates the grant', async () => {
    const inv = {
      id: 'inv-1',
      guild_id: 'guild-1',
      discord_id: SESSION.discordId,
      role_id: 'role-1',
      invited_by: '111111111111111111',
      status: 'pending',
      expires_at: future(),
    };
    adminMock = createAdminMock({
      team_invitations: [
        { data: inv, error: null }, // initial fetch
      ],
      accept_team_invitation_atomic: [{
        data: [{ outcome: 'accepted', invitation_id: 'inv-1', guild_id: 'guild-1', role_id: 'role-1' }],
        error: null,
      }],
    });

    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.role_id).toBe('role-1');

    expect(adminMock.rpc).toHaveBeenCalledWith('accept_team_invitation_atomic', {
      p_invitation_id: 'inv-1',
      p_discord_id: SESSION.discordId,
    });
    expect(adminMock.inserts.some((i) => i.table === 'dashboard_user_roles')).toBe(false);
    expect(adminMock.updates.some((i) => i.table === 'team_invitations')).toBe(false);
    expect(mockWriteTeamAudit).not.toHaveBeenCalled();
  });

  it('returns 404 for a foreign invitation (no info leak)', async () => {
    const inv = {
      id: 'inv-1',
      guild_id: 'guild-1',
      discord_id: '999999999999999999', // not the session id
      role_id: 'role-1',
      invited_by: '111111111111111111',
      status: 'pending',
      expires_at: future(),
    };
    adminMock = createAdminMock({ team_invitations: [{ data: inv, error: null }] });

    const res = await POST(req(), ctx());
    expect(res.status).toBe(404);
    expect(adminMock.inserts.some((i) => i.table === 'dashboard_user_roles')).toBe(false);
  });

  it('returns 404 when the invitation does not exist', async () => {
    adminMock = createAdminMock({ team_invitations: [{ data: null, error: null }] });
    const res = await POST(req(), ctx());
    expect(res.status).toBe(404);
  });

  it('rejects a revoked invitation with 409', async () => {
    const inv = {
      id: 'inv-1', guild_id: 'guild-1', discord_id: SESSION.discordId,
      role_id: 'role-1', invited_by: '111111111111111111', status: 'revoked', expires_at: future(),
    };
    adminMock = createAdminMock({
      team_invitations: [{ data: inv, error: null }],
      accept_team_invitation_atomic: [{
        data: [{ outcome: 'revoked', invitation_id: 'inv-1', guild_id: 'guild-1', role_id: 'role-1' }],
        error: null,
      }],
    });
    const res = await POST(req(), ctx());
    expect(res.status).toBe(409);
    expect(adminMock.inserts.some((i) => i.table === 'dashboard_user_roles')).toBe(false);
  });

  it('rejects an expired invitation with 409', async () => {
    const inv = {
      id: 'inv-1', guild_id: 'guild-1', discord_id: SESSION.discordId,
      role_id: 'role-1', invited_by: '111111111111111111', status: 'pending', expires_at: past(),
    };
    adminMock = createAdminMock({
      team_invitations: [{ data: inv, error: null }],
      accept_team_invitation_atomic: [{
        data: [{ outcome: 'expired', invitation_id: 'inv-1', guild_id: 'guild-1', role_id: 'role-1' }],
        error: null,
      }],
    });
    const res = await POST(req(), ctx());
    expect(res.status).toBe(409);
    expect(adminMock.inserts.some((i) => i.table === 'dashboard_user_roles')).toBe(false);
  });

  it('is idempotent on an already-accepted invitation', async () => {
    const inv = {
      id: 'inv-1', guild_id: 'guild-1', discord_id: SESSION.discordId,
      role_id: 'role-1', invited_by: '111111111111111111', status: 'accepted', expires_at: future(),
    };
    adminMock = createAdminMock({
      team_invitations: [{ data: inv, error: null }],
      accept_team_invitation_atomic: [{
        data: [{ outcome: 'already_accepted', invitation_id: 'inv-1', guild_id: 'guild-1', role_id: 'role-1' }],
        error: null,
      }],
    });
    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.alreadyAccepted).toBe(true);
  });

  it('returns 401 when unauthenticated', async () => {
    mockRequireAuth.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    });
    adminMock = createAdminMock({});
    const res = await POST(req(), ctx());
    expect(res.status).toBe(401);
  });
});
