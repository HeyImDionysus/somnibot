/**
 * welcome-route.live.test — drive the REAL /api/welcome handlers through the REAL
 * auth guard against LOCAL Supabase (real-session harness, zero prod edits).
 * Un-gates community-welcome-onboarding at the config layer: a dashboard welcome
 * SAVE lands in the exact guild_config columns the bot's welcome pipeline reads.
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

const WELCOME_CHANNEL = '223456789012345670';
const AUTO_ROLE = '223456789012345671';
const GOODBYE_CHANNEL = '223456789012345672';

describe.skipIf(!reachable)('LIVE: /api/welcome (real-session harness)', () => {
  const suffix = `${Date.now()}`;
  const guildId = `e2e-dash-welcome-${suffix}`;
  const ownerDiscordId = `e2e-owner-welc-${suffix}`;
  const admin: SupabaseClient = createClient(SUPA_URL, process.env.SUPABASE_SECRET_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  let session: OwnerSession;

  beforeAll(async () => {
    await admin.from('guild').upsert(
      { id: guildId, name: 'E2E Dash Welcome Guild', owner_discord_id: ownerDiscordId },
      { onConflict: 'id' },
    );
    // PUT uses .update() (not upsert) — ensure a guild_config row exists.
    await admin.from('guild_config').upsert({ guild_id: guildId }, { onConflict: 'guild_id' });
    session = await createOwnerSession(ownerDiscordId);
    const mock = buildNextHeadersMock(session, guildId);
    holder.cookies = mock.cookies;
    holder.headers = mock.headers;
  });

  afterAll(async () => {
    await admin.from('guild_config').delete().eq('guild_id', guildId);
    await admin.from('guild').delete().eq('id', guildId);
  });

  function jsonReq(method: string, body?: unknown): import('next/server').NextRequest {
    return new Request(`http://localhost/api/welcome`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `10.6.0.${(Date.now() % 250) + 1}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }) as unknown as import('next/server').NextRequest;
  }

  it('PUT saves welcome + goodbye config into guild_config', async () => {
    const { PUT } = await import('../../app/api/welcome/route');
    const res = await PUT(
      jsonReq('PUT', {
        welcome_enabled: true,
        welcome_channel_id: WELCOME_CHANNEL,
        welcome_message: 'Welcome {user}!',
        welcome_dm_enabled: true,
        welcome_dm_message: 'Glad you joined',
        welcome_auto_roles: [AUTO_ROLE],
        goodbye_enabled: true,
        goodbye_channel_id: GOODBYE_CHANNEL,
        goodbye_message: 'Farewell {user}',
      }),
    );
    expect(res.status).toBe(200);

    const { data } = await admin
      .from('guild_config')
      .select('welcome_enabled, welcome_channel_id, welcome_message, welcome_dm_enabled, welcome_auto_roles, goodbye_enabled, goodbye_channel_id')
      .eq('guild_id', guildId)
      .maybeSingle();
    expect(data).toMatchObject({
      welcome_enabled: true,
      welcome_channel_id: WELCOME_CHANNEL,
      welcome_message: 'Welcome {user}!',
      welcome_dm_enabled: true,
      goodbye_enabled: true,
      goodbye_channel_id: GOODBYE_CHANNEL,
    });
    expect((data?.welcome_auto_roles as string[] | undefined) ?? []).toContain(AUTO_ROLE);
  });

  it('GET returns the saved welcome config', async () => {
    const { GET } = await import('../../app/api/welcome/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { welcome_enabled?: boolean; welcome_message?: string } };
    expect(body.success).toBe(true);
    expect(body.data.welcome_enabled).toBe(true);
    expect(body.data.welcome_message).toBe('Welcome {user}!');
  });

  it('denies a PUT for a guild the session does not own (real 403)', async () => {
    holder.headers = buildNextHeadersMock(session, `${guildId}-foreign`).headers;
    const { PUT } = await import('../../app/api/welcome/route');
    const res = await PUT(jsonReq('PUT', { welcome_enabled: false }));
    expect(res.status).toBe(403);
    holder.headers = buildNextHeadersMock(session, guildId).headers;
    // Config untouched by the denied write.
    const { data } = await admin.from('guild_config').select('welcome_enabled').eq('guild_id', guildId).maybeSingle();
    expect(data?.welcome_enabled).toBe(true);
  });
});
