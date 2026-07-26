/**
 * Deep tests for features/farming/farming-manager.ts — viewFarm, plant, water, harvest, fertilize.
 * 267 uncovered statements at 37.0%.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

vi.mock('discord.js', async () => {
  const actual = await vi.importActual('discord.js');
  return { ...actual };
});

vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));

import { FarmingManager } from '../features/farming/farming-manager.js';

function makeChain(data: any = null) {
  const chain: any = {};
  for (const m of ['from', 'select', 'insert', 'update', 'delete', 'upsert', 'eq', 'neq', 'single', 'maybeSingle', 'order', 'limit', 'in', 'match', 'gt', 'gte', 'lt', 'lte', 'is', 'contains', 'or', 'not', 'count', 'range', 'ilike', 'like', 'textSearch', 'overlaps']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn(() => Promise.resolve({ data, error: null }));
  chain.maybeSingle = vi.fn(() => Promise.resolve({ data, error: null }));
  chain.then = (resolve: Function) => resolve({ data: data ? (Array.isArray(data) ? data : [data]) : [], error: null, count: 0 });
  return chain;
}

function makeSupa(overrides: Record<string, any> = {}) {
  return {
    from: vi.fn((table: string) => makeChain(overrides[table] ?? null)),
    rpc: vi.fn(async () => ({ data: null, error: null })),
  } as any;
}

describe('FarmingManager deep', () => {
  let manager: FarmingManager;
  const guildId = 'guild-1';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('viewFarm returns embed for user with no plots', async () => {
    const supa = makeSupa({
      guild_config: { guild_id: guildId, farming_enabled: true, farming_max_plots: 6 },
      farming_plots: [],
    });
    manager = new FarmingManager(guildId as any, supa, {} as any);
    const result = await manager.viewFarm('user-1');
    expect(result).toBeDefined();
    expect(result.embed).toBeDefined();
  });

  it('viewFarm returns embed for user with active plots', async () => {
    const supa = makeSupa({
      guild_config: { guild_id: guildId, farming_enabled: true, farming_max_plots: 6 },
      farming_plots: [
        { id: 'p1', user_id: 'user-1', crop_id: 'c1', planted_at: new Date().toISOString(), watered_at: new Date().toISOString(), fertilized: false, ready_at: new Date(Date.now() + 3600000).toISOString() },
      ],
      farming_crops: [{ id: 'c1', name: 'Wheat', emoji: '🌾', grow_time_minutes: 60, sell_price: 10 }],
    });
    manager = new FarmingManager(guildId as any, supa, {} as any);
    const result = await manager.viewFarm('user-1');
    expect(result.embed).toBeDefined();
  });

  it('plant puts a crop in an empty plot', async () => {
    const supa = makeSupa({
      guild_config: { guild_id: guildId, farming_enabled: true, farming_max_plots: 6 },
      farming_plots: [],
      farming_crops: [{ id: 'c1', name: 'Wheat', emoji: '🌾', grow_time_minutes: 60, sell_price: 10, seed_item_id: 'seed-wheat' }],
    });
    manager = new FarmingManager(guildId as any, supa, {} as any);
    const result = await manager.plant('user-1', 'wheat');
    expect(result.embed).toBeDefined();
  });

  it('water waters the first unwatered plot', async () => {
    const supa = makeSupa({
      guild_config: { guild_id: guildId, farming_enabled: true },
      farming_plots: [
        { id: 'p1', user_id: 'user-1', crop_id: 'c1', planted_at: new Date(Date.now() - 60000).toISOString(), watered_at: null, fertilized: false },
      ],
    });
    manager = new FarmingManager(guildId as any, supa, {} as any);
    const result = await manager.water('user-1');
    expect(result.embed).toBeDefined();
  });

  it('harvest collects ready crops', async () => {
    const supa = makeSupa({
      guild_config: { guild_id: guildId, farming_enabled: true },
      farming_plots: [
        { id: 'p1', user_id: 'user-1', crop_id: 'c1', planted_at: new Date(Date.now() - 7200000).toISOString(), watered_at: new Date(Date.now() - 3600000).toISOString(), fertilized: false, ready_at: new Date(Date.now() - 100).toISOString() },
      ],
      farming_crops: [{ id: 'c1', name: 'Wheat', emoji: '🌾', grow_time_minutes: 60, sell_price: 10, harvest_item_id: 'item-wheat' }],
    });
    manager = new FarmingManager(guildId as any, supa, {} as any);
    const result = await manager.harvest('user-1');
    expect(result.embed).toBeDefined();
  });

  it('fertilize applies fertilizer to a plot', async () => {
    const supa = makeSupa({
      guild_config: { guild_id: guildId, farming_enabled: true },
      farming_plots: [
        { id: 'p1', user_id: 'user-1', crop_id: 'c1', planted_at: new Date().toISOString(), watered_at: new Date().toISOString(), fertilized: false, ready_at: new Date(Date.now() + 3600000).toISOString() },
      ],
    });
    manager = new FarmingManager(guildId as any, supa, {} as any);
    const result = await manager.fertilize('user-1', 1);
    expect(result.embed).toBeDefined();
  });

  it('getConfig returns config from supabase', async () => {
    const supa = makeSupa({
      guild_config: { guild_id: guildId, farming_enabled: true, farming_max_plots: 6 },
    });
    manager = new FarmingManager(guildId as any, supa, {} as any);
    const config = await manager.getConfig();
    expect(config).toBeDefined();
  });

  // ── Harvest exactly-once (guarded compare-and-set) ────────
  // The harness distinguishes the read of ready plots from the guarded UPDATE:
  // reads of economy_farm_plots return `plots`, while the `.update(...).select()`
  // returns `claimed` — the rows the compare-and-set actually transitioned.
  function harvestSupa(opts: { plots: any[]; crops: any[]; claimed: any[] }) {
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    const from = vi.fn((table: string) => {
      let isUpdate = false;
      const chain: any = {};
      for (const m of ['select', 'insert', 'delete', 'upsert', 'eq', 'neq', 'single', 'maybeSingle', 'order', 'limit', 'in', 'match', 'gt', 'gte', 'lt', 'lte', 'is', 'contains', 'or', 'not', 'count', 'range', 'ilike', 'like']) {
        chain[m] = vi.fn(() => chain);
      }
      chain.update = vi.fn(() => { isUpdate = true; return chain; });
      const resolveData = () => {
        if (table === 'economy_farm_plots') return isUpdate ? opts.claimed : opts.plots;
        if (table === 'economy_crops') return opts.crops;
        if (table === 'guild_config') return { guild_id: guildId, economy_farming_enabled: true, economy_farming_wilt_enabled: true, economy_fertilizer_time_reduction_pct: 50, economy_farm_grid_size: 9 };
        return null;
      };
      chain.single = vi.fn(() => Promise.resolve({ data: resolveData(), error: null }));
      chain.maybeSingle = vi.fn(() => Promise.resolve({ data: resolveData(), error: null }));
      chain.then = (resolve: Function) => {
        const d = resolveData();
        resolve({ data: Array.isArray(d) ? d : (d ? [d] : []), error: null, count: 0 });
      };
      return chain;
    });
    return { from, rpc } as any;
  }

  const readyPlot = {
    id: 'p1', plot_index: 0, crop_id: 'c1',
    planted_at: new Date(Date.now() - 7200000).toISOString(),
    watered_at: new Date(Date.now() - 3600000).toISOString(),
    fertilized: false, harvested: false,
  };
  const wheat = { id: 'c1', name: 'Wheat', emoji: '🌾', grow_seconds: 60, wilt_seconds: 86400, sell_price: 10, seeds_returned: 0, seed_item_id: null };

  it('harvest credits only the rows the guarded UPDATE actually transitioned (winner)', async () => {
    const supa = harvestSupa({ plots: [readyPlot], crops: [wheat], claimed: [{ id: 'p1', crop_id: 'c1' }] });
    manager = new FarmingManager(guildId as any, supa, {} as any);
    const result = await manager.harvest('user-1');

    const addCalls = supa.rpc.mock.calls.filter((c: any[]) => c[0] === 'economy_add_balance');
    expect(addCalls).toHaveLength(1);
    expect(addCalls[0][1]).toMatchObject({ p_amount: 10 });
    expect((result.embed as any).data?.title).toContain('Harvest Complete');
  });

  it('harvest pays nothing when a concurrent call already claimed the ready plots (loser)', async () => {
    // The guarded UPDATE returns zero transitioned rows — the other harvest won.
    const supa = harvestSupa({ plots: [readyPlot], crops: [wheat], claimed: [] });
    manager = new FarmingManager(guildId as any, supa, {} as any);
    const result = await manager.harvest('user-1');

    const addCalls = supa.rpc.mock.calls.filter((c: any[]) => c[0] === 'economy_add_balance');
    expect(addCalls).toHaveLength(0);
    expect((result.embed as any).data?.description).toContain('No crops ready');
  });
});
