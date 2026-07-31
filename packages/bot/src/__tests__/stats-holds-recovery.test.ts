/**
 * Round-5 review repairs that lacked dedicated units:
 *
 *  - stats-manager (3689375350): a created counter channel whose identity
 *    write fails must be deleted, not leaked — with channel_id still null,
 *    every later update would create ANOTHER channel and a restart has no id
 *    to recover the orphan with.
 *  - mass-action-hold (3689375360): owner-notice delivery must be CLAIMED
 *    before Discord is called; recording the message id only afterwards merely
 *    elects which duplicate card's id is stored.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('discord.js', () => ({
  ChannelType: { GuildText: 0, GuildVoice: 2, GuildCategory: 4 },
  RESTJSONErrorCodes: { UnknownChannel: 10003 },
}));

describe('StatsChannelManager — failed identity write does not leak the channel', () => {
  function statsSupa(channelIdWriteError: { message: string } | null) {
    return {
      rpc: vi.fn(async () => ({ data: null, error: { message: 'rpc unavailable' } })),
      from: vi.fn((table: string) => {
        const chain: any = {};
        for (const m of ['select', 'eq', 'neq', 'in', 'order', 'limit', 'is']) {
          chain[m] = vi.fn(() => chain);
        }
        chain.update = vi.fn((payload: Record<string, unknown>) => {
          chain._payload = payload;
          return chain;
        });
        chain.maybeSingle = vi.fn(async () => {
          if (table !== 'stats_channels') {
            return {
              data: table === 'guild_config' ? { stats_channels_enabled: true } : null,
              error: null,
            };
          }
          if (chain._payload && 'channel_id' in chain._payload) {
            // Conditional identity claim read-back.
            return channelIdWriteError
              ? { data: null, error: channelIdWriteError }
              : { data: { id: 'sc-new' }, error: null };
          }
          return { data: null, error: null };
        });
        chain.single = vi.fn(async () => ({ data: null, error: null }));
        chain.then = (resolve: (v: unknown) => void) => {
          if (chain._payload && 'channel_id' in chain._payload) {
            return resolve({ data: null, error: channelIdWriteError });
          }
          if (table === 'stats_channels' && !chain._payload) {
            return resolve({
              data: [{
                id: 'sc-new',
                guild_id: 'g1',
                channel_id: null,
                name_format: 'Members: {value}',
                type: 'member_count',
                stat_type: 'member_count',
                stat_config: {},
                enabled: true,
                last_value: null,
              }],
              error: null,
            });
          }
          return resolve({ data: null, error: null });
        };
        return chain;
      }),
    } as any;
  }

  /** Minimal discord.js Collection surface gatherStats() traverses. */
  function coll() {
    const c: any = new Map();
    c.filter = () => coll();
    c.map = () => [];
    return c;
  }

  function makeGuild(created: { id: string; delete: ReturnType<typeof vi.fn> }) {
    return {
      id: 'g1',
      name: 'G',
      memberCount: 10,
      members: { cache: coll(), fetch: vi.fn(async () => coll()) },
      roles: { cache: coll() },
      presences: { cache: coll() },
      channels: {
        cache: coll(),
        create: vi.fn(async () => created),
        fetch: vi.fn(async () => coll()),
      },
    } as any;
  }

  it('falls back to deleting the channel when no survivor pointer can be written', async () => {
    // Round 11 evolved the abort path: the survivor pointer is tried FIRST;
    // deletion remains the compensation when the pointer itself cannot be
    // persisted (this double fails every stats_channels write).
    const { StatsChannelManager } = await import('../features/stats-channels/stats-manager.js');
    const created = { id: 'vc-orphan', delete: vi.fn(async () => ({})) };
    const mgr = new StatsChannelManager(
      makeGuild(created),
      statsSupa({ message: 'db unavailable' }),
      60,
    );
    await mgr.start().catch(() => {});
    mgr.stop?.();

    expect(created.delete).toHaveBeenCalledTimes(1);
  }, 20_000);

  it('keeps the channel when the identity write succeeds', async () => {
    const { StatsChannelManager } = await import('../features/stats-channels/stats-manager.js');
    const created = { id: 'vc-kept', delete: vi.fn(async () => ({})), setName: vi.fn(async () => ({})) };
    const mgr = new StatsChannelManager(makeGuild(created), statsSupa(null), 60);
    await mgr.start().catch(() => {});
    mgr.stop?.();

    expect(created.delete).not.toHaveBeenCalled();
  });
});

