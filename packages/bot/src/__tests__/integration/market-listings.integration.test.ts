/**
 * Integration test: Market listings — economy_market_atomic_create_listing RPC.
 *
 * Validates the atomic verify+decrement+insert transaction that makes listing
 * creation safe: either the listing exists and the items are escrowed in it,
 * or the seller's inventory is untouched. The inventory row lock must also
 * prevent concurrent listings of the same stack from overselling.
 * All against a real Supabase instance.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireSupabase } from './helpers.js';

let supa!: SupabaseClient;
const GUILD_ID = `test-market-guild-${Date.now()}`;
const SELLER = 'market-seller-aaa';
let itemId: string;

interface CreateListingResult {
  listing?: {
    id: string;
    guild_id: string;
    seller_id: string;
    item_id: string;
    item_name: string;
    quantity: number;
    remaining: number;
    price_per_unit: number;
    status: string;
  };
  error?: string;
}

function createListing(quantity: number) {
  return supa.rpc('economy_market_atomic_create_listing', {
    p_guild_id: GUILD_ID,
    p_seller_id: SELLER,
    p_item_id: itemId,
    p_quantity: quantity,
    p_price_per_unit: 50,
    p_item_name: 'Test Sword',
    p_expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  });
}

async function seedInventory(quantity: number): Promise<void> {
  await supa.from('economy_inventory').delete()
    .eq('guild_id', GUILD_ID).eq('user_id', SELLER);
  const { error } = await supa.from('economy_inventory').insert({
    guild_id: GUILD_ID,
    user_id: SELLER,
    item_id: itemId,
    quantity,
  });
  expect(error).toBeNull();
}

async function getInventoryQty(): Promise<number | null> {
  const { data } = await supa.from('economy_inventory').select('quantity')
    .eq('guild_id', GUILD_ID).eq('user_id', SELLER).eq('item_id', itemId)
    .maybeSingle();
  return data?.quantity ?? null;
}

async function countListings(): Promise<number> {
  const { count } = await supa.from('economy_market_listings')
    .select('id', { count: 'exact', head: true })
    .eq('guild_id', GUILD_ID);
  return count ?? 0;
}

beforeAll(async () => {
  supa = await requireSupabase();

  await supa.from('guild').insert({
    id: GUILD_ID,
    name: 'Market Test Guild',
    owner_discord_id: '111222333',
  });
  await supa.from('guild_config').insert({ guild_id: GUILD_ID });

  const { data: item, error } = await supa.from('economy_items').insert({
    guild_id: GUILD_ID,
    name: 'Test Sword',
    price: 100,
  }).select('id').single();
  expect(error).toBeNull();
  itemId = item!.id;
});

afterAll(async () => {
  await supa.from('economy_market_listings').delete().eq('guild_id', GUILD_ID);
  await supa.from('economy_inventory').delete().eq('guild_id', GUILD_ID);
  await supa.from('economy_items').delete().eq('guild_id', GUILD_ID);
  await supa.from('guild_config').delete().eq('guild_id', GUILD_ID);
  await supa.from('guild').delete().eq('id', GUILD_ID);
});

beforeEach(async () => {
  // Each test starts with no listings so counts are deterministic
  await supa.from('economy_market_listings').delete().eq('guild_id', GUILD_ID);
});

describe('economy_market_atomic_create_listing RPC', () => {
  it('creates the listing and decrements inventory exactly once', async () => {
    await seedInventory(10);

    const { data, error } = await createListing(3);

    expect(error).toBeNull();
    const result = data as CreateListingResult;
    expect(result.error).toBeUndefined();
    expect(result.listing).toBeDefined();
    expect(result.listing!.quantity).toBe(3);
    expect(result.listing!.remaining).toBe(3);
    expect(result.listing!.status).toBe('active');
    expect(result.listing!.seller_id).toBe(SELLER);

    expect(await getInventoryQty()).toBe(7);
    expect(await countListings()).toBe(1);
  });

  it('rejects insufficient inventory with a typed error and no mutation', async () => {
    await seedInventory(5);

    const { data, error } = await createListing(9);

    expect(error).toBeNull();
    const result = data as CreateListingResult;
    expect(result.error).toBe('insufficient_inventory');
    expect(result.listing).toBeUndefined();

    // Nothing changed: inventory intact, no listing row
    expect(await getInventoryQty()).toBe(5);
    expect(await countListings()).toBe(0);
  });

  it('rejects when the seller has no stack at all', async () => {
    await supa.from('economy_inventory').delete()
      .eq('guild_id', GUILD_ID).eq('user_id', SELLER);

    const { data, error } = await createListing(1);

    expect(error).toBeNull();
    expect((data as CreateListingResult).error).toBe('insufficient_inventory');
    expect(await countListings()).toBe(0);
  });

  it('removes the inventory row when the entire stack is listed', async () => {
    await seedInventory(4);

    const { data, error } = await createListing(4);

    expect(error).toBeNull();
    expect((data as CreateListingResult).listing).toBeDefined();
    // Mirrors economy_decrement_inventory: row deleted at zero
    expect(await getInventoryQty()).toBeNull();
  });

  it('raises on non-positive quantity without touching inventory', async () => {
    await seedInventory(5);

    const { error } = await createListing(0);

    expect(error).not.toBeNull();
    expect(error!.message).toContain('quantity must be positive');
    expect(await getInventoryQty()).toBe(5);
    expect(await countListings()).toBe(0);
  });

  it('concurrent double-listing of the same stack cannot oversell', async () => {
    await seedInventory(10);

    // Two parallel attempts to list 7 of a 10-stack: the row lock serializes
    // them, so exactly one wins and the loser gets the typed error.
    const [a, b] = await Promise.all([createListing(7), createListing(7)]);

    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
    const results = [a.data as CreateListingResult, b.data as CreateListingResult];
    const successes = results.filter((r) => r.listing);
    const rejections = results.filter((r) => r.error === 'insufficient_inventory');

    expect(successes).toHaveLength(1);
    expect(rejections).toHaveLength(1);
    expect(await getInventoryQty()).toBe(3);
    expect(await countListings()).toBe(1);
  });
});
