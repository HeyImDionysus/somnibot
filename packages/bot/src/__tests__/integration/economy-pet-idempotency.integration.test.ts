/**
 * Integration coverage for the atomic/idempotent pet money paths.
 *
 * A same-id retry (including a concurrent duplicate) must return the original
 * result while moving money and pet state exactly once. A retry after the
 * first call has committed is the ambiguous-commit recovery path.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireSupabase } from './helpers.js';

let supa!: SupabaseClient;
const GUILD_ID = `test-pet-idem-${Date.now()}`;
const USER = `pet-idem-user-${Date.now()}`;

function rpc(name: string, args: Record<string, unknown>) {
  return supa.rpc(name as never, args as never) as unknown as Promise<{
    data: Record<string, unknown> | null;
    error: { message: string } | null;
  }>;
}

async function walletOf(user = USER): Promise<number> {
  const { data } = await supa.from('economy_wallets').select('wallet').eq('guild_id', GUILD_ID).eq('user_id', user).single();
  return Number(data?.wallet ?? 0);
}

async function seedPet(user = USER, fields: Record<string, unknown> = {}): Promise<void> {
  await supa.from('economy_pets').upsert({
    guild_id: GUILD_ID, user_id: user, name: 'Test Pet', pet_type: 'hunting',
    hunger: 40, happiness: 80, energy: 90, level: 1, xp: 0, ...fields,
  });
}

beforeAll(async () => {
  supa = await requireSupabase();
  const { error: gErr } = await supa.from('guild').insert({ id: GUILD_ID, name: 'Pet Idempotency Guild', owner_discord_id: '100000000000000099' });
  if (gErr) throw new Error(`guild seed: ${gErr.message}`);
  const { error: cErr } = await supa.from('guild_config').insert({ guild_id: GUILD_ID, economy_pets_enabled: true });
  if (cErr) throw new Error(`guild_config seed: ${cErr.message}`);
});

afterAll(async () => {
  if (!supa) return;
  await supa.from('economy_pet_operations').delete().eq('guild_id', GUILD_ID);
  await supa.from('economy_transactions').delete().eq('guild_id', GUILD_ID);
  await supa.from('economy_pets').delete().eq('guild_id', GUILD_ID);
  await supa.from('economy_wallets').delete().eq('guild_id', GUILD_ID);
  await supa.from('guild_config').delete().eq('guild_id', GUILD_ID);
  await supa.from('guild').delete().eq('id', GUILD_ID);
});

describe('economy_pet_feed_atomic', () => {
  it('charges and mutates once, then replays the original result', async () => {
    await supa.from('economy_wallets').upsert({ guild_id: GUILD_ID, user_id: USER, wallet: 500 });
    await seedPet();
    const first = await rpc('economy_pet_feed_atomic', {
      p_guild_id: GUILD_ID, p_user_id: USER, p_amount: 30, p_cost: 50, p_request_id: 'feed-replay',
    });
    const replay = await rpc('economy_pet_feed_atomic', {
      p_guild_id: GUILD_ID, p_user_id: USER, p_amount: 30, p_cost: 50, p_request_id: 'feed-replay',
    });
    expect(first.error).toBeNull();
    expect(first.data).toMatchObject({ status: 'fed', replayed: false, old_hunger: 40, new_hunger: 70 });
    expect(replay.data).toMatchObject({ status: 'fed', replayed: true, old_hunger: 40, new_hunger: 70 });
    expect(await walletOf()).toBe(450);
    const { data: pet } = await supa.from('economy_pets').select('hunger').eq('guild_id', GUILD_ID).eq('user_id', USER).single();
    expect(pet?.hunger).toBe(70);
    const { count } = await supa.from('economy_transactions').select('*', { count: 'exact', head: true }).eq('guild_id', GUILD_ID).eq('idempotency_key', 'pet:feed:feed-replay');
    expect(count).toBe(1);
  });

  it('serializes a concurrent duplicate and moves nothing on insufficient funds', async () => {
    await supa.from('economy_wallets').upsert({ guild_id: GUILD_ID, user_id: USER, wallet: 500 });
    await seedPet();
    const [a, b] = await Promise.all([
      rpc('economy_pet_feed_atomic', { p_guild_id: GUILD_ID, p_user_id: USER, p_amount: 30, p_cost: 50, p_request_id: 'feed-concurrent' }),
      rpc('economy_pet_feed_atomic', { p_guild_id: GUILD_ID, p_user_id: USER, p_amount: 30, p_cost: 50, p_request_id: 'feed-concurrent' }),
    ]);
    expect(a.error).toBeNull(); expect(b.error).toBeNull();
    expect([a.data?.replayed, b.data?.replayed].sort()).toEqual([false, true]);
    expect(await walletOf()).toBe(450);

    await supa.from('economy_wallets').upsert({ guild_id: GUILD_ID, user_id: USER, wallet: 10 });
    const poor = await rpc('economy_pet_feed_atomic', { p_guild_id: GUILD_ID, p_user_id: USER, p_amount: 30, p_cost: 50, p_request_id: 'feed-poor' });
    expect(poor.error).toBeNull();
    expect(poor.data).toMatchObject({ status: 'insufficient_balance', replayed: false });
    expect(await walletOf()).toBe(10);
  });
});

describe('economy_pet_buy_atomic and economy_pet_train_atomic', () => {
  it('buy charges once under concurrent duplicate delivery', async () => {
    const user = `${USER}-buy`;
    await supa.from('economy_wallets').upsert({ guild_id: GUILD_ID, user_id: user, wallet: 10000 });
    const [a, b] = await Promise.all([
      rpc('economy_pet_buy_atomic', { p_guild_id: GUILD_ID, p_user_id: user, p_pet_type: 'hunting', p_pet_name: '🐺 Pet', p_price: 5000, p_request_id: 'buy-concurrent' }),
      rpc('economy_pet_buy_atomic', { p_guild_id: GUILD_ID, p_user_id: user, p_pet_type: 'hunting', p_pet_name: '🐺 Pet', p_price: 5000, p_request_id: 'buy-concurrent' }),
    ]);
    expect([a.data?.replayed, b.data?.replayed].sort()).toEqual([false, true]);
    expect(await walletOf(user)).toBe(5000);
    const { count } = await supa.from('economy_pets').select('*', { count: 'exact', head: true }).eq('guild_id', GUILD_ID).eq('user_id', user);
    expect(count).toBe(1);
  });

  it('train debits and mutates once, with replay recovering an ambiguous commit', async () => {
    const user = `${USER}-train`;
    await supa.from('economy_wallets').upsert({ guild_id: GUILD_ID, user_id: user, wallet: 500 });
    await seedPet(user);
    const args = { p_guild_id: GUILD_ID, p_user_id: user, p_xp_gain: 20, p_energy_cost: 20, p_cost: 100, p_request_id: 'train-replay' };
    const first = await rpc('economy_pet_train_atomic', args);
    const retryAfterTimeout = await rpc('economy_pet_train_atomic', args);
    expect(first.data).toMatchObject({ status: 'trained', replayed: false });
    expect(retryAfterTimeout.data).toMatchObject({ status: 'trained', replayed: true });
    expect(await walletOf(user)).toBe(400);
    const { data: pet } = await supa.from('economy_pets').select('xp,energy').eq('guild_id', GUILD_ID).eq('user_id', user).single();
    expect(pet).toMatchObject({ xp: 20, energy: 70 });
  });
});
