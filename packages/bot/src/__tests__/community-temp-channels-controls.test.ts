/**
 * community-temporary-channels FLEET_BACKLOG fixes.
 *
 *  - {owner-name} name-template variable is substituted (was rendered literally)
 *  - allow-claim control gates /voice claim
 *  - room-creation failure notifies the member + raises one owner alert
 *  - handleJoinHub is idempotent per join event + retries a transient create
 *  - empty-grace-seconds drives the empty-room grace window
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('discord.js', () => ({
  ChannelType: { GuildText: 0, GuildVoice: 2, GuildCategory: 4 },
  RESTJSONErrorCodes: { UnknownChannel: 10003 },
  PermissionFlagsBits: {
    ManageChannels: 4n, MoveMembers: 8n, MuteMembers: 16n, DeafenMembers: 32n,
    ViewChannel: 1n, SendMessages: 2n, ManageMessages: 64n,
  },
}));

const HUB = {
  id: 'hub1', guild_id: 'g1', hub_channel_id: 'hubvc', category_id: 'cat1',
  naming_format: "{owner-name}'s room",
  default_user_limit: 0, default_bitrate: 64000,
  keep_alive_minutes: 1, empty_grace_seconds: 15,
  allow_text_channel: false, allow_claim: true,
  moderator_roles: [] as string[], active: true,
};

/** Supabase double that records inserts and resolves selects to seeded rows. */
function makeSupa(hubs: any[] = [HUB], active: any[] = []) {
  const inserts: Record<string, any[]> = { active_temp_channels: [], alerts: [], temp_channel_hubs: [] };
  function chainFor(table: string) {
    const data = table === 'temp_channel_hubs' ? hubs : table === 'active_temp_channels' ? active : [];
    const c: any = {};
    for (const m of ['select', 'eq', 'neq', 'or', 'is', 'lt', 'gt', 'gte', 'lte', 'in', 'not', 'order', 'limit', 'range', 'match', 'contains', 'update', 'delete']) {
      c[m] = () => c;
    }
    c.insert = (row: any) => { (inserts[table] ||= []).push(row); return c; };
    c.maybeSingle = async () => ({ data: data[0] ?? null, error: null });
    c.single = async () => ({ data: data[0] ?? null, error: null });
    c.then = (resolve: (v: any) => void) => resolve({ data, error: null });
    return c;
  }
  return { supabase: { from: (t: string) => chainFor(t) } as any, inserts };
}

function member(id = 'u1', displayName = 'Alice') {
  return {
    id, displayName,
    user: { id, username: 'alice', bot: false },
    send: vi.fn(async () => {}),
    voice: { setChannel: vi.fn(async () => {}) },
  } as any;
}

function guild(create: (opts: any) => Promise<any>) {
  const cache = new Map<string, any>();
  return {
    id: 'g1',
    channels: { cache, create: vi.fn(create) },
  } as any;
}

async function loadManager() {
  const { TempChannelManager } = await import('../features/temp-channels/temp-channel-manager.js');
  return TempChannelManager;
}

describe('TempChannelManager — {owner-name} substitution', () => {
  it('renders the owner display name, not the literal template', async () => {
    const TempChannelManager = await loadManager();
    const { supabase } = makeSupa();
    const g = guild(async (opts) => ({ id: 'newvc', name: opts.name, members: new Map() }));
    const mgr = new TempChannelManager(g, supabase);
    await mgr.start();
    await mgr.handleJoinHub(member('u1', 'Alice'), 'hubvc');

    expect(g.channels.create).toHaveBeenCalledTimes(1);
    const opts = g.channels.create.mock.calls[0][0];
    expect(opts.name).toBe("Alice's room");
    expect(opts.name).not.toContain('{owner-name}');
  });
});

describe('TempChannelManager — room-creation failure surfacing', () => {
  it('notifies the member + writes one owner alert, and creates no active row', async () => {
    const TempChannelManager = await loadManager();
    const { supabase, inserts } = makeSupa();
    const g = guild(async () => { throw new Error('Missing Permissions'); });
    const mgr = new TempChannelManager(g, supabase);
    await mgr.start();
    const m = member('u1', 'Alice');
    await mgr.handleJoinHub(m, 'hubvc');

    expect(m.send).toHaveBeenCalledTimes(1);
    expect(inserts.alerts.length).toBe(1);
    expect(inserts.alerts[0].alert_type).toBe('temp_channel_creation_failed');
    expect(inserts.active_temp_channels.length).toBe(0);
  });
});

