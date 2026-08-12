/**
 * audit-route.live.test — SPIKE: prove the real-session harness drives a REAL
 * dashboard route handler end-to-end against LOCAL Supabase with ZERO production
 * auth edits (owner decision 2026-07-24).
 *
 * The GET /api/audit handler runs unchanged: real checkAdminRateLimit, real
 * requireGuildOwner (real getUser validating a REAL session, real guild-ownership
 * check), real createAdminSupabase read. Only next/headers is mocked (request
 * infrastructure). Skips unless local Supabase is reachable, so the plain Unit
 * (Dashboard) job (no Supabase) skips it; the Live-Stack E2E job runs it.
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

// ── next/headers mock: served from a mutable holder set per-scenario ─────────
const holder: ReturnType<typeof buildNextHeadersMock> = vi.hoisted(() => ({
  cookies: async () => ({ getAll: () => [] as import('./_session-harness').CookieRecord[], get: () => undefined, set: () => {} }),
  headers: async () => ({ get: () => null, has: () => false }),
}));
vi.mock('next/headers', () => ({
  cookies: () => holder.cookies(),
  headers: () => holder.headers(),
}));

const reachable = await localSupabaseReachable(SUPA_URL);

describe.skipIf(!reachable)('LIVE: GET /api/audit (real-session harness)', () => {
  const suffix = `${Date.now()}`;
  const guildId = `e2e-dash-audit-${suffix}`;
  const ownerDiscordId = `e2e-owner-${suffix}`;
  const admin: SupabaseClient = createClient(SUPA_URL, process.env.SUPABASE_SECRET_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  let session: OwnerSession;

  beforeAll(async () => {
    // Seed the owner's guild + two real audit rows scoped to it.
    await admin.from('guild').upsert(
      { id: guildId, name: 'E2E Dash Audit Guild', owner_discord_id: ownerDiscordId },
      { onConflict: 'id' },
    );
    await admin.from('audit_logs').insert([
      { guild_id: guildId, actor_type: 'discord', actor_id: ownerDiscordId, action: 'e2e.audit.alpha', category: 'test', success: true },
      { guild_id: guildId, actor_type: 'discord', actor_id: ownerDiscordId, action: 'e2e.audit.beta', category: 'test', success: true },
    ]);

    session = await createOwnerSession(ownerDiscordId);
    const mock = buildNextHeadersMock(session, guildId);
    holder.cookies = mock.cookies;
    holder.headers = mock.headers;
  });

  afterAll(async () => {
    await admin.from('audit_logs').delete().eq('guild_id', guildId);
    await admin.from('guild').delete().eq('id', guildId);
  });

  it('returns the guild-scoped audit rows through the REAL auth guard', async () => {
    const { GET } = await import('../../app/api/audit/route');
    const req = new Request(`http://localhost/api/audit?category=test`, {
      headers: { 'x-forwarded-for': `10.0.0.${(Date.now() % 250) + 1}` },
    }) as unknown as import('next/server').NextRequest;

    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: Array<{ action: string; guild_id: string }>; pagination: { total: number } };

    expect(body.success).toBe(true);
    const actions = body.data.map((r) => r.action).sort();
    expect(actions).toContain('e2e.audit.alpha');
    expect(actions).toContain('e2e.audit.beta');
    // Guild-scoping is REAL (guildId came from the validated session's ownership).
    expect(body.data.every((r) => r.guild_id === guildId)).toBe(true);
    expect(body.pagination.total).toBeGreaterThanOrEqual(2);
  });

  it('denies when the session owns no guild (real 403 from requireGuildOwner)', async () => {
    // Point the guild selector at a guild this owner does NOT own → real deny.
    const foreign = buildNextHeadersMock(session, `${guildId}-foreign`);
    holder.headers = foreign.headers;
    const { GET } = await import('../../app/api/audit/route');
    const req = new Request(`http://localhost/api/audit`, {
      headers: { 'x-forwarded-for': `10.0.1.${(Date.now() % 250) + 1}` },
    }) as unknown as import('next/server').NextRequest;
    const res = await GET(req);
    expect(res.status).toBe(403);
    // Restore for any later tests.
    holder.headers = buildNextHeadersMock(session, guildId).headers;
  });
});
