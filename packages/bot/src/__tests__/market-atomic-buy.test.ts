/**
 * Tests for MarketManager.buy idempotency — economy_market_settle_buy RPC.
 *
 * Regression coverage: /market buy previously ran FOUR separate, non-idempotent
 * RPCs (economy_market_buy listing decrement, economy_subtract_balance buyer
 * debit, economy_add_balance seller credit, economy_upsert_inventory delivery)
 * with NO idempotency key. A redelivered interaction therefore decremented the
 * listing again, debited the buyer again, credited the seller again and
 * delivered again → duplicate market sale / double-spend.
 *
 * buy() must now delegate the whole purchase to ONE atomic+idempotent RPC keyed
 * on the interaction id, so a redelivered /market buy is a proven no-op.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { trackProgress } = vi.hoisted(() => ({ trackProgress: vi.fn(async () => {}) }));

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../features/quests/quests-manager.js', () => ({
  getQuestsManager: () => ({ trackProgress }),
}));

import { MarketManager } from '../features/market/market-manager.js';

const SETTLE_RPC = 'economy_market_settle_buy';
// The four legacy, non-idempotent RPCs the single atomic settle RPC replaced.
// A redelivered buy re-invoked each of these, double-applying every side effect.
const LEGACY_RPCS = [
  'economy_market_buy',
  'economy_subtract_balance',
  'economy_add_balance',
  'economy_upsert_inventory',
];

const marketCfg = {
  economy_market_enabled: true,
  economy_market_fee_pct: 5,
  economy_market_listing_days: 7,
  economy_market_max_listings: 10,
};

const LISTING = {
  id: 'a1b2c3d4-1111-2222-3333-444455556666',
  guild_id: 'g1',
  seller_id: 'seller-9',
  item_id: 'item-1',
  item_name: 'Iron Sword',
  quantity: 5,
  remaining: 5,
  price_per_unit: 100,
  status: 'active',
  expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  created_at: new Date().toISOString(),
};

const PURCHASED = {
  status: 'purchased', replayed: false,
  item_id: 'item-1', item_name: 'Iron Sword',
  quantity: 2, requested_qty: 2,
  total_cost: 200, fee: 10, seller_earnings: 190,
  wallet_balance: 800, listing_status: 'active',
};

// What the RPC returns on a redelivered request id: the pre-existing settlement,
// flagged replayed so the manager applies NO fresh side effects.
const REPLAYED = {
  status: 'purchased', replayed: true,
  item_id: 'item-1', item_name: 'Iron Sword',
  quantity: 2, total_cost: 200, fee: 10,
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

function makeSupa(rpcImpl?: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>) {
  const supa: any = {
    from: vi.fn((table: string) => {
      if (table === 'guild_config') return chain(marketCfg);
      if (table === 'economy_market_listings') return chainAsync([LISTING]);
      return chain(null);
    }),
    rpc: vi.fn(rpcImpl ?? (async () => ({ data: null, error: null }))),
  };
  return supa;
}

const guild = { id: 'g1' } as any;
const valkey = {} as any;

function rpcNames(supa: any): string[] {
  return supa.rpc.mock.calls.map((c: unknown[]) => c[0] as string);
}

describe('MarketManager.buy atomic + idempotent settlement', () => {
  beforeEach(() => {
    trackProgress.mockClear();
  });

  it('settles the buy via ONE atomic RPC keyed on the interaction id — no legacy multi-RPC dance', async () => {
    const supa = makeSupa(async (fn) =>
      fn === SETTLE_RPC ? { data: PURCHASED, error: null } : { data: null, error: null },
    );
    const mgr = new MarketManager(guild, supa, valkey);

    const embed = await mgr.buy('buyer-1', 'a1b2c3d4', 2, 'interaction-abc');

    expect(embed.data.title).toContain('Purchase Complete');
    // Exactly one RPC — the atomic settle. No separate decrement/debit/credit/deliver.
    expect(supa.rpc).toHaveBeenCalledTimes(1);
    expect(supa.rpc).toHaveBeenCalledWith(SETTLE_RPC, {
      p_guild_id: 'g1',
      p_listing_id: LISTING.id,
      p_buyer_id: 'buyer-1',
      p_quantity: 2,
      p_fee_pct: 5,
      p_request_id: 'interaction-abc',
    });
    // None of the four legacy non-idempotent RPCs were invoked.
    for (const legacy of LEGACY_RPCS) expect(rpcNames(supa)).not.toContain(legacy);
    // A genuinely new trade awards quest progress exactly once.
    expect(trackProgress).toHaveBeenCalledTimes(1);
  });

  it('refuses to settle without a request id (idempotency key) and calls no RPC', async () => {
    const supa = makeSupa(async () => ({ data: null, error: null }));
    const mgr = new MarketManager(guild, supa, valkey);

    const embed = await mgr.buy('buyer-1', 'a1b2c3d4', 2 /* no requestId */);

    expect(embed.data.description).toContain('try again');
    // Fail closed: no settlement RPC is attempted when the idempotency key is absent.
    expect(supa.rpc).not.toHaveBeenCalled();
    expect(trackProgress).not.toHaveBeenCalled();
  });

  it('a redelivered interaction applies the purchase exactly once (server-side replay → no double side effects)', async () => {
    let calls = 0;
    const supa = makeSupa(async (fn) => {
      if (fn !== SETTLE_RPC) return { data: null, error: null };
      calls += 1;
      // First delivery settles; the redelivery hits the RPC's replay fence.
      return calls === 1 ? { data: PURCHASED, error: null } : { data: REPLAYED, error: null };
    });
    const mgr = new MarketManager(guild, supa, valkey);

    const first = await mgr.buy('buyer-1', 'a1b2c3d4', 2, 'interaction-dupe');
    const second = await mgr.buy('buyer-1', 'a1b2c3d4', 2, 'interaction-dupe');

    // Both deliveries surface success to the user...
    expect(first.data.title).toContain('Purchase Complete');
    expect(second.data.title).toContain('Purchase Complete');

    // ...but only ONE genuinely-new trade is recorded: the replayed delivery must
    // NOT re-award quest progress (the sole manager-side side effect of a buy).
    expect(trackProgress).toHaveBeenCalledTimes(1);

    // Both deliveries carried the SAME request id — the RPC is the single dedup
    // fence for the listing decrement / buyer debit / seller credit / delivery /
    // ledger pair; the manager never fans out to per-effect RPCs.
    const settleCalls = supa.rpc.mock.calls.filter((c: unknown[]) => c[0] === SETTLE_RPC);
    expect(settleCalls).toHaveLength(2);
    expect((settleCalls[0][1] as Record<string, unknown>).p_request_id).toBe('interaction-dupe');
    expect((settleCalls[1][1] as Record<string, unknown>).p_request_id).toBe('interaction-dupe');
    for (const legacy of LEGACY_RPCS) expect(rpcNames(supa)).not.toContain(legacy);
  });

  it('surfaces insufficient funds without awarding quest progress', async () => {
    const supa = makeSupa(async (fn) =>
      fn === SETTLE_RPC
        ? { data: { status: 'insufficient_funds', replayed: false, total_cost: 200, wallet_balance: 50 }, error: null }
        : { data: null, error: null },
    );
    const mgr = new MarketManager(guild, supa, valkey);

    const embed = await mgr.buy('buyer-1', 'a1b2c3d4', 2, 'interaction-poor');

    expect(embed.data.description).toContain('need');
    expect(rpcNames(supa)).toEqual([SETTLE_RPC]);
    expect(trackProgress).not.toHaveBeenCalled();
  });
});
