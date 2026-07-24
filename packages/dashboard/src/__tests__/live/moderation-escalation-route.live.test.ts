/**
 * moderation-escalation-route.live.test — drive the REAL /api/moderation/escalation
 * handlers through the REAL auth guard against LOCAL Supabase (real-session
 * harness, zero prod edits). Un-gates moderation dashboard-config at the
 * config-reaches-the-bot layer: the saved escalation chain lands in the exact
 * guild_config columns the bot's loadModConfig reads.
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

const MOD_LOG_CHANNEL = '223456789012345680';
const CHAIN = [
  { threshold: 2, action: 'warn' },
  { threshold: 3, action: 'mute', duration_minutes: 60 },
  { threshold: 5, action: 'ban' },
];

describe.skipIf(!reachable)('LIVE: /api/moderation/escalation (real-session harness)', () => {
  const suffix = `${Date.now()}`;
  const guildId = `e2e-dash-modesc-${suffix}`;
  const ownerDiscordId = `e2e-owner-modesc-${suffix}`;
  const admin: SupabaseClient = createClient(SUPA_URL, process.env.SUPABASE_SECRET_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  let session: OwnerSession;

  beforeAll(async () => {
    await admin.from('guild').upsert(
      { id: guildId, name: 'E2E Dash ModEsc Guild', owner_discord_id: ownerDiscordId },
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

  function jsonReq(method: string, body?: unknown): import('next/server').NextRequest {
    return new Request(`http://localhost/api/moderation/escalation`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `10.7.0.${(Date.now() % 250) + 1}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }) as unknown as import('next/server').NextRequest;
  }

  it('PUT saves the escalation chain + mod-log + expiry into guild_config', async () => {
    const { PUT } = await import('../../app/api/moderation/escalation/route');
    const res = await PUT(jsonReq('PUT', {
      escalation_chain: CHAIN,
      mod_log_channel_id: MOD_LOG_CHANNEL,
      infraction_expiry_days: 45,
    }));
    expect(res.status).toBe(200);

    const { data } = await admin
      .from('guild_config')
      .select('escalation_chain, mod_log_channel_id, infraction_expiry_days')
      .eq('guild_id', guildId)
      .maybeSingle();
    expect(data?.mod_log_channel_id).toBe(MOD_LOG_CHANNEL);
    expect(data?.infraction_expiry_days).toBe(45);
    expect(data?.escalation_chain).toEqual(CHAIN);
  });

  it('GET returns the saved moderation config', async () => {
    const { GET } = await import('../../app/api/moderation/escalation/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { escalation_chain: unknown; infraction_expiry_days: number } };
    expect(body.data.infraction_expiry_days).toBe(45);
    expect(body.data.escalation_chain).toEqual(CHAIN);
  });

  it('rejects an invalid chain (threshold < 1) with 400 and persists nothing', async () => {
    const { PUT } = await import('../../app/api/moderation/escalation/route');
    const res = await PUT(jsonReq('PUT', { escalation_chain: [{ threshold: 0, action: 'warn' }] }));
    expect(res.status).toBe(400);
    const { data } = await admin.from('guild_config').select('escalation_chain').eq('guild_id', guildId).maybeSingle();
    expect(data?.escalation_chain).toEqual(CHAIN); // unchanged
  });

  it('denies a PUT for a guild the session does not own (real 403)', async () => {
    holder.headers = buildNextHeadersMock(session, `${guildId}-foreign`).headers;
    const { PUT } = await import('../../app/api/moderation/escalation/route');
    const res = await PUT(jsonReq('PUT', { infraction_expiry_days: 7 }));
    expect(res.status).toBe(403);
    holder.headers = buildNextHeadersMock(session, guildId).headers;
    const { data } = await admin.from('guild_config').select('infraction_expiry_days').eq('guild_id', guildId).maybeSingle();
    expect(data?.infraction_expiry_days).toBe(45);
  });
});
