/**
 * DELETE /api/rbac/invitations/[id] — revoke a pending invitation.
 *
 * Revocation transitions pending → revoked atomically; if the row is not
 * pending (already accepted/expired/revoked) or belongs to another guild, the
 * conditional update matches nothing and the route returns 404.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRequirePermission = vi.fn();
vi.mock('@/lib/rbac', () => ({
  requirePermission: (...args: unknown[]) => mockRequirePermission(...args),
  authErrorResponse: vi.fn(),
}));

const mockWriteTeamAudit = vi.fn();
vi.mock('@/lib/team-invitations', () => ({
  writeTeamAudit: (...args: unknown[]) => mockWriteTeamAudit(...args),
}));

const mockRateLimit = vi.fn();
vi.mock('@/lib/api/admin-rate-limit', () => ({
  checkAdminRateLimit: (...args: unknown[]) => mockRateLimit(...args),
}));

let adminMock: ReturnType<typeof createAdminMock>;
vi.mock('@/lib/supabase/admin', () => ({
  createAdminSupabase: () => adminMock.supabase,
}));

import { DELETE } from '../app/api/rbac/invitations/[id]/route';

type QueryResult = { data?: unknown; error?: unknown };

function createAdminMock(config: Record<string, QueryResult[]>) {
  const queues: Record<string, QueryResult[]> = {};
  for (const [t, arr] of Object.entries(config)) queues[t] = [...arr];
  const updates: Array<{ table: string; payload: unknown }> = [];

  const from = vi.fn((table: string) => {
    const result = queues[table]?.length ? queues[table].shift()! : { data: null, error: null };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {};
    for (const m of ['select', 'eq', 'lt', 'order', 'limit']) chain[m] = vi.fn(() => chain);
    chain.update = vi.fn((payload: unknown) => { updates.push({ table, payload }); return chain; });
    chain.single = vi.fn(() => Promise.resolve(result));
    chain.maybeSingle = vi.fn(() => Promise.resolve(result));
    chain.then = (resolve: (v: QueryResult) => unknown) => resolve(result);
    return chain;
  });

  return { supabase: { from }, updates };
}

function ctx(id = 'inv-1') {
  return { params: Promise.resolve({ id }) };
}
function req(): Request {
  return new Request('http://localhost/api/rbac/invitations/inv-1', {
    method: 'DELETE',
    headers: { 'x-forwarded-for': '1.2.3.4' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimit.mockResolvedValue(null);
  mockRequirePermission.mockResolvedValue({ guildId: 'guild-1', discordId: '111111111111111111', isOwner: true });
  mockWriteTeamAudit.mockResolvedValue(undefined);
});

describe('DELETE /api/rbac/invitations/[id]', () => {
  it('revokes a pending invitation and audits it', async () => {
    adminMock = createAdminMock({
      team_invitations: [{ data: { id: 'inv-1', discord_id: '222222222222222222', role_id: 'role-1' }, error: null }],
    });

    const res = await DELETE(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);

    const upd = adminMock.updates.find((u) => u.table === 'team_invitations');
    expect((upd!.payload as Record<string, unknown>).status).toBe('revoked');
    expect(mockWriteTeamAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'team.invite_revoked', targetId: '222222222222222222' }),
    );
  });

  it('returns 404 when there is no pending invitation to revoke', async () => {
    adminMock = createAdminMock({ team_invitations: [{ data: null, error: null }] });
    const res = await DELETE(req(), ctx());
    expect(res.status).toBe(404);
    expect(mockWriteTeamAudit).not.toHaveBeenCalled();
  });
});
