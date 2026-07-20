/**
 * Integration test: /market buy is atomic + idempotent.
 *
 * Regression guard for the money-path bug where MarketManager.buy ran the purchase
 * as four separate, non-idempotent RPCs with no interaction-id key, so a
 * redelivered /market buy decremented the listing, debited the buyer, credited the
 * seller and delivered again → duplicate sale / double-spend. Now one atomic RPC
 * keyed on the interaction id; a replay is a proven no-op.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Guild } from 'discord.js';
import type Valkey from 'iovalkey';
import { requireSupabase } from './helpers.js';
import { MarketManager } from '../../features/market/market-manager.js';

let supa!: SupabaseClient;
const GUILD_ID = `test-market-${Date.now()}`;
const BUYER = 'market-buyer';
const SELLER = 'market-seller';
let itemId = '';
let listingId = '';

const valkeyStub = { get: async () => null, set: async () => 'OK', del: async () => 0 } as unknown as Valkey;

async function wallet(user: string): Promise<number> {
  const { data } = await supa.from('economy_wallets').select('wallet').eq('guild_id', GUILD_ID).eq('user_id', user).single();
  return Number(data!.wallet);
}

beforeAll(async () => {
  supa = await requireSupabase();
  await supa.from('guild').insert({ id: GUILD_ID, name: 'Market Test', owner_discord_id: '1' });
  await supa.from('guild_config').insert({ guild_id: GUILD_ID, economy_market_enabled: true, economy_market_fee_pct: 10 });
  const { data: item } = await supa.from('economy_items').insert({ guild_id: GUILD_ID, name: 'Widget', price: 50, active: true }).select('id').single();
  itemId = item!.id;
  await supa.rpc('economy_get_or_create_wallet', { p_guild_id: GUILD_ID, p_user_id: BUYER });
  await supa.rpc('economy_get_or_create_wallet', { p_guild_id: GUILD_ID, p_user_id: SELLER });
  await supa.from('economy_wallets').update({ wallet: 1000 }).eq('guild_id', GUILD_ID).eq('user_id', BUYER);
  await supa.from('economy_wallets').update({ wallet: 0 }).eq('guild_id', GUILD_ID).eq('user_id', SELLER);
  const { data: listing } = await supa.from('economy_market_listings').insert({
    guild_id: GUILD_ID, seller_id: SELLER, item_id: itemId, item_name: 'Widget',
    quantity: 5, remaining: 5, price_per_unit: 100, status: 'active',
    expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
  }).select('id').single();
  listingId = listing!.id;
});

afterAll(async () => {
  await supa.from('economy_transactions').delete().eq('guild_id', GUILD_ID);
  await supa.from('economy_inventory').delete().eq('guild_id', GUILD_ID);
  await supa.from('economy_market_listings').delete().eq('guild_id', GUILD_ID);
  await supa.from('economy_wallets').delete().eq('guild_id', GUILD_ID);
  await supa.from('economy_items').delete().eq('guild_id', GUILD_ID);
  await supa.from('guild_config').delete().eq('guild_id', GUILD_ID);
  await supa.from('guild').delete().eq('id', GUILD_ID);
});

describe('/market buy atomic + idempotent', () => {
  it('applies once, and a redelivered interaction is a no-op', async () => {
    const mgr = new MarketManager({ id: GUILD_ID } as unknown as Guild, supa, valkeyStub);
    const prefix = listingId.slice(0, 8);
    const requestId = 'interaction-req-1';

    // First buy: 2 @ 100 = 200; 10% fee = 20; seller nets 180.
    const e1 = await mgr.buy(BUYER, prefix, 2, requestId);
    expect(JSON.stringify(e1.data)).toMatch(/Purchase Complete/);
    expect(await wallet(BUYER)).toBe(800);
    expect(await wallet(SELLER)).toBe(180);

    const snapshot = async () => {
      const { data: l } = await supa.from('economy_market_listings').select('remaining, status').eq('id', listingId).single();
      const { data: inv } = await supa.from('economy_inventory').select('quantity').eq('guild_id', GUILD_ID).eq('user_id', BUYER).single();
      const { count } = await supa.from('economy_transactions').select('*', { count: 'exact', head: true }).eq('guild_id', GUILD_ID);
      return { remaining: l!.remaining, status: l!.status, inv: inv!.quantity, ledger: count };
    };
    const after1 = await snapshot();
    expect(after1).toEqual({ remaining: 3, status: 'active', inv: 2, ledger: 2 });

    // Replay with the SAME interaction id — nothing must change.
    const e2 = await mgr.buy(BUYER, prefix, 2, requestId);
    expect(JSON.stringify(e2.data)).toMatch(/Purchase Complete/); // still reports the (cached) success
    expect(await wallet(BUYER)).toBe(800); // NOT 600
    expect(await wallet(SELLER)).toBe(180); // NOT 360
    expect(await snapshot()).toEqual(after1); // listing/inventory/ledger unchanged
  });
});
