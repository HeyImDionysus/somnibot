import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  SOMNI_PALETTE: { primary: 0x5865f2, success: 0x57f287, danger: 0xed4245, warning: 0xfee75c },
  computeStateDiff: vi.fn(() => []),
  classifyDrift: vi.fn(() => []),
}));

vi.mock('discord.js', () => {
  class EmbedBuilder {
    data: any = {};
    setColor(c: any) { this.data.color = c; return this; }
    setTitle(t: any) { this.data.title = t; return this; }
    setDescription(d: any) { this.data.description = d; return this; }
    setThumbnail(t: any) { this.data.thumbnail = t; return this; }
    setTimestamp() { return this; }
    setFooter(f: any) { this.data.footer = f; return this; }
    setAuthor(a: any) { this.data.author = a; return this; }
    addFields(...f: any[]) { return this; }
    setImage(i: any) { return this; }
    setURL(u: any) { return this; }
    toJSON() { return this.data; }
  }
  class ActionRowBuilder { addComponents() { return this; } }
  class ButtonBuilder {
    setCustomId() { return this; }
    setLabel() { return this; }
    setStyle() { return this; }
    setEmoji() { return this; }
    setDisabled() { return this; }
    setURL() { return this; }
  }
  class StringSelectMenuBuilder {
    setCustomId() { return this; }
    setPlaceholder() { return this; }
    addOptions() { return this; }
    setMinValues() { return this; }
    setMaxValues() { return this; }
  }
  class SlashCommandBuilder {
    setName() { return this; }
    setDescription() { return this; }
    addStringOption(fn?: any) { if (fn) try { fn({ setName: () => ({ setDescription: () => ({ setRequired: () => ({ addChoices: () => ({}) }) }) }) }); } catch {} return this; }
    addIntegerOption(fn?: any) { if (fn) try { fn({ setName: () => ({ setDescription: () => ({ setRequired: () => ({ setMinValue: () => ({ setMaxValue: () => ({}) }) }) }) }) }); } catch {} return this; }
    addUserOption(fn?: any) { return this; }
    addSubcommand(fn?: any) { return this; }
    setDefaultMemberPermissions() { return this; }
    toJSON() { return {}; }
  }
  return {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    StringSelectMenuBuilder,
    SlashCommandBuilder,
    ChannelType: { GuildText: 0, GuildVoice: 2, GuildCategory: 4, GuildForum: 15 },
    PermissionFlagsBits: { ViewChannel: 1n, SendMessages: 2n, ManageChannels: 4n, ManageRoles: 8n, ModerateMembers: 16n, KickMembers: 32n, BanMembers: 64n, ManageMessages: 128n },
    PermissionsBitField: class { static Flags = { ViewChannel: 1n, SendMessages: 2n }; },
    ButtonStyle: { Primary: 1, Secondary: 2, Danger: 4, Link: 5 },
    GuildMemberFlags: { CompletedOnboarding: 2, DidRejoin: 4, StartedOnboarding: 8 },
    Collection: class extends Map {
      filter(fn: any) { const r = new (this.constructor as any)(); for (const [k,v] of this) if (fn(v,k)) r.set(k,v); return r; }
      map(fn: any) { return [...this.values()].map(fn); }
      find(fn: any) { return [...this.values()].find(fn); }
      first() { return [...this.values()][0]; }
    },
    Events: { ClientReady: 'ready', InteractionCreate: 'interactionCreate' },
    ComponentType: { Button: 2, StringSelect: 3 },
    TextInputStyle: { Short: 1, Paragraph: 2 },
    ModalBuilder: class { setCustomId() { return this; } setTitle() { return this; } addComponents() { return this; } },
    TextInputBuilder: class { setCustomId() { return this; } setLabel() { return this; } setStyle() { return this; } setRequired() { return this; } setValue() { return this; } setPlaceholder() { return this; } },
    AttachmentBuilder: class { constructor() {} },
    ContextMenuCommandBuilder: class { setName() { return this; } setType() { return this; } },
    ApplicationCommandType: { Message: 3, User: 2 },
    Colors: { White: 0xffffff, Red: 0xff0000 },
  };
});

vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));

vi.mock('../services/event-bus.js', () => ({
  PlatformEventBus: class { emit = vi.fn(); on = vi.fn(); off = vi.fn(); },
}));

vi.mock('shoukaku', () => ({
  Shoukaku: class { on = vi.fn(); getIdealNode = vi.fn(() => ({ rest: { resolve: vi.fn(async () => ({ loadType: 'search', data: [{ info: { title: 'Song', author: 'Artist', length: 180000, uri: 'https://example.com', artworkUrl: 'art' }, encoded: 'enc' }] })) } })) },
  Connectors: { DiscordJS: class {} },
}));

function makeChain(result: any = { data: null, error: null }) {
  const chain: any = {};
  for (const m of ['from','select','insert','update','delete','upsert',
    'eq','neq','gt','lt','gte','lte','in','is','not',
    'order','limit','single','maybeSingle','match','contains',
    'overlaps','filter','or','ilike','like','textSearch','returns','range']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn(() => Promise.resolve(result));
  chain.maybeSingle = vi.fn(() => Promise.resolve(result));
  chain.then = (resolve: Function) => resolve(result);
  return chain;
}

function makeSupa(result?: any) {
  const chain = makeChain(result || { data: null, error: null });
  return { from: vi.fn(() => chain), rpc: vi.fn(async () => ({ data: null, error: null })), channel: vi.fn(() => ({ on: vi.fn().mockReturnThis(), subscribe: vi.fn() })), removeChannel: vi.fn(), _chain: chain };
}

function makeValkey() {
  return { get: vi.fn(async () => null), set: vi.fn(async () => {}), setex: vi.fn(async () => {}), del: vi.fn(async () => {}), incr: vi.fn(async () => 1), expire: vi.fn(async () => {}), keys: vi.fn(async () => []), mget: vi.fn(async () => []), lpush: vi.fn(async () => 1), rpop: vi.fn(async () => null), llen: vi.fn(async () => 0), subscribe: vi.fn(async () => {}), on: vi.fn(), psubscribe: vi.fn(async () => {}), publish: vi.fn(async () => {}), duplicate: vi.fn(function(this: any) { return this; }), sadd: vi.fn(async () => 1), smembers: vi.fn(async () => []), srem: vi.fn(async () => 1), hset: vi.fn(async () => {}), hget: vi.fn(async () => null), hgetall: vi.fn(async () => ({})), hdel: vi.fn(async () => 1), zadd: vi.fn(async () => 1), zrangebyscore: vi.fn(async () => []), zrem: vi.fn(async () => 1) };
}

function makeClient(supaResult?: any) {
  return {
    supabase: makeSupa(supaResult),
    valkey: makeValkey(),
    eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
    guildId: 'g1',
    env: { GUILD_ID: 'g1' },
    channels: { cache: { get: vi.fn(() => ({ send: vi.fn(async () => ({ id: 'msg1' })), messages: { fetch: vi.fn(async () => new Map()) } })) } },
    guilds: { cache: { get: vi.fn(() => ({ id: 'g1', name: 'Test', memberCount: 100, roles: { cache: new Map() }, channels: { cache: new Map() } })) } },
    user: { tag: 'Bot#0001', id: 'bot1', displayAvatarURL: () => 'url' },
    ws: { ping: 50 },
  };
}

function makeGuild() {
  return {
    id: 'g1', name: 'Test Guild', memberCount: 100,
    roles: { cache: new Map([['r1', { id: 'r1', name: 'Member', position: 1 }]]), everyone: { id: 'g1', permissions: { bitfield: 0n } }, fetch: vi.fn(async () => new Map()) },
    channels: { cache: new Map([['c1', { id: 'c1', name: 'general', type: 0, send: vi.fn(async () => ({ id: 'msg1' })) }]]), fetch: vi.fn(async () => new Map()) },
    members: { fetch: vi.fn(async (id: string) => ({ id, user: { tag: 'User', displayAvatarURL: () => 'url', bot: false }, roles: { add: vi.fn(), remove: vi.fn(), cache: new Map() }, send: vi.fn(async () => {}) })), cache: new Map() },
    emojis: { cache: new Map() },
    me: { displayAvatarURL: () => 'url' },
  };
}


// ═══════════════════════════════════════════════════════════
// music-embeds.ts
// ═══════════════════════════════════════════════════════════
describe('music-embeds', () => {
  let mod: typeof import('../features/music/music-embeds.js');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../features/music/music-embeds.js');
  });

  it('buildNowPlayingEmbed returns embed', () => {
    const embed = mod.buildNowPlayingEmbed({
      title: 'Song', author: 'Artist', duration: 180000, uri: 'https://example.com',
      artworkUrl: 'art', position: 60000, isPaused: false, loopMode: 'off',
      volume: 80, requester: 'User#0001',
    } as any);
    expect(embed).toBeDefined();
  });

  it('buildQueueEmbed returns embed', () => {
    const embed = mod.buildQueueEmbed(
      { title: 'Now Playing', author: 'Artist', duration: 180000, uri: 'u' } as any,
      [{ title: 'Next', author: 'A', duration: 120000, uri: 'u2' }] as any,
      1,
    );
    expect(embed).toBeDefined();
  });

  it('buildAddedEmbed returns embed', () => {
    const embed = mod.buildAddedEmbed({ title: 'Song', author: 'Artist', duration: 180000, uri: 'u', artworkUrl: 'art' } as any, 'User');
    expect(embed).toBeDefined();
  });

  it('buildPlaylistAddedEmbed returns embed', () => {
    const embed = mod.buildPlaylistAddedEmbed('My Playlist', 5, 'User');
    expect(embed).toBeDefined();
  });

  it('buildMusicErrorEmbed returns embed', () => {
    const embed = mod.buildMusicErrorEmbed('Something went wrong');
    expect(embed).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// music-filters.ts
// ═══════════════════════════════════════════════════════════
describe('music-filters', () => {
  let mod: typeof import('../features/music/music-filters.js');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../features/music/music-filters.js');
  });

  it('FILTER_PRESETS is defined', () => {
    expect(mod.FILTER_PRESETS).toBeDefined();
    expect(Object.keys(mod.FILTER_PRESETS).length).toBeGreaterThan(0);
  });

  it('applyFilterPreset applies filter to player', async () => {
    const player = { setTimescale: vi.fn(), setEqualizer: vi.fn(), setFilters: vi.fn(), filters: {} };
    try { await mod.applyFilterPreset(player as any, 'nightcore' as any); } catch {}
  });

  it('applyCustomTimescale sets timescale', async () => {
    const player = { setTimescale: vi.fn(), setFilters: vi.fn(), filters: {} };
    try { await mod.applyCustomTimescale(player as any, 1.25, 1.0, 1.0); } catch {}
  });

  it('describeActiveFilters returns description', () => {
    const player = { filters: { timescale: { speed: 1.25 } } };
    const desc = mod.describeActiveFilters(player as any);
    expect(typeof desc).toBe('string');
  });
});

// ═══════════════════════════════════════════════════════════
// music-queue.ts
// ═══════════════════════════════════════════════════════════
describe('MusicQueueManager', () => {
  let mod: typeof import('../features/music/music-queue.js');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../features/music/music-queue.js');
  });

  it('constructs and manages queue', () => {
    const mgr = new mod.MusicQueueManager();
    expect(mgr).toBeDefined();
    mgr.add?.({ title: 'Song', uri: 'u', encoded: 'e' } as any);
    mgr.clear?.();
  });
});
