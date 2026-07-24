/**
 * Temp-channel branded message templates.
 *
 * Covers the resolver (variable substitution incl. the {owner-name} MED finding),
 * override-vs-default selection, and the wiring into the manager's room-created
 * surface and the command handler's control-applied / control-denied surfaces.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('discord.js', () => ({
  SlashCommandBuilder: class {
    setName() { return this; } setDescription() { return this; } addSubcommand() { return this; }
    addIntegerOption() { return this; } addStringOption() { return this; } addUserOption() { return this; }
  },
  ChannelType: { GuildText: 0, GuildVoice: 2, GuildCategory: 4 },
  PermissionFlagsBits: {
    ManageChannels: 4n, MoveMembers: 8n, MuteMembers: 16n, DeafenMembers: 32n,
    ViewChannel: 1n, SendMessages: 2n, ManageMessages: 64n, Connect: 128n,
  },
}));

import {
  resolveTemplate,
  selectTemplate,
  renderTempChannelTemplate,
  DEFAULT_TEMP_CHANNEL_TEMPLATES,
} from '../features/temp-channels/templates.js';

// ── Resolver ────────────────────────────────────────────────

describe('resolveTemplate', () => {
  it('substitutes a hyphenated {owner-name} token (the MED finding)', () => {
    expect(resolveTemplate('Hi {owner-name}!', { 'owner-name': 'Alice' })).toBe('Hi Alice!');
  });

  it('substitutes multiple tokens including {room-name}', () => {
    const out = resolveTemplate('{owner-name} owns {room-name}', {
      'owner-name': 'Bob',
      'room-name': "Bob's room",
    });
    expect(out).toBe("Bob owns Bob's room");
  });

  it('matches token names case-insensitively', () => {
    expect(resolveTemplate('{Owner-Name}', { 'owner-name': 'Cara' })).toBe('Cara');
  });

  it('leaves unknown tokens untouched so typos are visible', () => {
    expect(resolveTemplate('{owner-name} / {nope}', { 'owner-name': 'Dee' })).toBe('Dee / {nope}');
  });

  it('leaves a token whose value is null/undefined untouched', () => {
    expect(resolveTemplate('{server}', { server: undefined })).toBe('{server}');
    expect(resolveTemplate('{server}', { server: null })).toBe('{server}');
  });

  it('coerces numeric values to strings', () => {
    expect(resolveTemplate('limit={count}', { count: 5 })).toBe('limit=5');
  });

  it('returns empty string for an empty template', () => {
    expect(resolveTemplate('', { anything: 'x' })).toBe('');
  });

  it('does not treat @everyone-style text as a token', () => {
    expect(resolveTemplate('@everyone {owner-name}', { 'owner-name': 'Eve' })).toBe('@everyone Eve');
  });
});

// ── Override vs default selection ───────────────────────────

describe('selectTemplate', () => {
  it('returns the built-in default when the hub has no override', () => {
    expect(selectTemplate({}, 'room_created')).toBe(DEFAULT_TEMP_CHANNEL_TEMPLATES.room_created);
    expect(selectTemplate(null, 'control_applied')).toBe(DEFAULT_TEMP_CHANNEL_TEMPLATES.control_applied);
  });

  it('returns the built-in default when the override is null or blank', () => {
    expect(selectTemplate({ room_created_template: null }, 'room_created')).toBe(
      DEFAULT_TEMP_CHANNEL_TEMPLATES.room_created,
    );
    expect(selectTemplate({ room_created_template: '   ' }, 'room_created')).toBe(
      DEFAULT_TEMP_CHANNEL_TEMPLATES.room_created,
    );
  });

  it('returns the override when it is a non-blank string', () => {
    expect(selectTemplate({ room_created_template: 'Custom {owner-name}' }, 'room_created')).toBe(
      'Custom {owner-name}',
    );
  });
});

describe('renderTempChannelTemplate', () => {
  it('renders the default when no override, substituting variables', () => {
    const out = renderTempChannelTemplate(null, 'control_applied', { action: '🔒 Locked.' });
    expect(out).toBe('🔒 Locked.'); // default is "{action}"
  });

  it('renders an override with variables substituted', () => {
    const out = renderTempChannelTemplate(
      { control_applied_template: '✨ {server} · {action}' },
      'control_applied',
      { server: 'MyGuild', action: '🔒 Locked.' },
    );
    expect(out).toBe('✨ MyGuild · 🔒 Locked.');
  });
});

// ── Manager wiring: room-created surface ────────────────────

const HUB = {
  id: 'hub1', guild_id: 'g1', hub_channel_id: 'hubvc', category_id: 'cat1',
  naming_format: "{owner-name}'s room",
  default_user_limit: 0, default_bitrate: 64000,
  keep_alive_minutes: 1, empty_grace_seconds: 15,
  allow_text_channel: false, allow_claim: true,
  moderator_roles: [] as string[], active: true,
  room_created_template: null as string | null,
  control_applied_template: null as string | null,
  control_denied_template: null as string | null,
};

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

/** Guild whose channels.create records + caches the channels it makes. */
function makeGuild() {
  const cache = new Map<string, any>();
  const created: any[] = [];
  const create = vi.fn(async (opts: any) => {
    const ch = {
      id: `ch${created.length + 1}`,
      name: opts.name,
      type: opts.type,
      members: new Map(),
      send: vi.fn(async () => {}),
    };
    created.push(ch);
    cache.set(ch.id, ch);
    return ch;
  });
  return { guild: { id: 'g1', name: 'MyGuild', channels: { cache, create } } as any, created };
}

