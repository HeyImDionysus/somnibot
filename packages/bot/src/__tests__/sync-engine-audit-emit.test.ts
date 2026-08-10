/**
 * sync-engine audit emit tests
 *
 * The periodic reconcile cycle previously left the sync.completed / sync.failed
 * audit mappings dead. These tests assert a successful cycle emits
 * `sync.completed` and a throwing cycle (via the scheduler) emits `sync.failed`,
 * each of which AuditService maps to an audit_logs row.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  computeStateDiff: vi.fn(() => []),
  classifyDrift: vi.fn(() => []),
}));

vi.mock('discord.js', () => {
  class C extends Map {
    filter(fn: any) { const r = new C(); for (const [k, v] of this) if (fn(v, k)) r.set(k, v); return r; }
    map(fn: any) { return [...this.values()].map(fn); }
  }
  return {
    EmbedBuilder: class { setColor() { return this; } setTitle() { return this; } setDescription() { return this; } addFields() { return this; } },
    ChannelType: { GuildText: 0, GuildCategory: 4 },
    Collection: C,
    PermissionFlagsBits: { ViewChannel: 1n },
  };
});

vi.mock('../sync/snapshot.js', () => ({
  takeSnapshot: vi.fn(async () => ({ roles: [], channels: [], categories: [], everyonePermissions: '0' })),
}));

import { runSyncCycle, startSyncScheduler } from '../sync/sync-engine.js';
import { takeSnapshot } from '../sync/snapshot.js';

function makeChain(result: any = { data: null, error: null }) {
  const chain: any = {};
  for (const m of ['from', 'select', 'insert', 'update', 'delete', 'upsert', 'eq', 'in', 'range', 'order', 'limit', 'single', 'maybeSingle', 'returns']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn(() => Promise.resolve(result));
  chain.maybeSingle = vi.fn(() => Promise.resolve(result));
  chain.then = (resolve: Function) => resolve(result);
  return chain;
}

function makeSupa(tableData: Record<string, any> = {}) {
  return {
    from: vi.fn((table: string) => makeChain({ data: tableData[table] ?? null, error: null })),
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

const CONFIG = { enabled: true, intervalMinutes: 5, autoRepair: false, autoRepairEveryone: false };

describe('sync-engine sync.completed emit', () => {
  it('emits sync.completed at the end of a cycle when desired state exists', async () => {
    const supa = makeSupa({
      guild_desired_state: { guild_id: 'guild-1', roles: [], channels: [] },
      discord_id_map: [],
    });
    const bus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() } as any;

    await runSyncCycle(makeGuild(), supa as any, bus, CONFIG);

    expect(bus.emit).toHaveBeenCalledWith(
      'sync.completed',
      'guild-1',
      expect.objectContaining({ driftItemsFound: 0, itemsRepaired: 0, itemsAccepted: 0 }),
    );
  });

  it('does NOT emit sync.completed when there is no desired state', async () => {
    const supa = makeSupa({});
    const bus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() } as any;

    await runSyncCycle(makeGuild(), supa as any, bus, CONFIG);

    expect(bus.emit).not.toHaveBeenCalledWith('sync.completed', expect.anything(), expect.anything());
  });
});

describe('sync-engine sync.failed emit', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('emits sync.failed when a scheduled cycle throws', async () => {
    (takeSnapshot as any).mockRejectedValueOnce(new Error('snapshot boom'));
    const supa = makeSupa({
      guild_config: { sync_enabled: true, sync_interval_minutes: 999, sync_auto_repair: false, sync_auto_repair_everyone: false },
      guild_desired_state: { guild_id: 'guild-1', roles: [], channels: [] },
      discord_id_map: [],
    });
    const bus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() } as any;

    const scheduler = startSyncScheduler(makeGuild(), supa as any, bus, { ...CONFIG, intervalMinutes: 999 });
    // The scheduler runs the first cycle 30s after start.
    await vi.advanceTimersByTimeAsync(30_000);
    scheduler.stop();

    expect(bus.emit).toHaveBeenCalledWith(
      'sync.failed',
      'guild-1',
      expect.objectContaining({ error: 'snapshot boom', stage: 'cycle' }),
    );
  });
});
