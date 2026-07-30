/**
 * levels-route.live.test — drive the REAL /api/levels dashboard handlers through
 * the REAL auth guard against LOCAL Supabase (real-session harness, zero prod
 * edits). This closes the loop the community-levels bot proof only half-proves:
 * a dashboard levels SAVE lands in the exact guild_config row the bot's
 * loadLevelConfig reads, and reward creation lands a real level_rewards row.
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

// Valid discord-snowflake-shaped ids the route's zod schema accepts.
const ROLE_A = '223456789012345670';
const NO_XP_ROLE = '223456789012345671';

describe.skipIf(!reachable)('LIVE: /api/levels (real-session harness)', () => {
  const suffix = `${Date.now()}`;
  const guildId = `e2e-dash-levels-${suffix}`;
  const ownerDiscordId = `e2e-owner-lvl-${suffix}`;
  const admin: SupabaseClient = createClient(SUPA_URL, process.env.SUPABASE_SECRET_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  let session: OwnerSession;

  beforeAll(async () => {
    await admin.from('guild').upsert(
      { id: guildId, name: 'E2E Dash Levels Guild', owner_discord_id: ownerDiscordId },
      { onConflict: 'id' },
    );
    session = await createOwnerSession(ownerDiscordId);
    const mock = buildNextHeadersMock(session, guildId);
    holder.cookies = mock.cookies;
    holder.headers = mock.headers;
  });

  afterAll(async () => {
    await admin.from('level_rewards').delete().eq('guild_id', guildId);
    await admin.from('xp_multipliers').delete().eq('guild_id', guildId);
    await admin.from('guild_config').delete().eq('guild_id', guildId);
    await admin.from('guild').delete().eq('id', guildId);
  });

  function jsonReq(method: string, body?: unknown, query = ''): import('next/server').NextRequest {
    return new Request(`http://localhost/api/levels${query}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `10.2.0.${(Date.now() % 250) + 1}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }) as unknown as import('next/server').NextRequest;
  }

  it('PUT saves levels config into the exact guild_config row the bot reads', async () => {
    const { PUT } = await import('../../app/api/levels/route');
    const cfg = {
      levels_enabled: true,
      xp_min: 15,
      xp_max: 25,
      xp_cooldown_seconds: 45,
      voice_xp_enabled: true,
      voice_xp_per_interval: 12,
      voice_xp_interval_minutes: 5,
      xp_multiplier_mode: 'highest',
      no_xp_role_id: NO_XP_ROLE,
    };
    const res = await PUT(jsonReq('PUT', cfg));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);

    // The REAL guild_config row now carries the saved values — the exact columns
    // packages/bot/.../xp-tracker.ts loadLevelConfig selects.
    const { data } = await admin
      .from('guild_config')
      .select('levels_enabled, xp_min, xp_max, xp_cooldown_seconds, voice_xp_enabled, voice_xp_per_interval, no_xp_role_id')
      .eq('guild_id', guildId)
      .maybeSingle();
    expect(data).toMatchObject({
      levels_enabled: true,
      xp_min: 15,
      xp_max: 25,
      xp_cooldown_seconds: 45,
      voice_xp_enabled: true,
      voice_xp_per_interval: 12,
      no_xp_role_id: NO_XP_ROLE,
    });
  });

  it('POST creates a level reward row scoped to the guild', async () => {
    const { POST } = await import('../../app/api/levels/route');
    const res = await POST(jsonReq('POST', { type: 'reward', level: 5, role_id: ROLE_A, announce: true }));
    expect(res.status).toBe(200);

    const { data } = await admin
      .from('level_rewards')
      .select('guild_id, level, role_id, announce')
      .eq('guild_id', guildId)
      .eq('level', 5)
      .maybeSingle();
    expect(data).toMatchObject({ guild_id: guildId, level: 5, role_id: ROLE_A, announce: true });
  });

  it('GET returns the saved settings bundle (config + rewards)', async () => {
    const { GET } = await import('../../app/api/levels/route');
    const res = await GET(jsonReq('GET'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      config: { xp_min?: number; xp_cooldown_seconds?: number; levels_enabled?: boolean };
      rewards: Array<{ level: number; role_id: string }>;
    };
    expect(body.success).toBe(true);
    expect(body.config.xp_min).toBe(15);
    expect(body.config.xp_cooldown_seconds).toBe(45);
    expect(body.config.levels_enabled).toBe(true);
    expect(body.rewards.some((r) => r.level === 5 && r.role_id === ROLE_A)).toBe(true);
  });

  it('denies a PUT for a guild the session does not own (real 403)', async () => {
    holder.headers = buildNextHeadersMock(session, `${guildId}-foreign`).headers;
    const { PUT } = await import('../../app/api/levels/route');
    const res = await PUT(jsonReq('PUT', { xp_min: 99 }));
    expect(res.status).toBe(403);
    holder.headers = buildNextHeadersMock(session, guildId).headers;

    // The real guild_config is untouched by the denied write.
    const { data } = await admin.from('guild_config').select('xp_min').eq('guild_id', guildId).maybeSingle();
    expect(data?.xp_min).toBe(15);
  });
});