async function loadManager() {
  const { TempChannelManager } = await import('../features/temp-channels/temp-channel-manager.js');
  return TempChannelManager;
}

describe('TempChannelManager — room-created template surface', () => {
  it('posts the default welcome into the voice channel with the owner name and mentions disabled', async () => {
    const TempChannelManager = await loadManager();
    const { supabase } = makeSupa();
    const { guild, created } = makeGuild();
    const mgr = new TempChannelManager(guild, supabase);
    await mgr.start();
    await mgr.handleJoinHub(member('u1', 'Alice'), 'hubvc');

    const vc = created[0];
    expect(vc.send).toHaveBeenCalledTimes(1);
    const payload = vc.send.mock.calls[0][0];
    expect(payload.content).toContain('Alice');
    expect(payload.content).not.toContain('{owner-name}');
    expect(payload.allowedMentions).toEqual({ parse: [] });
  });

  it('posts into the paired text channel (not the voice channel) when one exists', async () => {
    const TempChannelManager = await loadManager();
    const { supabase } = makeSupa([{ ...HUB, allow_text_channel: true }]);
    const { guild, created } = makeGuild();
    const mgr = new TempChannelManager(guild, supabase);
    await mgr.start();
    await mgr.handleJoinHub(member('u1', 'Alice'), 'hubvc');

    const [vc, tc] = created;
    expect(tc.send).toHaveBeenCalledTimes(1);
    expect(vc.send).not.toHaveBeenCalled();
  });

  it('renders an owner override with {owner-name} and {room-name}', async () => {
    const TempChannelManager = await loadManager();
    const { supabase } = makeSupa([{ ...HUB, room_created_template: 'Welcome {owner-name} to {room-name}' }]);
    const { guild, created } = makeGuild();
    const mgr = new TempChannelManager(guild, supabase);
    await mgr.start();
    await mgr.handleJoinHub(member('u1', 'Alice'), 'hubvc');

    expect(created[0].send.mock.calls[0][0].content).toBe("Welcome Alice to Alice's room");
  });

  it('swallows a send failure without dropping the created room', async () => {
    const TempChannelManager = await loadManager();
    const { supabase, inserts } = makeSupa();
    const cache = new Map<string, any>();
    const create = vi.fn(async (opts: any) => {
      const ch = { id: 'vcX', name: opts.name, type: opts.type, members: new Map(), send: vi.fn(async () => { throw new Error('Missing Permissions'); }) };
      cache.set(ch.id, ch);
      return ch;
    });
    const guild = { id: 'g1', name: 'MyGuild', channels: { cache, create } } as any;
    const mgr = new TempChannelManager(guild, supabase);
    await mgr.start();
    const m = member('u1', 'Alice');
    await expect(mgr.handleJoinHub(m, 'hubvc')).resolves.toBeUndefined();

    expect(inserts.active_temp_channels.length).toBe(1);
    expect(m.voice.setChannel).toHaveBeenCalledTimes(1);
  });
});

