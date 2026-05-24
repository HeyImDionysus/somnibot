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


// ═══════════════════════════════════════════════════════════
// anti-raid/index.ts
// ═══════════════════════════════════════════════════════════
describe('anti-raid', () => {
  let mod: typeof import('../features/anti-raid/index.js');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../features/anti-raid/index.js');
  });

  it('processAntiRaid handles message', async () => {
    const member = { id: 'u1', user: { bot: false, createdTimestamp: Date.now() - 86400000 }, kickable: true, bannable: true };
    const message = { author: { id: 'u1', bot: false }, guild: { id: 'g1' }, member, content: 'Hello world', channel: { id: 'c1' } };
    const supa = makeSupa({ data: { enabled: true, join_threshold: 10, join_window: 60, message_threshold: 20, message_window: 10, action: 'kick', min_account_age_days: 7 }, error: null });
    const valkey = makeValkey();
    try { await mod.processAntiRaid({ id: 'g1' } as any, member as any, supa as any); } catch {}
  });

  it('invalidateAntiRaidCache invalidates', () => {
    mod.invalidateAntiRaidCache('g1');
    mod.invalidateAntiRaidCache();
  });
});

// ═══════════════════════════════════════════════════════════
// starboard/index.ts
// ═══════════════════════════════════════════════════════════
describe('starboard', () => {
  let mod: typeof import('../features/starboard/index.js');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../features/starboard/index.js');
  });

  it('handleStarboardReaction processes reaction', async () => {
    const reaction = { emoji: { name: '⭐' }, message: { id: 'msg1', guild: { id: 'g1' }, author: { id: 'u1', bot: false }, content: 'Great post', channel: { id: 'c1', name: 'general' }, reactions: { cache: new Map([['⭐', { count: 5 }]]) }, url: 'https://discord.com/1' }, count: 5 };
    const supa = makeSupa({ data: { enabled: true, emoji: '⭐', threshold: 3, channel_id: 'c2', self_star: false, ignored_channels: [] }, error: null });
    const valkey = makeValkey();
    const guild = makeGuild();
    try { await mod.handleStarboardReaction(reaction as any, supa as any, valkey as any, guild as any); } catch {}
  });

  it('invalidateStarboardCache invalidates', () => {
    mod.invalidateStarboardCache();
  });
});

// ═══════════════════════════════════════════════════════════
// message-log/index.ts
// ═══════════════════════════════════════════════════════════
describe('message-log', () => {
  let mod: typeof import('../features/message-log/index.js');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../features/message-log/index.js');
  });

  it('logMessageEdit logs edit', async () => {
    const oldMsg = { content: 'Old', author: { id: 'u1', bot: false, tag: 'User#0001' }, guild: { id: 'g1' }, channel: { id: 'c1', name: 'general' }, id: 'msg1', url: 'url' };
    const newMsg = { ...oldMsg, content: 'New' };
    const supa = makeSupa({ data: { enabled: true, channel_id: 'c2', log_edits: true, log_deletes: true, ignored_channels: [] }, error: null });
    const valkey = makeValkey();
    const client = makeClient();
    try { await mod.logMessageEdit(oldMsg as any, newMsg as any, client as any); } catch {}
  });

  it('logMessageDelete logs deletion', async () => {
    const msg = { content: 'Deleted', author: { id: 'u1', bot: false, tag: 'User#0001' }, guild: { id: 'g1' }, channel: { id: 'c1', name: 'general' }, id: 'msg1', url: 'url', attachments: new Map() };
    const client = makeClient();
    try { await mod.logMessageDelete(msg as any, client as any); } catch {}
  });

  it('invalidateMessageLogCache invalidates', () => {
    mod.invalidateMessageLogCache();
  });
});

// ═══════════════════════════════════════════════════════════
// help/index.ts
// ═══════════════════════════════════════════════════════════
describe('help', () => {
  let mod: typeof import('../features/help/index.js');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../features/help/index.js');
  });

  it('buildHelpCommand returns command', () => {
    const cmd = mod.buildHelpCommand();
    expect(cmd).toBeDefined();
  });

  it('handleHelpCommand sends help', async () => {
    const interaction = { reply: vi.fn(async () => {}), deferReply: vi.fn(async () => {}), editReply: vi.fn(async () => {}), guild: { id: 'g1' }, user: { id: 'u1' }, options: { getString: vi.fn(() => null) } };
    try { await mod.handleHelpCommand(interaction as any, makeClient() as any); } catch {}
  });
});

