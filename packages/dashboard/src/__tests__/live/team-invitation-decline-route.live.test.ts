/**
 * team-invitation-decline-route.live.test — drive the NEW
 * POST /api/rbac/invitations/[id]/decline through the REAL requireAuth guard
 * against LOCAL Supabase (real-session harness, zero prod auth edits).
 * Completes the consent model's other half: the invited member can REFUSE the
 * role — pending → declined atomically, audited, never touching
 * dashboard_user_roles — and a declined invitation can no longer be accepted.
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

const holder = vi.hoisted(() => ({
  cookies: async () => ({ getAll: () => [] as unknown[], get: () => undefined, set: () => {} }),
  headers: async () => ({ get: () => null, has: () => false }),
}));
vi.mock('next/headers', () => ({
  cookies: () => holder.cookies(),
  headers: () => holder.headers(),
}));

const reachable = await localSupabaseReachable(SUPA_URL);

describe.skipIf(!reachable)('LIVE: POST /api/rbac/invitations/[id]/decline (real-session harness)', () => {
  const suffix = `${Date.now()}`;
  const guildId = `e2e-dash-decl-${suffix}`;
  const ownerDiscordId = `e2e-owner-decl-${suffix}`;
  const inviteeDiscordId = `e2e-invitee-decl-${suffix}`;
  const admin: SupabaseClient = createClient(SUPA_URL, process.env.SUPABASE_SECRET_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  let inviteeSession: OwnerSession;
  let roleId: string;
  let invitationId: string;

  async function seedInvitation(): Promise<string> {
    const { data, error } = await admin
      .from('team_invitations')
      .insert({
        guild_id: guildId,
        discord_id: inviteeDiscordId,
        role_id: roleId,
        status: 'pending',
        dm_status: 'skipped',
        delivery_mode: 'dashboard',
        invited_by: ownerDiscordId,
        expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      })
      .select('id')
      .single();
    if (error) throw new Error(`invitation seed failed: ${error.message}`);
    return (data as { id: string }).id;
  }

  beforeAll(async () => {
    await admin.from('guild').upsert(
      { id: guildId, name: 'E2E Dash Decline Guild', owner_discord_id: ownerDiscordId },
      { onConflict: 'id' },
    );
    const { data: role } = await admin
      .from('dashboard_roles')
      .insert({ guild_id: guildId, name: 'E2E Declinee', permissions: ['dashboard.view_analytics'], is_system: false, priority: 5 })
      .select('id')
      .single();
    roleId = (role as { id: string }).id;
    invitationId = await seedInvitation();

    // The INVITEE's real session (requireAuth needs a session, not ownership).
    inviteeSession = await createOwnerSession(inviteeDiscordId);
    const mock = buildNextHeadersMock(inviteeSession, guildId);
    holder.cookies = mock.cookies;
    holder.headers = mock.headers;
  });

  afterAll(async () => {
    await admin.from('team_invitations').delete().eq('guild_id', guildId);
    await admin.from('dashboard_user_roles').delete().eq('guild_id', guildId);
    await admin.from('dashboard_roles').delete().eq('guild_id', guildId);
    await admin.from('audit_logs').delete().eq('guild_id', guildId);
    await admin.from('guild').delete().eq('id', guildId);
  });

  function postReq(): Request {
    return new Request(`http://localhost/api/rbac/invitations/${invitationId}/decline`, {
      method: 'POST',
      headers: { 'x-forwarded-for': `10.15.0.${(Date.now() % 250) + 1}` },
    });
  }

  it('declines a pending invitation: status flips, audited, NO role grant', async () => {
    const { POST } = await import('../../app/api/rbac/invitations/[id]/decline/route');
    const res = await POST(postReq(), { params: Promise.resolve({ id: invitationId }) });
    expect(res.status).toBe(200);

    const { data: inv } = await admin
      .from('team_invitations')
      .select('status, responded_at')
      .eq('id', invitationId)
      .maybeSingle();
    expect(inv?.status).toBe('declined');
    expect(inv?.responded_at).toBeTruthy();

    // Consent honored: the refused role was NEVER granted.
    const { count } = await admin
      .from('dashboard_user_roles')
      .select('id', { count: 'exact', head: true })
      .eq('guild_id', guildId)
      .eq('discord_id', inviteeDiscordId);
    expect(count ?? 0).toBe(0);

    const { data: audits } = await admin
      .from('audit_logs')
      .select('action, actor_id')
      .eq('guild_id', guildId)
      .eq('action', 'team.invite_declined');
    expect((audits ?? []).some((a) => a.actor_id === inviteeDiscordId)).toBe(true);
  });

  it('a replayed decline is idempotent (200, still exactly one declined row)', async () => {
    const { POST } = await import('../../app/api/rbac/invitations/[id]/decline/route');
    const res = await POST(postReq(), { params: Promise.resolve({ id: invitationId }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; alreadyDeclined?: boolean };
    expect(body.alreadyDeclined).toBe(true);
  });

  it('a declined invitation can no longer be accepted (409, no grant)', async () => {
    const { POST: ACCEPT } = await import('../../app/api/rbac/invitations/[id]/accept/route');
    const res = await ACCEPT(postReq(), { params: Promise.resolve({ id: invitationId }) });
    expect(res.status).toBe(409);
    const { count } = await admin
      .from('dashboard_user_roles')
      .select('id', { count: 'exact', head: true })
      .eq('guild_id', guildId)
      .eq('discord_id', inviteeDiscordId);
    expect(count ?? 0).toBe(0);
  });

  it('a FOREIGN session cannot decline another member’s invitation (404, row untouched)', async () => {
    invitationId = await seedInvitation(); // fresh pending invitation
    const foreign = await createOwnerSession(`e2e-stranger-${suffix}`);
    const mock = buildNextHeadersMock(foreign, guildId);
    holder.cookies = mock.cookies;
    holder.headers = mock.headers;

    const { POST } = await import('../../app/api/rbac/invitations/[id]/decline/route');
    const res = await POST(postReq(), { params: Promise.resolve({ id: invitationId }) });
    expect(res.status).toBe(404);

    const { data: inv } = await admin.from('team_invitations').select('status').eq('id', invitationId).maybeSingle();
    expect(inv?.status).toBe('pending');

    // Restore the invitee session for any later tests.
    const back = buildNextHeadersMock(inviteeSession, guildId);
    holder.cookies = back.cookies;
    holder.headers = back.headers;
  });
});
