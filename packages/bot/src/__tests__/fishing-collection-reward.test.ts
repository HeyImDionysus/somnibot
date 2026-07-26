/**
 * [game-economy-fishing] Tests for:
 *  - the one-time collection completion bonus (fence-gated, paid exactly once)
 *  - the durable unpaid flag + retryUnpaidPayouts idempotent settle sweep
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../features/quests/quests-manager.js', () => ({
  getQuestsManager: () => ({ trackProgress: vi.fn(async () => {}) }),
}));
vi.mock('discord.js', () => ({
  EmbedBuilder: class {
    data: any = {};
    setColor(c: any) { this.data.color = c; return this; }
    setTitle(t: any) { this.data.title = t; return this; }
    setDescription(d: any) { this.data.description = d; return this; }
    setFooter(f: any) { return this; }
    addFields(...f: any[]) { this.data.fields = [...(this.data.fields || []), ...f]; return this; }
  },
}));

import { FishingManager } from '../features/fishing/fishing-manager.js';

const CFG = {
  economy_fishing_enabled: true,
  economy_fishing_cooldown_seconds: 30,
  economy_fishing_junk_chance_pct: 0,      // force a fish catch (never junk/treasure)
  economy_fishing_treasure_chance_pct: 0,
  economy_fishing_collection_reward_enabled: true,
  economy_fishing_collection_reward_coins: 5000,
};
const SPECIES = [
  { id: 'sp1', name: 'Bass', emoji: '🐟', rarity: 'common', min_weight: 1, max_weight: 2, base_price: 10 },
];

function guild() { return { id: 'g1' } as any; }
function valkey() {
  return { set: vi.fn(async () => 'OK'), ttl: vi.fn(async () => -2) } as any;
}

/** Chain that resolves to `rows` on await and to `single` on .single(). */
function makeChain(rows: any[], single: any = null) {
  const c: any = {};
  for (const m of ['select', 'insert', 'update', 'delete', 'upsert', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'order', 'limit', 'ilike', 'like', 'is', 'not', 'match', 'range', 'filter', 'contains'])
    c[m] = vi.fn(() => c);
  c.single = vi.fn(async () => ({ data: single, error: null }));
  c.maybeSingle = vi.fn(async () => ({ data: single, error: null }));
  c.then = (resolve: any) => resolve({ data: rows, error: null, count: rows.length });
  return c;
}

describe('[game-economy-fishing] collection completion bonus', () => {
  beforeEach(() => vi.clearAllMocks());

  it('credits the completion bonus once, then never again (per-member fence)', async () => {
    let fenceClaimed = false;
    const rpc = vi.fn(async (..._a: any[]) => ({ data: null, error: null }));
    const catchChain: any = makeChain([{ species_id: 'sp1' }], { id: 'c1' });
    const insertSpy = vi.fn((..._a: any[]) => catchChain);
    catchChain.insert = insertSpy;

    const supabase = {
      rpc,
      from: vi.fn((table: string) => {
        switch (table) {
          case 'guild_config': return makeChain([], CFG);
          case 'economy_fish_species': return makeChain(SPECIES);
          case 'economy_inventory':
            // Rod present (also used by consumeBait, which then no-ops via rpc=null).
            return makeChain([{ id: 'inv1', quantity: 1, item_id: 'item1', economy_items: { name: 'Fishing Rod', category: 'Tools', durability: 100 } }]);
          case 'economy_fish_catches': return catchChain;
          case 'economy_fish_collection_rewards': {
            const claimedNow = !fenceClaimed;
            fenceClaimed = true;
            return makeChain(claimedNow ? [{ user_id: 'u1' }] : []);
          }
          default: return makeChain([]);
        }
      }),
    } as any;

    const mgr = new FishingManager(guild(), supabase, valkey());

    const first = await mgr.fish('u1');
    const rewardCalls = rpc.mock.calls.filter((c) => c[0] === 'economy_add_balance' && c[1]?.p_amount === 5000);
    expect(rewardCalls.length).toBe(1);
    expect(JSON.stringify(first.embed.data.fields ?? [])).toContain('Collection Complete');

    // Second completion: fence already set → no second bonus, no completion field.
    const second = await mgr.fish('u1');
    const rewardCallsAfter = rpc.mock.calls.filter((c) => c[0] === 'economy_add_balance' && c[1]?.p_amount === 5000);
    expect(rewardCallsAfter.length).toBe(1); // still exactly one, ever
    expect(JSON.stringify(second.embed.data.fields ?? [])).not.toContain('Collection Complete');
  });

  it('pays nothing when the collection reward is disabled', async () => {
    const rpc = vi.fn(async (..._a: any[]) => ({ data: null, error: null }));
    const catchChain: any = makeChain([{ species_id: 'sp1' }], { id: 'c1' });
    const supabase = {
      rpc,
      from: vi.fn((table: string) => {
        switch (table) {
          case 'guild_config': return makeChain([], { ...CFG, economy_fishing_collection_reward_enabled: false });
          case 'economy_fish_species': return makeChain(SPECIES);
          case 'economy_inventory': return makeChain([{ id: 'inv1', quantity: 1, item_id: 'item1', economy_items: { name: 'Fishing Rod', category: 'Tools' } }]);
          case 'economy_fish_catches': return catchChain;
          default: return makeChain([]);
        }
      }),
    } as any;
    const mgr = new FishingManager(guild(), supabase, valkey());
    await mgr.fish('u1');
    const rewardCalls = rpc.mock.calls.filter((c) => c[0] === 'economy_add_balance' && c[1]?.p_amount === 5000);
    expect(rewardCalls.length).toBe(0);
  });
});

