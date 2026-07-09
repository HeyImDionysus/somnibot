/**
 * Tests for MarketManager.listItem atomicity — economy_market_atomic_create_listing RPC.
 *
 * Regression coverage: listing creation previously decremented inventory via
 * economy_decrement_inventory, then INSERTed the listing row separately, with a
 * compensating economy_upsert_inventory refund on insert failure. If both the
 * insert AND the refund failed, the seller's items were permanently destroyed.
 * listItem must now delegate verify+decrement+insert to a single atomic RPC so
 * there is no refund path at all.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../features/quests/quests-manager.js', () => ({
  getQuestsManager: () => null,
}));

import { MarketManager } from '../features/market/market-manager.js';

const ATOMIC_RPC = 'economy_market_atomic_create_listing';

const marketCfg = {
  economy_market_enabled: true,
  economy_market_fee_pct: 5,
  economy_market_listing_days: 7,
  economy_market_max_listings: 10,
};

const createdListing = {
  id: 'lst-new-1',
  guild_id: 'g1',
  seller_id: 'u1',
  item_id: 'item-1',
  item_name: 'Iron Sword',
  quantity: 3,
  remaining: 3,
  price_per_unit: 50,
  status: 'active',
  expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  created_at: new Date().toISOString(),
};

// ═══════ Shared helpers ═══════
function chain(data: any = null, error: any = null) {
  const c: any = {};
  for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'or', 'not', 'order', 'limit', 'range', 'match', 'ilike', 'like', 'filter', 'contains', 'textSearch', 'head', 'overlaps'])
    c[m] = vi.fn((..._: any[]) => c);
  c.maybeSingle = vi.fn(async () => ({ data, error }));
  c.single = vi.fn(async () => ({ data, error }));
  c.then = undefined;
  return c;
}
function chainAsync(data: any[] = [], count: number | null = null, error: any = null) {
  const c: any = {};
  for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'or', 'not', 'order', 'limit', 'range', 'match', 'ilike', 'like', 'filter', 'contains', 'textSearch', 'head', 'overlaps'])
    c[m] = vi.fn((..._: any[]) => c);
  c.maybeSingle = vi.fn(async () => ({ data: data?.[0] ?? null, error, count }));
  c.single = vi.fn(async () => ({ data: data?.[0] ?? null, error, count }));
  c.then = (resolve: Function) => resolve({ data, error, count });
  return c;
}

function makeSupa(opts: {
  inventoryQty?: number;
  rpcImpl?: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
} = {}) {
  const { inventoryQty = 10 } = opts;
  // Shared listings chain so tests can assert .insert() is never called
  const listingsChain = chainAsync([], 0);
  const supa: any = {
    listingsChain,
    from: vi.fn((table: string) => {
      if (table === 'guild_config') return chain(marketCfg);
      if (table === 'economy_market_listings') return listingsChain;
      if (table === 'economy_inventory') return chainAsync([
        { id: 'inv1', quantity: inventoryQty, item_id: 'item-1', economy_items: { id: 'item-1', name: 'Iron Sword' } },
      ]);
      return chain(null);
    }),
    rpc: vi.fn(opts.rpcImpl ?? (async () => ({ data: null, error: null }))),
  };
  return supa;
}

const guild = { id: 'g1' } as any;
const valkey = {} as any;

describe('MarketManager.listItem atomic listing creation', () => {
  it('creates the listing via ONE atomic RPC and decrements exactly once', async () => {
    const supa = makeSupa({
      rpcImpl: async (fn) =>
        fn === ATOMIC_RPC
          ? { data: { listing: createdListing }, error: null }
          : { data: null, error: null },
    });
    const mgr = new MarketManager(guild, supa, valkey);

    const embed = await mgr.listItem('u1', 'Iron Sword', 3, 50);

    expect(embed.data.title).toContain('Item Listed');
    // Exactly one RPC — the atomic create. No separate decrement, no refund.
    expect(supa.rpc).toHaveBeenCalledTimes(1);
    expect(supa.rpc).toHaveBeenCalledWith(ATOMIC_RPC, {
      p_guild_id: 'g1',
      p_seller_id: 'u1',
      p_item_id: 'item-1',
      p_quantity: 3,
      p_price_per_unit: 50,
      p_item_name: 'Iron Sword',
      p_expires_at: expect.any(String),
    });
    // The listing row is inserted inside the RPC, never client-side.
    expect(supa.listingsChain.insert).not.toHaveBeenCalled();
  });

  it('rejects insufficient inventory (typed error) without any mutation or refund', async () => {
    const supa = makeSupa({
      rpcImpl: async (fn) =>
        fn === ATOMIC_RPC
          ? { data: { error: 'insufficient_inventory' }, error: null }
          : { data: null, error: null },
    });
    const mgr = new MarketManager(guild, supa, valkey);

    const embed = await mgr.listItem('u1', 'Iron Sword', 3, 50);

    expect(embed.data.description).toContain("don't have enough");
    // Only the atomic RPC ran — no economy_upsert_inventory refund attempt.
    const rpcNames = supa.rpc.mock.calls.map((c: unknown[]) => c[0]);
    expect(rpcNames).toEqual([ATOMIC_RPC]);
    expect(supa.listingsChain.insert).not.toHaveBeenCalled();
  });

  it('surfaces an RPC error cleanly with no refund path', async () => {
    const supa = makeSupa({
      rpcImpl: async (fn) =>
        fn === ATOMIC_RPC
          ? { data: null, error: { message: 'connection reset' } }
          : { data: null, error: null },
    });
    const mgr = new MarketManager(guild, supa, valkey);

    const embed = await mgr.listItem('u1', 'Iron Sword', 3, 50);

    expect(embed.data.description).toContain('Failed to create listing');
    // The transaction rolled back server-side; the client must NOT attempt a
    // compensating economy_upsert_inventory refund (the old lossy path).
    const rpcNames = supa.rpc.mock.calls.map((c: unknown[]) => c[0]);
    expect(rpcNames).toEqual([ATOMIC_RPC]);
    expect(supa.listingsChain.insert).not.toHaveBeenCalled();
  });

  it('concurrent double-listing of the same stack cannot oversell (RPC contract)', async () => {
    // Both calls pass the stale client-side pre-check (10 in inventory, 7 each),
    // but the RPC's row lock serializes them: the second sees only 3 left.
    let rpcCalls = 0;
    const supa = makeSupa({
      inventoryQty: 10,
      rpcImpl: async (fn) => {
        if (fn !== ATOMIC_RPC) return { data: null, error: null };
        rpcCalls += 1;
        return rpcCalls === 1
          ? { data: { listing: { ...createdListing, quantity: 7, remaining: 7 } }, error: null }
          : { data: { error: 'insufficient_inventory' }, error: null };
      },
    });
    const mgr = new MarketManager(guild, supa, valkey);

    const [first, second] = await Promise.all([
      mgr.listItem('u1', 'Iron Sword', 7, 50),
      mgr.listItem('u1', 'Iron Sword', 7, 50),
    ]);

    expect(first.data.title).toContain('Item Listed');
    expect(second.data.description).toContain("don't have enough");
    // Both attempts went through the atomic RPC — nothing else touched inventory.
    const rpcNames = supa.rpc.mock.calls.map((c: unknown[]) => c[0]);
    expect(rpcNames).toEqual([ATOMIC_RPC, ATOMIC_RPC]);
    expect(supa.listingsChain.insert).not.toHaveBeenCalled();
  });
});
