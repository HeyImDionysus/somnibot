/**
 * Integration coverage for economy_buy_item (shop /buy).
 *
 * Real local Supabase, no mocks. Proves the properties mocks cannot: the funds
 * check, debit, stock decrement, inventory grant, and ledger row commit as one
 * transaction; a redelivered interaction charges and delivers exactly once;
 * concurrent same-id deliveries serialize to one purchase; and a failed purchase
 * (insufficient funds / out of stock) moves nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireSupabase } from './helpers.js';

let supa!: SupabaseClient;
const GUILD_ID = `test-buy-item-${Date.now()}`;
const USER = `buy-user-${Date.now()}`;
let itemId: string;

interface BuyResult {
  status: 'purchased' | 'insufficient_funds' | 'out_of_stock' | 'max_per_user' | 'item_not_found';
  replayed: boolean;
  total_cost?: number;
  wallet_balance?: number;
}

async function buy(quantity: number, requestId: string): Promise<{ data: BuyResult | null; error: { message: string } | null }> {
  return supa.rpc('economy_buy_item', {
    p_guild_id: GUILD_ID,
    p_user_id: USER,
    p_item_id: itemId,
    p_quantity: quantity,
    p_request_id: requestId,
  }) as unknown as Promise<{ data: BuyResult | null; error: { message: string } | null }>;
}

async function seedWallet(wallet: number): Promise<void> {
  await supa.from('economy_wallets').upsert({ guild_id: GUILD_ID, user_id: USER, wallet, bank: 0, total_earned: wallet, total_spent: 0 });
}
async function walletOf(): Promise<number> {
  const { data } = await supa.from('economy_wallets').select('wallet').eq('guild_id', GUILD_ID).eq('user_id', USER).single();
  return Number(data!.wallet);
}
async function stockOf(): Promise<number> {
  const { data } = await supa.from('economy_items').select('stock').eq('id', itemId).single();
  return Number(data!.stock);
}
async function inventoryOf(): Promise<number> {
  const { data } = await supa.from('economy_inventory').select('quantity').eq('guild_id', GUILD_ID).eq('user_id', USER).eq('item_id', itemId).maybeSingle();
  return Number(data?.quantity ?? 0);
}
async function shopBuyRows(requestId: string): Promise<number> {
  const { count } = await supa.from('economy_transactions').select('*', { count: 'exact', head: true })
    .eq('guild_id', GUILD_ID).eq('user_id', USER).eq('type', 'shop_buy').eq('metadata->>request_id', requestId);
  return count ?? 0;
}

beforeAll(async () => {
  supa = await requireSupabase();
  const { error: gErr } = await supa.from('guild').insert({ id: GUILD_ID, name: 'Atomic Buy Test Guild', owner_discord_id: '100000000000000020' });
  if (gErr) throw new Error(`guild seed: ${gErr.message}`);
  const { data: item, error: iErr } = await supa.from('economy_items')
    .insert({ guild_id: GUILD_ID, name: 'Sword', price: 100, stock: 10, active: true })
    .select('id').single();
  if (iErr) throw new Error(`item seed: ${iErr.message}`);
  itemId = item!.id as string;
});

afterAll(async () => {
  const ids = [GUILD_ID];
  await supa.from('economy_transactions').delete().in('guild_id', ids);
  await supa.from('economy_inventory').delete().in('guild_id', ids);
  await supa.from('economy_items').delete().in('guild_id', ids);
  await supa.from('economy_wallets').delete().in('guild_id', ids);
  await supa.from('guild').delete().in('id', ids);
});

describe('economy_buy_item', () => {
  it('charges, decrements stock, grants inventory, and writes one ledger row atomically', async () => {
    await seedWallet(1000);
    const { data, error } = await buy(1, 'interaction-happy');
    expect(error).toBeNull();
    expect(data).toMatchObject({ status: 'purchased', replayed: false, total_cost: 100 });
    expect(await walletOf()).toBe(900);
    expect(await stockOf()).toBe(9);
    expect(await inventoryOf()).toBe(1);
    expect(await shopBuyRows('interaction-happy')).toBe(1);
  });

  it('replays one interaction without a second charge or a second item (double-spend fix)', async () => {
    const replay = await buy(1, 'interaction-happy');
    expect(replay.error).toBeNull();
    expect(replay.data).toMatchObject({ status: 'purchased', replayed: true });
    // Unchanged from the first purchase above.
    expect(await walletOf()).toBe(900);
    expect(await stockOf()).toBe(9);
    expect(await inventoryOf()).toBe(1);
    expect(await shopBuyRows('interaction-happy')).toBe(1);
  });

  it('serializes a concurrent same-id double-fire to exactly one purchase', async () => {
    const before = await walletOf();
    const [r1, r2] = await Promise.all([buy(1, 'interaction-concurrent'), buy(1, 'interaction-concurrent')]);
    expect(r1.error).toBeNull();
    expect(r2.error).toBeNull();
    expect([r1.data!.replayed, r2.data!.replayed].sort()).toEqual([false, true]);
    expect(before - (await walletOf())).toBe(100); // exactly one charge
    expect(await shopBuyRows('interaction-concurrent')).toBe(1);
  });

  it('moves nothing on insufficient funds', async () => {
    await seedWallet(50);
    const stockBefore = await stockOf();
    const { data, error } = await buy(1, 'interaction-poor');
    expect(error).toBeNull();
    expect(data).toMatchObject({ status: 'insufficient_funds' });
    expect(await walletOf()).toBe(50);
    expect(await stockOf()).toBe(stockBefore);
    expect(await shopBuyRows('interaction-poor')).toBe(0);
  });

  it('moves nothing when the requested quantity exceeds stock', async () => {
    await seedWallet(100000);
    const { data, error } = await buy(999, 'interaction-nostock');
    expect(error).toBeNull();
    expect(data).toMatchObject({ status: 'out_of_stock' });
    expect(await walletOf()).toBe(100000);
    expect(await shopBuyRows('interaction-nostock')).toBe(0);
  });

  it('erases the shop_buy ledger anchor through the member-purge RPC', async () => {
    // The idempotency anchor is a shop_buy economy_transactions row, which
    // purge_member_data already deletes — no new PII table escapes purge.
    expect(await shopBuyRows('interaction-happy')).toBe(1);
    const { error } = await supa.rpc('purge_member_data', { p_guild_id: GUILD_ID, p_user_id: USER });
    expect(error).toBeNull();
    expect(await shopBuyRows('interaction-happy')).toBe(0);
  });
});