describe('TempChannelManager — join idempotency + retry', () => {
  it('a replayed concurrent join spawns exactly one room', async () => {
    const TempChannelManager = await loadManager();
    const { supabase, inserts } = makeSupa();
    let n = 0;
    const g = guild(async (opts) => ({ id: `vc${++n}`, name: opts.name, members: new Map() }));
    const mgr = new TempChannelManager(g, supabase);
    await mgr.start();
    const m = member('u1', 'Alice');
    await Promise.all([mgr.handleJoinHub(m, 'hubvc'), mgr.handleJoinHub(m, 'hubvc')]);

    expect(g.channels.create).toHaveBeenCalledTimes(1);
    expect(inserts.active_temp_channels.length).toBe(1);
  });

  it('a transient create error is retried, yielding exactly one room', async () => {
    const TempChannelManager = await loadManager();
    const { supabase, inserts } = makeSupa();
    let calls = 0;
    const g = guild(async (opts) => {
      calls++;
      if (calls === 1) throw new Error('503 transient');
      return { id: 'vc-ok', name: opts.name, members: new Map() };
    });
    const mgr = new TempChannelManager(g, supabase);
    await mgr.start();
    await mgr.handleJoinHub(member('u1', 'Alice'), 'hubvc');

    expect(calls).toBe(2);
    expect(inserts.active_temp_channels.length).toBe(1);
    expect(inserts.alerts.length).toBe(0);
  });
});

describe('/voice claim — allow-claim gate', () => {
  function claimInteraction(ownerInChannel: boolean) {
    const vc = { id: 'vc1', members: { has: (id: string) => (ownerInChannel ? id === 'owner1' : false) } };
    const channels = new Map<string, any>([['vc1', vc]]);
    const members = new Map<string, any>([
      ['u1', { voice: { channelId: 'vc1' }, roles: { cache: { has: () => false } } }],
    ]);
    return {
      reply: vi.fn(async () => {}),
      member: { id: 'u1' },
      user: { id: 'u1' },
      guild: { id: 'g1', members: { cache: members }, channels: { cache: channels } },
      options: { getSubcommand: () => 'claim', getInteger: () => 0, getString: () => '', getUser: () => ({ id: 'x' }) },
      replied: false,
      deferred: false,
    } as any;
  }

  function fakeManager(allowClaim: boolean) {
    return {
      isTempChannel: () => true,
      getChannelOwner: () => 'owner1',
      getHubForChannel: () => ({ ...HUB, allow_claim: allowClaim }),
      transferOwnership: vi.fn(async () => {}),
    } as any;
  }

  it('refuses the claim when allow_claim is false', async () => {
    const { handleTempChannelCommand } = await import('../features/temp-channels/commands.js');
    const inter = claimInteraction(false);
    const mgr = fakeManager(false);
    await handleTempChannelCommand(inter, mgr);

    expect(mgr.transferOwnership).not.toHaveBeenCalled();
    expect(inter.reply).toHaveBeenCalledTimes(1);
    expect(String(inter.reply.mock.calls[0][0].content)).toMatch(/disabled/i);
  });

  it('allows the claim when allow_claim is true and the owner has left', async () => {
    const { handleTempChannelCommand } = await import('../features/temp-channels/commands.js');
    const inter = claimInteraction(false);
    const mgr = fakeManager(true);
    await handleTempChannelCommand(inter, mgr);

    expect(mgr.transferOwnership).toHaveBeenCalledTimes(1);
  });
});

describe('TempChannelManager — empty-grace-seconds window', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('schedules the empty-room delete at the configured seconds window', async () => {
    const TempChannelManager = await loadManager();
    const active = [{ channel_id: 'tvc', text_channel_id: null, guild_id: 'g1', hub_id: 'hub1', owner_id: 'u1' }];
    const { supabase } = makeSupa([HUB], active);
    const emptyVc = { id: 'tvc', members: { filter: () => ({ size: 0 }) } };
    const g = guild(async (opts) => ({ id: 'x', name: opts.name, members: new Map() }));
    g.channels.cache.set('tvc', emptyVc);
    const mgr = new TempChannelManager(g, supabase);
    await mgr.start();

    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    await mgr.handleLeaveTemp('tvc');

    // empty_grace_seconds = 15 → 15_000 ms window (not the 60_000 ms minutes default)
    const delays = setTimeoutSpy.mock.calls.map((c) => c[1]);
    expect(delays).toContain(15_000);
    mgr.stop();
  });
});

