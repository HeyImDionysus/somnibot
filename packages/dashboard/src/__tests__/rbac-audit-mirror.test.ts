/**
 * RBAC / team-management observability.
 *
 * The RBAC dashboard routes must now write an append-only audit_logs row for
 * every role mutation, raise an `escalation_blocked` owner alert when a
 * privilege-escalation attempt is denied, and audit + mirror a live role revoke.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRequirePermission = vi.fn();
vi.mock('@/lib/rbac', () => ({
  requirePermission: (...a: unknown[]) => mockRequirePermission(...a),
  authErrorResponse: vi.fn(),
}));

const mockParseBody = vi.fn();
vi.mock('@/lib/api/validation', () => ({
  parseBody: (...a: unknown[]) => mockParseBody(...a),
  schemas: {},
}));

vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/api/csrf', () => ({ invalidateCsrfCookies: vi.fn() }));

const mockLoadTeamConfig = vi.fn();
const mockWriteTeamAudit = vi.fn();
vi.mock('@/lib/team-invitations', () => ({
  loadTeamConfig: (...a: unknown[]) => mockLoadTeamConfig(...a),
  writeTeamAudit: (...a: unknown[]) => mockWriteTeamAudit(...a),
}));

const mockCreateAdmin = vi.fn();
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: () => mockCreateAdmin() }));

import { POST as ROLES_POST, PATCH as ROLES_PATCH } from '@/app/api/rbac/roles/route';
import { POST as USERS_POST, DELETE as USERS_DELETE } from '@/app/api/rbac/users/route';

function tableMock(config: Record<string, Array<Record<string, unknown>>> = {}) {
  const queues: Record<string, Array<Record<string, unknown>>> = {};
  for (const [t, arr] of Object.entries(config)) queues[t] = [...arr];
  const inserts: Array<{ table: string; payload: any }> = [];
  const updates: Array<{ table: string; payload: any }> = [];
  const from = vi.fn((table: string) => {
    const result = queues[table]?.length ? queues[table].shift()! : { data: null, error: null };
    const chain: any = {};
    for (const m of ['select', 'eq', 'order', 'range', 'limit', 'in']) chain[m] = vi.fn(() => chain);
    chain.insert = vi.fn((p: any) => { inserts.push({ table, payload: p }); return chain; });
    chain.update = vi.fn((p: any) => { updates.push({ table, payload: p }); return chain; });
    chain.delete = vi.fn(() => chain);
    chain.single = vi.fn(() => Promise.resolve(result));
    chain.maybeSingle = vi.fn(() => Promise.resolve(result));
    chain.then = (r: (v: any) => unknown) => r(result);
    return chain;
  });
  return { admin: { from, rpc: vi.fn().mockResolvedValue({ data: 7, error: null }) }, inserts, updates };
}

function req(path: string, method: string) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '1.2.3.4' },
  }) as unknown as import('next/server').NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('rbac/roles audit', () => {
  it('writes an rbac.role_created audit row on create', async () => {
    mockRequirePermission.mockResolvedValue({ guildId: 'guild-1', discordId: 'actor-1' });
    mockParseBody.mockResolvedValue({ ok: true, data: { name: 'Support', permissions: ['x'], priority: 5 } });
    const { admin, inserts } = tableMock({ dashboard_roles: [{ data: { id: 'role-new' }, error: null }] });
    mockCreateAdmin.mockReturnValue(admin);

    const res = await ROLES_POST(req('/api/rbac/roles', 'POST'));
    expect(res.status).toBe(200);
    expect(inserts.some((i) => i.table === 'audit_logs' && i.payload.action === 'rbac.role_created')).toBe(true);
  });

  it('audits the denial and raises escalation_blocked when editing a system role', async () => {
    mockRequirePermission.mockResolvedValue({ guildId: 'guild-1', discordId: 'actor-1' });
    mockParseBody.mockResolvedValue({ ok: true, data: { id: 'sys-role', permissions: ['dashboard.full_access'] } });
    const { admin, inserts } = tableMock({ dashboard_roles: [{ data: { is_system: true, name: 'admin' }, error: null }] });
    mockCreateAdmin.mockReturnValue(admin);

    const res = await ROLES_PATCH(req('/api/rbac/roles', 'PATCH'));
    expect(res.status).toBe(403);
    expect(inserts.some((i) => i.table === 'audit_logs' && i.payload.action === 'rbac.role_update_denied' && i.payload.success === false)).toBe(true);
    expect(inserts.some((i) => i.table === 'alerts' && i.payload.alert_type === 'escalation_blocked')).toBe(true);
  });
});

describe('rbac/users escalation + revoke observability', () => {
  it('raises escalation_blocked when a lower-priority actor assigns a higher role', async () => {
    mockRequirePermission.mockResolvedValue({ guildId: 'guild-1', discordId: 'actor-1', isOwner: false });
    mockParseBody.mockResolvedValue({
      ok: true,
      data: { discord_id: '222222222222222222', role_id: '00000000-0000-0000-0000-000000000001' },
    });
    const { admin, inserts } = tableMock({
      dashboard_roles: [{ data: { priority: 5, is_system: false }, error: null }],
      dashboard_user_roles: [{ data: [], error: null }], // assigner holds nothing → max priority 0
    });
    mockCreateAdmin.mockReturnValue(admin);

    const res = await USERS_POST(req('/api/rbac/users', 'POST'));
    expect(res.status).toBe(403);
    expect(inserts.some((i) => i.table === 'audit_logs' && i.payload.action === 'rbac.role_assign_denied' && i.payload.success === false)).toBe(true);
    expect(inserts.some((i) => i.table === 'alerts' && i.payload.alert_type === 'escalation_blocked')).toBe(true);
  });

  it('audits and mirrors a live role revoke', async () => {
    mockRequirePermission.mockResolvedValue({ guildId: 'guild-1', discordId: 'actor-1' });
    const { admin, inserts } = tableMock({
      dashboard_user_roles: [{ data: { discord_id: '222222222222222222', role_id: 'role-1' }, error: null }],
    });
    mockCreateAdmin.mockReturnValue(admin);

    const res = await USERS_DELETE(req('/api/rbac/users?id=assignment-1', 'DELETE'));
    expect(res.status).toBe(200);
    expect(mockWriteTeamAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'team.role_revoked', targetId: '222222222222222222' }),
    );
    expect(inserts.some((i) => i.table === 'alerts' && i.payload.alert_type === 'team_role_revoked')).toBe(true);
  });
});
