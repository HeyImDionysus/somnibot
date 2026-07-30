/**
 * team-users-route.live.test — drive the REAL /api/rbac/users handlers through
 * the REAL requirePermission('dashboard.manage_team') guard against LOCAL
 * Supabase (real-session harness, zero prod edits). Un-gates
 * administration-team-management's consent-based invitation model: an
 * assignment POST creates a PENDING team_invitations row (never a live role
 * grant while direct-assignment is off) + a team.invite_sent audit, and a
 * system-role assignment is refused 403 + audited + pages the owner.
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

const INVITEE = '223456789012345695';

describe.skipIf(!reachable)('LIVE: /api/rbac/users (real-session harness)', () => {
  const suffix = `${Date.now()}`;
  const guildId = `e2e-dash-team-${suffix}`;
  const ownerDiscordId = `e2e-owner-team-${suffix}`;
  const admin: SupabaseClient = createClient(SUPA_URL, process.env.SUPABASE_SECRET_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  let session: OwnerSession;
  let customRoleId: string;
  let systemRoleId: string;

  beforeAll(async () => {
    await admin.from('guild').upsert(
      { id: guildId, name: 'E2E Dash Team Guild', owner_discord_id: ownerDiscordId },
      { onConflict: 'id' },
    );
    // The guild-creation trigger seeds the system roles; add one custom role.
    const { data: sys } = await admin
      .from('dashboard_roles').select('id').eq('guild_id', guildId).eq('name', 'moderator').single();
    systemRoleId = (sys as { id: string }).id;
    const { data: custom } = await admin
      .from('dashboard_roles')
      .insert({ guild_id: guildId, name: 'E2E Helper', permissions: ['dashboard.view_analytics'], is_system: false, priority: 5 })
      .select('id')
      .single();
    customRoleId = (custom as { id: string }).id;

    session = await createOwnerSession(ownerDiscordId);
    const mock = buildNextHeadersMock(session, guildId);
    holder.cookies = mock.cookies;
    holder.headers = mock.headers;
  });

  afterAll(async () => {
    await admin.from('team_invitations').delete().eq('guild_id', guildId);
    await admin.from('dashboard_user_roles').delete().eq('guild_id', guildId);
    await admin.from('dashboard_roles').delete().eq('guild_id', guildId);
    await admin.from('alerts').delete().eq('guild_id', guildId);
    await admin.from('audit_logs').delete().eq('guild_id', guildId);
    await admin.from('guild').delete().eq('id', guildId);
  });

  function jsonReq(method: string, body?: unknown): import('next/server').NextRequest {
    return new Request(`http://localhost/api/rbac/users`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `10.13.0.${(Date.now() % 250) + 1}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }) as unknown as import('next/server').NextRequest;
  }

  it('POST creates a PENDING invitation (consent model — no live role grant) + invite audit', async () => {
    const { POST } = await import('../../app/api/rbac/users/route');
    const res = await POST(jsonReq('POST', { discord_id: INVITEE, role_id: customRoleId }));
    expect(res.status).toBe(200);

    const { data: invites } = await admin
      .from('team_invitations')
      .select('status, discord_id, role_id, invited_by')
      .eq('guild_id', guildId);
    expect(invites).toHaveLength(1);
    expect(invites?.[0]).toMatchObject({ status: 'pending', discord_id: INVITEE, role_id: customRoleId, invited_by: ownerDiscordId });

    // Consent model: NO live dashboard_user_roles assignment yet.
    const { count } = await admin
      .from('dashboard_user_roles').select('id', { count: 'exact', head: true })
      .eq('guild_id', guildId).eq('discord_id', INVITEE);
    expect(count ?? 0).toBe(0);

    const { data: audits } = await admin
      .from('audit_logs').select('action').eq('guild_id', guildId).eq('action', 'team.invite_sent');
    expect((audits ?? []).length).toBeGreaterThanOrEqual(1);
  });

  it('refuses to assign a SYSTEM role (403 + role_assign_denied audit + owner alert)', async () => {
    const { POST } = await import('../../app/api/rbac/users/route');
    const res = await POST(jsonReq('POST', { discord_id: INVITEE, role_id: systemRoleId }));
    expect(res.status).toBe(403);

    const { data: audits } = await admin
      .from('audit_logs').select('action, success').eq('guild_id', guildId).eq('action', 'rbac.role_assign_denied');
    expect((audits ?? []).some((a) => a.success === false)).toBe(true);
    const { count } = await admin.from('alerts').select('id', { count: 'exact', head: true }).eq('guild_id', guildId);
    expect(count ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('rejects a duplicate pending invitation with 409', async () => {
    const { POST } = await import('../../app/api/rbac/users/route');
    const res = await POST(jsonReq('POST', { discord_id: INVITEE, role_id: customRoleId }));
    expect(res.status).toBe(409);
    const { count } = await admin
      .from('team_invitations').select('id', { count: 'exact', head: true }).eq('guild_id', guildId);
    expect(count ?? 0).toBe(1);
  });

  it('denies for a guild the session does not own (real 403)', async () => {
    holder.headers = buildNextHeadersMock(session, `${guildId}-foreign`).headers;
    const { POST } = await import('../../app/api/rbac/users/route');
    const res = await POST(jsonReq('POST', { discord_id: INVITEE, role_id: customRoleId }));
    expect(res.status).toBe(403);
    holder.headers = buildNextHeadersMock(session, guildId).headers;
  });
});
