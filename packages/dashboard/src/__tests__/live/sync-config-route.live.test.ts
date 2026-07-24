/**
 * sync-config-route.live.test — drive the REAL /api/sync/config PUT through the
 * REAL auth guard against LOCAL Supabase (real-session harness, zero prod edits).
 * Un-gates administration-server-sync dashboard config, including the schema's
 * reject-never-clamp contract on sync_interval_minutes (5..1440).
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

describe.skipIf(!reachable)('LIVE: /api/sync/config (real-session harness)', () => {
  const suffix = `${Date.now()}`;
  const guildId = `e2e-dash-sync-${suffix}`;
  const ownerDiscordId = `e2e-owner-sync-${suffix}`;
  const admin: SupabaseClient = createClient(SUPA_URL, process.env.SUPABASE_SECRET_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  let session: OwnerSession;

  beforeAll(async () => {
    await admin.from('guild').upsert(
      { id: guildId, name: 'E2E Dash Sync Guild', owner_discord_id: ownerDiscordId },
      { onConflict: 'id' },
    );
    session = await createOwnerSession(ownerDiscordId);
    const mock = buildNextHeadersMock(session, guildId);
    holder.cookies = mock.cookies;
    holder.headers = mock.headers;
  });

  afterAll(async () => {
    await admin.from('guild_config').delete().eq('guild_id', guildId);
    await admin.from('guild').delete().eq('id', guildId);
  });

  function jsonReq(body?: unknown): import('next/server').NextRequest {
    return new Request(`http://localhost/api/sync/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `10.10.0.${(Date.now() % 250) + 1}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }) as unknown as import('next/server').NextRequest;
  }

  it('PUT saves sync config into guild_config', async () => {
    const { PUT } = await import('../../app/api/sync/config/route');
    const res = await PUT(jsonReq({ sync_enabled: true, sync_interval_minutes: 60, sync_auto_repair: true }));
    expect(res.status).toBe(200);

    const { data } = await admin
      .from('guild_config')
      .select('sync_enabled, sync_interval_minutes, sync_auto_repair')
      .eq('guild_id', guildId)
      .maybeSingle();
    expect(data).toMatchObject({ sync_enabled: true, sync_interval_minutes: 60, sync_auto_repair: true });
  });

  it('rejects an out-of-range interval with 400 (reject, never clamp) and persists nothing', async () => {
    const { PUT } = await import('../../app/api/sync/config/route');
    const res = await PUT(jsonReq({ sync_interval_minutes: 2 }));
    expect(res.status).toBe(400);
    const { data } = await admin.from('guild_config').select('sync_interval_minutes').eq('guild_id', guildId).maybeSingle();
    expect(data?.sync_interval_minutes).toBe(60);
  });

  it('denies a PUT for a guild the session does not own (real 403)', async () => {
    holder.headers = buildNextHeadersMock(session, `${guildId}-foreign`).headers;
    const { PUT } = await import('../../app/api/sync/config/route');
    const res = await PUT(jsonReq({ sync_enabled: false }));
    expect(res.status).toBe(403);
    holder.headers = buildNextHeadersMock(session, guildId).headers;
    const { data } = await admin.from('guild_config').select('sync_enabled').eq('guild_id', guildId).maybeSingle();
    expect(data?.sync_enabled).toBe(true);
  });
});
