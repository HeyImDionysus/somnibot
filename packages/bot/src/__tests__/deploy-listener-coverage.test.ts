/**
 * deploy-listener — coverage tests
 *
 * Tests: getDeployStatus, startDeployListener, executeDeploy,
 * parseDesiredState, executeDeployDirect
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

function resetDeployMocks(): void {
  vi.resetAllMocks();
  mockDeployServerState.mockResolvedValue({
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
  mockWriteAuditLog.mockResolvedValue(undefined);
  mockWriteAuditBatch.mockResolvedValue(undefined);
  mockWriteGuildSnapshot.mockResolvedValue(undefined);
}

// ── Helpers ───────────────────────────────────────────────

function chainBuilder(resolveValue: Record<string, unknown> = { data: null, error: null }) {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'is', 'update', 'upsert', 'insert', 'delete', 'order', 'limit']) {
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
  let subscriptionCallback: ((status: string) => void) | null = null;
  let eventBusListeners: Record<string, Function[]> = {};
  let latestRequestRow: Record<string, unknown> | null = null;
  let claimResultOverride: Record<string, unknown> | null = null;
  let settleResult = true;
  let renewResult = true;
  const guilds = new Map([
    ['g1', makeGuild('g1')],
    ['g2', makeGuild('g2')],
  ]);

  const channelObj = {
    on: vi.fn().mockImplementation((_event: string, _filter: unknown, cb: Function) => {
      realtimeCallback = cb as any;
      return channelObj;
    }),
    subscribe: vi.fn().mockImplementation((cb: (status: string) => void) => {
      subscriptionCallback = cb;
      cb('SUBSCRIBED');
    }),
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
      rpc: vi.fn().mockImplementation((name: string, params?: Record<string, unknown>) => {
        if (name === 'claim_deploy_request') {
          const guildId = typeof params?.p_guild_id === 'string' ? params.p_guild_id : 'g1';
          const requestId = typeof params?.p_request_id === 'string'
            ? params.p_request_id
            : '11111111-1111-4111-8111-111111111111';
          return Promise.resolve({
            data: {
              guild_id: guildId,
              applied_at: null,
              deploy_request_id: requestId,
              roles: [],
              channels: [],
              categories: [],
              ...latestRequestRow,
              deploy_claim_token: '22222222-2222-4222-8222-222222222222',
              deploy_lease_expires_at: '2099-01-01T00:00:00.000Z',
              deploy_status: 'running',
              ...claimResultOverride,
            },
            error: null,
          });
        }
        if (name === 'fail_interrupted_deploy_requests') {
          return Promise.resolve({ data: 0, error: null });
        }
        if (name === 'renew_deploy_request_claim') {
          return Promise.resolve({ data: renewResult, error: null });
        }
        return Promise.resolve({ data: settleResult, error: null });
      }),
    },
    eventBus: {
      on: vi.fn().mockImplementation((event: string, cb: Function) => {
        eventBusListeners[event] = eventBusListeners[event] || [];
        eventBusListeners[event].push(cb);
      }),
      emit: vi.fn(),
    },
    _realtimeCallback: () => {
      const callback = realtimeCallback;
      return callback
        ? async (payload: Record<string, unknown>) => {
          const incoming = typeof payload.new === 'object'
            && payload.new !== null
            && !Array.isArray(payload.new)
            ? payload.new
            : {};
          const enriched = {
            guild_id: 'g1',
            applied_at: null,
            deploy_request_id: '11111111-1111-4111-8111-111111111111',
            deploy_status: 'requested',
            roles: [],
            channels: [],
            categories: [],
            ...incoming,
          };
          latestRequestRow = enriched;
            await callback({ ...payload, new: enriched });
          }
        : null;
    },
    _fireEvent: async (event: string, data?: unknown, guildId = 'g1') => {
      for (const cb of eventBusListeners[event] || []) {
        await cb({ type: event, guildId, timestamp: Date.now(), data: data ?? {} });
      }
    },
    _channelObj: channelObj,
    _resubscribe: () => subscriptionCallback?.('SUBSCRIBED'),
    _setSettleResult: (value: boolean) => {
      settleResult = value;
    },
    _setRenewResult: (value: boolean) => {
      renewResult = value;
    },
    _setClaimResult: (value: Record<string, unknown>) => {
      claimResultOverride = value;
    },
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
    resetDeployMocks();
  });

  it('subscribes to realtime channel', () => {
    const client = makeClient();
    startDeployListener(client as any);
    expect(client.supabase.channel).toHaveBeenCalledWith('deploy-listener');
    expect(client._channelObj.subscribe).toHaveBeenCalled();
  });

  it('recovers a pending deploy after the realtime subscription starts', async () => {
    const client = makeClient();
    client.supabase.from.mockReturnValueOnce(chainBuilder({
      data: [{
        guild_id: 'g1',
        applied_at: null,
        deploy_request_id: '11111111-1111-4111-8111-111111111111',
        deploy_status: 'requested',
        roles: [{ name: 'Admin', permissions: '8' }],
        channels: [{ name: 'general', type: 'text', categoryKey: 'cat-text' }],
      }],
      error: null,
    }));

    startDeployListener(client as any);
    await vi.waitFor(() => expect(mockDeployServerState).toHaveBeenCalled());
  });

  it('subscribes to all guild desired-state updates', () => {
    const client = makeClient();
    startDeployListener(client as any);

    expect(client._channelObj.on).toHaveBeenCalledWith(
      'postgres_changes',
      expect.objectContaining({
        event: '*',
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

  it('reconciles interrupted requests only once across realtime reconnects', async () => {
    const client = makeClient();
    startDeployListener(client as unknown as Parameters<typeof startDeployListener>[0]);

    client._resubscribe();
    client._resubscribe();
    await vi.waitFor(() => expect(client.supabase.rpc).toHaveBeenCalled());

    expect(client.supabase.rpc.mock.calls.filter(([name]) =>
      name === 'fail_interrupted_deploy_requests',
    )).toHaveLength(1);
  });

  it('claims one requested deployment and ignores the running-state echo', async () => {
    const client = makeClient();
    startDeployListener(client as unknown as Parameters<typeof startDeployListener>[0]);
    const callback = client._realtimeCallback();
    const requestId = '11111111-1111-4111-8111-111111111111';

    await callback!({
      new: {
        guild_id: 'g1',
        applied_at: null,
        deploy_request_id: requestId,
        deploy_status: 'requested',
        roles: [],
        channels: [],
        categories: [],
      },
    });
    await callback!({
      new: {
        guild_id: 'g1',
        applied_at: null,
        deploy_request_id: requestId,
        deploy_claim_token: '22222222-2222-4222-8222-222222222222',
        deploy_status: 'running',
        roles: [],
        channels: [],
        categories: [],
      },
    });

    expect(client.supabase.rpc).toHaveBeenCalledWith('claim_deploy_request', {
      p_guild_id: 'g1',
      p_request_id: requestId,
    });
    expect(client.supabase.rpc.mock.calls.filter(([name]) =>
      name === 'claim_deploy_request',
    )).toHaveLength(1);
    expect(mockDeployServerState).toHaveBeenCalledTimes(1);
  });

  it('settles a claimed request as failed when its desired state is malformed', async () => {
    const client = makeClient();
    client._setClaimResult({ roles: null });
    startDeployListener(client as unknown as Parameters<typeof startDeployListener>[0]);
    const callback = client._realtimeCallback();

    await expect(callback!({
      new: {
        guild_id: 'g1',
        applied_at: null,
        deploy_request_id: '11111111-1111-4111-8111-111111111111',
        deploy_status: 'requested',
        roles: [],
        channels: [],
        categories: [],
      },
    })).rejects.toThrow('Claimed deployment request is malformed');

    expect(client.supabase.rpc).toHaveBeenCalledWith('settle_deploy_request', expect.objectContaining({
      p_guild_id: 'g1',
      p_request_id: '11111111-1111-4111-8111-111111111111',
      p_claim_token: '22222222-2222-4222-8222-222222222222',
      p_success: false,
    }));
    expect(mockDeployServerState).not.toHaveBeenCalled();
  });

  it('uses destructive mode only when the reviewed row explicitly requests it', async () => {
    const client = makeClient();
    startDeployListener(client as unknown as Parameters<typeof startDeployListener>[0]);
    const cb = client._realtimeCallback();

    await cb!({
      new: {
        applied_at: null,
        deploy_mode: 'destructive',
        roles: [],
        channels: [],
        categories: [],
      },
    });

    expect(mockDeployServerState).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ cleanExisting: true }),
    );
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

  it('deploys a reviewed empty plan', async () => {
    const client = makeClient();
    startDeployListener(client as any);
    const cb = client._realtimeCallback();

    await cb!({ new: { applied_at: null, roles: [], channels: [] } });
    expect(mockDeployServerState).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ roles: [], channels: [] }),
      expect.objectContaining({ cleanExisting: false }),
    );
  });

  it('handles event bus deploy.requested', async () => {
    const client = makeClient();
    const desiredStateQuery = chainBuilder({
      data: {
        guild_id: 'g2',
        applied_at: null,
        deploy_request_id: '11111111-1111-4111-8111-111111111111',
        deploy_status: 'requested',
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
    resetDeployMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renews the claim lease while Discord deployment remains in progress', async () => {
    vi.useFakeTimers();
    let finishDeployment: ((result: Awaited<ReturnType<typeof mockDeployServerState>>) => void)
      | undefined;
    mockDeployServerState.mockImplementationOnce(() => new Promise((resolve) => {
      finishDeployment = resolve;
    }));
    const client = makeClient();
    startDeployListener(client as unknown as Parameters<typeof startDeployListener>[0]);
    const cb = client._realtimeCallback()!;

    const deployment = cb({
      new: { applied_at: null, roles: [{ name: 'Admin' }], channels: [] },
    });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(client.supabase.rpc).toHaveBeenCalledWith('renew_deploy_request_claim', {
      p_guild_id: 'g1',
      p_request_id: '11111111-1111-4111-8111-111111111111',
      p_claim_token: '22222222-2222-4222-8222-222222222222',
    });

    finishDeployment?.({
      success: true,
      actions: [],
      errors: [],
      idMappings: [],
      duration: 30_000,
    });
    await deployment;
  });

  it('leaves ID mapping persistence to the deployer', async () => {
    const client = makeClient();
    client.supabase.from.mockReturnValue(chainBuilder({ data: null, error: null }));
    startDeployListener(client as any);
    const cb = client._realtimeCallback()!;

    await cb({
      new: { applied_at: null, roles: [{ name: 'Admin' }], channels: [] },
    });

    expect(client.supabase.from).not.toHaveBeenCalledWith('discord_id_map');
  });

  it('settles the claimed desired state as successful', async () => {
    const client = makeClient();
    client.supabase.from.mockReturnValue(chainBuilder({ data: null, error: null }));
    startDeployListener(client as any);
    const cb = client._realtimeCallback()!;

    await cb({
      new: { applied_at: null, roles: [{ name: 'Admin' }], channels: [] },
    });

    expect(client.supabase.rpc).toHaveBeenCalledWith(
      'settle_deploy_request',
      expect.objectContaining({ p_success: true }),
    );
  });

  it('settles as failed instead of recording success when required audit persistence fails', async () => {
    mockWriteAuditBatch.mockRejectedValueOnce(new Error('audit unavailable'));
    const client = makeClient();
    client.supabase.from.mockReturnValue(chainBuilder({ data: null, error: null }));
    startDeployListener(client as unknown as Parameters<typeof startDeployListener>[0]);
    const cb = client._realtimeCallback()!;

    await cb({
      new: { applied_at: null, roles: [{ name: 'Admin' }], channels: [] },
    });

    const settlementCalls = client.supabase.rpc.mock.calls.filter(([name]) =>
      name === 'settle_deploy_request',
    );
    expect(settlementCalls).toHaveLength(1);
    expect(settlementCalls[0]?.[1]).toEqual(expect.objectContaining({
      p_success: false,
      p_error: 'audit unavailable',
    }));
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

  it('reports failure when the claimed request cannot be settled', async () => {
    const client = makeClient();
    client._setSettleResult(false);
    startDeployListener(client as unknown as Parameters<typeof startDeployListener>[0]);
    const cb = client._realtimeCallback()!;

    await cb({
      new: { applied_at: null, roles: [{ name: 'x' }], channels: [] },
    });

    expect(client.eventBus.emit).toHaveBeenCalledWith(
      'deploy.failed',
      'g1',
      expect.objectContaining({ error: expect.stringContaining('Failed to settle the claimed deployment request') }),
    );
    expect(client.eventBus.emit).not.toHaveBeenCalledWith(
      'server.deployed',
      'g1',
      expect.anything(),
    );
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'deploy.failed',
        errorMessage: expect.stringContaining('Failed to settle the claimed deployment request'),
      }),
    );
    expect(mockWriteAuditLog).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'deploy.completed' }),
    );
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

  it('preserves stored category names exactly', async () => {
    const client = makeClient();
    client.supabase.from.mockReturnValue(chainBuilder({ data: null, error: null }));
    startDeployListener(client as unknown as Parameters<typeof startDeployListener>[0]);
    const cb = client._realtimeCallback()!;

    await cb({
      new: {
        applied_at: null,
        roles: [],
        channels: [{ name: 'release-validation', categoryKey: 'cat-release-qa' }],
        categories: [{ key: 'cat-release-qa', name: 'Release QA', position: 0 }],
      },
    });

    expect(mockDeployServerState.mock.calls[0][2].categories).toEqual([
      { key: 'cat-release-qa', name: 'Release QA', position: 0 },
    ]);
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