describe('StatsChannelManager — abort survivors are durably recovered (round 11)', () => {
  /**
   * A supabase double for the survivor machinery. Query shapes:
   *  - loadChannels: select('*') on stats_channels, no update payload → configRows
   *  - reconcile scan: uses .neq → scanRows
   *  - identity write: update payload with channel_id, awaited plainly → identityError
   *  - adopt: update payload with channel_id terminated by maybeSingle → adopt read-back
   *  - pending read/write: select/update of pending_cleanup_channel_ids via maybeSingle
   *  - trim: update payload with pending_cleanup_channel_ids, awaited plainly → ok
   */
  function survivorSupa(options: {
    configRows?: Array<Record<string, unknown>>;
    scanRows?: Array<Record<string, unknown>>;
    identityWriteFails?: boolean;
    adoptMatches?: boolean;
  }) {
    const updatePayloads: Array<Record<string, unknown>> = [];
    const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const supabase = {
      rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
        rpcCalls.push({ fn, args });
        return { data: true, error: null };
      }),
      from: vi.fn((table: string) => {
        const chain: any = {};
        let usedNeq = false;
        for (const m of ['select', 'eq', 'in', 'order', 'limit', 'is']) chain[m] = vi.fn(() => chain);
        chain.neq = vi.fn(() => { usedNeq = true; return chain; });
        chain.update = vi.fn((payload: Record<string, unknown>) => {
          chain._payload = payload;
          updatePayloads.push(payload);
          return chain;
        });
        chain.single = vi.fn(async () => ({ data: null, error: null }));
        chain.maybeSingle = vi.fn(async () => {
          if (table !== 'stats_channels') {
            return {
              data: table === 'guild_config' ? { stats_channels_enabled: true } : null,
              error: null,
            };
          }
          if (chain._payload && 'channel_id' in chain._payload) {
            if (options.identityWriteFails) {
              return { data: null, error: { message: 'db unavailable' } };
            }
            return { data: options.adoptMatches === false ? null : { id: 'sc-1' }, error: null };
          }
          if (chain._payload && 'pending_cleanup_channel_ids' in chain._payload) {
            return { data: { id: 'sc-1' }, error: null };
          }
          return { data: { pending_cleanup_channel_ids: [] }, error: null };
        });
        chain.then = (resolve: (v: unknown) => void) => {
          if (chain._payload && 'channel_id' in chain._payload) {
            return resolve({
              data: null,
              error: options.identityWriteFails ? { message: 'db unavailable' } : null,
            });
          }
          if (chain._payload) return resolve({ data: null, error: null });
          if (table === 'stats_channels' && usedNeq) {
            return resolve({ data: options.scanRows ?? [], error: null });
          }
          if (table === 'stats_channels') {
            return resolve({ data: options.configRows ?? [], error: null });
          }
          return resolve({ data: null, error: null });
        };
        return chain;
      }),
    } as any;
    return { supabase, updatePayloads, rpcCalls };
  }

  function coll() {
    const c: any = new Map();
    c.filter = () => coll();
    c.map = () => [];
    return c;
  }

  function makeGuild(options: {
    created?: { id: string; delete: ReturnType<typeof vi.fn> };
    fetchChannel?: (id: string) => Promise<unknown>;
  }) {
    return {
      id: 'g1',
      name: 'G',
      memberCount: 10,
      members: { cache: coll(), fetch: vi.fn(async () => coll()) },
      roles: { cache: coll() },
      presences: { cache: coll() },
      channels: {
        cache: coll(),
        create: vi.fn(async () => options.created),
        fetch: vi.fn(options.fetchChannel ?? (async () => coll())),
      },
    } as any;
  }

  const CONFIG_ROW = {
    id: 'sc-1',
    guild_id: 'g1',
    channel_id: null,
    name_format: 'Members: {value}',
    stat_type: 'member_count',
    stat_config: {},
    active: true,
    last_value: null,
    pending_cleanup_channel_ids: [],
  };

  async function load() {
    const { StatsChannelManager } = await import('../features/stats-channels/stats-manager.js');
    return StatsChannelManager;
  }

  it('persists the survivor pointer INSTEAD of deleting when the identity write fails', async () => {
    const StatsChannelManager = await load();
    const created = { id: 'vc-orphan', delete: vi.fn(async () => ({})) };
    const { supabase, rpcCalls } = survivorSupa({
      configRows: [{ ...CONFIG_ROW }],
      scanRows: [],
      identityWriteFails: true,
    });
    const mgr = new StatsChannelManager(makeGuild({ created }), supabase, 60);
    await mgr.start().catch(() => {});
    mgr.stop?.();

    // The survivor became durable state, so the channel is NOT torn down —
    // the reconciler will adopt it as the counter on the next pass.
    expect(created.delete).not.toHaveBeenCalled();
    expect(rpcCalls).toContainEqual({
      fn: 'append_stats_pending_cleanup',
      args: { p_config_id: 'sc-1', p_channel_id: 'vc-orphan' },
    });
  }, 20_000);

  it('adopts a survivor for an active config whose channel_id is still null', async () => {
    const StatsChannelManager = await load();
    const survivor = { id: 'vc-x', delete: vi.fn(async () => ({})) };
    const { supabase, updatePayloads, rpcCalls } = survivorSupa({
      configRows: [],
      scanRows: [{
        id: 'sc-1', channel_id: null, active: true, pending_cleanup_channel_ids: ['vc-x'],
      }],
    });
    const mgr = new StatsChannelManager(
      makeGuild({ fetchChannel: async () => survivor }),
      supabase,
      60,
    );
    await mgr.start().catch(() => {});
    mgr.stop?.();

    expect(survivor.delete).not.toHaveBeenCalled();
    expect(updatePayloads).toContainEqual({ channel_id: 'vc-x' });
    expect(rpcCalls).toContainEqual({
      fn: 'remove_stats_pending_cleanup',
      args: { p_config_id: 'sc-1', p_channel_ids: ['vc-x'] },
    });
  });

  it('deletes a survivor owned by a deactivated config', async () => {
    const StatsChannelManager = await load();
    const survivor = { id: 'vc-x', delete: vi.fn(async () => ({})) };
    const { supabase, rpcCalls } = survivorSupa({
      configRows: [],
      scanRows: [{
        id: 'sc-1', channel_id: null, active: false, pending_cleanup_channel_ids: ['vc-x'],
      }],
    });
    const mgr = new StatsChannelManager(
      makeGuild({ fetchChannel: async () => survivor }),
      supabase,
      60,
    );
    await mgr.start().catch(() => {});
    mgr.stop?.();

    expect(survivor.delete).toHaveBeenCalledTimes(1);
    expect(rpcCalls).toContainEqual({
      fn: 'remove_stats_pending_cleanup',
      args: { p_config_id: 'sc-1', p_channel_ids: ['vc-x'] },
    });
  });

  it('drops a survivor Discord confirms is already gone', async () => {
    const StatsChannelManager = await load();
    const { supabase, rpcCalls } = survivorSupa({
      configRows: [],
      scanRows: [{
        id: 'sc-1', channel_id: null, active: false, pending_cleanup_channel_ids: ['vc-gone'],
      }],
    });
    const mgr = new StatsChannelManager(
      makeGuild({
        fetchChannel: async () => {
          throw { code: 10003 };
        },
      }),
      supabase,
      60,
    );
    await mgr.start().catch(() => {});
    mgr.stop?.();

    expect(rpcCalls).toContainEqual({
      fn: 'remove_stats_pending_cleanup',
      args: { p_config_id: 'sc-1', p_channel_ids: ['vc-gone'] },
    });
  });

  it('keeps a survivor whose deletion fails for the next pass', async () => {
    const StatsChannelManager = await load();
    const survivor = {
      id: 'vc-x',
      delete: vi.fn(async () => {
        throw new Error('missing permissions');
      }),
    };
    const { supabase, rpcCalls } = survivorSupa({
      configRows: [],
      scanRows: [{
        id: 'sc-1', channel_id: null, active: false, pending_cleanup_channel_ids: ['vc-x'],
      }],
    });
    const mgr = new StatsChannelManager(
      makeGuild({ fetchChannel: async () => survivor }),
      supabase,
      60,
    );
    await mgr.start().catch(() => {});
    mgr.stop?.();

    expect(survivor.delete).toHaveBeenCalledTimes(1);
    // Nothing resolved, so no removal is issued — the id stays durable for
    // the next reconcile pass.
    expect(
      rpcCalls.filter((call) => call.fn === 'remove_stats_pending_cleanup'),
    ).toEqual([]);
  });

  it('disposes of its own channel when another process wins the identity claim (round 12)', async () => {
    // Two overlapping processes both create a counter channel; the identity
    // write is a CONDITIONAL claim on channel_id IS NULL. The loser must not
    // overwrite the winner's durable pointer — its channel is the duplicate
    // and goes through the same durable-disposal machinery as the abort path.
    const StatsChannelManager = await load();
    const created = { id: 'vc-dup', delete: vi.fn(async () => ({})) };
    const { supabase, updatePayloads, rpcCalls } = survivorSupa({
      configRows: [{ ...CONFIG_ROW }],
      scanRows: [],
      adoptMatches: false,
    });
    const guild = makeGuild({ created });
    const mgr = new StatsChannelManager(guild, supabase, 60);
    await mgr.start().catch(() => {});
    mgr.stop?.();

    // The loser recorded its duplicate durably instead of deleting blind…
    expect(rpcCalls).toContainEqual({
      fn: 'append_stats_pending_cleanup',
      args: { p_config_id: 'sc-1', p_channel_id: 'vc-dup' },
    });
    expect(created.delete).not.toHaveBeenCalled();
    // …and never force-wrote its own id over the winner's pointer.
    expect(
      updatePayloads.filter((payload) => payload.channel_id === 'vc-dup').length,
    ).toBe(1); // the single conditional claim attempt, matched zero rows
  });

  it('never deletes a survivor that IS the live counter channel', async () => {
    const StatsChannelManager = await load();
    const fetchChannel = vi.fn(async () => ({ id: 'vc-live', delete: vi.fn() }));
    const { supabase, rpcCalls } = survivorSupa({
      configRows: [],
      scanRows: [{
        id: 'sc-1', channel_id: 'vc-live', active: true, pending_cleanup_channel_ids: ['vc-live'],
      }],
    });
    const mgr = new StatsChannelManager(makeGuild({ fetchChannel }), supabase, 60);
    await mgr.start().catch(() => {});
    mgr.stop?.();

    // A prior pass adopted it but could not trim the list: the only work left
    // is dropping the id — touching Discord at all risks the live counter.
    expect(fetchChannel).not.toHaveBeenCalled();
    expect(rpcCalls).toContainEqual({
      fn: 'remove_stats_pending_cleanup',
      args: { p_config_id: 'sc-1', p_channel_ids: ['vc-live'] },
    });
  });
});

