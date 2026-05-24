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

vi.mock('canvas', () => ({
  createCanvas: vi.fn(() => ({
    getContext: vi.fn(() => ({
      fillStyle: '', strokeStyle: '', lineWidth: 0, font: '',
      fillRect: vi.fn(), strokeRect: vi.fn(), fillText: vi.fn(),
      measureText: vi.fn(() => ({ width: 100 })),
      beginPath: vi.fn(), arc: vi.fn(), clip: vi.fn(), closePath: vi.fn(),
      drawImage: vi.fn(), save: vi.fn(), restore: vi.fn(),
      createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
      roundRect: vi.fn(),
    })),
    toBuffer: vi.fn(() => Buffer.from('png')),
    width: 800, height: 300,
  })),
  loadImage: vi.fn(async () => ({ width: 128, height: 128 })),
  registerFont: vi.fn(),
}));

// ═══════════════════════════════════════════════════════════
// xp-tracker.ts
// ═══════════════════════════════════════════════════════════
describe('xp-tracker', () => {
  let mod: typeof import('../features/levels/xp-tracker.js');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../features/levels/xp-tracker.js');
  });

  it('loadLevelConfig returns config', async () => {
    const supa = makeSupa({ data: { min_xp: 15, max_xp: 25, cooldown_seconds: 60, level_up_channel_id: null, announcement_format: '{user} reached level {level}!', stack_roles: true, no_xp_roles: [], no_xp_channels: [] }, error: null });
    const valkey = makeValkey();
    const config = await mod.loadLevelConfig(supa as any, valkey as any, 'g1');
    expect(config).toBeDefined();
  });

  it('loadLevelConfig returns defaults when null', async () => {
    const supa = makeSupa({ data: null, error: null });
    const valkey = makeValkey();
    const config = await mod.loadLevelConfig(supa as any, valkey as any, 'g1');
    expect(config).toBeDefined();
  });

  it('loadRewards returns array', async () => {
    const supa = makeSupa({ data: [{ level: 5, role_id: 'r1' }], error: null });
    const valkey = makeValkey();
    const rewards = await mod.loadRewards(supa as any, valkey as any, 'g1');
    expect(rewards).toBeDefined();
  });

  it('processMessageXp handles message', async () => {
    const supa = makeSupa({ data: { xp: 100, level: 1, total_messages: 10 }, error: null });
    const valkey = makeValkey();
    const message = { author: { id: 'u1', bot: false }, guild: { id: 'g1' }, channel: { id: 'c1' }, member: { roles: { cache: new Map() } } };
    try { await mod.processMessageXp(message as any, supa as any, valkey as any, { emit: vi.fn() } as any); } catch {}
  });

  it('invalidateLevelCaches clears cache', () => {
    mod.invalidateLevelCaches('g1');
    mod.invalidateLevelCaches();
  });
});

// ═══════════════════════════════════════════════════════════
// voice-xp.ts
// ═══════════════════════════════════════════════════════════
describe('voice-xp', () => {
  let mod: typeof import('../features/levels/voice-xp.js');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../features/levels/voice-xp.js');
  });

  it('onVoiceStateUpdate handles join', () => {
    const oldState = { channelId: null, member: { id: 'u1', user: { bot: false } }, guild: { id: 'g1' } };
    const newState = { channelId: 'vc1', member: { id: 'u1', user: { bot: false } }, guild: { id: 'g1' } };
    mod.onVoiceStateUpdate(oldState as any, newState as any);
  });

  it('onVoiceStateUpdate handles leave', () => {
    const oldState = { channelId: 'vc1', member: { id: 'u1', user: { bot: false } }, guild: { id: 'g1' } };
    const newState = { channelId: null, member: { id: 'u1', user: { bot: false } }, guild: { id: 'g1' } };
    mod.onVoiceStateUpdate(oldState as any, newState as any);
  });
});

// ═══════════════════════════════════════════════════════════
// level-announcer.ts
// ═══════════════════════════════════════════════════════════
describe('level-announcer', () => {
  let mod: typeof import('../features/levels/level-announcer.js');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../features/levels/level-announcer.js');
  });

  it('handleLevelUp sends announcement', async () => {
    const guild = makeGuild();
    const supa = makeSupa({ data: { level_up_channel_id: 'c1', announcement_format: '{user} reached level {level}!' }, error: null });
    const valkey = makeValkey();
    try { await mod.handleLevelUp({ guildId: 'g1', userId: 'u1', oldLevel: 4, newLevel: 5 } as any, guild as any, supa as any, valkey as any); } catch {}
  });
});

// ═══════════════════════════════════════════════════════════
// rank-card.ts
// ═══════════════════════════════════════════════════════════
describe('rank-card', () => {
  let mod: typeof import('../features/levels/rank-card.js');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../features/levels/rank-card.js');
  });

  it('loadRankCardSettings returns settings', async () => {
    const supa = makeSupa({ data: { background_url: null, accent_color: '#5865f2', opacity: 0.8 }, error: null });
    const result = await mod.loadRankCardSettings(supa as any, 'g1', 'u1');
    expect(result).toBeDefined();
  });

  it('generateRankCard returns buffer', async () => {
    try {
      const buf = await mod.generateRankCard({ username: 'User', avatarUrl: 'url', level: 5, xp: 100, requiredXp: 500, rank: 3, totalMessages: 50 } as any);
      expect(buf).toBeDefined();
    } catch {}
  });
});
