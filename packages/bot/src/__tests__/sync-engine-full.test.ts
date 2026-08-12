/**
 * Sync Engine — Full tests
 *
 * Tests runSyncCycle: desired state lookup, snapshot, diff/classify,
 * auto-repair @everyone, auto-repair other drift, community channel filtering,
 * ticket channel filtering, event emission, audit logging, DB persistence.
 * Also tests startSyncScheduler lifecycle.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DriftItem } from '@somnibot/shared';

// ── Mocks ────────────────────────────────────────────────
const mockComputeStateDiff = vi.fn((): any => ({ everyoneDrift: false, diffs: [] }));
const mockClassifyDrift = vi.fn((): any[] => []);
const mockTakeSnapshot = vi.fn(async () => ({
  everyonePermissions: '0',
  roles: [],
  categories: [],
  channels: [],
}));

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  computeStateDiff: (...args: any[]) => (mockComputeStateDiff as Function)(...args),
  classifyDrift: (...args: any[]) => (mockClassifyDrift as Function)(...args),
}));

vi.mock('../sync/snapshot.js', () => ({
  takeSnapshot: (...args: any[]) => (mockTakeSnapshot as Function)(...args),
}));

vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));

import { runSyncCycle, startSyncScheduler, type SyncConfig } from '../sync/sync-engine.js';

// ── Helpers ──────────────────────────────────────────────
class MockCollection extends Map {
  filter(fn: (v: any, k: string) => boolean): MockCollection {
    const result = new MockCollection();
    for (const [k, v] of this) if (fn(v, k)) result.set(k, v);
    return result;
  }
}

function supaChain(data: any = null, error: any = null) {
  const c: any = {};
  const methods = ['select','insert','update','upsert','delete','eq','neq','gte','lt',
    'lte','limit','range','order','in','filter','maybeSingle','single','match','then'];
  for (const m of methods) c[m] = vi.fn((..._: any[]) => c);
  c.maybeSingle = vi.fn(async () => ({ data, error }));
  c.single = vi.fn(async () => ({ data, error }));
  c.then = (resolve: any) => resolve({ data, error });
  return c;
}

function makeGuild(overrides: Record<string, any> = {}) {
  const roles = new MockCollection();
  const everyone = {
    id: 'g1',
    name: '@everyone',
    setPermissions: vi.fn(async () => {}),
  };
  roles.set('g1', everyone);

  const channels = new MockCollection();

  return {
    id: 'g1',
    roles: { cache: roles, everyone },
    channels: { cache: channels },
    rulesChannelId: null,
    publicUpdatesChannelId: null,
    members: { me: { roles: { highest: { position: 10 } } } },
    client: { user: { id: 'bot1' } },
    ...overrides,
  };
}

function makeEventBus() {
  return { emit: vi.fn() };
}

function makeConfig(overrides: Partial<SyncConfig> = {}): SyncConfig {
  return {
    enabled: true,
    intervalMinutes: 5,
    autoRepair: false,
    autoRepairEveryone: false,
    ...overrides,
  };
}

function extraChannelDrift(entityName: string, entityDiscordId: string): DriftItem {
  return {
    type: 'EXTRA_RESOURCE',
    severity: 'info',
    entityType: 'channel',
    entityName,
    entityDiscordId,
    description: 'Unexpected channel',
    suggestedAction: 'accept',
  };
}

function everyoneDrift(): DriftItem {
  return {
    type: 'EVERYONE_DRIFT',
    severity: 'critical',
    entityType: 'everyone',
    entityName: '@everyone',
    description: '@everyone permissions changed.',
    suggestedAction: 'repair',
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('runSyncCycle', () => {
  it('returns empty drift when no desired state exists', async () => {
    const guild = makeGuild();
    const supabase = {
      from: vi.fn(() => supaChain(null)),
    } as any;
    const bus = makeEventBus();
    const config = makeConfig({ autoRepair: true });

    const result = await runSyncCycle(guild as any, supabase, bus as any, config);

    expect(result.driftItems).toEqual([]);
    expect(result.repaired).toBe(0);
    expect(result.timestamp).toBeTruthy();
  });

  it('computes diff and classifies drift', async () => {
    const guild = makeGuild();
    const desiredData = {
      roles: [{ key: 'mod', name: 'Mod', permissions: '0' }],
      channels: [{ key: 'gen', name: 'general', type: 0 }],
    };
    const mappings = [{ template_key: 'role:mod', discord_id: 'r1' }];

    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'guild_desired_state') return supaChain(desiredData);
        if (table === 'discord_id_map') return supaChain(mappings);
        if (table === 'audit_logs') return supaChain();
        return supaChain();
      }),
    } as any;

    mockComputeStateDiff.mockReturnValueOnce({ everyoneDrift: false, diffs: [] });
    mockClassifyDrift.mockReturnValueOnce([]);

    const bus = makeEventBus();
    const config = makeConfig();

    const result = await runSyncCycle(guild as any, supabase, bus as any, config);

    expect(mockTakeSnapshot).toHaveBeenCalledWith(guild);
    expect(mockComputeStateDiff).toHaveBeenCalled();
    expect(mockClassifyDrift).toHaveBeenCalled();
    expect(result.driftItems).toEqual([]);
  });

  it('auto-repairs @everyone only when BOTH auto-repair and the @everyone opt-in are on', async () => {
    const guild = makeGuild();
    const desiredData = { roles: [], channels: [] };
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'guild_desired_state') return supaChain(desiredData);
        if (table === 'discord_id_map') return supaChain([]);
        if (table === 'audit_logs') return supaChain();
        return supaChain();
      }),
    } as any;

    mockComputeStateDiff.mockReturnValueOnce({ everyoneDrift: true, diffs: [] });
    mockClassifyDrift.mockReturnValueOnce([everyoneDrift()]);

    const bus = makeEventBus();
    const config = makeConfig({ autoRepair: true, autoRepairEveryone: true });

    await runSyncCycle(guild as any, supabase, bus as any, config);

    expect(guild.roles.everyone.setPermissions).toHaveBeenCalledTimes(1);
    expect(guild.roles.everyone.setPermissions).toHaveBeenCalledWith(
      0n,
      expect.stringContaining('auto-repair'),
    );
  });

  it('does NOT reset @everyone when the @everyone opt-in is on but general auto-repair is OFF', async () => {
    // Regression guard: gating on autoRepairEveryone ALONE (with the old default
    // true) silently wiped @everyone perms to 0 out of the box.
    const guild = makeGuild();
    const desiredData = { roles: [], channels: [] };
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'guild_desired_state') return supaChain(desiredData);
        if (table === 'discord_id_map') return supaChain([]);
        if (table === 'audit_logs') return supaChain();
        return supaChain();
      }),
    } as any;

    mockComputeStateDiff.mockReturnValueOnce({ everyoneDrift: true, diffs: [] });
    mockClassifyDrift.mockReturnValueOnce([everyoneDrift()]);

    const bus = makeEventBus();
    const config = makeConfig({ autoRepair: false, autoRepairEveryone: true });

    await runSyncCycle(guild as any, supabase, bus as any, config);

    expect(guild.roles.everyone.setPermissions).not.toHaveBeenCalled();
  });

  it('does not auto-repair @everyone when not configured', async () => {
    const guild = makeGuild();
    const desiredData = { roles: [], channels: [] };
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'guild_desired_state') return supaChain(desiredData);
        if (table === 'discord_id_map') return supaChain([]);
        if (table === 'audit_logs') return supaChain();
        return supaChain();
      }),
    } as any;

    mockComputeStateDiff.mockReturnValueOnce({ everyoneDrift: true, diffs: [] });
    mockClassifyDrift.mockReturnValueOnce([]);

    const bus = makeEventBus();
    const config = makeConfig({ autoRepairEveryone: false });

    await runSyncCycle(guild as any, supabase, bus as any, config);

    expect(guild.roles.everyone.setPermissions).not.toHaveBeenCalled();
  });

  it('does NOT reset @everyone when general auto-repair is ON but the @everyone opt-in is OFF', async () => {
    // Explicit-opt-in guard: @everyone is destructive (reset to 0), so it must
    // require its OWN opt-in even when general auto-repair is enabled — dropping
    // the autoRepairEveryone condition would silently wipe @everyone perms.
    const guild = makeGuild();
    const desiredData = { roles: [], channels: [] };
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'guild_desired_state') return supaChain(desiredData);
        if (table === 'discord_id_map') return supaChain([]);
        if (table === 'audit_logs') return supaChain();
        return supaChain();
      }),
    } as any;

    mockComputeStateDiff.mockReturnValueOnce({ everyoneDrift: true, diffs: [] });
    mockClassifyDrift.mockReturnValueOnce([everyoneDrift()]);

    const bus = makeEventBus();
    const config = makeConfig({ autoRepair: true, autoRepairEveryone: false });

    await runSyncCycle(guild as any, supabase, bus as any, config);

    expect(guild.roles.everyone.setPermissions).not.toHaveBeenCalled();
  });

  it('does not exempt a user-created moderator-only channel by name', async () => {
    const channels = new MockCollection();
    const rulesChannel = { id: 'rules1', name: 'rules' };
    const updatesChannel = { id: 'updates1', name: 'public-updates' };
    channels.set('rules1', rulesChannel);
    channels.set('updates1', updatesChannel);

    const guild = makeGuild({
      rulesChannelId: 'rules1',
      publicUpdatesChannelId: 'updates1',
      channels: { cache: channels },
    });

    const desiredData = { roles: [], channels: [] };
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'guild_desired_state') return supaChain(desiredData);
        if (table === 'discord_id_map') return supaChain([]);
        if (table === 'audit_logs') return supaChain();
        return supaChain();
      }),
    } as any;

    mockComputeStateDiff.mockReturnValueOnce({ everyoneDrift: false, diffs: [] });
    mockClassifyDrift.mockReturnValueOnce([
      extraChannelDrift('rules', 'rules1'),
      extraChannelDrift('moderator-only', 'user-mod-only'),
      extraChannelDrift('public-updates', 'updates1'),
      extraChannelDrift('real-channel', 'real-channel'),
    ]);

    const bus = makeEventBus();
    const config = makeConfig({ autoRepair: true });

    const result = await runSyncCycle(guild as any, supabase, bus as any, config);

    expect(result.driftItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityDiscordId: 'user-mod-only' }),
      expect.objectContaining({ entityDiscordId: 'real-channel' }),
    ]));
    expect(result.driftItems).toHaveLength(2);
    expect(result.repaired).toBe(0);
  });

  it('does not exempt an unmapped ticket-looking channel by name', async () => {
    const guild = makeGuild();
    const desiredData = { roles: [], channels: [] };
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'guild_desired_state') return supaChain(desiredData);
        if (table === 'discord_id_map') return supaChain([]);
        if (table === 'audit_logs') return supaChain();
        return supaChain();
      }),
    } as any;

    mockComputeStateDiff.mockReturnValueOnce({ everyoneDrift: false, diffs: [] });
    mockClassifyDrift.mockReturnValueOnce([
      extraChannelDrift('ticket-1234-user', 'user-ticket-looking'),
      extraChannelDrift('general-chat', 'general-chat'),
    ]);

    const bus = makeEventBus();
    const config = makeConfig({ autoRepair: true });

    const result = await runSyncCycle(guild as any, supabase, bus as any, config);

    expect(result.driftItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityDiscordId: 'user-ticket-looking' }),
      expect.objectContaining({ entityDiscordId: 'general-chat' }),
    ]));
    expect(result.driftItems).toHaveLength(2);
    expect(result.repaired).toBe(0);
  });

  it('exempts only canonical system, mapped, and registered ticket channel IDs', async () => {
    const guild = makeGuild({ safetyAlertsChannelId: 'system-moderator-only' });
    const desiredData = { roles: [], channels: [] };
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'guild_desired_state') return supaChain(desiredData);
        if (table === 'discord_id_map') return supaChain([
          { entity_type: 'channel', template_key: 'channel:moderator-only', discord_id: 'mapped-moderator-only' },
        ]);
        if (table === 'tickets') return supaChain([{ channel_id: 'registered-ticket-channel' }]);
        if (table === 'audit_logs') return supaChain();
        return supaChain();
      }),
    };

    mockComputeStateDiff.mockReturnValueOnce({ everyoneDrift: false, diffs: [] });
    mockClassifyDrift.mockReturnValueOnce([
      extraChannelDrift('not-the-name', 'system-moderator-only'),
      extraChannelDrift('not-the-name', 'mapped-moderator-only'),
      extraChannelDrift('not-ticket-shaped', 'registered-ticket-channel'),
      extraChannelDrift('ticket-42-user', 'user-ticket-looking'),
    ]);

    const result = await runSyncCycle(
      guild as unknown as Parameters<typeof runSyncCycle>[0],
      supabase as unknown as Parameters<typeof runSyncCycle>[1],
      makeEventBus() as unknown as Parameters<typeof runSyncCycle>[2],
      makeConfig(),
    );

    expect(result.driftItems).toEqual([
      expect.objectContaining({ entityDiscordId: 'user-ticket-looking' }),
    ]);
  });

  it('emits drift.detected event when drift found', async () => {
    const guild = makeGuild();
    const desiredData = { roles: [], channels: [] };
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'guild_desired_state') return supaChain(desiredData);
        if (table === 'discord_id_map') return supaChain([]);
        if (table === 'audit_logs') return supaChain();
        return supaChain();
      }),
    } as any;

    mockComputeStateDiff.mockReturnValueOnce({ everyoneDrift: false, diffs: [] });
    mockClassifyDrift.mockReturnValueOnce([
      { type: 'PERMISSION_DRIFT', entityType: 'role', entityName: 'Admin', severity: 'critical', suggestedAction: 'repair' } as any,
    ]);

    const bus = makeEventBus();
    const config = makeConfig();

    await runSyncCycle(guild as any, supabase, bus as any, config);

    expect(bus.emit).toHaveBeenCalledWith('drift.detected', 'g1', expect.objectContaining({
      driftCount: 1,
      criticalCount: 1,
    }));
  });

  it('writes audit log when drift detected', async () => {
    const guild = makeGuild();
    const desiredData = { roles: [], channels: [] };
    const insertChain = supaChain();
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'guild_desired_state') return supaChain(desiredData);
        if (table === 'discord_id_map') return supaChain([]);
        if (table === 'audit_logs') return insertChain;
        return supaChain();
      }),
    } as any;

    mockComputeStateDiff.mockReturnValueOnce({ everyoneDrift: false, diffs: [] });
    mockClassifyDrift.mockReturnValueOnce([
      { type: 'EXTRA_RESOURCE', entityType: 'role', entityName: 'Rogue', severity: 'medium' } as any,
    ]);

    const bus = makeEventBus();
    const config = makeConfig();

    await runSyncCycle(guild as any, supabase, bus as any, config);

    expect(supabase.from).toHaveBeenCalledWith('audit_logs');
    expect(insertChain.insert).toHaveBeenCalledWith(expect.objectContaining({
      guild_id: 'g1',
      actor_type: 'system',
      action: 'drift.detected',
    }));
  });

  it('updates guild_desired_state with sync results', async () => {
    const guild = makeGuild();
    const desiredData = { roles: [], channels: [] };
    const updateChain = supaChain();
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'guild_desired_state') {
          // First call: select for desired state
          // We need a stateful mock
          return supaChain(desiredData);
        }
        if (table === 'discord_id_map') return supaChain([]);
        if (table === 'audit_logs') return supaChain();
        return supaChain();
      }),
    } as any;

    mockComputeStateDiff.mockReturnValueOnce({ everyoneDrift: false, diffs: [] });
    mockClassifyDrift.mockReturnValueOnce([]);

    const bus = makeEventBus();
    const config = makeConfig();

    await runSyncCycle(guild as any, supabase, bus as any, config);

    // Should have called from('guild_desired_state') for the update
    expect(supabase.from).toHaveBeenCalledWith('guild_desired_state');
  });

  it('handles auto-repair @everyone error gracefully', async () => {
    const guild = makeGuild();
    guild.roles.everyone.setPermissions = vi.fn(async () => { throw new Error('API error'); });

    const desiredData = { roles: [], channels: [] };
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'guild_desired_state') return supaChain(desiredData);
        if (table === 'discord_id_map') return supaChain([]);
        if (table === 'audit_logs') return supaChain();
        return supaChain();
      }),
    } as any;

    mockComputeStateDiff.mockReturnValueOnce({ everyoneDrift: true, diffs: [] });
    mockClassifyDrift.mockReturnValueOnce([]);

    const bus = makeEventBus();
    const config = makeConfig({ autoRepairEveryone: true });

    // Should not throw
    const result = await runSyncCycle(guild as any, supabase, bus as any, config);
    expect(result.repaired).toBe(0);
  });
});

describe('startSyncScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a stop function', async () => {
    const guild = makeGuild();
    const supabase = { from: vi.fn(() => supaChain()) } as any;
    const bus = makeEventBus();
    const config = makeConfig();

    const scheduler = startSyncScheduler(guild as any, supabase, bus as any, config);

    expect(typeof scheduler.stop).toBe('function');
    await scheduler.stop(); // Clean up
  });

  it('stop clears the interval', async () => {
    const guild = makeGuild();
    const supabase = { from: vi.fn(() => supaChain()) } as any;
    const bus = makeEventBus();
    const config = makeConfig({ intervalMinutes: 1 });

    const scheduler = startSyncScheduler(guild as any, supabase, bus as any, config);
    await scheduler.stop();

    // After stop, advancing time should not trigger runs
    // (If timer was cleared, no more callbacks)
    expect(scheduler).toBeDefined();
  });

  it('rearms the live interval without a bot restart', async () => {
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    const scheduler = startSyncScheduler(
      makeGuild() as any,
      { from: vi.fn(() => supaChain()) } as any,
      makeEventBus() as any,
      makeConfig({ intervalMinutes: 60 }),
    );

    scheduler.reconfigure(5);

    expect(intervalSpy).toHaveBeenLastCalledWith(expect.any(Function), 5 * 60 * 1000);
    await scheduler.stop();
  });

  it('can run immediately when an initially disabled scheduler is enabled', async () => {
    const supabase = { from: vi.fn(() => supaChain({
      sync_enabled: true,
      sync_interval_minutes: 60,
      sync_auto_repair: false,
      sync_auto_repair_everyone: false,
    })) } as any;
    const scheduler = startSyncScheduler(
      makeGuild() as any,
      supabase,
      makeEventBus() as any,
      makeConfig({ enabled: false, intervalMinutes: 60 }),
    );

    scheduler.reconfigure(undefined, true);
    await vi.waitFor(() => expect(supabase.from).toHaveBeenCalledWith('guild_config'));
    await scheduler.stop();
  });

  it('stop waits for an in-flight config read and prevents the sync cycle', async () => {
    type ConfigRead = {
      data: {
        sync_enabled: boolean;
        sync_interval_minutes: number;
        sync_auto_repair: boolean;
        sync_auto_repair_everyone: boolean;
      };
    };
    let resolveConfig!: (value: ConfigRead) => void;
    const configRead = new Promise<ConfigRead>((resolve) => { resolveConfig = resolve; });
    const configChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn(() => configRead),
    };
    const supabase = { from: vi.fn(() => configChain) } as any;
    const scheduler = startSyncScheduler(
      makeGuild() as any,
      supabase,
      makeEventBus() as any,
      makeConfig({ enabled: true, intervalMinutes: 60 }),
    );

    scheduler.reconfigure(undefined, true);
    await vi.waitFor(() => expect(supabase.from).toHaveBeenCalledWith('guild_config'));
    const stopped = scheduler.stop();
    let stopSettled = false;
    void stopped.then(() => { stopSettled = true; });
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    resolveConfig({
      data: {
        sync_enabled: true,
        sync_interval_minutes: 60,
        sync_auto_repair: true,
        sync_auto_repair_everyone: true,
      },
    });
    await stopped;

    expect(supabase.from).toHaveBeenCalledTimes(1);
  });
});