describe('[game-economy-fishing] durable unpaid flag + retry sweep', () => {
  beforeEach(() => vi.clearAllMocks());

  it('inserts the catch paid=false and raises an alert when the credit fails', async () => {
    const alertInsert = vi.fn((..._a: any[]) => makeChain([]));
    const catchChain: any = makeChain([{ species_id: 'sp1' }], { id: 'c1' });
    const insertSpy = vi.fn((..._a: any[]) => catchChain);
    catchChain.insert = insertSpy;

    // economy_add_balance always fails → catch left unpaid, alert raised.
    const rpc = vi.fn(async (..._a: any[]) => ({ data: null, error: { message: 'boom' } }));
    const supabase = {
      rpc,
      from: vi.fn((table: string) => {
        switch (table) {
          case 'guild_config': return makeChain([], CFG);
          case 'economy_fish_species': return makeChain(SPECIES);
          case 'economy_inventory': return makeChain([{ id: 'inv1', quantity: 1, item_id: 'item1', economy_items: { name: 'Fishing Rod', category: 'Tools' } }]);
          case 'economy_fish_catches': return catchChain;
          case 'alerts': { const c = makeChain([]); c.insert = alertInsert; return c; }
          default: return makeChain([]);
        }
      }),
    } as any;
    const mgr = new FishingManager(guild(), supabase, valkey());
    await mgr.fish('u1');

    // Catch row inserted with paid=false.
    expect(insertSpy).toHaveBeenCalled();
    expect(insertSpy.mock.calls[0][0].paid).toBe(false);
    // Payout-degraded owner alert raised.
    expect(alertInsert).toHaveBeenCalled();
    expect(alertInsert.mock.calls[0][0].alert_type).toBe('fishing_payout_degraded');
  });

  it('retryUnpaidPayouts credits each unpaid catch exactly once (atomic claim)', async () => {
    const rpc = vi.fn(async (..._a: any[]) => ({ data: null, error: null }));
    let selectCount = 0;
    const supabase = {
      rpc,
      from: vi.fn((table: string) => {
        if (table !== 'economy_fish_catches') return makeChain([]);
        const c: any = {};
        for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'gt', 'in', 'order', 'limit']) c[m] = vi.fn(() => c);
        // The initial paid=false scan returns one row on the first sweep, none after.
        c.then = (resolve: any) => {
          const rows = selectCount++ === 0 ? [{ id: 'c1', user_id: 'u1', price_earned: 100 }] : [];
          resolve({ data: rows, error: null, count: rows.length });
        };
        // The atomic claim `.update({paid:true})...select('id')` wins the row once.
        c.select = vi.fn(() => ({ ...c, then: (r: any) => r({ data: [{ id: 'c1' }], error: null }) }));
        return c;
      }),
    } as any;
    const mgr = new FishingManager(guild(), supabase, valkey());

    const settled = await mgr.retryUnpaidPayouts();
    expect(settled).toBe(1);
    const credits = rpc.mock.calls.filter((call) => call[0] === 'economy_add_balance' && call[1]?.p_amount === 100);
    expect(credits.length).toBe(1);
  });
});
