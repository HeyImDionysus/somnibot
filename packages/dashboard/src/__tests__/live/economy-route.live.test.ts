/**
 * economy-route.live.test — drive the REAL /api/economy handlers through the
 * REAL requirePermission('dashboard.manage_economy') guard against LOCAL
 * Supabase (real-session harness, zero prod edits; owner short-circuit).
 * Un-gates the economy dashboard-config lane: a PATCH lands in the exact
 * guild_config columns the bot's EconomyManager reads, and GET aggregates
 * real wallet stats through the economy_wallet_stats RPC.
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

describe.skipIf(!reachable)('LIVE: /api/economy (real-session harness)', () => {
  const suffix = `${Date.now()}`;
  const guildId = `e2e-dash-econ-${suffix}`;
  const ownerDiscordId = `e2e-owner-econ-${suffix}`;
  const memberId = `e2e-econ-member-${suffix}`;
  const admin: SupabaseClient = createClient(SUPA_URL, process.env.SUPABASE_SECRET_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  let session: OwnerSession;

  beforeAll(async () => {
    await admin.from('guild').upsert(
      { id: guildId, name: 'E2E Dash Economy Guild', owner_discord_id: ownerDiscordId },
      { onConflict: 'id' },
    );
    // PATCH uses .update() — a guild_config row must exist.
    await admin.from('guild_config').upsert({ guild_id: guildId }, { onConflict: 'guild_id' });
    // A real wallet so GET's economy_wallet_stats RPC aggregates something.
    const { error: walletErr } = await admin.from('economy_wallets').upsert(
      { guild_id: guildId, user_id: memberId, wallet: 750, bank: 250 },
      { onConflict: 'guild_id,user_id' },
    );
    if (walletErr) throw new Error(`wallet seed failed: ${walletErr.message}`);
    session = await createOwnerSession(ownerDiscordId);
    const mock = buildNextHeadersMock(session, guildId);
    holder.cookies = mock.cookies;
    holder.headers = mock.headers;
  });

  afterAll(async () => {
    await admin.from('economy_wallets').delete().eq('guild_id', guildId);
    await admin.from('guild_config').delete().eq('guild_id', guildId);
    await admin.from('guild').delete().eq('id', guildId);
  });

  function jsonReq(method: string, body?: unknown): import('next/server').NextRequest {
    return new Request(`http://localhost/api/economy`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `10.11.0.${(Date.now() % 250) + 1}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }) as unknown as import('next/server').NextRequest;
  }

  it('PATCH saves economy config into guild_config (owner short-circuit through requirePermission)', async () => {
    const { PATCH } = await import('../../app/api/economy/route');
    const res = await PATCH(jsonReq('PATCH', { economy_enabled: true, currency_name: 'Doubloons', currency_emoji: '🔶' }));
    expect(res.status).toBe(200);

    const { data } = await admin
      .from('guild_config')
      .select('economy_enabled, currency_name, currency_emoji')
      .eq('guild_id', guildId)
      .maybeSingle();
    expect(data).toMatchObject({ economy_enabled: true, currency_name: 'Doubloons', currency_emoji: '🔶' });
  });

  it('GET returns the saved config + REAL wallet aggregates', async () => {
    const { GET } = await import('../../app/api/economy/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { config: { currency_name?: string }; stats: { totalWallets: number; totalCirculation: number; totalBanked: number } };
    };
    expect(body.data.config.currency_name).toBe('Doubloons');
    expect(body.data.stats.totalWallets).toBe(1);
    expect(body.data.stats.totalCirculation).toBe(750);
    expect(body.data.stats.totalBanked).toBe(250);
  });

  it('denies a PATCH for a guild the session does not own (real 403)', async () => {
    holder.headers = buildNextHeadersMock(session, `${guildId}-foreign`).headers;
    const { PATCH } = await import('../../app/api/economy/route');
    const res = await PATCH(jsonReq('PATCH', { currency_name: 'Nope' }));
    expect(res.status).toBe(403);
    holder.headers = buildNextHeadersMock(session, guildId).headers;
    const { data } = await admin.from('guild_config').select('currency_name').eq('guild_id', guildId).maybeSingle();
    expect(data?.currency_name).toBe('Doubloons');
  });
});
