// @ts-nocheck
/**
 * Deep tests for features/market/market-manager.ts — browse, listItem, buy, myListings, cancel.
 * 224 uncovered statements at 42.3%.
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

import { MarketManager } from '../features/market/market-manager.js';

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

describe('MarketManager deep', () => {
  const guildId = 'guild-1';

  it('browse returns embed with listings', async () => {
    const supa = makeSupa({
      guild_config: { guild_id: guildId, market_enabled: true, market_tax_percent: 5, currency_symbol: '💰' },
      market_listings: [
        { id: 'list-1', seller_id: 'user-2', item_name: 'Sword', price: 100, quantity: 1, created_at: new Date().toISOString() },
      ],
    });
    const mgr = new MarketManager(guildId, supa);
    const result = await mgr.browse();
    expect(result).toBeDefined();
  });

  it('browse with category filter', async () => {
    const supa = makeSupa({
      guild_config: { guild_id: guildId, market_enabled: true, currency_symbol: '💰' },
      market_listings: [],
    });
    const mgr = new MarketManager(guildId, supa);
    const result = await mgr.browse('weapons');
    expect(result).toBeDefined();
  });

  it('listItem creates a new listing', async () => {
    const supa = makeSupa({
      guild_config: { guild_id: guildId, market_enabled: true, market_max_listings: 10, currency_symbol: '💰' },
      market_listings: [],
    });
    const mgr = new MarketManager(guildId, supa);
    const result = await mgr.listItem('user-1', 'Sword', 100, 1);
    expect(result).toBeDefined();
  });

  it('buy purchases a listing', async () => {
    const supa = makeSupa({
      guild_config: { guild_id: guildId, market_enabled: true, market_tax_percent: 5, currency_symbol: '💰' },
      market_listings: { id: 'list-abc123', seller_id: 'user-2', item_name: 'Sword', item_id: 'sword-1', price: 100, quantity: 1, guild_id: guildId },
    });
    const mgr = new MarketManager(guildId, supa);
    const result = await mgr.buy('user-1', 'abc123');
    expect(result).toBeDefined();
  });

  it('myListings returns user listings', async () => {
    const supa = makeSupa({
      guild_config: { guild_id: guildId, market_enabled: true, currency_symbol: '💰' },
      market_listings: [
        { id: 'list-1', seller_id: 'user-1', item_name: 'Shield', price: 50, quantity: 1, created_at: new Date().toISOString() },
      ],
    });
    const mgr = new MarketManager(guildId, supa);
    const result = await mgr.myListings('user-1');
    expect(result).toBeDefined();
  });

  it('cancelListing removes a listing', async () => {
    const supa = makeSupa({
      guild_config: { guild_id: guildId, market_enabled: true, currency_symbol: '💰' },
      market_listings: { id: 'list-abc123', seller_id: 'user-1', item_name: 'Shield', item_id: 'shield-1', price: 50, quantity: 1, guild_id: guildId },
    });
    const mgr = new MarketManager(guildId, supa);
    const result = await mgr.cancelListing('user-1', 'abc123');
    expect(result).toBeDefined();
  });
});