// ── Command wiring: control-applied / control-denied ────────

function makeCommandInteraction(opts: {
  userId: string;
  ownerId: string;
  hub: any;
  vc?: any;
  sub?: string;
}) {
  const vcId = 'vc1';
  const vc = opts.vc ?? {
    id: vcId, name: 'Owners room',
    permissionOverwrites: { edit: vi.fn(async () => {}), create: vi.fn(async () => {}), delete: vi.fn(async () => {}) },
    members: new Map(),
    setUserLimit: vi.fn(async () => {}),
    setName: vi.fn(async () => {}),
  };
  const members = new Map<string, any>([
    [opts.userId, { displayName: opts.userId === opts.ownerId ? 'Owner' : 'Rando', voice: { channelId: vcId }, roles: { cache: { has: () => false } } }],
    [opts.ownerId, { displayName: 'Owner', voice: { channelId: vcId }, roles: { cache: { has: () => false } } }],
  ]);
  const channels = new Map<string, any>([[vcId, vc]]);
  const interaction = {
    reply: vi.fn(async () => {}),
    member: { id: opts.userId },
    user: { id: opts.userId, username: opts.userId },
    guild: { id: 'g1', name: 'MyGuild', members: { cache: members }, channels: { cache: channels } },
    options: {
      getSubcommand: () => opts.sub ?? 'lock',
      getInteger: () => 0,
      getString: () => 'x',
      getUser: () => ({ id: 'target1' }),
    },
    replied: false,
    deferred: false,
  } as any;
  const manager = {
    isTempChannel: () => true,
    getChannelOwner: () => opts.ownerId,
    getHubForChannel: () => opts.hub,
    transferOwnership: vi.fn(async () => {}),
  } as any;
  return { interaction, manager, vc };
}

describe('handleTempChannelCommand — control-applied surface', () => {
  it('uses the default (pass-through) template when the hub has no override', async () => {
    const { handleTempChannelCommand } = await import('../features/temp-channels/commands.js');
    const { interaction } = makeCommandInteraction({ userId: 'owner1', ownerId: 'owner1', hub: { ...HUB } });
    await handleTempChannelCommand(interaction, {
      isTempChannel: () => true, getChannelOwner: () => 'owner1', getHubForChannel: () => ({ ...HUB }),
    } as any);
    expect(interaction.reply.mock.calls[0][0].content).toBe('🔒 Voice channel locked.');
  });

  it('wraps the action with an owner-branded control_applied template', async () => {
    const { handleTempChannelCommand } = await import('../features/temp-channels/commands.js');
    const hub = { ...HUB, control_applied_template: '✨ {server} · {action}' };
    const { interaction, manager } = makeCommandInteraction({ userId: 'owner1', ownerId: 'owner1', hub });
    await handleTempChannelCommand(interaction, manager);
    expect(interaction.reply.mock.calls[0][0].content).toBe('✨ MyGuild · 🔒 Voice channel locked.');
  });
});

describe('handleTempChannelCommand — control-denied surface', () => {
  it('uses the default template for a non-owner refusal', async () => {
    const { handleTempChannelCommand } = await import('../features/temp-channels/commands.js');
    const { interaction, manager } = makeCommandInteraction({ userId: 'rando', ownerId: 'owner1', hub: { ...HUB } });
    await handleTempChannelCommand(interaction, manager);
    expect(interaction.reply.mock.calls[0][0].content).toBe('❌ Only the channel owner or moderators can use this command.');
    expect(manager.transferOwnership).not.toHaveBeenCalled();
  });

  it('wraps the reason with an owner-branded control_denied template', async () => {
    const { handleTempChannelCommand } = await import('../features/temp-channels/commands.js');
    const hub = { ...HUB, control_denied_template: '🙅 {reason}' };
    const { interaction, manager } = makeCommandInteraction({ userId: 'rando', ownerId: 'owner1', hub });
    await handleTempChannelCommand(interaction, manager);
    expect(interaction.reply.mock.calls[0][0].content).toBe('🙅 ❌ Only the channel owner or moderators can use this command.');
  });
});
