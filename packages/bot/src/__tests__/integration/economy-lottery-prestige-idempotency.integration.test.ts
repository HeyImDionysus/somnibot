/**
 * Integration coverage for lottery_buy_tickets_atomic and economy_prestige_apply.
 *
 * Real local Supabase. Proves exactly-once on both money paths: a redelivered
 * /lottery buy charges and issues tickets once (never twice), and a redelivered
 * /prestige applies once (never double-bumping the level or the earning
 * multiplier). Concurrent same-id lottery buys serialize to one purchase.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireSupabase } from './helpers.js';

let supa!: SupabaseClient;
const GUILD_ID = `test-lp-${Date.now()}`;
const USER = `lp-user-${Date.now()}`;
let drawingId: string;

async function seedWallet(wallet: number, bank = 0): Promise<void> {
  await supa.from('economy_wallets').upsert({ guild_id: GUILD_ID, user_id: USER, wallet, bank, total_earned: wallet, total_spent: 0 });
}
async function walletOf(): Promise<number> {
  const { data } = await supa.from('economy_wallets').select('wallet').eq('guild_id', GUILD_ID).eq('user_id', USER).single();
  return Number(data!.wallet);
}
async function ticketCount(requestId?: string): Promise<number> {
  let q = supa.from('economy_lottery_tickets').select('*', { count: 'exact', head: true }).eq('drawing_id', drawingId).eq('user_id', USER);
  if (requestId) q = q.eq('request_id', requestId);
  const { count } = await q;
  return count ?? 0;
}
function lotteryBuy(count: number, requestId: string) {
  return supa.rpc('lottery_buy_tickets_atomic', {
    p_drawing_id: drawingId, p_guild_id: GUILD_ID, p_user_id: USER,
    p_count: count, p_max: 10, p_cost: count * 100, p_request_id: requestId,
  }) as unknown as Promise<{ data: { status: string; replayed: boolean } | null; error: unknown }>;
}
function prestige(requestId: string) {
  return supa.rpc('economy_prestige_apply', {
    p_guild_id: GUILD_ID, p_user_id: USER, p_min_level: 50, p_min_net_worth: 1000000,
    p_multiplier_gain: 10, p_request_id: requestId,
  }) as unknown as Promise<{ data: { status: string; replayed: boolean; new_level: number; new_multiplier: number } | null; error: unknown }>;
}
async function prestigeRow(): Promise<{ prestige_level: number; multiplier_pct: number; total_resets: number } | null> {
  const { data } = await supa.from('economy_prestige').select('prestige_level, multiplier_pct, total_resets').eq('guild_id', GUILD_ID).eq('user_id', USER).maybeSingle();
  return (data as { prestige_level: number; multiplier_pct: number; total_resets: number } | null) ?? null;
}

beforeAll(async () => {
  supa = await requireSupabase();
  const { error: gErr } = await supa.from('guild').insert({ id: GUILD_ID, name: 'LP Test Guild', owner_discord_id: '100000000000000030' });
  if (gErr) throw new Error(`guild seed: ${gErr.message}`);
  const { error: cErr } = await supa.from('guild_config').insert({ guild_id: GUILD_ID });
  if (cErr) throw new Error(`guild_config seed: ${cErr.message}`);
  const { data: d, error: dErr } = await supa.from('economy_lottery_drawings').insert({ guild_id: GUILD_ID, status: 'active', jackpot: 0 }).select('id').single();
  if (dErr) throw new Error(`drawing seed: ${dErr.message}`);
  drawingId = d!.id as string;
});

afterAll(async () => {
  const ids = [GUILD_ID];
  await supa.from('economy_lottery_tickets').delete().in('guild_id', ids);
  await supa.from('economy_lottery_drawings').delete().in('guild_id', ids);
  await supa.from('economy_prestige').delete().in('guild_id', ids);
  await supa.from('member_levels').delete().in('guild_id', ids);
  await supa.from('economy_wallets').delete().in('guild_id', ids);
  await supa.from('guild_config').delete().in('guild_id', ids);
  await supa.from('guild').delete().in('id', ids);
});

describe('lottery_buy_tickets_atomic', () => {
  it('charges and issues tickets, then replays exactly once (double-charge fix)', async () => {
    await seedWallet(1000);
    const first = await lotteryBuy(2, 'interaction-lbuy');
    expect(first.error).toBeNull();
    expect(first.data).toMatchObject({ status: 'purchased', replayed: false });
    expect(await walletOf()).toBe(800);
    expect(await ticketCount()).toBe(2);

    const replay = await lotteryBuy(2, 'interaction-lbuy');
    expect(replay.error).toBeNull();
    expect(replay.data).toMatchObject({ status: 'purchased', replayed: true });
    expect(await walletOf()).toBe(800); // unchanged
    expect(await ticketCount()).toBe(2); // not 4
    expect(await ticketCount('interaction-lbuy')).toBe(2);
  });

  it('serializes a concurrent same-id double-fire to one purchase', async () => {
    const before = await walletOf();
    const [r1, r2] = await Promise.all([lotteryBuy(1, 'interaction-lcc'), lotteryBuy(1, 'interaction-lcc')]);
    expect(r1.error).toBeNull();
    expect(r2.error).toBeNull();
    expect([r1.data!.replayed, r2.data!.replayed].sort()).toEqual([false, true]);
    expect(before - (await walletOf())).toBe(100);
    expect(await ticketCount('interaction-lcc')).toBe(1);
  });

  it('moves nothing on insufficient funds', async () => {
    await seedWallet(50);
    const { data, error } = await lotteryBuy(1, 'interaction-lpoor');
    expect(error).toBeNull();
    expect(data).toMatchObject({ status: 'insufficient_funds' });
    expect(await walletOf()).toBe(50);
    expect(await ticketCount('interaction-lpoor')).toBe(0);
  });
});

describe('economy_prestige_apply', () => {
  it('applies once, then replays without double-bumping level or multiplier', async () => {
    await seedWallet(2000000, 0);
    await supa.from('member_levels').upsert({ guild_id: GUILD_ID, member_id: USER, level: 60 });

    const first = await prestige('interaction-prestige');
    expect(first.error).toBeNull();
    expect(first.data).toMatchObject({ status: 'prestiged', replayed: false, new_level: 1, new_multiplier: 10 });
    expect(await walletOf()).toBe(0); // wallet reset
    expect(await prestigeRow()).toMatchObject({ prestige_level: 1, multiplier_pct: 10, total_resets: 1 });

    const replay = await prestige('interaction-prestige');
    expect(replay.error).toBeNull();
    expect(replay.data).toMatchObject({ status: 'prestiged', replayed: true, new_level: 1, new_multiplier: 10 });
    // Level, multiplier, and reset count are unchanged — the replay did not re-apply.
    expect(await prestigeRow()).toMatchObject({ prestige_level: 1, multiplier_pct: 10, total_resets: 1 });
  });

  it('rejects below the level requirement without side effects', async () => {
    const otherUser = `${USER}-lowlevel`;
    const { data, error } = await supa.rpc('economy_prestige_apply', {
      p_guild_id: GUILD_ID, p_user_id: otherUser, p_min_level: 50, p_min_net_worth: 1000000, p_multiplier_gain: 10, p_request_id: 'interaction-lowlevel',
    });
    expect(error).toBeNull();
    expect(data).toMatchObject({ status: 'level_too_low' });
    const { count } = await supa.from('economy_prestige').select('*', { count: 'exact', head: true }).eq('guild_id', GUILD_ID).eq('user_id', otherUser);
    expect(count).toBe(0);
  });
});
