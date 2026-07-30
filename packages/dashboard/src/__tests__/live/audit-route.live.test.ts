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

// ── Arm the local rig env BEFORE importing any route/module ──────────────────
const DEMO_SERVICE =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const DEMO_ANON =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SUPA_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
Object.assign(process.env, {
  SUPABASE_URL: SUPA_URL,
  NEXT_PUBLIC_SUPABASE_URL: SUPA_URL,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || DEMO_ANON,
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || DEMO_ANON,
  SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY || DEMO_SERVICE,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || DEMO_SERVICE,
});

import { createOwnerSession, buildNextHeadersMock, type OwnerSession } from './_session-harness';

// ── next/headers mock: served from a mutable holder set per-scenario ─────────
const holder: ReturnType<typeof buildNextHeadersMock> = vi.hoisted(() => ({
  cookies: async () => ({ getAll: () => [] as import('./_session-harness').CookieRecord[], get: () => undefined, set: () => {} }),
  headers: async () => ({ get: () => null, has: () => false }),
}));
vi.mock('next/headers', () => ({
  cookies: () => holder.cookies(),
  headers: () => holder.headers(),
}));

async function localSupabaseReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${SUPA_URL}/auth/v1/health`);
    return res.ok;
  } catch {
    return false;
  }
}

const reachable = await localSupabaseReachable();

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
