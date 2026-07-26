/**
 * Tests for features/audit/diagnostics-service.ts — DiagnosticsService class.
 * 132 uncovered statements at 14.8%.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

vi.mock('discord.js', () => ({
  EmbedBuilder: class {
    setColor() { return this; } setTitle() { return this; } setDescription() { return this; } addFields() { return this; }
  },
  Collection: class extends Map {},
}));

import { DiagnosticsService } from '../features/audit/diagnostics-service.js';

function makeChain(data: any = null) {
  const chain: any = {};
  for (const m of ['from', 'select', 'insert', 'update', 'delete', 'upsert', 'eq', 'single', 'maybeSingle', 'order', 'limit', 'in', 'count', 'gte', 'lte']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn(() => Promise.resolve({ data, error: null }));
  chain.maybeSingle = vi.fn(() => Promise.resolve({ data, error: null }));
  chain.insert = vi.fn(() => Promise.resolve({ error: null }));
  chain.upsert = vi.fn(() => Promise.resolve({ error: null }));
  chain.then = (resolve: Function) => resolve({ data: data ? [data] : [], error: null, count: 0 });
  return chain;
}

describe('DiagnosticsService', () => {
  it('has snapshot method', () => {
    const svc = new DiagnosticsService({} as any, {} as any);
    expect(typeof svc.start).toBe('function');
  });

  it('instantiates', () => {
    const svc = new DiagnosticsService({} as any, {
      from: vi.fn(() => makeChain()),
      rpc: vi.fn(async () => ({ data: null, error: null })),
    } as any);
    expect(svc).toBeDefined();
  });

  it('writes diagnostics under the initialized guild id, not the client primary guild id', async () => {
    const chain = makeChain();
    const guild = {
      memberCount: 42,
      voiceStates: {
        cache: {
          filter: vi.fn(() => ({ size: 3 })),
        },
      },
    };
    const client = {
      guildId: 'guild-1,guild-2',
      guilds: {
        cache: {
          get: vi.fn((guildId: string) => guildId === 'guild-2' ? guild : undefined),
        },
      },
      shoukaku: { nodes: new Map() },
      valkey: {
        info: vi.fn(async () => 'used_memory:1048576\r\n'),
        ping: vi.fn(async () => 'PONG'),
      },
      ws: { ping: 42 },
    };
    const supabase = {
      from: vi.fn(() => chain),
      rpc: vi.fn(async () => ({ data: null, error: null })),
    };
    const svc = new DiagnosticsService(client as any, supabase as any, 'guild-2');

    await (svc as any).writeSnapshot();

    expect(client.guilds.cache.get).toHaveBeenCalledWith('guild-2');
    expect(chain.eq).toHaveBeenCalledWith('guild_id', 'guild-2');
    expect(chain.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        guild_id: 'guild-2',
        type: 'health',
        guild_member_count: 42,
        active_voice_connections: 3,
      }),
      { onConflict: 'guild_id,type' },
    );
    expect(chain.insert).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ guild_id: 'guild-2' }),
      ]),
    );
  });
});