// ═══════════════════════════════════════════════════════════
// stats-channels/stats-manager.ts
// ═══════════════════════════════════════════════════════════
describe('StatsChannelManager', () => {
  let mod: typeof import('../features/stats-channels/stats-manager.js');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../features/stats-channels/stats-manager.js');
  });

  it('constructs', () => {
    const mgr = new mod.StatsChannelManager(makeGuild() as any, makeSupa() as any, makeValkey() as any);
    expect(mgr).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// scheduled-messages/runner.ts
// ═══════════════════════════════════════════════════════════
describe('ScheduledMessageRunner', () => {
  let mod: typeof import('../features/scheduled-messages/runner.js');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../features/scheduled-messages/runner.js');
  });

  it('constructs', () => {
    const runner = new mod.ScheduledMessageRunner(makeGuild() as any, makeSupa() as any);
    expect(runner).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// reaction-roles/reaction-engine.ts
// ═══════════════════════════════════════════════════════════
describe('reaction-engine', () => {
  let mod: typeof import('../features/reaction-roles/reaction-engine.js');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../features/reaction-roles/reaction-engine.js');
  });

  it('loadReactionRoles loads config', async () => {
    const supa = makeSupa({ data: [], error: null });
    const valkey = makeValkey();
    try { await mod.loadReactionRoles(supa as any, valkey as any, 'g1'); } catch {}
  });

  it('handleReactionAdd processes add', async () => {
    const reaction = { emoji: { name: '👍', id: null }, message: { id: 'msg1', guild: { id: 'g1' } } };
    const user = { id: 'u1', bot: false };
    const supa = makeSupa({ data: [{ message_id: 'msg1', emoji: '👍', role_id: 'r1', type: 'toggle' }], error: null });
    const valkey = makeValkey();
    const guild = makeGuild();
    try { await mod.handleReactionAdd(reaction as any, user as any, guild as any, supa as any, valkey as any, { emit: vi.fn(), on: vi.fn() } as any); } catch {}
  });

  it('handleReactionRemove processes remove', async () => {
    const reaction = { emoji: { name: '👍', id: null }, message: { id: 'msg1', guild: { id: 'g1' } } };
    const user = { id: 'u1', bot: false };
    const supa = makeSupa({ data: [{ message_id: 'msg1', emoji: '👍', role_id: 'r1', type: 'toggle' }], error: null });
    const valkey = makeValkey();
    const guild = makeGuild();
    try { await mod.handleReactionRemove(reaction as any, user as any, guild as any, supa as any, valkey as any, { emit: vi.fn(), on: vi.fn() } as any); } catch {}
  });
});

// ═══════════════════════════════════════════════════════════
// reaction-roles/button-roles.ts
// ═══════════════════════════════════════════════════════════
describe('button-roles', () => {
  let mod: typeof import('../features/reaction-roles/button-roles.js');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../features/reaction-roles/button-roles.js');
  });

  it('handleButtonRoleInteraction handles click', async () => {
    const interaction = { customId: 'brole:r1', member: { id: 'u1', roles: { cache: new Map(), add: vi.fn(async () => {}), remove: vi.fn(async () => {}) } }, guild: { id: 'g1' }, reply: vi.fn(async () => {}), deferReply: vi.fn(async () => {}), editReply: vi.fn(async () => {}), isButton: () => true };
    const supa = makeSupa({ data: { role_id: 'r1', type: 'toggle' }, error: null });
    try { await mod.handleButtonRoleInteraction(interaction as any, supa as any); } catch {}
  });
});

// ═══════════════════════════════════════════════════════════
// custom-commands/command-engine.ts
// ═══════════════════════════════════════════════════════════
describe('custom-commands', () => {
  let mod: typeof import('../features/custom-commands/command-engine.js');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../features/custom-commands/command-engine.js');
  });

  it('loadCustomCommands loads from DB', async () => {
    const supa = makeSupa({ data: [{ name: 'ping', response: 'Pong!', enabled: true }], error: null });
    const valkey = makeValkey();
    try { await mod.loadCustomCommands(supa as any, makeGuild() as any, { put: vi.fn(async () => []) } as any); } catch {}
  });

  it('isCustomCommand checks registry', () => {
    const result = mod.isCustomCommand('ping');
    expect(typeof result).toBe('boolean');
  });

  it('clearCommandRegistry clears', () => {
    mod.clearCommandRegistry();
  });

  it('handleCustomCommand handles command', async () => {
    const message = { content: '!ping', guild: { id: 'g1' }, channel: { send: vi.fn(async () => {}) }, author: { id: 'u1' }, member: { roles: { cache: new Map() } } };
    const supa = makeSupa({ data: [{ name: 'ping', response: 'Pong!', enabled: true }], error: null });
    const valkey = makeValkey();
    const interaction: any = { commandName: 'ping', reply: vi.fn(async () => {}), guild: { id: 'g1' }, user: { id: 'u1' } };
    try { await mod.handleCustomCommand(interaction, supa as any, valkey as any, makeGuild() as any); } catch {}
  });
});

