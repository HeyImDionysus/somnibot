/**
 * music-route.live.test — drive the REAL /api/music handlers through the REAL
 * auth guard against LOCAL Supabase (real-session harness, zero prod edits).
 * Un-gates music dashboard config: the saved settings land in the exact
 * guild_config columns the bot's music gate + player read (music_enabled is the
 * flag guild-init gates the MusicPlayerManager on).
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

const DJ_ROLE = '223456789012345690';

describe.skipIf(!reachable)('LIVE: /api/music (real-session harness)', () => {
  const suffix = `${Date.now()}`;
  const guildId = `e2e-dash-music-${suffix}`;
  const ownerDiscordId = `e2e-owner-music-${suffix}`;
  const admin: SupabaseClient = createClient(SUPA_URL, process.env.SUPABASE_SECRET_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  let session: OwnerSession;

  beforeAll(async () => {
    await admin.from('guild').upsert(
      { id: guildId, name: 'E2E Dash Music Guild', owner_discord_id: ownerDiscordId },
      { onConflict: 'id' },
    );
    // PUT uses .upsert? music route builds updates then… (route upserts via
    // guild_config update path) — seed a config row so update-style writes land.
    await admin.from('guild_config').upsert({ guild_id: guildId }, { onConflict: 'guild_id' });
    session = await createOwnerSession(ownerDiscordId);
    const mock = buildNextHeadersMock(session, guildId);
    holder.cookies = mock.cookies;
    holder.headers = mock.headers;
  });

  afterAll(async () => {
    await admin.from('audit_logs').delete().eq('guild_id', guildId);
    await admin.from('guild_config').delete().eq('guild_id', guildId);
    await admin.from('guild').delete().eq('id', guildId);
  });

  function jsonReq(method: string, body?: unknown): import('next/server').NextRequest {
    return new Request(`http://localhost/api/music`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `10.9.0.${(Date.now() % 250) + 1}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }) as unknown as import('next/server').NextRequest;
  }

  it('PUT saves music settings into guild_config (incl. the music_enabled gate)', async () => {
    const { PUT } = await import('../../app/api/music/route');
    const res = await PUT(jsonReq('PUT', {
      music_enabled: false,
      music_default_volume: 77,
      dj_role_id: DJ_ROLE,
      vote_skip_threshold_percent: 66,
      self_skip_enabled: false,
    }));
    expect(res.status).toBe(200);

    const { data } = await admin
      .from('guild_config')
      .select('music_enabled, music_default_volume, dj_role_id, vote_skip_threshold_percent, self_skip_enabled')
      .eq('guild_id', guildId)
      .maybeSingle();
    expect(data).toMatchObject({
      music_enabled: false,
      music_default_volume: 77,
      dj_role_id: DJ_ROLE,
      vote_skip_threshold_percent: 66,
      self_skip_enabled: false,
    });
  });

  it('GET returns the saved music config', async () => {
    const { GET } = await import('../../app/api/music/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { music_enabled: boolean; music_default_volume: number } };
    expect(body.data.music_enabled).toBe(false);
    expect(body.data.music_default_volume).toBe(77);
  });

  it('audits a rejected no-op save (music.config_rejected)', async () => {
    const { PUT } = await import('../../app/api/music/route');
    const res = await PUT(jsonReq('PUT', {}));
    expect(res.status).toBe(400);
    const { data } = await admin
      .from('audit_logs')
      .select('action, success')
      .eq('guild_id', guildId)
      .eq('action', 'music.config_rejected');
    expect((data ?? []).length).toBeGreaterThanOrEqual(1);
  });

  it('denies a PUT for a guild the session does not own (real 403)', async () => {
    holder.headers = buildNextHeadersMock(session, `${guildId}-foreign`).headers;
    const { PUT } = await import('../../app/api/music/route');
    const res = await PUT(jsonReq('PUT', { music_default_volume: 10 }));
    expect(res.status).toBe(403);
    holder.headers = buildNextHeadersMock(session, guildId).headers;
    const { data } = await admin.from('guild_config').select('music_default_volume').eq('guild_id', guildId).maybeSingle();
    expect(data?.music_default_volume).toBe(77);
  });
});
