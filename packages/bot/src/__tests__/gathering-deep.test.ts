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
    const mgr = new GatheringManager(guildId as any, supa, {} as any);
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
    const mgr = new GatheringManager(guildId as any, supa, {} as any);
    const result = await mgr.gather('user-1', 'mine');
    expect(result).toBeDefined();
  });

  function sellableLootSupa() {
    return makeSupa({
      guild_config: {
        guild_id: guildId,
        economy_gathering_enabled: true,
        economy_gathering_cooldown_seconds: 30,
        currency_name: 'Gilder',
        currency_emoji: '💠',
      },
      economy_loot_tables: [
        { id: 'l1', item_name: 'Iron Ore', emoji: '⛏️', rarity: 'common', min_qty: 1, max_qty: 1, weight: 100, tool_tier: 0, sell_value: 50, gives_item_id: null },
      ],
    });
  }

  it('brands the coin-sale line with the configured currency, not stock "coins"', async () => {
    const supa = sellableLootSupa();
    const valkey = { set: vi.fn().mockResolvedValue('OK'), pttl: vi.fn().mockResolvedValue(0) };
    const mgr = new GatheringManager(guildId as any, supa, valkey as any);

    const result = await mgr.gather('user-1', 'mine', 'interaction-1');
    expect(result.result).not.toBeNull();
    const desc: string = (result.embed as any).data?.description ?? '';
    expect(desc).toContain('Gilder');
    expect(desc).toContain('💠');
    expect(desc).not.toContain('coins');
  });

  it('idempotency fence: a redelivered interaction is refused before any credit', async () => {
    const supa = sellableLootSupa();
    // SET NX fails for the interaction-scoped idem key (already processed), so
    // the gather refuses without re-rolling or re-crediting.
    const valkey = {
      set: vi.fn((key: string) => Promise.resolve(key.includes(':idem:') ? null : 'OK')),
      pttl: vi.fn().mockResolvedValue(0),
    };
    const mgr = new GatheringManager(guildId as any, supa, valkey as any);

    const result = await mgr.gather('user-1', 'mine', 'interaction-replayed');
    expect(result.error).toBe('duplicate');
    expect(result.result).toBeNull();
    // No wallet credit was attempted on the replay.
    expect(supa.rpc).not.toHaveBeenCalled();
  });
});