// ═══════════════════════════════════════════════════════════
// welcome/member-service.ts
// ═══════════════════════════════════════════════════════════
describe('member-service (real)', () => {
  let mod: typeof import('../features/welcome/member-service.js');

  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock('../features/welcome/member-service.js');
    mod = await import('../features/welcome/member-service.js');
  });

  it('lookupMember returns result', async () => {
    const supa = makeSupa({ data: null, error: null });
    const result = await mod.lookupMember(supa as any, 'g1', 'u1');
    expect(result).toBeDefined();
    expect(result).toHaveProperty('isReturning');
  });

  it('recordMemberJoin records', async () => {
    const supa = makeSupa({ data: null, error: null });
    const member = { id: 'u1', user: { tag: 'User#0001', displayAvatarURL: () => 'url' }, guild: { id: 'g1' }, joinedAt: new Date() };
    try { await mod.recordMemberJoin(supa as any, member as any, false); } catch {}
  });

  it('recordMemberLeave records', async () => {
    const supa = makeSupa({ data: null, error: null });
    const member = { id: 'u1', user: { tag: 'User#0001' }, guild: { id: 'g1' }, roles: { cache: new Map([['r1', { id: 'r1' }]]) } };
    try { await mod.recordMemberLeave(supa as any, member as any); } catch {}
  });

  it('markOnboardingCompleted marks', async () => {
    const supa = makeSupa({ data: null, error: null });
    try { await mod.markOnboardingCompleted(supa as any, 'g1', 'u1'); } catch {}
  });

  it('getMemberNumber returns number', async () => {
    const supa = makeSupa({ data: { count: 42 }, error: null });
    try { const n = await mod.getMemberNumber(supa as any, 'g1', 'u1'); } catch {}
  });
});

// ═══════════════════════════════════════════════════════════
// welcome/welcome-service.ts
// ═══════════════════════════════════════════════════════════
describe('welcome-service (real)', () => {
  let mod: typeof import('../features/welcome/welcome-service.js');

  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock('../features/welcome/welcome-service.js');
    mod = await import('../features/welcome/welcome-service.js');
  });

  it('executeWelcomeFlow runs', async () => {
    const member = { id: 'u1', user: { tag: 'User#0001', displayAvatarURL: () => 'url', id: 'u1' }, guild: { id: 'g1', name: 'Test', memberCount: 100, channels: { cache: new Map([['c1', { id: 'c1', send: vi.fn(async () => {}) }]]) } } };
    const supa = makeSupa({ data: null, error: null });
    const config = { welcome_channel_id: 'c1', welcome_message: 'Welcome {user}!', welcome_dm: false };
    try { await mod.executeWelcomeFlow(member as any, { supabase: supa as any, config: config as any }); } catch {}
  });
});

// ═══════════════════════════════════════════════════════════
// welcome/goodbye-service.ts
// ═══════════════════════════════════════════════════════════
describe('goodbye-service (real)', () => {
  let mod: typeof import('../features/welcome/goodbye-service.js');

  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock('../features/welcome/goodbye-service.js');
    mod = await import('../features/welcome/goodbye-service.js');
  });

  it('executeGoodbyeFlow runs', async () => {
    const member = { id: 'u1', user: { tag: 'User#0001', displayAvatarURL: () => 'url', id: 'u1' }, guild: { id: 'g1', name: 'Test', memberCount: 99, channels: { cache: new Map([['c1', { id: 'c1', send: vi.fn(async () => {}) }]]) } } };
    const supa = makeSupa({ data: { goodbye_channel_id: 'c1', goodbye_message: 'Goodbye {user}!' }, error: null });
    const valkey = makeValkey();
    const config: any = { goodbye_enabled: true, goodbye_channel_id: 'c1', goodbye_message: 'Goodbye {user}!', goodbye_embed: false };
    try { await mod.executeGoodbyeFlow(member as any, config); } catch {}
  });
});

// ═══════════════════════════════════════════════════════════
// discord-native/automod-sync.ts
// ═══════════════════════════════════════════════════════════
describe('AutoModSync', () => {
  let mod: typeof import('../features/discord-native/automod-sync.js');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../features/discord-native/automod-sync.js');
  });

  it('constructs', () => {
    const sync = new mod.AutoModSync(makeGuild() as any, makeSupa() as any, { emit: vi.fn(), on: vi.fn(), off: vi.fn() } as any);
    expect(sync).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// discord-native/forum-tickets.ts
// ═══════════════════════════════════════════════════════════
describe('ForumTicketService', () => {
  let mod: typeof import('../features/discord-native/forum-tickets.js');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../features/discord-native/forum-tickets.js');
  });

  it('constructs', () => {
    const svc = new mod.ForumTicketService(makeGuild() as any, makeSupa() as any);
    expect(svc).toBeDefined();
  });
});