describe('TempChannelManager — cleanup-job persistence failures stay recoverable', () => {
  /**
   * Purpose-built double for the active-row-insert failure branch:
   *  - occurrence claim insert WINS (returns a claimed row);
   *  - active_temp_channels insert FAILS (the branch under test);
   *  - the created voice channel's delete REJECTS, leaving a survivor;
   *  - the cleanup-pending update fails `failUpdates` times before succeeding.
   * Every occurrence-table update payload is recorded so the assertions can
   * distinguish cleanup-pending writes from a terminal status flip.
   */
  function persistenceSupa(failUpdates: number) {
    const occurrenceUpdates: any[] = [];
    let updateAttempts = 0;
    function chainFor(table: string) {
      const c: any = { _insert: null, _update: null };
      for (const m of ['select', 'eq', 'neq', 'or', 'is', 'lt', 'gt', 'gte', 'lte', 'in', 'not', 'order', 'limit', 'range', 'match', 'contains', 'delete']) {
        c[m] = () => c;
      }
      c.insert = (row: any) => { c._insert = row; return c; };
      c.update = (payload: any) => { c._update = payload; return c; };
      c.single = async () => {
        if (table === 'discord_operation_occurrences' && c._insert) {
          return {
            data: {
              id: 'occ-1', guild_id: 'g1', operation_kind: 'temp_channel',
              occurrence_key: 'k', status: 'claimed', result: {},
              resource_id: null, last_error: null,
            },
            error: null,
          };
        }
        if (table === 'temp_channel_hubs') return { data: HUB, error: null };
        return { data: null, error: null };
      };
      c.maybeSingle = async () => {
        if (table === 'discord_operation_occurrences' && c._update) {
          updateAttempts++;
          occurrenceUpdates.push(c._update);
          if (updateAttempts <= failUpdates) {
            return { data: null, error: { message: 'transient write failure' } };
          }
          return { data: { id: 'occ-1' }, error: null };
        }
        if (table === 'temp_channel_hubs') return { data: HUB, error: null };
        return { data: null, error: null };
      };
      c.then = (resolve: (v: any) => void) => {
        if (table === 'active_temp_channels' && c._insert) {
          return resolve({ data: null, error: { message: 'insert refused' } });
        }
        if (table === 'discord_operation_occurrences' && c._update) {
          // Terminal fail/release writes await the chain directly.
          occurrenceUpdates.push(c._update);
          return resolve({ data: null, error: null });
        }
        if (table === 'temp_channel_hubs') return resolve({ data: [HUB], error: null });
        return resolve({ data: [], error: null });
      };
      return c;
    }
    return {
      supabase: { from: (t: string) => chainFor(t) } as any,
      occurrenceUpdates,
      attempts: () => updateAttempts,
    };
  }

  function survivorGuild() {
    return guild(async (opts) => ({
      id: 'vc-1', name: opts.name, members: new Map(),
      delete: vi.fn(async () => { throw new Error('50013 missing permissions'); }),
    }));
  }

  it('retries a transient cleanup-pending write and never terminalizes the claim', async () => {
    const TempChannelManager = await loadManager();
    const { supabase, occurrenceUpdates, attempts } = persistenceSupa(1);
    const mgr = new TempChannelManager(survivorGuild(), supabase);
    await mgr.start();

    await mgr.handleJoinHub(member('u1', 'Alice'), 'hubvc', 'join-evt-1');

    expect(attempts()).toBe(2);
    const pending = occurrenceUpdates.find((u) => u?.result?.channelCleanupPending === true);
    expect(pending, 'the cleanup job must be durably recorded on retry').toBeTruthy();
    expect(pending.result.channelIds).toEqual(['vc-1']);
    // The claim must never be flipped terminal: the reconciler only scans
    // claimed rows, so `failed` would orphan the surviving channel invisibly.
    expect(occurrenceUpdates.some((u) => u?.status === 'failed')).toBe(false);
  });

  it('leaves the occurrence CLAIMED when persistence is exhausted — never failed', async () => {
    const TempChannelManager = await loadManager();
    const { supabase, occurrenceUpdates, attempts } = persistenceSupa(99);
    const mgr = new TempChannelManager(survivorGuild(), supabase);
    await mgr.start();

    await mgr.handleJoinHub(member('u1', 'Alice'), 'hubvc', 'join-evt-2');

    expect(attempts()).toBe(3);
    // No terminal write of ANY kind: not failed, not released, not completed.
    expect(occurrenceUpdates.some((u) => u?.status === 'failed')).toBe(false);
    expect(occurrenceUpdates.some((u) => u?.status === 'released')).toBe(false);
    expect(occurrenceUpdates.some((u) => u?.status === 'completed')).toBe(false);
  });
});

