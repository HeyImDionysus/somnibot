/**
 * diagnostics-route.live.test — drive the REAL /api/diagnostics GET through the
 * REAL auth guard against LOCAL Supabase (real-session harness, zero prod
 * edits). Un-gates administration-diagnostics at the dashboard-read layer: the
 * route aggregates REAL bot_diagnostics health/heartbeat rows + audit_logs
 * sync markers for the session's guild.
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

describe.skipIf(!reachable)('LIVE: GET /api/diagnostics (real-session harness)', () => {
  const suffix = `${Date.now()}`;
  const guildId = `e2e-dash-diag-${suffix}`;
  const ownerDiscordId = `e2e-owner-diag-${suffix}`;
  const admin: SupabaseClient = createClient(SUPA_URL, process.env.SUPABASE_SECRET_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  let session: OwnerSession;
  const nowIso = new Date().toISOString();

  beforeAll(async () => {
    await admin.from('guild').upsert(
      { id: guildId, name: 'E2E Dash Diagnostics Guild', owner_discord_id: ownerDiscordId },
      { onConflict: 'id' },
    );
    // Fresh health snapshot -> the route must report the bot ONLINE with these stats.
    await admin.from('bot_diagnostics').upsert(
      {
        guild_id: guildId,
        type: 'health',
        snapshot_at: nowIso,
        uptime_seconds: 4242,
        memory_rss_mb: 123,
        discord_ws_ping: 42,
        guild_member_count: 7,
      },
      { onConflict: 'guild_id,type' },
    );
    // A completed-sync audit marker -> surfaces as lastSync.
    await admin.from('audit_logs').insert({
      guild_id: guildId,
      actor_type: 'system',
      actor_id: 'sync',
      action: 'sync.completed',
      details: { seeded: true },
      success: true,
    });
    session = await createOwnerSession(ownerDiscordId);
    const mock = buildNextHeadersMock(session, guildId);
    holder.cookies = mock.cookies;
    holder.headers = mock.headers;
  });

  afterAll(async () => {
    await admin.from('bot_diagnostics').delete().eq('guild_id', guildId);
    await admin.from('audit_logs').delete().eq('guild_id', guildId);
    await admin.from('guild').delete().eq('id', guildId);
  });

  function getReq(): import('next/server').NextRequest {
    return new Request(`http://localhost/api/diagnostics`, {
      headers: { 'x-forwarded-for': `10.12.0.${(Date.now() % 250) + 1}` },
    }) as unknown as import('next/server').NextRequest;
  }

  it('GET aggregates the real health snapshot + sync marker for the guild', async () => {
    const { GET } = await import('../../app/api/diagnostics/route');
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: {
        bot: { online: boolean; uptimeSeconds: number; wsPing: number; guildMemberCount: number };
        sync: { lastSync: string | null };
      };
    };
    expect(body.success).toBe(true);
    // The seeded snapshot is < 2 minutes old -> online, with our exact stats.
    expect(body.data.bot.online).toBe(true);
    expect(body.data.bot.uptimeSeconds).toBe(4242);
    expect(body.data.bot.wsPing).toBe(42);
    expect(body.data.bot.guildMemberCount).toBe(7);
    expect(body.data.sync.lastSync).toBeTruthy();
  });

  it('denies for a guild the session does not own (real 403)', async () => {
    holder.headers = buildNextHeadersMock(session, `${guildId}-foreign`).headers;
    const { GET } = await import('../../app/api/diagnostics/route');
    const res = await GET(getReq());
    expect(res.status).toBe(403);
    holder.headers = buildNextHeadersMock(session, guildId).headers;
  });
});
