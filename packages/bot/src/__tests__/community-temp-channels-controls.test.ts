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

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('discord.js', () => ({
  ChannelType: { GuildText: 0, GuildVoice: 2, GuildCategory: 4 },
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
    for (const m of ['select', 'eq', 'neq', 'or', 'is', 'lt', 'gt', 'gte', 'lte', 'in', 'not', 'order', 'limit', 'range', 'match', 'update', 'delete']) {
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
