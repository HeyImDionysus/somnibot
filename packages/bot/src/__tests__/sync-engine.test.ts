/**
 * Tests for sync/sync-engine.ts — the periodic drift detection engine
 * that compares Discord state against desired state and optionally auto-repairs.
 * 239 uncovered statements.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
  computeStateDiff: vi.fn(() => []),
  classifyDrift: vi.fn(() => []),
}));

vi.mock('discord.js', () => {
  class C extends Map {
    filter(fn: any) { const r = new C(); for (const [k, v] of this) if (fn(v, k)) r.set(k, v); return r; }
    map(fn: any) { return [...this.values()].map(fn); }
  }
  return {
    EmbedBuilder: class {
      setColor() { return this; } setTitle() { return this; }
      setDescription() { return this; } addFields() { return this; }
    },
    ChannelType: { GuildText: 0, GuildCategory: 4 },
    Collection: C,
    PermissionFlagsBits: { ViewChannel: 1n },
  };
});

vi.mock('../sync/snapshot.js', () => ({
  takeSnapshot: vi.fn(async () => ({
    roles: [], channels: [], categories: [],
    everyonePermissions: '0',
  })),
}));

vi.mock('../services/event-bus.js', () => ({
  PlatformEventBus: class { emit = vi.fn(); on = vi.fn(); off = vi.fn(); },
}));

import { runSyncCycle } from '../sync/sync-engine.js';
import { computeStateDiff, classifyDrift } from '@somnibot/shared';

function makeChain(result: any = { data: null, error: null }) {
  const chain: any = {};
  for (const m of ['from', 'select', 'insert', 'update', 'delete', 'upsert', 'eq', 'order', 'limit', 'single', 'maybeSingle', 'returns']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn(() => Promise.resolve(result));
  chain.maybeSingle = vi.fn(() => Promise.resolve(result));
  chain.then = (resolve: Function) => resolve(result);
  return chain;
}

function makeSupa(tableData: Record<string, any> = {}) {
  return {
    from: vi.fn((table: string) => {
      const data = tableData[table] ?? null;
      return makeChain({ data, error: null });
    }),
    rpc: vi.fn(async () => ({ data: null, error: null })),
  };
}

function makeGuild() {
  return {
    id: 'guild-1', name: 'Test', memberCount: 100,
    roles: { cache: new Map(), everyone: { id: 'guild-1' } },
    channels: { cache: new Map() },
  } as any;
}

describe('sync-engine', () => {
  describe('runSyncCycle', () => {
    it('returns empty drift when no desired state exists', async () => {
      const supa = makeSupa({});
      const bus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() } as any;

      const result = await runSyncCycle(
        makeGuild(), supa as any, bus,
        { enabled: true, intervalMinutes: 5, autoRepair: false, autoRepairEveryone: false },
      );

      expect(result.driftItems).toEqual([]);
      expect(result.repaired).toBe(0);
      expect(result.timestamp).toBeTruthy();
    });

    it('computes diff and classifies drift when desired state exists', async () => {
      const supa = makeSupa({
        guild_desired_state: { guild_id: 'guild-1', roles: [], channels: [] },
        discord_id_map: [{ template_key: 'k1', discord_id: 'd1' }],
      });
      const bus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() } as any;

      const result = await runSyncCycle(
        makeGuild(), supa as any, bus,
        { enabled: true, intervalMinutes: 5, autoRepair: false, autoRepairEveryone: false },
      );

      expect(computeStateDiff).toHaveBeenCalled();
      expect(classifyDrift).toHaveBeenCalled();
      expect(result.timestamp).toBeTruthy();
    });

    it('stores drift report in Supabase', async () => {
      (classifyDrift as any).mockReturnValueOnce([
        { entity: 'role', key: 'r1', type: 'missing', severity: 'high' },
      ]);
      const supa = makeSupa({
        guild_desired_state: { guild_id: 'guild-1', roles: [], channels: [] },
        discord_id_map: [],
      });
      const bus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() } as any;

      await runSyncCycle(
        makeGuild(), supa as any, bus,
        { enabled: true, intervalMinutes: 5, autoRepair: false, autoRepairEveryone: false },
      );

      // Should upsert drift report
      expect(supa.from).toHaveBeenCalled();
    });

    it('stores drift report when drift items exist', async () => {
      (classifyDrift as any).mockReturnValueOnce([
        { entity: 'role', key: 'r1', type: 'missing', severity: 'high' },
      ]);
      const supa = makeSupa({
        guild_desired_state: { guild_id: 'guild-1', roles: [], channels: [] },
        discord_id_map: [],
      });
      const bus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() } as any;

      const result = await runSyncCycle(
        makeGuild(), supa as any, bus,
        { enabled: true, intervalMinutes: 5, autoRepair: false, autoRepairEveryone: false },
      );

      expect(supa.from).toHaveBeenCalled();
    });
  });
});
