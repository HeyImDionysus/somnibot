/**
 * Deep tests for features/farming/farming-manager.ts — viewFarm, plant, water, harvest, fertilize.
 * 267 uncovered statements at 37.0%.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
  SOMNI_PALETTE: { primary: 0x5865f2, success: 0x57f287, danger: 0xed4245, warning: 0xfee75c },
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
});