describe('TempChannelManager — startup cleanup failures stay contained', () => {
  it('start() resolves and installs the retry timer when the initial reconcile throws', async () => {
    const TempChannelManager = await loadManager();
    // Occurrence-table scans reject outright (network-style failure); hub and
    // active-row loads still work.
    function chainFor(table: string) {
      const c: any = {};
      for (const m of ['select', 'eq', 'neq', 'or', 'is', 'lt', 'gt', 'gte', 'lte', 'in', 'not', 'order', 'limit', 'range', 'match', 'contains', 'insert', 'update', 'delete']) {
        c[m] = () => c;
      }
      c.maybeSingle = async () => ({ data: null, error: null });
      c.single = async () => ({ data: null, error: null });
      c.then = (resolve: (v: any) => void, reject?: (e: unknown) => void) => {
        if (table === 'discord_operation_occurrences' && reject) {
          return reject(new Error('database momentarily unreachable'));
        }
        return resolve({ data: table === 'temp_channel_hubs' ? [HUB] : [], error: null });
      };
      return c;
    }
    const supabase = { from: (t: string) => chainFor(t) } as any;
    const g = guild(async () => ({ id: 'vc-1', members: new Map() }));
    const mgr = new TempChannelManager(g, supabase);

    // The whole point: this must not throw. guild-init awaits start() inside
    // the shared community-features try, so a throw here used to take down
    // stats channels, scheduled messages and giveaways with it.
    await expect(mgr.start()).resolves.not.toThrow();
    expect((mgr as any).pendingChannelCleanupTimer).toBeTruthy();
    mgr.stop();
    expect((mgr as any).pendingChannelCleanupTimer).toBeNull();
  });
});

describe('TempChannelManager — startup orphan cleanup retries on the periodic timer', () => {
  it('retries a transiently failed orphan retirement without waiting for a restart', async () => {
    vi.useFakeTimers();
    try {
      const TempChannelManager = await loadManager();
      const retireCalls: number[] = [];
      // First retirement attempt fails (transient DB error → startup cleanup
      // is contained); the second, fired by the periodic timer, succeeds.
      const rpc = vi.fn(async (name: string) => {
        if (name === 'retire_temp_channel') {
          retireCalls.push(Date.now());
          if (retireCalls.length === 1) {
            return { data: null, error: { message: 'db momentarily unavailable' } };
          }
          return { data: true, error: null };
        }
        return { data: null, error: null };
      });
      function chainFor(table: string) {
        const c: any = {};
        for (const m of ['select', 'eq', 'neq', 'or', 'is', 'lt', 'gt', 'gte', 'lte', 'in', 'not', 'order', 'limit', 'range', 'match', 'contains', 'insert', 'update', 'delete']) {
          c[m] = () => c;
        }
        c.maybeSingle = async () => ({ data: null, error: null });
        c.single = async () => ({ data: null, error: null });
        c.then = (resolve: (v: any) => void) => resolve({
          data: table === 'temp_channel_hubs'
            ? [HUB]
            : table === 'active_temp_channels'
              ? [{
                  channel_id: 'gone-vc', text_channel_id: null, guild_id: 'g1',
                  hub_id: 'hub1', owner_id: 'u1', creation_occurrence_id: null,
                }]
              : [],
          error: null,
        });
        return c;
      }
      const supabase = { from: (t: string) => chainFor(t), rpc } as any;
      // 'gone-vc' is absent from the guild cache — a genuine orphan.
      const g = guild(async () => ({ id: 'vc-x', members: new Map() }));
      const mgr = new TempChannelManager(g, supabase);

      // Startup: the retirement fails, but start() must still resolve.
      await mgr.start();
      expect(retireCalls.length).toBe(1);

      // One periodic interval later the ORPHAN cleanup (not just the
      // cleanup-pending reconcile) must run again and retire the row.
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 50);
      expect(retireCalls.length).toBe(2);

      mgr.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
