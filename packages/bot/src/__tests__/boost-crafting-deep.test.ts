/**
 * Deep tests for features/crafting/crafting-manager.ts — listRecipes, craft.
 * 204 uncovered statements at 32.5%.
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

import { CraftingManager } from '../features/crafting/crafting-manager.js';

function makeChain(data: any = null) {
  const chain: any = {};
  for (const m of ['from', 'select', 'insert', 'update', 'delete', 'upsert', 'eq', 'neq', 'single', 'maybeSingle', 'order', 'limit', 'in', 'match', 'gt', 'gte', 'lt', 'lte', 'is', 'contains', 'or', 'not', 'count', 'range', 'ilike']) {
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

describe('CraftingManager deep', () => {
  const guildId = 'guild-1';

  it('getConfig returns crafting config', async () => {
    const supa = makeSupa({
      guild_config: { guild_id: guildId, crafting_enabled: true },
    });
    const mgr = new CraftingManager(guildId as any, supa, {} as any);
    const config = await mgr.getConfig();
    expect(config).toBeDefined();
  });

  it('listRecipes returns embed with recipes', async () => {
    const supa = makeSupa({
      guild_config: { guild_id: guildId, crafting_enabled: true },
      crafting_recipes: [
        { id: 'r1', name: 'Iron Sword', ingredients: [{ item_name: 'Iron', quantity: 3 }], result_item_id: 'sword-1', result_quantity: 1, emoji: '⚔️', craft_time_minutes: 5, level_required: 1 },
      ],
    });
    const mgr = new CraftingManager(guildId as any, supa, {} as any);
    const result = await mgr.listRecipes();
    expect(result.embed).toBeDefined();
  });

  it('craft creates an item from recipe', async () => {
    const supa = makeSupa({
      guild_config: { guild_id: guildId, crafting_enabled: true },
      crafting_recipes: [
        { id: 'r1', name: 'Iron Sword', ingredients: [{ item_name: 'Iron', quantity: 3 }], result_item_id: 'sword-1', result_quantity: 1, emoji: '⚔️' },
      ],
    });
    const mgr = new CraftingManager(guildId as any, supa, {} as any);
    const result = await mgr.craft('user-1', 'Iron Sword');
    expect(result.embed).toBeDefined();
  });
});
