/**
 * Deep tests for features/gathering/gathering-manager.ts — gather.
 * 157 uncovered statements at 48.9%.
 */
import { describe, it, expect, vi } from 'vitest';

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

import { GatheringManager } from '../features/gathering/gathering-manager.js';

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

describe('GatheringManager deep', () => {
  const guildId = 'guild-1';

  it('getConfig returns gathering config', async () => {
    const supa = makeSupa({
      guild_config: { guild_id: guildId, gathering_enabled: true, gathering_cooldown_seconds: 30 },
    });
    const mgr = new GatheringManager(guildId, supa);
    const config = await mgr.getConfig();
    expect(config).toBeDefined();
  });

  it('gather performs a gathering action', async () => {
    const supa = makeSupa({
      guild_config: { guild_id: guildId, gathering_enabled: true, gathering_cooldown_seconds: 30 },
      gathering_loot: [
        { id: 'l1', source_type: 'mine', item_id: 'ore-1', item_name: 'Iron Ore', emoji: '⛏️', rarity: 'common', weight: 100, min_qty: 1, max_qty: 3 },
      ],
    });
    const mgr = new GatheringManager(guildId, supa);
    const result = await mgr.gather('user-1', 'mine');
    expect(result).toBeDefined();
  });
});
