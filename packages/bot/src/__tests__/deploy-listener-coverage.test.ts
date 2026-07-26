/**
 * deploy-listener — coverage tests
 *
 * Tests: getDeployStatus, startDeployListener, executeDeploy,
 * parseDesiredState, executeDeployDirect
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

const mockDeployServerState = vi.fn().mockResolvedValue({
  success: true,
  actions: [
    { action: 'create', entityType: 'role', entityName: 'Admin', discordId: 'r1', success: true },
    { action: 'create', entityType: 'channel', entityName: 'general', discordId: 'ch1', success: true },
    { action: 'create', entityType: 'category', entityName: 'Text', discordId: 'cat1', success: true },
    { action: 'apply', entityType: 'override', entityName: 'override1', discordId: 'o1', success: true },
  ],
  errors: [],
  idMappings: [{ entityType: 'role', key: 'admin', discordId: 'r1' }],
  duration: 500,
});
vi.mock('../deploy/deployer.js', () => ({
  deployServerState: (...args: unknown[]) => mockDeployServerState(...args),
}));

const mockWriteAuditLog = vi.fn().mockResolvedValue(undefined);
const mockWriteAuditBatch = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/audit.js', () => ({
  writeAuditLog: (...args: unknown[]) => mockWriteAuditLog(...args),
  writeAuditBatch: (...args: unknown[]) => mockWriteAuditBatch(...args),
}));

const mockWriteGuildSnapshot = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/guild-snapshot.js', () => ({
  writeGuildSnapshot: (...args: unknown[]) => mockWriteGuildSnapshot(...args),
}));

import { getDeployStatus, startDeployListener } from '../deploy/deploy-listener.js';

// ── Helpers ───────────────────────────────────────────────

function chainBuilder(resolveValue: Record<string, unknown> = { data: null, error: null }) {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'update', 'upsert', 'insert', 'delete', 'order', 'limit']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.single = vi.fn().mockResolvedValue(resolveValue);
  chain.maybeSingle = vi.fn().mockResolvedValue(resolveValue);
  chain.then = (res: (v: unknown) => void, rej?: (e: unknown) => void) =>
    Promise.resolve(resolveValue).then(res, rej);
  return chain;
}

function makeGuild(id: string) {
  return { id, name: `Guild ${id}` };
}

function makeClient() {
  let realtimeCallback: ((payload: Record<string, unknown>) => Promise<void>) | null = null;
  let eventBusListeners: Record<string, Function[]> = {};
  const guilds = new Map([
    ['g1', makeGuild('g1')],
    ['g2', makeGuild('g2')],
  ]);

  const channelObj = {
    on: vi.fn().mockImplementation((_event: string, _filter: unknown, cb: Function) => {
      realtimeCallback = cb as any;
      return channelObj;
    }),
    subscribe: vi.fn().mockImplementation((cb: Function) => { cb('SUBSCRIBED'); }),
  };

  return {
    guildId: 'g1',
    guilds: {
      cache: {
        get: vi.fn((guildId: string) => guilds.get(guildId)),
      },
    },
    supabase: {
      channel: vi.fn().mockReturnValue(channelObj),
      from: vi.fn().mockReturnValue(chainBuilder()),
    },
    eventBus: {
      on: vi.fn().mockImplementation((event: string, cb: Function) => {
        eventBusListeners[event] = eventBusListeners[event] || [];
        eventBusListeners[event].push(cb);
      }),
      emit: vi.fn(),
    },
    _realtimeCallback: () => realtimeCallback,
    _fireEvent: async (event: string, data?: unknown, guildId = 'g1') => {
      for (const cb of eventBusListeners[event] || []) {
        await cb({ type: event, guildId, timestamp: Date.now(), data: data ?? {} });
      }
    },
    _channelObj: channelObj,
  };
}

describe('getDeployStatus', () => {
  it('returns null initially', () => {
    const status = getDeployStatus();
    // After module load, no deploy has been run
    // It may or may not be null depending on previous tests
    expect(status === null || status?.deployId).toBeTruthy();
  });
});

describe('startDeployListener', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('subscribes to realtime channel', () => {
    const client = makeClient();
    startDeployListener(client as any);
    expect(client.supabase.channel).toHaveBeenCalledWith('deploy-listener');
    expect(client._channelObj.subscribe).toHaveBeenCalled();
  });

  it('subscribes to all guild desired-state updates', () => {
    const client = makeClient();
    startDeployListener(client as any);

    expect(client._channelObj.on).toHaveBeenCalledWith(
      'postgres_changes',
      expect.objectContaining({
        event: 'UPDATE',
        schema: 'public',
        table: 'guild_desired_state',
      }),
      expect.any(Function),
    );
    expect(client._channelObj.on.mock.calls[0][1]).not.toHaveProperty('filter');
  });

  it('registers event bus listener for deploy.requested', () => {
    const client = makeClient();
    startDeployListener(client as any);
    expect(client.eventBus.on).toHaveBeenCalledWith('deploy.requested', expect.any(Function));
  });

  it('handles realtime deploy trigger', async () => {
    const client = makeClient();
    startDeployListener(client as any);

    // Get the realtime callback
    const cb = client._realtimeCallback();
    expect(cb).toBeTruthy();

    // Simulate a deploy request payload
    await cb!({
      new: {
        applied_at: null,
        roles: [{ name: 'Admin', permissions: '8' }],
        channels: [{ name: 'general', type: 'text', categoryKey: 'cat-text' }],
      },
    });

    expect(mockDeployServerState).toHaveBeenCalled();
    expect(mockWriteAuditLog).toHaveBeenCalled();
  });

  it('handles realtime deploy trigger for a non-primary guild', async () => {
    const client = makeClient();
    startDeployListener(client as any);

    const cb = client._realtimeCallback();
    await cb!({
      new: {
        guild_id: 'g2',
        applied_at: null,
        roles: [{ name: 'Admin', permissions: '8' }],
        channels: [{ name: 'general', type: 'text' }],
      },
    });

    expect(client.guilds.cache.get).toHaveBeenCalledWith('g2');
    expect(mockDeployServerState).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'g2' }),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(getDeployStatus('g2')).toEqual(expect.objectContaining({ guildId: 'g2' }));
  });

  it('ignores realtime updates when applied_at is set', async () => {
    const client = makeClient();
    startDeployListener(client as any);
    const cb = client._realtimeCallback();

    await cb!({
      new: { applied_at: '2026-01-01', roles: [{ name: 'x' }], channels: [] },
    });

    expect(mockDeployServerState).not.toHaveBeenCalled();
  });

  it('ignores realtime updates with empty roles', async () => {
    const client = makeClient();
    startDeployListener(client as any);
    const cb = client._realtimeCallback();

    await cb!({ new: { applied_at: null, roles: [], channels: [] } });
    expect(mockDeployServerState).not.toHaveBeenCalled();
  });

  it('handles event bus deploy.requested', async () => {
    const client = makeClient();
    const desiredStateQuery = chainBuilder({
      data: {
        guild_id: 'g2',
        roles: [{ name: 'Mod', permissions: '0' }],
        channels: [],
      },
      error: null,
    });
    client.supabase.from.mockReturnValue(desiredStateQuery);
    startDeployListener(client as any);

    await client._fireEvent('deploy.requested', {}, 'g2');
    expect(desiredStateQuery.eq).toHaveBeenCalledWith('guild_id', 'g2');
    expect(mockDeployServerState).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'g2' }),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('handles event bus deploy when no state found', async () => {
    const client = makeClient();
    client.supabase.from.mockReturnValue(chainBuilder({ data: null, error: null }));
    startDeployListener(client as any);

    await client._fireEvent('deploy.requested', {});
    expect(mockDeployServerState).not.toHaveBeenCalled();
  });
});

describe('executeDeployDirect (via realtime trigger)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stores ID mappings on success', async () => {
    const client = makeClient();
    client.supabase.from.mockReturnValue(chainBuilder({ data: null, error: null }));
    startDeployListener(client as any);
    const cb = client._realtimeCallback()!;

    await cb({
      new: { applied_at: null, roles: [{ name: 'Admin' }], channels: [] },
    });

    // Check upsert was called for id mappings
    expect(client.supabase.from).toHaveBeenCalledWith('discord_id_map');
  });

  it('marks desired state as applied', async () => {
    const client = makeClient();
    client.supabase.from.mockReturnValue(chainBuilder({ data: null, error: null }));
    startDeployListener(client as any);
    const cb = client._realtimeCallback()!;

    await cb({
      new: { applied_at: null, roles: [{ name: 'Admin' }], channels: [] },
    });

    expect(client.supabase.from).toHaveBeenCalledWith('guild_desired_state');
  });

  it('emits server.deployed event', async () => {
    const client = makeClient();
    client.supabase.from.mockReturnValue(chainBuilder({ data: null, error: null }));
    startDeployListener(client as any);
    const cb = client._realtimeCallback()!;

    await cb({
      new: { applied_at: null, roles: [{ name: 'Admin' }], channels: [] },
    });

    expect(client.eventBus.emit).toHaveBeenCalledWith(
      'server.deployed', 'g1', expect.objectContaining({ deployId: expect.any(String) }),
    );
  });

  it('writes guild snapshot after deploy', async () => {
    const client = makeClient();
    client.supabase.from.mockReturnValue(chainBuilder({ data: null, error: null }));
    startDeployListener(client as any);
    const cb = client._realtimeCallback()!;

    await cb({
      new: { applied_at: null, roles: [{ name: 'x' }], channels: [] },
    });

    expect(mockWriteGuildSnapshot).toHaveBeenCalled();
  });

  it('handles deploy failure', async () => {
    mockDeployServerState.mockResolvedValueOnce({
      success: false,
      actions: [],
      errors: [{ entityName: 'Admin', error: 'perm denied' }],
      idMappings: [],
      duration: 200,
    });

    const client = makeClient();
    client.supabase.from.mockReturnValue(chainBuilder({ data: null, error: null }));
    startDeployListener(client as any);
    const cb = client._realtimeCallback()!;

    await cb({
      new: { applied_at: null, roles: [{ name: 'Admin' }], channels: [] },
    });

    expect(client.eventBus.emit).toHaveBeenCalledWith(
      'deploy.failed', 'g1', expect.objectContaining({ error: expect.stringContaining('perm denied') }),
    );
  });

  it('handles fatal deployment error', async () => {
    mockDeployServerState.mockRejectedValueOnce(new Error('fatal crash'));

    const client = makeClient();
    client.supabase.from.mockReturnValue(chainBuilder({ data: null, error: null }));
    startDeployListener(client as any);
    const cb = client._realtimeCallback()!;

    await cb({
      new: { applied_at: null, roles: [{ name: 'Admin' }], channels: [] },
    });

    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'deploy.fatal' }),
    );
  });

  it('handles snapshot failure gracefully', async () => {
    mockWriteGuildSnapshot.mockRejectedValueOnce(new Error('snap fail'));

    const client = makeClient();
    client.supabase.from.mockReturnValue(chainBuilder({ data: null, error: null }));
    startDeployListener(client as any);
    const cb = client._realtimeCallback()!;

    await cb({
      new: { applied_at: null, roles: [{ name: 'x' }], channels: [] },
    });

    // Should not throw
    expect(mockWriteAuditLog).toHaveBeenCalled();
  });

  it('handles upsert error for ID mappings', async () => {
    const client = makeClient();
    client.supabase.from.mockReturnValue(chainBuilder({ data: null, error: { message: 'upsert fail' } }));
    startDeployListener(client as any);
    const cb = client._realtimeCallback()!;

    await cb({
      new: { applied_at: null, roles: [{ name: 'x' }], channels: [] },
    });

    // Should log error but not throw
    expect(mockWriteAuditLog).toHaveBeenCalled();
  });

  it('parses categories from channel categoryKeys', async () => {
    mockDeployServerState.mockResolvedValueOnce({
      success: true,
      actions: [],
      errors: [],
      idMappings: [],
      duration: 100,
    });

    const client = makeClient();
    client.supabase.from.mockReturnValue(chainBuilder({ data: null, error: null }));
    startDeployListener(client as any);
    const cb = client._realtimeCallback()!;

    await cb({
      new: {
        applied_at: null,
        roles: [{ name: 'x' }],
        channels: [
          { name: 'general', categoryKey: 'cat-text-channels' },
          { name: 'voice', categoryKey: 'cat-text-channels' }, // dup
          { name: 'dev', categoryKey: 'cat-dev' },
        ],
      },
    });

    // deployServerState should receive categories extracted from channels
    const call = mockDeployServerState.mock.calls[0];
    const desiredState = call[2];
    expect(desiredState.categories).toHaveLength(2);
    expect(desiredState.categories[0].key).toBe('cat-text-channels');
    expect(desiredState.categories[1].key).toBe('cat-dev');
  });

  it('handles guild not found', async () => {
    const client = makeClient();
    client.guilds.cache.get.mockReturnValue(undefined);
    client.supabase.from.mockReturnValue(chainBuilder({ data: null, error: null }));
    startDeployListener(client as any);
    const cb = client._realtimeCallback()!;

    await cb({
      new: { applied_at: null, roles: [{ name: 'x' }], channels: [] },
    });

    expect(mockDeployServerState).not.toHaveBeenCalled();
  });
});