describe('MassActionHoldService — owner notice is claimed before Discord is called', () => {
  const HOLD = {
    id: 'hold-1',
    guild_id: 'g1',
    automation_id: 'auto-1',
    member_count: 40,
    threshold: 25,
    created_at: new Date().toISOString(),
    notification_message_id: null as string | null,
  };

  function makeService(options: { claimWins: boolean }) {
    const calls: string[] = [];
    const updatePayloads: Array<Record<string, unknown>> = [];
    const supabase = {
      from: vi.fn((table: string) => {
        const chain: any = {};
        const filters: Record<string, unknown> = {};
        for (const m of ['select', 'order', 'limit']) chain[m] = vi.fn(() => chain);
        chain.eq = vi.fn((c: string, v: unknown) => { filters[c] = v; return chain; });
        chain.is = vi.fn((c: string, v: unknown) => { filters[`is:${c}`] = v; return chain; });
        chain.update = vi.fn((payload: Record<string, unknown>) => {
          chain._payload = payload;
          updatePayloads.push(payload);
          return chain;
        });
        chain.maybeSingle = vi.fn(async () => ({
          data: table === 'guild_config' ? { alert_channel_id: 'alerts-ch' } : null,
          error: null,
        }));
        chain.then = (resolve: (v: unknown) => void) => {
          if (chain._payload) {
            const value = String(chain._payload.notification_message_id ?? '');
            if (value.startsWith('pending:')) {
              calls.push('claim');
              return resolve({
                data: options.claimWins ? [{ id: HOLD.id }] : [],
                error: null,
              });
            }
            calls.push('record');
            return resolve({ data: [{ id: HOLD.id }], error: null });
          }
          return resolve({ data: null, error: null });
        };
        return chain;
      }),
    } as any;

    const send = vi.fn(async () => {
      calls.push('send');
      return { id: 'msg-1' };
    });
    const channel = {
      isTextBased: () => true,
      send,
      messages: { fetch: vi.fn(async () => ({ find: () => undefined })) },
    };
    const guild = { id: 'g1', channels: { cache: new Map([['alerts-ch', channel]]) } } as any;
    return { supabase, guild, calls, send, updatePayloads };
  }

  async function load() {
    const { MassActionHoldService } = await import('../features/automations/mass-action-hold.js');
    return MassActionHoldService;
  }

  it('claims delivery BEFORE sending, then records the real message id', async () => {
    const MassActionHoldService = await load();
    const { supabase, guild, calls, send } = makeService({ claimWins: true });
    const service = new MassActionHoldService(supabase, guild);

    await service.ensureOwnerNotice({ ...HOLD } as never, 'Bulk kick');

    expect(send).toHaveBeenCalledTimes(1);
    // The ordering IS the finding: claim → send → record. Send-first meant two
    // concurrent recovery paths could both post a card and the conditional
    // update could only choose which duplicate's id to keep.
    expect(calls).toEqual(['claim', 'send', 'record']);
  });

  it('sends NOTHING when another path already owns the claim', async () => {
    const MassActionHoldService = await load();
    const { supabase, guild, send } = makeService({ claimWins: false });
    const service = new MassActionHoldService(supabase, guild);

    await service.ensureOwnerNotice({ ...HOLD } as never, 'Bulk kick');

    expect(send).not.toHaveBeenCalled();
  });

  it('leaves a FRESH pending claim alone', async () => {
    const MassActionHoldService = await load();
    const { supabase, guild, send } = makeService({ claimWins: true });
    const service = new MassActionHoldService(supabase, guild);

    await service.ensureOwnerNotice(
      { ...HOLD, notification_message_id: `pending:${HOLD.id}:${Date.now()}` } as never,
      'Bulk kick',
    );

    expect(send).not.toHaveBeenCalled();
  });

  it('reclaims a STALE pending claim and delivers', async () => {
    const MassActionHoldService = await load();
    const { supabase, guild, calls, send } = makeService({ claimWins: true });
    const service = new MassActionHoldService(supabase, guild);

    await service.ensureOwnerNotice(
      { ...HOLD, notification_message_id: `pending:${HOLD.id}:${Date.now() - 20 * 60_000}` } as never,
      'Bulk kick',
    );

    // Stale sentinel released, delivery re-claimed, card posted exactly once.
    expect(send).toHaveBeenCalledTimes(1);
    expect(calls[calls.length - 1]).toBe('record');
  });

  it('scans only holds still needing notice delivery (round 11)', async () => {
    // The bounded oldest-first recovery scan used to include DELIVERED holds:
    // 500 old holds with recorded cards returned the same page forever, so a
    // newer hold whose notice failed was never revisited. The query itself
    // must exclude delivered rows — undelivered (null) and pending:* claim
    // sentinels are exactly what ensureOwnerNotice can act on.
    const MassActionHoldService = await load();
    const orFilters: string[] = [];
    const rows = [{ ...HOLD }];
    const supabase = {
      from: vi.fn(() => {
        const chain: any = {};
        for (const m of ['select', 'eq', 'order']) chain[m] = vi.fn(() => chain);
        chain.or = vi.fn((filter: string) => {
          orFilters.push(filter);
          return chain;
        });
        chain.limit = vi.fn(async () => ({ data: rows, error: null }));
        return chain;
      }),
    } as any;
    const service = new MassActionHoldService(
      supabase,
      { id: 'g1', channels: { cache: new Map() } } as never,
    );

    const held = await service.listHeldNeedingNotice();

    expect(held).toEqual(rows);
    expect(orFilters).toEqual([
      'notification_message_id.is.null,notification_message_id.like.pending:*',
    ]);
  });
});
