/**
 * rbac-roles-route.live.test — drive the REAL /api/rbac/roles handlers through
 * the REAL requirePermission guard against LOCAL Supabase (real-session harness,
 * zero prod edits). Un-gates administration-rbac and proves the live
 * privilege-escalation guard: a custom role round-trips (create/update/delete
 * with rbac.* audit rows), but a SYSTEM role is immutable — PATCH/DELETE are
 * refused 403, audited as *_denied, and page the owner via an alert row.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  armDashboardLiveEnv,
  localSupabaseReachable,
  createOwnerSession,
  buildNextHeadersMock,
  type OwnerSession,
} from './_session-harness';

const SUPA_URL = armDashboardLiveEnv();

const holder: ReturnType<typeof buildNextHeadersMock> = vi.hoisted(() => ({
  cookies: async () => ({ getAll: () => [] as import('./_session-harness').CookieRecord[], get: () => undefined, set: () => {} }),
  headers: async () => ({ get: () => null, has: () => false }),
}));
vi.mock('next/headers', () => ({
  cookies: () => holder.cookies(),
  headers: () => holder.headers(),
}));

const reachable = await localSupabaseReachable(SUPA_URL);

describe.skipIf(!reachable)('LIVE: /api/rbac/roles (real-session harness)', () => {
  const suffix = `${Date.now()}`;
  const guildId = `e2e-dash-rbac-${suffix}`;
  const ownerDiscordId = `e2e-owner-rbac-${suffix}`;
  const admin: SupabaseClient = createClient(SUPA_URL, process.env.SUPABASE_SECRET_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  let session: OwnerSession;
  let customRoleId: string;
  let systemRoleId: string;
  let systemRolePerms: string[];

  beforeAll(async () => {
    await admin.from('guild').upsert(
      { id: guildId, name: 'E2E Dash RBAC Guild', owner_discord_id: ownerDiscordId },
      { onConflict: 'id' },
    );
    // Creating the guild auto-seeds the system roles (owner/admin/moderator/…)
    // via a DB trigger — reuse one to prove system-role immutability.
    const { data: sys } = await admin
      .from('dashboard_roles')
      .select('id, permissions')
      .eq('guild_id', guildId)
      .eq('name', 'moderator')
      .single();
    systemRoleId = (sys as { id: string; permissions: string[] }).id;
    systemRolePerms = (sys as { permissions: string[] }).permissions;

    session = await createOwnerSession(ownerDiscordId);
    const mock = buildNextHeadersMock(session, guildId);
    holder.cookies = mock.cookies;
    holder.headers = mock.headers;
  });

  afterAll(async () => {
    await admin.from('dashboard_roles').delete().eq('guild_id', guildId);
    await admin.from('alerts').delete().eq('guild_id', guildId);
    await admin.from('audit_logs').delete().eq('guild_id', guildId);
    await admin.from('guild').delete().eq('id', guildId);
  });

  function jsonReq(method: string, body?: unknown, query = ''): import('next/server').NextRequest {
    return new Request(`http://localhost/api/rbac/roles${query}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `10.5.0.${(Date.now() % 250) + 1}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }) as unknown as import('next/server').NextRequest;
  }

  it('POST creates a custom role + rbac.role_created audit', async () => {
    const { POST } = await import('../../app/api/rbac/roles/route');
    const res = await POST(jsonReq('POST', { name: 'E2E Support', permissions: ['dashboard.view_analytics'], priority: 20 }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { id: string; is_system: boolean; guild_id: string } };
    expect(body.data.is_system).toBe(false);
    expect(body.data.guild_id).toBe(guildId);
    customRoleId = body.data.id;

    const { data: audits } = await admin
      .from('audit_logs').select('action, target_id').eq('guild_id', guildId).eq('action', 'rbac.role_created');
    expect((audits ?? []).some((a) => a.target_id === customRoleId)).toBe(true);
  });

  it('PATCH updates a custom role', async () => {
    const { PATCH } = await import('../../app/api/rbac/roles/route');
    const res = await PATCH(jsonReq('PATCH', { id: customRoleId, permissions: ['dashboard.view_analytics', 'dashboard.manage_economy'] }));
    expect(res.status).toBe(200);
    const { data } = await admin.from('dashboard_roles').select('permissions').eq('id', customRoleId).maybeSingle();
    expect((data?.permissions as string[] | undefined) ?? []).toContain('dashboard.manage_economy');
  });

  it('refuses to modify a SYSTEM role (403 + role_update_denied audit + escalation alert)', async () => {
    const { PATCH } = await import('../../app/api/rbac/roles/route');
    const res = await PATCH(jsonReq('PATCH', { id: systemRoleId, permissions: ['dashboard.full_access', 'dashboard.manage_economy'] }));
    expect(res.status).toBe(403);

    const { data: audits } = await admin
      .from('audit_logs').select('action, target_id, success').eq('guild_id', guildId).eq('action', 'rbac.role_update_denied');
    expect((audits ?? []).some((a) => a.target_id === systemRoleId && a.success === false)).toBe(true);

    // The system role's permissions are untouched by the refused edit.
    const { data: role } = await admin.from('dashboard_roles').select('permissions').eq('id', systemRoleId).maybeSingle();
    expect((role?.permissions as string[] | undefined) ?? []).toEqual(systemRolePerms);

    // Owner was paged.
    const { count } = await admin
      .from('alerts').select('id', { count: 'exact', head: true }).eq('guild_id', guildId);
    expect(count ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('refuses to delete a SYSTEM role (403)', async () => {
    const { DELETE } = await import('../../app/api/rbac/roles/route');
    const res = await DELETE(jsonReq('DELETE', undefined, `?id=${systemRoleId}`));
    expect(res.status).toBe(403);
    const { data } = await admin.from('dashboard_roles').select('id').eq('id', systemRoleId).maybeSingle();
    expect(data?.id).toBe(systemRoleId); // still there
  });

  it('DELETE removes the custom role + rbac.role_deleted audit', async () => {
    const { DELETE } = await import('../../app/api/rbac/roles/route');
    const res = await DELETE(jsonReq('DELETE', undefined, `?id=${customRoleId}`));
    expect(res.status).toBe(200);
    const { data } = await admin.from('dashboard_roles').select('id').eq('id', customRoleId).maybeSingle();
    expect(data).toBeNull();
    const { data: audits } = await admin
      .from('audit_logs').select('action').eq('guild_id', guildId).eq('action', 'rbac.role_deleted');
    expect((audits ?? []).length).toBeGreaterThanOrEqual(1);
  });

  it('denies a POST for a guild the session does not own (real 403)', async () => {
    holder.headers = buildNextHeadersMock(session, `${guildId}-foreign`).headers;
    const { POST } = await import('../../app/api/rbac/roles/route');
    const res = await POST(jsonReq('POST', { name: 'nope', permissions: [] }));
    expect(res.status).toBe(403);
    holder.headers = buildNextHeadersMock(session, guildId).headers;
  });
});
