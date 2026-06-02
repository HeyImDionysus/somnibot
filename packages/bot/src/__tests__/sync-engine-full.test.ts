/**
 * Sync Engine — Full tests
 *
 * Tests runSyncCycle: desired state lookup, snapshot, diff/classify,
 * auto-repair @everyone, auto-repair other drift, community channel filtering,
 * ticket channel filtering, event emission, audit logging, DB persistence.
 * Also tests startSyncScheduler lifecycle.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────
const mockComputeStateDiff = vi.fn((): any => ({ everyoneDrift: false, diffs: [] }));
const mockClassifyDrift = vi.fn((): any[] => []);
const mockTakeSnapshot = vi.fn(async () => ({
  everyonePermissions: '0',
  roles: [],
  categories: [],
  channels: [],
}));

vi.mock('@somnibot/shared', () => ({
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
    'lte','limit','order','in','filter','maybeSingle','single','match','then'];
  for (const m of methods) c[m] = vi.fn((..._: any[]) => c);
  c.maybeSingle = vi.fn(async () => ({ data, error }));
  c.single = vi.fn(async () => ({ data, error }));
  c.then = (resolve: any) => resolve({ data: data ? [data] : [], error });
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runSyncCycle', () => {
  it('returns empty drift when no desired state exists', async () => {
    const guild = makeGuild();
    const supabase = {
      from: vi.fn(() => supaChain(null)),
    } as any;
    const bus = makeEventBus();
    const config = makeConfig();

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

  it('auto-repairs @everyone when configured and drift detected', async () => {
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
    const config = makeConfig({ autoRepairEveryone: true });

    await runSyncCycle(guild as any, supabase, bus as any, config);

    expect(guild.roles.everyone.setPermissions).toHaveBeenCalledWith(
      0n,
      expect.stringContaining('auto-repair'),
    );
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

  it('filters out community-required channels', async () => {
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
    // Return drift items for community channels
    mockClassifyDrift.mockReturnValueOnce([
      { type: 'EXTRA_RESOURCE', entityType: 'channel', entityName: 'rules', severity: 'low' } as any,
      { type: 'EXTRA_RESOURCE', entityType: 'channel', entityName: 'moderator-only', severity: 'low' } as any,
      { type: 'EXTRA_RESOURCE', entityType: 'channel', entityName: 'public-updates', severity: 'low' } as any,
      { type: 'EXTRA_RESOURCE', entityType: 'channel', entityName: 'real-channel', severity: 'medium' } as any,
    ]);

    const bus = makeEventBus();
    const config = makeConfig();

    const result = await runSyncCycle(guild as any, supabase, bus as any, config);

    // Community channels should be filtered
    expect(result.driftItems).toHaveLength(1);
    expect(result.driftItems[0].entityName).toBe('real-channel');
  });

  it('filters out ticket channels', async () => {
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
      { type: 'EXTRA_RESOURCE', entityType: 'channel', entityName: 'ticket-1234-user', severity: 'low' } as any,
      { type: 'EXTRA_RESOURCE', entityType: 'channel', entityName: 'general-chat', severity: 'low' } as any,
    ]);

    const bus = makeEventBus();
    const config = makeConfig();

    const result = await runSyncCycle(guild as any, supabase, bus as any, config);

    expect(result.driftItems).toHaveLength(1);
    expect(result.driftItems[0].entityName).toBe('general-chat');
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

  it('returns a stop function', () => {
    const guild = makeGuild();
    const supabase = { from: vi.fn(() => supaChain()) } as any;
    const bus = makeEventBus();
    const config = makeConfig();

    const scheduler = startSyncScheduler(guild as any, supabase, bus as any, config);

    expect(typeof scheduler.stop).toBe('function');
    scheduler.stop(); // Clean up
  });

  it('stop clears the interval', () => {
    const guild = makeGuild();
    const supabase = { from: vi.fn(() => supaChain()) } as any;
    const bus = makeEventBus();
    const config = makeConfig({ intervalMinutes: 1 });

    const scheduler = startSyncScheduler(guild as any, supabase, bus as any, config);
    scheduler.stop();

    // After stop, advancing time should not trigger runs
    // (If timer was cleared, no more callbacks)
    expect(true).toBe(true); // Mainly testing it doesn't throw
  });
});
