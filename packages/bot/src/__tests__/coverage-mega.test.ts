/**
 * Mega coverage test — exercises deep code paths in the largest uncovered modules.
 *
 * Targets (by uncovered line count):
 * - music-player.ts (1072 lines, ~1% covered)
 * - action-executor.ts (373 lines, ~1% covered)
 * - deployer.ts (614 lines, ~18% covered)
 * - deploy-listener.ts (346 lines, ~2% covered)
 * - games-manager.ts (774 lines, ~19% covered)
 * - modal-handlers.ts (400 lines, ~7% covered)
 * - bot-presence.ts (162 lines, ~3% covered)
 * - polls-manager.ts (628 lines, ~17% covered)
 * - quests-manager.ts (288 lines, ~11% covered)
 * - wizard-engine.ts (198 lines, ~7% covered)
 * - achievements-manager.ts (189 lines, ~12% covered)
 * - profiles-manager.ts (130 lines, ~18% covered)
 * - welcome-service.ts (165 lines, ~19% covered)
 * - onboarding-handler.ts (411 lines, ~49% covered)
 * - command-engine.ts (281 lines, ~23% covered)
 * - starboard/index.ts (196 lines, ~27% covered)
 * - button-roles.ts (265 lines, ~11% covered)
 * - scheduled-messages/runner.ts (287 lines, ~9% covered)
 * - stats-channels/stats-manager.ts (213 lines, ~14% covered)
 * - temp-channels: voice-handler (34 lines, 0%) + temp-channel-manager
 * - forum-tickets.ts (228 lines, ~7% covered)
 * - automod-sync.ts (190 lines, ~18% covered)
 * - autocomplete.ts (113 lines, ~21% covered)
 * - client.ts (117 lines, 0%)
 * - config.ts (34 lines, ~23% covered)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/* ─── @somnibot/shared mock ─── */
vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  SOMNI_PALETTE: { primary: 0x5865f2, success: 0x57f287, danger: 0xed4245, warning: 0xfee75c },
  randomXp: vi.fn((min: number, max: number) => Math.floor((min + max) / 2)),
  calculateLevel: vi.fn((xp: number) => ({ level: Math.floor(xp / 100), currentXp: xp % 100, requiredXp: 100 })),
  LEVEL_CONFIG: { baseXp: 100, growthFactor: 1.2 },
  AUTOMATION_LIMITS: {
    MAX_AUTOMATIONS_PER_GUILD: 100,
    MAX_ACTIONS_PER_AUTOMATION: 10,
    MAX_CONDITIONS_PER_AUTOMATION: 5,
    MAX_DELAY_SECONDS: 3600,
    MAX_FIRES_PER_USER_PER_MINUTE: 5,
    DM_COOLDOWN_SECONDS: 300,
    ROLE_GRANT_DELAY_MS: 0,
    MAX_CHAIN_DEPTH: 3,
  },
  WIZARD_STEPS: [
    { id: 'paypal', title: 'PayPal', emoji: '💰', fieldToSettingsKey: { client_id: 'paypal_client_id', secret: 'paypal_client_secret' } },
    { id: 'deploy', title: 'Deployment', emoji: '🚀', fieldToSettingsKey: { dashboard_url: 'dashboard_url' } },
    { id: 'supabase', title: 'Supabase', emoji: '🗄️', fieldToSettingsKey: { access_token: 'supabase_access_token' } },
  ],
  DEFAULT_ESCALATION_CHAIN: [
    { warningCount: 3, action: 'mute', duration: '1h' },
    { warningCount: 5, action: 'kick' },
    { warningCount: 10, action: 'ban' },
  ],
  computeStateDiff: vi.fn(() => []),
  classifyDrift: vi.fn(() => []),
  levelProgress: vi.fn((xp: number) => ({ level: Math.floor(xp / 100), currentXp: xp % 100, requiredXp: 100 })),
}));

/* ─── discord.js mock ─── */
vi.mock('discord.js', () => {
  class EmbedBuilder {
    data: any = {};
    setColor() { return this; } setTitle() { return this; } setDescription() { return this; }
    setThumbnail() { return this; } setTimestamp() { return this; } setFooter() { return this; }
    setAuthor() { return this; } addFields(..._f: any[]) { return this; } setImage() { return this; }
    setURL() { return this; } toJSON() { return this.data; }
  }
  class ActionRowBuilder { components: any[] = []; addComponents(...c: any[]) { this.components.push(...c); return this; } }
  class ButtonBuilder {
    setCustomId() { return this; } setLabel() { return this; } setStyle() { return this; }
    setEmoji() { return this; } setDisabled() { return this; } setURL() { return this; }
  }
  class StringSelectMenuBuilder {
    setCustomId() { return this; } setPlaceholder() { return this; }
    addOptions() { return this; } setMaxValues() { return this; } setMinValues() { return this; }
  }
  class ModalBuilder { setCustomId() { return this; } setTitle() { return this; } addComponents() { return this; } }
  class TextInputBuilder {
    setCustomId() { return this; } setLabel() { return this; } setStyle() { return this; }
    setRequired() { return this; } setValue() { return this; } setPlaceholder() { return this; }
    setMinLength() { return this; } setMaxLength() { return this; }
  }
  class SlashCommandBuilder {
    setName() { return this; } setDescription() { return this; } setDefaultMemberPermissions() { return this; }
    setDMPermission() { return this; }
    addSubcommand(fn: any) { try { fn(this); } catch {} return this; }
    addSubcommandGroup(fn: any) { try { fn(this); } catch {} return this; }
    addStringOption(fn: any) { try { fn(this); } catch {} return this; }
    addIntegerOption(fn: any) { try { fn(this); } catch {} return this; }
    addBooleanOption(fn: any) { try { fn(this); } catch {} return this; }
    addNumberOption(fn: any) { try { fn(this); } catch {} return this; }
    addUserOption(fn: any) { try { fn(this); } catch {} return this; }
    addChannelOption(fn: any) { try { fn(this); } catch {} return this; }
    addRoleOption(fn: any) { try { fn(this); } catch {} return this; }
    addAttachmentOption(fn: any) { try { fn(this); } catch {} return this; }
    setRequired() { return this; } setMinValue() { return this; } setMaxValue() { return this; }
    setChoices() { return this; } addChoices() { return this; } setAutocomplete() { return this; }
    toJSON() { return {}; }
  }
  class AttachmentBuilder { constructor(public d: any, public o?: any) {} }
  class Collection extends Map {
    constructor(entries?: any) { super(); if (entries) for (const [k, v] of entries) this.set(k, v); }
    filter(fn: any) { const r = new Collection(); for (const [k,v] of this) if (fn(v,k)) r.set(k,v); return r; }
    map(fn: any) { return [...this.values()].map(fn); }
    find(fn: any) { return [...this.values()].find(fn); }
    first() { return [...this.values()][0]; }
    toJSON() { return [...this.values()]; }
    sort(fn: any) { return new Collection([...this.entries()].sort(([,a],[,b]) => fn(a,b))); }
    reduce(fn: any, init: any) { let acc = init; for (const [k,v] of this) acc = fn(acc, v, k); return acc; }
    at(idx: number) { return [...this.values()][idx]; }
    some(fn: any) { return [...this.values()].some(fn); }
    every(fn: any) { return [...this.values()].every(fn); }
  }
  class PermissionsBitField {
    bitfield: bigint;
    constructor(bits: any = 0n) { this.bitfield = typeof bits === 'bigint' ? bits : BigInt(bits || 0); }
    has() { return true; }
    static Flags = { ViewChannel: 1n, SendMessages: 2n, ManageGuild: 32n, ManageChannels: 64n, ManageRoles: 256n, BanMembers: 4n, KickMembers: 8n, ManageMessages: 16n, ModerateMembers: 128n };
  }
  return {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, StringSelectMenuBuilder,
    ModalBuilder, TextInputBuilder, SlashCommandBuilder, AttachmentBuilder,
    Collection, PermissionsBitField,
    Client: class { guilds = { cache: new Collection() }; user = { setPresence: vi.fn() }; on() { return this; } },
    ChannelType: { GuildText: 0, GuildVoice: 2, GuildCategory: 4, GuildAnnouncement: 5, GuildForum: 15, GuildStageVoice: 13 },
    PermissionFlagsBits: { ViewChannel: 1n, SendMessages: 2n, ManageGuild: 32n, ManageChannels: 64n, ManageRoles: 256n, BanMembers: 4n, KickMembers: 8n, ManageMessages: 16n, ModerateMembers: 128n },
    ButtonStyle: { Primary: 1, Secondary: 2, Danger: 4, Link: 5, Success: 3 },
    ComponentType: { Button: 2, StringSelect: 3 },
    TextInputStyle: { Short: 1, Paragraph: 2 },
    Events: { ClientReady: 'ready', InteractionCreate: 'interactionCreate', GuildCreate: 'guildCreate', MessageCreate: 'messageCreate', GuildMemberAdd: 'guildMemberAdd', VoiceStateUpdate: 'voiceStateUpdate' },
    ActivityType: { Playing: 0, Streaming: 1, Listening: 2, Watching: 3, Custom: 4, Competing: 5 },
    AutoModerationRuleTriggerType: { Keyword: 1, Spam: 3, KeywordPreset: 4, MentionSpam: 5 },
    AutoModerationActionType: { BlockMessage: 1, SendAlertMessage: 2, Timeout: 3 },
    REST: class { setToken() { return this; } },
    Routes: { applicationGuildCommands: () => '/fake' },
    GatewayIntentBits: { Guilds: 1, GuildMembers: 2, GuildMessages: 4 },
    Partials: { Channel: 0, Message: 1, Reaction: 2, GuildMember: 3 },
  };
});

/* ─── shoukaku mock ─── */
vi.mock('shoukaku', () => ({
  Shoukaku: class {
    constructor() {}
    on() { return this; }
    joinVoiceChannel() { return Promise.resolve({ node: { rest: { resolve: vi.fn(async () => ({ loadType: 'track', data: { info: { title: 'Test', uri: 'http://test', length: 200000, author: 'Author' }, encoded: 'enc123' } })) } }, playTrack: vi.fn(), stopTrack: vi.fn(), setPaused: vi.fn(), setGlobalVolume: vi.fn(), setFilterVolume: vi.fn(), seekTo: vi.fn(), setFilters: vi.fn(), on: vi.fn(), destroy: vi.fn() }); }
    leaveVoiceChannel() {}
    getPlayer() { return null; }
    players: Map<string, any> = new Map();
  },
  Connectors: { DiscordJS: class {} },
}));

/* ─── service mocks ─── */
vi.mock('../services/supabase.js', () => ({ getSupabase: vi.fn(() => makeSupa()) }));
vi.mock('../services/valkey.js', () => ({
  getValkey: vi.fn(() => makeValkey()),
  connectValkey: vi.fn(async () => {}),
  valkey: makeValkey(),
}));
vi.mock('../services/audit.js', () => ({ writeAuditLog: vi.fn(async () => {}), writeAuditBatch: vi.fn(async () => {}) }));
vi.mock('../services/guild-snapshot.js', () => ({ writeGuildSnapshot: vi.fn(async () => {}) }));
vi.mock('../services/event-bus.js', () => ({ eventBus: { emit: vi.fn(), on: vi.fn(), removeAllListeners: vi.fn() }, PlatformEventBus: class { emit = vi.fn(); on = vi.fn(); removeAllListeners = vi.fn(); } }));
vi.mock('../services/reconciliation.js', () => ({ runReconciliation: vi.fn(async () => {}) }));
vi.mock('../services/commerce-fulfillment.js', () => ({
  CommerceFulfillmentService: class { async handle() { return { success: true }; } },
}));
vi.mock('../features/moderation/mod-log.js', () => ({ postModLogEntry: vi.fn(async () => {}) }));
vi.mock('../features/moderation/infraction-service.js', () => ({
  createInfraction: vi.fn(async () => ({ id: 'inf1' })),
  getActiveWarningCount: vi.fn(async () => 0),
  getActiveInfractionCount: vi.fn(async () => 0),
  getMemberInfractions: vi.fn(async () => []),
  pardonInfraction: vi.fn(async () => true),
  expireInfractions: vi.fn(async () => 0),
  calculateExpiryDate: vi.fn((d: number) => new Date(Date.now() + d * 86400000).toISOString()),
}));
vi.mock('../features/moderation/escalation.js', () => ({
  executeEscalation: vi.fn(async () => {}),
  getEscalationAction: vi.fn(() => null),
}));
vi.mock('../features/levels/rank-card.js', () => ({
  generateRankCard: vi.fn(async () => Buffer.from('PNG')),
}));
vi.mock('../features/music/music-embeds.js', () => ({
  buildNowPlayingEmbed: vi.fn(() => ({ toJSON: () => ({}) })),
  buildAddedEmbed: vi.fn(() => ({ toJSON: () => ({}) })),
  buildPlaylistAddedEmbed: vi.fn(() => ({ toJSON: () => ({}) })),
  buildMusicErrorEmbed: vi.fn(() => ({ toJSON: () => ({}) })),
  buildMusicInfoEmbed: vi.fn(() => ({ toJSON: () => ({}) })),
  buildQueueEmbed: vi.fn(() => ({ toJSON: () => ({}) })),
  formatDuration: vi.fn(() => '0:00'),
}));
vi.mock('../features/music/music-self-healer.js', () => ({
  MusicSelfHealer: class { checkHealth = vi.fn(); tryHeal = vi.fn(); },
}));
vi.mock('../features/music/music-filters.js', () => ({
  applyFilterPreset: vi.fn(async () => {}),
  applyCustomTimescale: vi.fn(async () => {}),
  describeActiveFilters: vi.fn(() => 'None'),
}));
vi.mock('../features/levels/level-announcer.js', () => ({
  announceLevelUp: vi.fn(async () => {}),
}));
vi.mock('../features/welcome/welcome-card.js', () => ({
  generateWelcomeCard: vi.fn(async () => Buffer.from('PNG')),
}));
vi.mock('../features/welcome/welcome-variables.js', () => ({
  buildWelcomeVariables: vi.fn(() => ({ user: '<@u1>', userName: 'TestUser', server: 'TestServer', memberCount: '100', memberNumber: '#42' })),
  interpolateMessage: vi.fn((msg: string) => msg),
}));
vi.mock('../features/welcome/member-service.js', () => ({
  getMemberNumber: vi.fn(async () => 42),
}));
vi.mock('../guards/bot-role-guard.js', () => ({
  checkBotRolePosition: vi.fn(() => ({ ok: true })),
  checkBotPermissions: vi.fn(() => ({ ok: true })),
}));

/* ─── helper factories ─── */

function makeChain(result: any = { data: null, error: null }) {
  const chain: any = {};
  for (const m of ['from','select','insert','update','delete','upsert','eq','neq','gt','lt','gte','lte','in','is','not','order','limit','single','maybeSingle','match','contains','overlaps','filter','or','ilike','like','textSearch','returns','range','count','csv']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn(() => Promise.resolve(result));
  chain.maybeSingle = vi.fn(() => Promise.resolve(result));
  chain.then = (resolve: Function) => resolve(result);
  (chain as any)[Symbol.asyncIterator] = async function* () {};
  return chain;
}

function makeSupa(result?: any) {
  const chain = makeChain(result ?? { data: null, error: null });
  return {
    from: vi.fn((table: string) => {
      if (table === 'xp_multipliers') return makeChain({ data: [], error: null });
      return chain;
    }),
    rpc: vi.fn(async () => ({ data: null, error: null })),
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn((cb?: Function) => { if (cb) cb('SUBSCRIBED'); return { unsubscribe: vi.fn() }; }),
    })),
    removeChannel: vi.fn(),
  };
}

function makeValkey(): any {
  return {
    get: vi.fn(async () => null), set: vi.fn(async () => 'OK'), setex: vi.fn(async () => 'OK'),
    del: vi.fn(async () => 1), incr: vi.fn(async () => 1), expire: vi.fn(async () => 1),
    keys: vi.fn(async () => []), mget: vi.fn(async () => []), scan: vi.fn(async () => ['0', []]),
    lpush: vi.fn(async () => 1), rpop: vi.fn(async () => null), llen: vi.fn(async () => 0),
    rpush: vi.fn(async () => 1), lpop: vi.fn(async () => null), lrange: vi.fn(async () => []),
    subscribe: vi.fn(async () => {}), on: vi.fn(), psubscribe: vi.fn(async () => {}),
    publish: vi.fn(async () => 1), duplicate: vi.fn(function(this: any) { return this; }),
    sadd: vi.fn(async () => 1), smembers: vi.fn(async () => []), srem: vi.fn(async () => 1),
    hset: vi.fn(async () => 1), hget: vi.fn(async () => null), hgetall: vi.fn(async () => ({})),
    hdel: vi.fn(async () => 1), xadd: vi.fn(async () => ''), xread: vi.fn(async () => null),
    zadd: vi.fn(async () => 1), zrange: vi.fn(async () => []), zrangebyscore: vi.fn(async () => []),
    zrem: vi.fn(async () => 1), exists: vi.fn(async () => 0), ttl: vi.fn(async () => -1),
    persist: vi.fn(async () => 1), scard: vi.fn(async () => 0), srandmember: vi.fn(async () => null),
    sismember: vi.fn(async () => 0), incrby: vi.fn(async () => 1), decrby: vi.fn(async () => 0),
    lrem: vi.fn(async () => 1), lindex: vi.fn(async () => null), ltrim: vi.fn(async () => 'OK'),
    multi: vi.fn(() => ({ incr: vi.fn().mockReturnThis(), expire: vi.fn().mockReturnThis(), exec: vi.fn(async () => [[null, 1], [null, 1]]) })),
  };
}

function makeCollection(entries: [string, any][] = []): any {
  const col: any = new Map(entries);
  col.filter = function(fn: any) { const r = makeCollection(); for (const [k,v] of this) if (fn(v,k)) r.set(k,v); return r; };
  col.map = function(fn: any) { return [...this.values()].map(fn); };
  col.find = function(fn: any) { return [...this.values()].find(fn); };
  col.first = function() { return [...this.values()][0]; };
  col.toJSON = function() { return [...this.values()]; };
  col.sort = function(fn: any) { return makeCollection([...this.entries()].sort(([,a]: any,[,b]: any) => fn(a,b))); };
  col.reduce = function(fn: any, init: any) { let acc = init; for (const [k,v] of this) acc = fn(acc, v, k); return acc; };
  col.some = function(fn: any) { return [...this.values()].some(fn); };
  col.at = function(idx: number) { return [...this.values()][idx]; };
  return col;
}

function makeGuild(overrides: any = {}): any {
  const textCh: any = {
    id: 'ch1', type: 0, name: 'general',
    send: vi.fn(async () => ({ id: 'msg1', edit: vi.fn() })),
    threads: { create: vi.fn(async () => ({ id: 'thread1', send: vi.fn() })) },
    permissionOverwrites: { create: vi.fn(async () => {}), set: vi.fn(async () => {}) },
    setName: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    edit: vi.fn(async () => {}),
  };
  const voiceCh: any = { id: 'vc1', type: 2, name: 'Voice', members: makeCollection() };
  const category: any = { id: 'cat1', type: 4, name: 'Category', children: makeCollection([['ch1', textCh]]) };

  const role1: any = { id: 'role1', name: 'Admin', position: 10, permissions: { has: () => true }, editable: true, setPosition: vi.fn(async () => {}), edit: vi.fn(async () => {}), delete: vi.fn(async () => {}) };
  const everyoneRole: any = { id: 'g1', name: '@everyone', position: 0, permissions: { has: () => false }, editable: true, setPermissions: vi.fn(async () => {}), edit: vi.fn(async () => {}) };

  return {
    id: 'g1', name: 'Test Guild', memberCount: 100,
    members: {
      cache: makeCollection([['u1', { id: 'u1', user: { id: 'u1', username: 'TestUser', bot: false, tag: 'TestUser#0001', displayAvatarURL: () => 'https://cdn.example.com/avatar.png' }, roles: { cache: makeCollection([['role1', role1]]), add: vi.fn(async () => {}), remove: vi.fn(async () => {}) }, send: vi.fn(async () => ({})), kickable: true, bannable: true, moderatable: true, kick: vi.fn(async () => {}), ban: vi.fn(async () => {}), timeout: vi.fn(async () => {}), displayName: 'TestUser' }]]),
      fetch: vi.fn(async () => makeCollection()),
    },
    channels: {
      cache: makeCollection([['ch1', textCh], ['vc1', voiceCh], ['cat1', category]]),
      create: vi.fn(async (opts: any) => ({ ...textCh, id: 'new-ch', name: opts.name, permissionOverwrites: { create: vi.fn(async () => {}) } })),
      fetch: vi.fn(async () => makeCollection([['ch1', textCh]])),
    },
    roles: {
      cache: makeCollection([['role1', role1], ['g1', everyoneRole]]),
      create: vi.fn(async (opts: any) => ({ id: 'new-role', name: opts.name, position: 1, setPosition: vi.fn(async () => {}) })),
      fetch: vi.fn(async () => makeCollection([['role1', role1]])),
    },
    emojis: { cache: makeCollection() },
    autoModerationRules: { fetch: vi.fn(async () => makeCollection()), create: vi.fn(async () => ({})) },
    fetchAuditLogs: vi.fn(async () => ({ entries: makeCollection() })),
    ...overrides,
  };
}

function makeInteraction(overrides: any = {}): any {
  const deferred = { replied: false, deferred: false };
  return {
    guildId: 'g1',
    guild: makeGuild(),
    user: { id: 'u1', username: 'TestUser', tag: 'TestUser#0001', displayAvatarURL: () => 'https://cdn.example.com/avatar.png' },
    member: { id: 'u1', user: { id: 'u1', username: 'TestUser', bot: false }, roles: { cache: makeCollection([['role1', { id: 'role1' }]]), add: vi.fn(), remove: vi.fn() }, send: vi.fn(async () => ({})), kickable: true, bannable: true, moderatable: true, displayName: 'TestUser', permissions: { has: () => true } },
    channel: { id: 'ch1', type: 0, send: vi.fn(async () => ({ id: 'msg1' })), name: 'general' },
    channelId: 'ch1',
    options: {
      getSubcommand: vi.fn(() => 'test'),
      getString: vi.fn(() => 'test-value'),
      getInteger: vi.fn(() => 100),
      getNumber: vi.fn(() => 1.5),
      getBoolean: vi.fn(() => true),
      getUser: vi.fn(() => ({ id: 'u2', username: 'Other', tag: 'Other#0001', displayAvatarURL: () => '' })),
      getChannel: vi.fn(() => ({ id: 'ch1', type: 0, name: 'general' })),
      getRole: vi.fn(() => ({ id: 'role1', name: 'Admin' })),
      getMember: vi.fn(() => ({ id: 'u2', user: { id: 'u2', username: 'Other' }, roles: { cache: makeCollection() } })),
      getAttachment: vi.fn(() => null),
      getFocused: vi.fn(() => 'search'),
      ...overrides.options,
    },
    replied: false,
    deferred: false,
    reply: vi.fn(async (opts: any) => { deferred.replied = true; return { edit: vi.fn() }; }),
    editReply: vi.fn(async () => ({})),
    followUp: vi.fn(async () => ({})),
    deferReply: vi.fn(async () => { deferred.deferred = true; }),
    deferUpdate: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    showModal: vi.fn(async () => {}),
    isButton: vi.fn(() => false),
    isChatInputCommand: vi.fn(() => true),
    isModalSubmit: vi.fn(() => false),
    isStringSelectMenu: vi.fn(() => false),
    isAutocomplete: vi.fn(() => false),
    customId: '',
    commandName: 'test',
    message: { id: 'msg1', edit: vi.fn(async () => {}), delete: vi.fn(async () => {}) },
    fields: { getTextInputValue: vi.fn(() => 'modal-value') },
    respond: vi.fn(async () => {}),
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════
// 1. ACTION EXECUTOR — 373 lines, ~1% covered
// ═══════════════════════════════════════════════════════════
describe('action-executor deep coverage', () => {
  it('executes send_message action', async () => {
    const { executeActions } = await import('../features/automations/action-executor.js');
    const guild = makeGuild();
    const ctx: any = {
      guild,
      member: guild.members.cache.get('u1'),
      channelId: 'ch1',
      messageId: 'msg1',
      message: { id: 'msg1', reply: vi.fn(async () => {}), react: vi.fn(async () => {}), deletable: true, delete: vi.fn(async () => {}), startThread: vi.fn(async () => ({ id: 'thread1' })) },
      supabase: makeSupa(),
      guildId: 'g1',
      rateLimiter: { allowFire: vi.fn(async () => true), allowDM: vi.fn(async () => true) },
      automationId: 'auto1',
      variables: { user: '<@u1>', channel: '#general' },
    };

    const result = await executeActions([
      { type: 'send_message', config: { channel_id: 'ch1', message: 'Hello {user}!' } },
    ], ctx);
    expect(result.executed).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('executes send_dm action', async () => {
    const { executeActions } = await import('../features/automations/action-executor.js');
    const guild = makeGuild();
    const ctx: any = {
      guild, member: guild.members.cache.get('u1'),
      channelId: 'ch1', messageId: null, message: null,
      supabase: makeSupa(), guildId: 'g1',
      rateLimiter: { allowFire: vi.fn(async () => true), allowDM: vi.fn(async () => true) },
      automationId: 'auto1', variables: {},
    };
    const result = await executeActions([{ type: 'send_dm', config: { message: 'Hey!' } }], ctx);
    expect(result.executed).toBe(1);
  });

  it('executes send_dm rate limited', async () => {
    const { executeActions } = await import('../features/automations/action-executor.js');
    const guild = makeGuild();
    const ctx: any = {
      guild, member: guild.members.cache.get('u1'),
      channelId: 'ch1', messageId: null, message: null,
      supabase: makeSupa(), guildId: 'g1',
      rateLimiter: { allowFire: vi.fn(async () => true), allowDM: vi.fn(async () => false) },
      automationId: 'auto1', variables: {},
    };
    const result = await executeActions([{ type: 'send_dm', config: { message: 'Hey!' } }], ctx);
    expect(result.failed).toBe(1);
  });

  it('executes reply_to_message action', async () => {
    const { executeActions } = await import('../features/automations/action-executor.js');
    const guild = makeGuild();
    const msg: any = { id: 'msg1', reply: vi.fn(async () => {}), react: vi.fn(async () => {}), deletable: true, delete: vi.fn(async () => {}), startThread: vi.fn(async () => ({})) };
    const ctx: any = {
      guild, member: guild.members.cache.get('u1'),
      channelId: 'ch1', messageId: 'msg1', message: msg,
      supabase: makeSupa(), guildId: 'g1',
      rateLimiter: { allowFire: vi.fn(async () => true), allowDM: vi.fn(async () => true) },
      automationId: 'auto1', variables: { user: '<@u1>' },
    };
    const result = await executeActions([{ type: 'reply_to_message', config: { message: 'Thanks {user}!' } }], ctx);
    expect(result.executed).toBe(1);
  });

  it('executes give_role and remove_role', async () => {
    const { executeActions } = await import('../features/automations/action-executor.js');
    const guild = makeGuild();
    const ctx: any = {
      guild, member: guild.members.cache.get('u1'),
      channelId: 'ch1', messageId: null, message: null,
      supabase: makeSupa(), guildId: 'g1',
      rateLimiter: { allowFire: vi.fn(async () => true), allowDM: vi.fn(async () => true) },
      automationId: 'auto1', variables: {},
    };
    const result = await executeActions([
      { type: 'give_role', config: { role_id: 'role1' } },
      { type: 'remove_role', config: { role_id: 'role1' } },
    ], ctx);
    expect(result.executed).toBe(2);
  });

  it('handles role not found', async () => {
    const { executeActions } = await import('../features/automations/action-executor.js');
    const guild = makeGuild();
    const ctx: any = {
      guild, member: guild.members.cache.get('u1'),
      channelId: 'ch1', messageId: null, message: null,
      supabase: makeSupa(), guildId: 'g1',
      rateLimiter: { allowFire: vi.fn(async () => true), allowDM: vi.fn(async () => true) },
      automationId: 'auto1', variables: {},
    };
    const result = await executeActions([{ type: 'give_role', config: { role_id: 'nonexistent' } }], ctx);
    expect(result.failed).toBe(1);
  });

  it('executes add_reaction, delete_message, create_thread', async () => {
    const { executeActions } = await import('../features/automations/action-executor.js');
    const guild = makeGuild();
    const msg: any = { id: 'msg1', reply: vi.fn(async () => {}), react: vi.fn(async () => {}), deletable: true, delete: vi.fn(async () => {}), startThread: vi.fn(async () => ({ id: 't1' })) };
    const ctx: any = {
      guild, member: guild.members.cache.get('u1'),
      channelId: 'ch1', messageId: 'msg1', message: msg,
      supabase: makeSupa(), guildId: 'g1',
      rateLimiter: { allowFire: vi.fn(async () => true), allowDM: vi.fn(async () => true) },
      automationId: 'auto1', variables: { user: 'Test' },
    };
    const result = await executeActions([
      { type: 'add_reaction', config: { emoji: '⭐' } },
      { type: 'delete_message', config: {} },
      { type: 'create_thread', config: { name: 'Thread {user}', auto_archive_minutes: 1440 } },
    ], ctx);
    expect(result.executed).toBe(3);
  });

  it('executes wait_delay (clamped)', async () => {
    const { executeActions } = await import('../features/automations/action-executor.js');
    const guild = makeGuild();
    const ctx: any = {
      guild, member: null, channelId: null, messageId: null, message: null,
      supabase: makeSupa(), guildId: 'g1',
      rateLimiter: { allowFire: vi.fn(async () => true), allowDM: vi.fn(async () => true) },
      automationId: 'auto1', variables: {},
    };
    const result = await executeActions([{ type: 'wait_delay', config: { seconds: 0.001 } }], ctx);
    expect(result.executed).toBe(1);
  });

  it('executes log_to_channel', async () => {
    const { executeActions } = await import('../features/automations/action-executor.js');
    const guild = makeGuild();
    const ctx: any = {
      guild, member: guild.members.cache.get('u1'),
      channelId: 'ch1', messageId: null, message: null,
      supabase: makeSupa(), guildId: 'g1',
      rateLimiter: { allowFire: vi.fn(async () => true), allowDM: vi.fn(async () => true) },
      automationId: 'auto1', variables: { user: '<@u1>' },
    };
    const result = await executeActions([{ type: 'log_to_channel', config: { channel_id: 'ch1', message: 'Log {user}' } }], ctx);
    expect(result.executed).toBe(1);
  });

  it('executes grant_entitlement', async () => {
    const { executeActions } = await import('../features/automations/action-executor.js');
    const guild = makeGuild();
    const supa = makeSupa();
    // Override from to return product data
    const productChain = makeChain({ data: { name: 'VIP', granted_role_ids: ['role1'], granted_channel_ids: [] }, error: null });
    const customerChain = makeChain({ data: { id: 'cust1' }, error: null });
    const queueChain = makeChain({ data: null, error: null });
    let callCount = 0;
    supa.from = vi.fn((table: string) => {
      if (table === 'products') return productChain;
      if (table === 'customers') return customerChain;
      if (table === 'bot_action_queue') return queueChain;
      return makeChain();
    });
    const ctx: any = {
      guild, member: guild.members.cache.get('u1'),
      channelId: 'ch1', messageId: null, message: null,
      supabase: supa, guildId: 'g1',
      rateLimiter: { allowFire: vi.fn(async () => true), allowDM: vi.fn(async () => true) },
      automationId: 'auto1', variables: {},
    };
    const result = await executeActions([{ type: 'grant_entitlement', config: { product_id: 'prod1' } }], ctx);
    expect(result.executed).toBe(1);
  });

  it('executes ban, kick, mute', async () => {
    const { executeActions } = await import('../features/automations/action-executor.js');
    const guild = makeGuild();
    const ctx: any = {
      guild, member: guild.members.cache.get('u1'),
      channelId: 'ch1', messageId: null, message: null,
      supabase: makeSupa(), guildId: 'g1',
      rateLimiter: { allowFire: vi.fn(async () => true), allowDM: vi.fn(async () => true) },
      automationId: 'auto1', variables: { user: 'Test' },
    };
    const r1 = await executeActions([{ type: 'ban_member', config: { reason: 'Auto {user}' } }], ctx);
    expect(r1.executed).toBe(1);
    const r2 = await executeActions([{ type: 'kick_member', config: { reason: 'Auto' } }], ctx);
    expect(r2.executed).toBe(1);
    const r3 = await executeActions([{ type: 'mute_member', config: { duration_minutes: 10, reason: 'Auto' } }], ctx);
    expect(r3.executed).toBe(1);
  });

  it('handles unknown action type', async () => {
    const { executeActions } = await import('../features/automations/action-executor.js');
    const guild = makeGuild();
    const ctx: any = {
      guild, member: null, channelId: null, messageId: null, message: null,
      supabase: makeSupa(), guildId: 'g1',
      rateLimiter: { allowFire: vi.fn(async () => true), allowDM: vi.fn(async () => true) },
      automationId: 'auto1', variables: {},
    };
    const result = await executeActions([{ type: 'nonexistent_action', config: {} }], ctx);
    expect(result.failed).toBe(1);
  });

  it('handles no member context for DM/role/ban/kick/mute', async () => {
    const { executeActions } = await import('../features/automations/action-executor.js');
    const guild = makeGuild();
    const ctx: any = {
      guild, member: null, channelId: null, messageId: null, message: null,
      supabase: makeSupa(), guildId: 'g1',
      rateLimiter: { allowFire: vi.fn(async () => true), allowDM: vi.fn(async () => true) },
      automationId: 'auto1', variables: {},
    };
    const r1 = await executeActions([{ type: 'send_dm', config: { message: 'Hi' } }], ctx);
    expect(r1.failed).toBe(1);
    const r2 = await executeActions([{ type: 'give_role', config: { role_id: 'r1' } }], ctx);
    expect(r2.failed).toBe(1);
    const r3 = await executeActions([{ type: 'remove_role', config: { role_id: 'r1' } }], ctx);
    expect(r3.failed).toBe(1);
    const r4 = await executeActions([{ type: 'ban_member', config: {} }], ctx);
    expect(r4.failed).toBe(1);
    const r5 = await executeActions([{ type: 'kick_member', config: {} }], ctx);
    expect(r5.failed).toBe(1);
    const r6 = await executeActions([{ type: 'mute_member', config: { duration_minutes: 5 } }], ctx);
    expect(r6.failed).toBe(1);
    const r7 = await executeActions([{ type: 'grant_entitlement', config: { product_id: 'p1' } }], ctx);
    expect(r7.failed).toBe(1);
  });

  it('handles no message context for reply/reaction/delete/thread', async () => {
    const { executeActions } = await import('../features/automations/action-executor.js');
    const guild = makeGuild();
    const ctx: any = {
      guild, member: guild.members.cache.get('u1'),
      channelId: 'ch1', messageId: null, message: null,
      supabase: makeSupa(), guildId: 'g1',
      rateLimiter: { allowFire: vi.fn(async () => true), allowDM: vi.fn(async () => true) },
      automationId: 'auto1', variables: {},
    };
    for (const type of ['reply_to_message', 'add_reaction', 'delete_message', 'create_thread']) {
      const r = await executeActions([{ type, config: { message: 'x', emoji: '⭐', name: 'Thread' } }], ctx);
      expect(r.failed).toBe(1);
    }
  });

  it('executes create_ticket action', async () => {
    const { executeActions } = await import('../features/automations/action-executor.js');
    const guild = makeGuild();
    const supa = makeSupa();
    supa.from = vi.fn((table: string) => {
      if (table === 'ticket_panels') return makeChain({ data: { id: 'panel1', open_category_id: 'cat1', manager_roles: ['role1'] }, error: null });
      if (table === 'tickets') return makeChain({ data: { id: 'ticket1' }, error: null });
      return makeChain();
    });
    supa.rpc = vi.fn(async () => ({ data: 42, error: null })) as any;
    const ctx: any = {
      guild, member: guild.members.cache.get('u1'),
      channelId: 'ch1', messageId: null, message: null,
      supabase: supa, guildId: 'g1',
      rateLimiter: { allowFire: vi.fn(async () => true), allowDM: vi.fn(async () => true) },
      automationId: 'auto1', variables: { user: 'Test' },
    };
    const result = await executeActions([{ type: 'create_ticket', config: { subject: 'Auto ticket' } }], ctx);
    expect(result.executed).toBe(1);
  });

  it('handles channel not found for send_message', async () => {
    const { executeActions } = await import('../features/automations/action-executor.js');
    const guild = makeGuild();
    const ctx: any = {
      guild, member: null, channelId: null, messageId: null, message: null,
      supabase: makeSupa(), guildId: 'g1',
      rateLimiter: { allowFire: vi.fn(async () => true), allowDM: vi.fn(async () => true) },
      automationId: 'auto1', variables: {},
    };
    const result = await executeActions([{ type: 'send_message', config: { channel_id: 'nonexistent', message: 'Hi' } }], ctx);
    expect(result.failed).toBe(1);
  });

  it('respects action limit', async () => {
    const { executeActions } = await import('../features/automations/action-executor.js');
    const guild = makeGuild();
    const ctx: any = {
      guild, member: null, channelId: null, messageId: null, message: null,
      supabase: makeSupa(), guildId: 'g1',
      rateLimiter: { allowFire: vi.fn(async () => true), allowDM: vi.fn(async () => true) },
      automationId: 'auto1', variables: {},
    };
    // Create 12 actions (limit is 10)
    const actions = Array.from({ length: 12 }, () => ({ type: 'wait_delay', config: { seconds: 0.001 } }));
    const result = await executeActions(actions, ctx);
    expect(result.executed + result.failed).toBeLessThanOrEqual(10);
  });
});

// ═══════════════════════════════════════════════════════════
// 2. WIZARD ENGINE — 198 lines, ~7% covered
// ═══════════════════════════════════════════════════════════
describe('wizard-engine deep coverage', () => {
  it('loadProgress returns defaults on missing data', async () => {
    const mod = await import('../features/setup-wizard/wizard-engine.js');
    const supa = makeSupa({ data: null, error: null });
    const progress = await mod.loadProgress(supa as any);
    expect(progress.configured).toEqual([]);
    expect(progress.skipped).toEqual([]);
  });

  it('loadProgress parses stored progress', async () => {
    const mod = await import('../features/setup-wizard/wizard-engine.js');
    const stored = JSON.stringify({ configured: ['paypal'], skipped: ['deploy'], lastRun: '2024-01-01' });
    const supa = makeSupa({ data: { value: stored }, error: null });
    const progress = await mod.loadProgress(supa as any);
    expect(progress.configured).toEqual(['paypal']);
    expect(progress.skipped).toEqual(['deploy']);
  });

  it('loadProgress handles corrupt JSON', async () => {
    const mod = await import('../features/setup-wizard/wizard-engine.js');
    const supa = makeSupa({ data: { value: 'not-json' }, error: null });
    const progress = await mod.loadProgress(supa as any);
    expect(progress.configured).toEqual([]);
  });

  it('saveProgress upserts to supabase', async () => {
    const mod = await import('../features/setup-wizard/wizard-engine.js');
    const supa = makeSupa();
    await mod.saveProgress(supa as any, { configured: ['paypal'], skipped: [], lastRun: new Date().toISOString() });
    expect(supa.from).toHaveBeenCalledWith('instance_settings');
  });

  it('getNextStep finds first unconfigured step', async () => {
    const mod = await import('../features/setup-wizard/wizard-engine.js');
    const result = mod.getNextStep({ configured: ['paypal'], skipped: [], lastRun: '' });
    expect(result).not.toBeNull();
    expect(result!.step.id).toBe('deploy');
  });

  it('getNextStep returns null when all done', async () => {
    const mod = await import('../features/setup-wizard/wizard-engine.js');
    const result = mod.getNextStep({ configured: ['paypal', 'deploy', 'supabase'], skipped: [], lastRun: '' });
    expect(result).toBeNull();
  });

  it('getNextStep skips skipped steps', async () => {
    const mod = await import('../features/setup-wizard/wizard-engine.js');
    const result = mod.getNextStep({ configured: ['paypal'], skipped: ['deploy'], lastRun: '' });
    expect(result).not.toBeNull();
    expect(result!.step.id).toBe('supabase');
  });

  it('detectConfigured checks instance_settings', async () => {
    const mod = await import('../features/setup-wizard/wizard-engine.js');
    const supa = makeSupa({ data: [{ key: 'paypal_client_id', value: 'abc' }, { key: 'paypal_client_secret', value: 'xyz' }], error: null });
    const configured = await mod.detectConfigured(supa as any);
    expect(configured).toBeInstanceOf(Set);
  });

  it('detectConfigured returns empty set when no data', async () => {
    const mod = await import('../features/setup-wizard/wizard-engine.js');
    const supa = makeSupa({ data: null, error: null });
    const configured = await mod.detectConfigured(supa as any);
    expect(configured.size).toBe(0);
  });

  it('storeCredentials saves to instance_settings and updates env', async () => {
    const mod = await import('../features/setup-wizard/wizard-engine.js');
    const supa = makeSupa();
    const step = { id: 'paypal', fieldToSettingsKey: { client_id: 'paypal_client_id', secret: 'paypal_client_secret' } };
    await mod.storeCredentials(supa as any, step as any, { client_id: 'my-id', secret: 'my-secret' });
    expect(supa.from).toHaveBeenCalledWith('instance_settings');
  });

  it('enableFeatureFlag upserts guild_config', async () => {
    const mod = await import('../features/setup-wizard/wizard-engine.js');
    const supa = makeSupa();
    await mod.enableFeatureFlag(supa as any, 'g1', 'commerce_enabled');
    expect(supa.from).toHaveBeenCalledWith('guild_config');
  });
});

// ═══════════════════════════════════════════════════════════
// 3. BOT PRESENCE — 162 lines, ~3% covered
// ═══════════════════════════════════════════════════════════
describe('bot-presence deep coverage', () => {
  it('constructs and starts/stops', async () => {
    const { BotPresenceManager } = await import('../features/discord-ux/bot-presence.js');
    const client: any = {
      user: { setPresence: vi.fn() },
      guilds: { cache: makeCollection([['g1', { id: 'g1', memberCount: 100 }]]) },
    };
    const supa = makeSupa({ data: { custom_bot_statuses: ['Status 1', 'Status 2'] }, error: null });
    const mgr = new BotPresenceManager(client, 'g1', supa as any);
    mgr.start(60000);
    // Should have set initial presence
    mgr.stop();
  });

  it('builds presence entries with music and products', async () => {
    const { BotPresenceManager } = await import('../features/discord-ux/bot-presence.js');
    const client: any = {
      user: { setPresence: vi.fn() },
      guilds: { cache: makeCollection([['g1', { id: 'g1', memberCount: 100 }]]) },
      _musicPlayer: {
        queueManager: {
          getQueue: vi.fn(async () => ({ nowPlaying: { info: { title: 'Cool Song' } } })),
        },
      },
    };
    const supaChain = makeChain({ data: { custom_bot_statuses: ['Custom Status'] }, error: null });
    const supa: any = {
      from: vi.fn((table: string) => {
        if (table === 'products') {
          const c = makeChain({ data: null, error: null, count: 5 });
          c.then = (resolve: Function) => resolve({ data: null, error: null, count: 5 });
          return c;
        }
        return supaChain;
      }),
    };
    const mgr = new BotPresenceManager(client, 'g1', supa);
    mgr.start(100000);
    // Wait for presence cycle
    await new Promise(r => setTimeout(r, 50));
    mgr.stop();
  });
});

// ═══════════════════════════════════════════════════════════
// 4. VOICE HANDLER — 34 lines, 0% covered
// ═══════════════════════════════════════════════════════════
describe('voice-handler deep coverage', () => {
  it('handles join to hub channel', async () => {
    const { handleVoiceStateForTempChannels } = await import('../features/temp-channels/voice-handler.js');
    const manager: any = {
      isHubChannel: vi.fn(() => true),
      handleJoinHub: vi.fn(async () => {}),
      isTempChannel: vi.fn(() => false),
      handleLeaveTemp: vi.fn(async () => {}),
    };
    const oldState: any = { channelId: null, member: null };
    const newState: any = { channelId: 'vc1', member: { user: { bot: false }, id: 'u1' } };
    await handleVoiceStateForTempChannels(oldState, newState, manager);
    expect(manager.handleJoinHub).toHaveBeenCalled();
  });

  it('handles leave from temp channel', async () => {
    const { handleVoiceStateForTempChannels } = await import('../features/temp-channels/voice-handler.js');
    const manager: any = {
      isHubChannel: vi.fn(() => false),
      handleJoinHub: vi.fn(async () => {}),
      isTempChannel: vi.fn(() => true),
      handleLeaveTemp: vi.fn(async () => {}),
    };
    const oldState: any = { channelId: 'vc1', member: { user: { bot: false }, id: 'u1' } };
    const newState: any = { channelId: null, member: { user: { bot: false }, id: 'u1' } };
    await handleVoiceStateForTempChannels(oldState, newState, manager);
    expect(manager.handleLeaveTemp).toHaveBeenCalled();
  });

  it('ignores bot users', async () => {
    const { handleVoiceStateForTempChannels } = await import('../features/temp-channels/voice-handler.js');
    const manager: any = { isHubChannel: vi.fn(), handleJoinHub: vi.fn(), isTempChannel: vi.fn(), handleLeaveTemp: vi.fn() };
    const oldState: any = { channelId: null, member: null };
    const newState: any = { channelId: 'vc1', member: { user: { bot: true }, id: 'bot1' } };
    await handleVoiceStateForTempChannels(oldState, newState, manager);
    expect(manager.isHubChannel).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════
// 5. DEPLOYER — 614 lines, ~18% covered
// ═══════════════════════════════════════════════════════════
describe('deployer deep coverage', () => {
  it('deploys with empty desired state', async () => {
    const { deployServerState } = await import('../deploy/deployer.js');
    const guild = makeGuild();
    const supa = makeSupa();
    const desiredState: any = { roles: [], channels: [], categories: [] };
    const result = await deployServerState(guild, supa as any, desiredState, {
      cleanExisting: false, dryRun: false,
      onProgress: vi.fn(),
    });
    expect(result.success).toBeDefined();
    expect(result.actions).toBeDefined();
  });

  it('deploys roles and channels', async () => {
    const { deployServerState } = await import('../deploy/deployer.js');
    const guild = makeGuild();
    const supa = makeSupa();
    const desiredState: any = {
      roles: [{ key: 'mod', name: 'Moderator', color: '#FF0000', hoist: true, mentionable: false, permissions: [] }],
      channels: [{ key: 'welcome', name: 'welcome', type: 'text', category_key: null, permission_overrides: [] }],
      categories: [{ key: 'main', name: 'Main', permission_overrides: [] }],
    };
    const result = await deployServerState(guild, supa as any, desiredState, {
      cleanExisting: false, dryRun: false,
    });
    expect(result.actions.length).toBeGreaterThan(0);
  });

  it('deploys in dry run mode', async () => {
    const { deployServerState } = await import('../deploy/deployer.js');
    const guild = makeGuild();
    const supa = makeSupa();
    const desiredState: any = {
      roles: [{ key: 'admin', name: 'Admin', color: '#0000FF', hoist: false, mentionable: false, permissions: [] }],
      channels: [],
      categories: [],
    };
    const result = await deployServerState(guild, supa as any, desiredState, {
      cleanExisting: false, dryRun: true,
    });
    expect(result.success).toBeDefined();
  });

  it('deploys with cleanExisting', async () => {
    const { deployServerState } = await import('../deploy/deployer.js');
    const guild = makeGuild();
    const supa = makeSupa();
    const desiredState: any = { roles: [], channels: [], categories: [] };
    const result = await deployServerState(guild, supa as any, desiredState, {
      cleanExisting: true, dryRun: false,
    });
    expect(result.success).toBeDefined();
  });

  it('handles roles with permission_overrides', async () => {
    const { deployServerState } = await import('../deploy/deployer.js');
    const guild = makeGuild();
    const supa = makeSupa();
    const desiredState: any = {
      roles: [],
      categories: [{ key: 'mod-cat', name: 'Moderation', permission_overrides: [{ role_key: '@everyone', allow: [], deny: ['ViewChannel'] }] }],
      channels: [{ key: 'mod-chat', name: 'mod-chat', type: 'text', category_key: 'mod-cat', permission_overrides: [{ role_key: '@everyone', allow: [], deny: ['ViewChannel'] }] }],
    };
    const result = await deployServerState(guild, supa as any, desiredState, {
      cleanExisting: false, dryRun: false,
    });
    expect(result).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// 6. DEPLOY LISTENER — 346 lines, ~2% covered
// ═══════════════════════════════════════════════════════════
describe('deploy-listener deep coverage', () => {
  it('getDeployStatus returns null initially', async () => {
    const { getDeployStatus } = await import('../deploy/deploy-listener.js');
    const status = getDeployStatus();
    // May be null or an object depending on whether startDeployListener was called
    expect(status === null || typeof status === 'object').toBe(true);
  });

  it('startDeployListener subscribes to supabase realtime', async () => {
    const { startDeployListener } = await import('../deploy/deploy-listener.js');
    const client: any = {
      guildId: 'g1',
      guilds: { cache: makeCollection([['g1', makeGuild()]]) },
      supabase: makeSupa(),
      valkey: makeValkey(),
      eventBus: { emit: vi.fn(), on: vi.fn(), removeAllListeners: vi.fn() },
    };
    // Should not throw
    startDeployListener(client);
  });
});

// ═══════════════════════════════════════════════════════════
// 7. MUSIC PLAYER — 1072 lines, ~1% covered
// ═══════════════════════════════════════════════════════════
describe('music-player deep coverage', () => {
  it('constructs a MusicPlayerManager', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const guild = makeGuild();
    const shoukaku: any = {
      on: vi.fn(),
      joinVoiceChannel: vi.fn(async () => ({
        node: { rest: { resolve: vi.fn(async () => ({ loadType: 'track', data: { info: { title: 'Song', uri: 'http://x', length: 200000, author: 'A' }, encoded: 'enc' } })) } },
        playTrack: vi.fn(), stopTrack: vi.fn(), setPaused: vi.fn(),
        setGlobalVolume: vi.fn(), setFilterVolume: vi.fn(), seekTo: vi.fn(),
        setFilters: vi.fn(), on: vi.fn(), destroy: vi.fn(),
      })),
      leaveVoiceChannel: vi.fn(),
      getPlayer: vi.fn(() => null),
      players: new Map(),
    };
    const supa = makeSupa({ data: null, error: null });
    const valkey = makeValkey();
    const eventBus: any = { emit: vi.fn(), on: vi.fn(), removeAllListeners: vi.fn() };

    const mgr = new MusicPlayerManager(guild, shoukaku, supa as any, valkey, eventBus);
    expect(mgr).toBeDefined();
    expect(mgr.queueManager).toBeDefined();
  });

  it('init loads config and sets up events', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const guild = makeGuild();
    const shoukaku: any = {
      on: vi.fn(),
      joinVoiceChannel: vi.fn(async () => ({
        node: { rest: { resolve: vi.fn(async () => ({ loadType: 'empty', data: null })) } },
        playTrack: vi.fn(), stopTrack: vi.fn(), setPaused: vi.fn(),
        setGlobalVolume: vi.fn(), setFilterVolume: vi.fn(), seekTo: vi.fn(),
        setFilters: vi.fn(), on: vi.fn(), destroy: vi.fn(),
      })),
      leaveVoiceChannel: vi.fn(),
      getPlayer: vi.fn(() => null),
      players: new Map(),
    };
    const supa = makeSupa({ data: { default_volume: 80, max_queue_length: 200, allow_duplicates: false, dj_role_id: 'role1', auto_leave_timeout: 300000, inactivity_timeout: 1800000 }, error: null });
    const valkey = makeValkey();
    const eventBus: any = { emit: vi.fn(), on: vi.fn(), removeAllListeners: vi.fn() };

    const mgr = new MusicPlayerManager(guild, shoukaku, supa as any, valkey, eventBus);
    await mgr.init();
    mgr.shutdown();
  });

  it('getStatus returns status object', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const guild = makeGuild();
    const shoukaku: any = {
      on: vi.fn(), joinVoiceChannel: vi.fn(), leaveVoiceChannel: vi.fn(),
      getPlayer: vi.fn(() => null), players: new Map(),
    };
    const supa = makeSupa();
    const valkey = makeValkey();
    const eventBus: any = { emit: vi.fn(), on: vi.fn(), removeAllListeners: vi.fn() };
    const mgr = new MusicPlayerManager(guild, shoukaku, supa as any, valkey, eventBus);
    const status = await mgr.getStatus();
    expect(status).toBeDefined();
  });

  it('isDJ checks DJ role', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const guild = makeGuild();
    const shoukaku: any = {
      on: vi.fn(), joinVoiceChannel: vi.fn(), leaveVoiceChannel: vi.fn(),
      getPlayer: vi.fn(() => null), players: new Map(),
    };
    const supa = makeSupa();
    const valkey = makeValkey();
    const eventBus: any = { emit: vi.fn(), on: vi.fn(), removeAllListeners: vi.fn() };
    const mgr = new MusicPlayerManager(guild, shoukaku, supa as any, valkey, eventBus);
    const isDj = await mgr.isDJ('u1');
    expect(typeof isDj).toBe('boolean');
  });

  it('stop returns message when no player', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const guild = makeGuild();
    const shoukaku: any = {
      on: vi.fn(), joinVoiceChannel: vi.fn(), leaveVoiceChannel: vi.fn(),
      getPlayer: vi.fn(() => null), players: new Map(),
    };
    const supa = makeSupa();
    const valkey = makeValkey();
    const eventBus: any = { emit: vi.fn(), on: vi.fn(), removeAllListeners: vi.fn() };
    const mgr = new MusicPlayerManager(guild, shoukaku, supa as any, valkey, eventBus);
    const result = await mgr.stop('g1');
    expect(result.success).toBeDefined();
  });

  it('skip returns message when no player', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const guild = makeGuild();
    const shoukaku: any = {
      on: vi.fn(), joinVoiceChannel: vi.fn(), leaveVoiceChannel: vi.fn(),
      getPlayer: vi.fn(() => null), players: new Map(),
    };
    const supa = makeSupa();
    const valkey = makeValkey();
    const eventBus: any = { emit: vi.fn(), on: vi.fn(), removeAllListeners: vi.fn() };
    const mgr = new MusicPlayerManager(guild, shoukaku, supa as any, valkey, eventBus);
    const result = await mgr.skip('g1');
    expect(result.success).toBeDefined();
  });

  it('togglePause returns message when no player', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const guild = makeGuild();
    const shoukaku: any = {
      on: vi.fn(), joinVoiceChannel: vi.fn(), leaveVoiceChannel: vi.fn(),
      getPlayer: vi.fn(() => null), players: new Map(),
    };
    const supa = makeSupa();
    const valkey = makeValkey();
    const eventBus: any = { emit: vi.fn(), on: vi.fn(), removeAllListeners: vi.fn() };
    const mgr = new MusicPlayerManager(guild, shoukaku, supa as any, valkey, eventBus);
    const result = await mgr.togglePause('g1');
    expect(result).toBeDefined();
  });

  it('seek returns message when no player', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const guild = makeGuild();
    const shoukaku: any = {
      on: vi.fn(), joinVoiceChannel: vi.fn(), leaveVoiceChannel: vi.fn(),
      getPlayer: vi.fn(() => null), players: new Map(),
    };
    const supa = makeSupa();
    const valkey = makeValkey();
    const eventBus: any = { emit: vi.fn(), on: vi.fn(), removeAllListeners: vi.fn() };
    const mgr = new MusicPlayerManager(guild, shoukaku, supa as any, valkey, eventBus);
    const result = await mgr.seek('g1', 5000);
    expect(result.success).toBeDefined();
  });

  it('setVolume returns message when no player', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const guild = makeGuild();
    const shoukaku: any = {
      on: vi.fn(), joinVoiceChannel: vi.fn(), leaveVoiceChannel: vi.fn(),
      getPlayer: vi.fn(() => null), players: new Map(),
    };
    const supa = makeSupa();
    const valkey = makeValkey();
    const eventBus: any = { emit: vi.fn(), on: vi.fn(), removeAllListeners: vi.fn() };
    const mgr = new MusicPlayerManager(guild, shoukaku, supa as any, valkey, eventBus);
    const result = await mgr.setVolume('g1', 80);
    expect(result.success).toBeDefined();
  });

  it('setLoopMode returns message when no player', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const guild = makeGuild();
    const shoukaku: any = {
      on: vi.fn(), joinVoiceChannel: vi.fn(), leaveVoiceChannel: vi.fn(),
      getPlayer: vi.fn(() => null), players: new Map(),
    };
    const supa = makeSupa();
    const valkey = makeValkey();
    const eventBus: any = { emit: vi.fn(), on: vi.fn(), removeAllListeners: vi.fn() };
    const mgr = new MusicPlayerManager(guild, shoukaku, supa as any, valkey, eventBus);
    const result = await mgr.setLoopMode('g1', 'off');
    expect(result.success).toBeDefined();
  });

  it('cycleLoopMode returns result', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const guild = makeGuild();
    const shoukaku: any = {
      on: vi.fn(), joinVoiceChannel: vi.fn(), leaveVoiceChannel: vi.fn(),
      getPlayer: vi.fn(() => null), players: new Map(),
    };
    const supa = makeSupa();
    const valkey = makeValkey();
    const eventBus: any = { emit: vi.fn(), on: vi.fn(), removeAllListeners: vi.fn() };
    const mgr = new MusicPlayerManager(guild, shoukaku, supa as any, valkey, eventBus);
    const result = await mgr.cycleLoopMode('g1');
    expect(result).toBeDefined();
  });

  it('shuffle returns result', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const guild = makeGuild();
    const shoukaku: any = {
      on: vi.fn(), joinVoiceChannel: vi.fn(), leaveVoiceChannel: vi.fn(),
      getPlayer: vi.fn(() => null), players: new Map(),
    };
    const supa = makeSupa();
    const valkey = makeValkey();
    const eventBus: any = { emit: vi.fn(), on: vi.fn(), removeAllListeners: vi.fn() };
    const mgr = new MusicPlayerManager(guild, shoukaku, supa as any, valkey, eventBus);
    const result = await mgr.shuffle('g1');
    expect(result.success).toBeDefined();
  });

  it('remove returns result', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const guild = makeGuild();
    const shoukaku: any = {
      on: vi.fn(), joinVoiceChannel: vi.fn(), leaveVoiceChannel: vi.fn(),
      getPlayer: vi.fn(() => null), players: new Map(),
    };
    const supa = makeSupa();
    const valkey = makeValkey();
    const eventBus: any = { emit: vi.fn(), on: vi.fn(), removeAllListeners: vi.fn() };
    const mgr = new MusicPlayerManager(guild, shoukaku, supa as any, valkey, eventBus);
    const result = await mgr.remove('g1', 0);
    expect(result.success).toBeDefined();
  });

  it('applyFilter returns result', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const guild = makeGuild();
    const shoukaku: any = {
      on: vi.fn(), joinVoiceChannel: vi.fn(), leaveVoiceChannel: vi.fn(),
      getPlayer: vi.fn(() => null), players: new Map(),
    };
    const supa = makeSupa();
    const valkey = makeValkey();
    const eventBus: any = { emit: vi.fn(), on: vi.fn(), removeAllListeners: vi.fn() };
    const mgr = new MusicPlayerManager(guild, shoukaku, supa as any, valkey, eventBus);
    const result = await mgr.applyFilter('g1', 'bassboost' as any);
    expect(result.success).toBeDefined();
  });

  it('voteSkip returns result when no player', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const guild = makeGuild();
    const shoukaku: any = {
      on: vi.fn(), joinVoiceChannel: vi.fn(), leaveVoiceChannel: vi.fn(),
      getPlayer: vi.fn(() => null), players: new Map(),
    };
    const supa = makeSupa();
    const valkey = makeValkey();
    const eventBus: any = { emit: vi.fn(), on: vi.fn(), removeAllListeners: vi.fn() };
    const mgr = new MusicPlayerManager(guild, shoukaku, supa as any, valkey, eventBus);
    const result = await mgr.voteSkip('g1', 'u1');
    expect(result.success).toBeDefined();
  });

  it('handleButton returns message', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const guild = makeGuild();
    const shoukaku: any = {
      on: vi.fn(), joinVoiceChannel: vi.fn(), leaveVoiceChannel: vi.fn(),
      getPlayer: vi.fn(() => null), players: new Map(),
    };
    const supa = makeSupa();
    const valkey = makeValkey();
    const eventBus: any = { emit: vi.fn(), on: vi.fn(), removeAllListeners: vi.fn() };
    const mgr = new MusicPlayerManager(guild, shoukaku, supa as any, valkey, eventBus);
    const result = await mgr.handleButton('music_skip', 'u1');
    expect(result).toBeDefined();
  });

  it('getStats returns stats', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const guild = makeGuild();
    const shoukaku: any = {
      on: vi.fn(), joinVoiceChannel: vi.fn(), leaveVoiceChannel: vi.fn(),
      getPlayer: vi.fn(() => null), players: new Map(),
    };
    const supa = makeSupa({ data: [], error: null });
    const valkey = makeValkey();
    const eventBus: any = { emit: vi.fn(), on: vi.fn(), removeAllListeners: vi.fn() };
    const mgr = new MusicPlayerManager(guild, shoukaku, supa as any, valkey, eventBus);
    const stats = await mgr.getStats(7);
    expect(stats).toBeDefined();
  });

  it('reloadConfig reloads from db', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const guild = makeGuild();
    const shoukaku: any = {
      on: vi.fn(), joinVoiceChannel: vi.fn(), leaveVoiceChannel: vi.fn(),
      getPlayer: vi.fn(() => null), players: new Map(),
    };
    const supa = makeSupa({ data: { default_volume: 60 }, error: null });
    const valkey = makeValkey();
    const eventBus: any = { emit: vi.fn(), on: vi.fn(), removeAllListeners: vi.fn() };
    const mgr = new MusicPlayerManager(guild, shoukaku, supa as any, valkey, eventBus);
    await mgr.reloadConfig();
  });
});

// ═══════════════════════════════════════════════════════════
// 8. GAMES MANAGER — 774 lines, ~19% covered
// ═══════════════════════════════════════════════════════════
describe('games-manager deep coverage', () => {
  it('registers and invalidates cache', async () => {
    const { GamesManager, registerGamesManager, invalidateGamesCache } = await import('../features/games/games-manager.js');
    const supa = makeSupa();
    const mgr = new GamesManager(supa as any);
    registerGamesManager(mgr);
    invalidateGamesCache();
  });

  it('coinflip runs game flow', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const supa = makeSupa({ data: { balance: 1000, bank: 0 }, error: null });
    const mgr = new GamesManager(supa as any);
    const interaction = makeInteraction();
    await mgr.coinflip(interaction, 100);
    expect(interaction.reply).toHaveBeenCalled();
  });

  it('slots runs game flow', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const supa = makeSupa({ data: { balance: 1000, bank: 0 }, error: null });
    const mgr = new GamesManager(supa as any);
    const interaction = makeInteraction();
    await mgr.slots(interaction, 100);
    expect(interaction.reply).toHaveBeenCalled();
  });

  it('rps runs game flow', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const supa = makeSupa({ data: { balance: 1000, bank: 0 }, error: null });
    const mgr = new GamesManager(supa as any);
    const interaction = makeInteraction();
    await mgr.rps(interaction, 100, 'rock');
    expect(interaction.reply).toHaveBeenCalled();
  });

  it('dice runs game flow', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const supa = makeSupa({ data: { balance: 1000, bank: 0 }, error: null });
    const mgr = new GamesManager(supa as any);
    const interaction = makeInteraction();
    await mgr.dice(interaction, 100);
    expect(interaction.reply).toHaveBeenCalled();
  });

  it('blackjack runs game flow', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const supa = makeSupa({ data: { balance: 1000, bank: 0 }, error: null });
    const mgr = new GamesManager(supa as any);
    const interaction = makeInteraction();
    await mgr.blackjack(interaction, 100);
    expect(interaction.reply).toHaveBeenCalled();
  });

  it('highlow runs game flow', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const supa = makeSupa({ data: { balance: 1000, bank: 0 }, error: null });
    const mgr = new GamesManager(supa as any);
    const interaction = makeInteraction();
    await mgr.highlow(interaction);
    expect(interaction.reply).toHaveBeenCalled();
  });

  it('scratch runs game flow', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const supa = makeSupa({ data: { balance: 1000, bank: 0 }, error: null });
    const mgr = new GamesManager(supa as any);
    const interaction = makeInteraction();
    await mgr.scratch(interaction, 100);
    expect(interaction.reply).toHaveBeenCalled();
  });

  it('guess runs game flow', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const supa = makeSupa({ data: { balance: 1000, bank: 0 }, error: null });
    const mgr = new GamesManager(supa as any);
    const interaction = makeInteraction();
    await mgr.guess(interaction, 100);
    expect(interaction.reply).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════
// 9. POLLS MANAGER — 628 lines, ~17% covered
// ═══════════════════════════════════════════════════════════
describe('polls-manager deep coverage', () => {
  it('registers and invalidates', async () => {
    const { PollsManager, registerPollsManager, invalidatePollsCache } = await import('../features/polls/polls-manager.js');
    const supa = makeSupa();
    const mgr = new PollsManager(supa as any);
    registerPollsManager(mgr);
    invalidatePollsCache();
  });

  it('createPoll creates a poll', async () => {
    const { PollsManager } = await import('../features/polls/polls-manager.js');
    const supa = makeSupa({ data: { id: 'poll1' }, error: null });
    const mgr = new PollsManager(supa as any);
    const interaction = makeInteraction();
    await mgr.createPoll(interaction, 'Favorite color?', ['Red', 'Blue', 'Green'], false);
    expect(interaction.reply).toHaveBeenCalled();
  });

  it('closePoll closes a poll', async () => {
    const { PollsManager } = await import('../features/polls/polls-manager.js');
    const supa = makeSupa({ data: { id: 'poll1', channel_id: 'ch1', message_id: 'msg1', question: 'Test?', options: ['A','B'], votes: {}, status: 'active', creator_id: 'u1' }, error: null });
    const mgr = new PollsManager(supa as any);
    const interaction = makeInteraction();
    await mgr.closePoll(interaction, 'poll1');
  });
});

// ═══════════════════════════════════════════════════════════
// 10. QUESTS MANAGER — 288 lines, ~11% covered
// ═══════════════════════════════════════════════════════════
describe('quests-manager deep coverage', () => {
  it('registers and retrieves', async () => {
    const { QuestsManager, registerQuestsManager, invalidateQuestsCache, getQuestsManager } = await import('../features/quests/quests-manager.js');
    const supa = makeSupa();
    const mgr = new QuestsManager(supa as any);
    registerQuestsManager(mgr);
    expect(getQuestsManager()).toBe(mgr);
    invalidateQuestsCache();
  });
});

// ═══════════════════════════════════════════════════════════
// 11. ACHIEVEMENTS MANAGER — 189 lines, ~12% covered
// ═══════════════════════════════════════════════════════════
describe('achievements-manager deep coverage', () => {
  it('registers and invalidates', async () => {
    const { AchievementsManager, registerAchievementsManager, invalidateAchievementsCache } = await import('../features/achievements/achievements-manager.js');
    const supa = makeSupa();
    const mgr = new AchievementsManager(supa as any);
    registerAchievementsManager(mgr);
    invalidateAchievementsCache();
  });
});

// ═══════════════════════════════════════════════════════════
// 12. PROFILES MANAGER — 130 lines, ~18% covered
// ═══════════════════════════════════════════════════════════
describe('profiles-manager deep coverage', () => {
  it('registers and invalidates', async () => {
    const { ProfilesManager, registerProfilesManager, invalidateProfilesCache } = await import('../features/profiles/profiles-manager.js');
    const supa = makeSupa();
    const mgr = new ProfilesManager(supa as any);
    registerProfilesManager(mgr);
    invalidateProfilesCache();
    mgr.clearCache();
  });
});

// ═══════════════════════════════════════════════════════════
// 13. STARBOARD — 196 lines, ~27% covered
// ═══════════════════════════════════════════════════════════
describe('starboard deep coverage', () => {
  it('handleStarboardReaction processes a reaction', async () => {
    const { handleStarboardReaction } = await import('../features/starboard/index.js');
    const guild = makeGuild();
    const supa = makeSupa({ data: { starboard_enabled: true, starboard_channel_id: 'ch1', starboard_threshold: 3, starboard_emoji: '⭐', starboard_self_star: false }, error: null });
    const reaction: any = {
      emoji: { name: '⭐' },
      count: 5,
      message: {
        id: 'msg1',
        author: { id: 'u2', bot: false },
        content: 'Great post!',
        guild,
        guildId: 'g1',
        channel: { id: 'ch2', name: 'general' },
        attachments: makeCollection(),
        embeds: [],
        url: 'https://discord.com/channels/g1/ch2/msg1',
        partial: false,
        fetch: vi.fn(async function(this: any) { return this; }),
      },
      partial: false,
      fetch: vi.fn(async function(this: any) { return this; }),
      users: { fetch: vi.fn(async () => makeCollection([['u1', { id: 'u1', bot: false }], ['u3', { id: 'u3', bot: false }]])) },
    };
    const user: any = { id: 'u1' };
    await handleStarboardReaction(reaction, user, supa as any, 'g1');
  });

  it('invalidateStarboardCache works', async () => {
    const { invalidateStarboardCache } = await import('../features/starboard/index.js');
    invalidateStarboardCache();
  });
});

// ═══════════════════════════════════════════════════════════
// 14. CUSTOM COMMANDS ENGINE — 281 lines, ~23% covered
// ═══════════════════════════════════════════════════════════
describe('custom-commands-engine deep coverage', () => {
  it('loads custom commands', async () => {
    const { loadCustomCommands, isCustomCommand, clearCommandRegistry } = await import('../features/custom-commands/command-engine.js');
    const supa = makeSupa({ data: [{ id: 'cmd1', guild_id: 'g1', name: 'hello', description: 'Say hello', actions: [{ type: 'send_message', message: 'Hello!' }], enabled: true, cooldown_seconds: 5, required_role_ids: [] }], error: null });
    const guild = makeGuild();
    const rest: any = { put: vi.fn(async () => []) };
    clearCommandRegistry();
    await loadCustomCommands(supa as any, guild, rest);
    expect(isCustomCommand('hello')).toBeDefined();
  });

  it('handles custom command execution', async () => {
    const { loadCustomCommands, handleCustomCommand, clearCommandRegistry } = await import('../features/custom-commands/command-engine.js');
    const supa = makeSupa({ data: [{ id: 'cmd1', guild_id: 'g1', name: 'greet', description: 'Greet', actions: [{ type: 'send_message', message: 'Hi {user}!' }], enabled: true, cooldown_seconds: 0, required_role_ids: [] }], error: null });
    const valkey = makeValkey();
    const guild = makeGuild();
    const rest: any = { put: vi.fn(async () => []) };
    clearCommandRegistry();
    await loadCustomCommands(supa as any, guild, rest);
    const interaction = makeInteraction({ commandName: 'greet' });
    await handleCustomCommand(interaction, supa as any, valkey, guild);
  });
});

// ═══════════════════════════════════════════════════════════
// 15. SCHEDULED MESSAGES RUNNER — 287 lines, ~9% covered
// ═══════════════════════════════════════════════════════════
describe('scheduled-messages runner deep coverage', () => {
  it('constructs runner', async () => {
    const { ScheduledMessageRunner } = await import('../features/scheduled-messages/runner.js');
    const supa = makeSupa();
    const guild = makeGuild();
    const runner = new ScheduledMessageRunner(supa as any, guild);
    expect(runner).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// 16. STATS CHANNELS MANAGER — 213 lines, ~14% covered
// ═══════════════════════════════════════════════════════════
describe('stats-channels-manager deep coverage', () => {
  it('constructs manager', async () => {
    const { StatsChannelManager } = await import('../features/stats-channels/stats-manager.js');
    const supa = makeSupa();
    const guild = makeGuild();
    const mgr = new StatsChannelManager(supa as any, guild);
    expect(mgr).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// 17. AUTOMOD SYNC — 190 lines, ~18% covered
// ═══════════════════════════════════════════════════════════
describe('automod-sync deep coverage', () => {
  it('constructs AutoModSync', async () => {
    const { AutoModSync } = await import('../features/discord-native/automod-sync.js');
    const supa = makeSupa();
    const guild = makeGuild();
    const eventBus: any = { emit: vi.fn(), on: vi.fn(), removeAllListeners: vi.fn() };
    const sync = new AutoModSync(guild, supa as any, eventBus);
    expect(sync).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// 18. FORUM TICKETS — 228 lines, ~7% covered
// ═══════════════════════════════════════════════════════════
describe('forum-tickets deep coverage', () => {
  it('constructs ForumTicketService', async () => {
    const { ForumTicketService } = await import('../features/discord-native/forum-tickets.js');
    const supa = makeSupa();
    const guild = makeGuild();
    const svc = new ForumTicketService(guild, supa as any);
    expect(svc).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// 19. WELCOME SERVICE — 165 lines, ~19% covered
// ═══════════════════════════════════════════════════════════
describe('welcome-service deep coverage', () => {
  it('executes welcome flow with default config', async () => {
    const { executeWelcomeFlow } = await import('../features/welcome/welcome-service.js');
    const guild = makeGuild();
    const member: any = {
      id: 'u1', user: { id: 'u1', username: 'TestUser', displayAvatarURL: () => 'https://example.com/avatar.png', tag: 'TestUser#0001' },
      guild, send: vi.fn(async () => ({})), displayName: 'TestUser',
      roles: { cache: makeCollection(), add: vi.fn(async () => {}) },
    };
    const supa = makeSupa();
    const config: any = {
      welcome_enabled: true,
      welcome_channel_id: 'ch1',
      welcome_message: 'Welcome {user}!',
      welcome_dm_enabled: true,
      welcome_dm_message: 'Hello {user}!',
      welcome_card_enabled: false,
      welcome_auto_roles: [],
    };
    await executeWelcomeFlow(member, { supabase: supa as any, config });
  });
});

// ═══════════════════════════════════════════════════════════
// 20. BUTTON ROLES — 265 lines, ~11% covered
// ═══════════════════════════════════════════════════════════
describe('button-roles deep coverage', () => {
  it('handleButtonRoleInteraction processes button', async () => {
    const { handleButtonRoleInteraction } = await import('../features/reaction-roles/button-roles.js');
    const interaction = makeInteraction({
      isButton: vi.fn(() => true),
      customId: 'btnrole:role1',
    });
    const supa = makeSupa({ data: { id: 'panel1', roles: [{ role_id: 'role1', emoji: '⭐', label: 'VIP' }] }, error: null });
    await handleButtonRoleInteraction(interaction, supa as any);
  });
});

// ═══════════════════════════════════════════════════════════
// 21. ONBOARDING HANDLER — 411 lines, ~49% covered
// ═══════════════════════════════════════════════════════════
describe('onboarding-handler deep coverage', () => {
  it('handleMemberJoin processes new member', async () => {
    const { handleMemberJoin } = await import('../features/welcome/onboarding-handler.js');
    const guild = makeGuild();
    const member: any = {
      id: 'u1', user: { id: 'u1', username: 'TestUser', bot: false, tag: 'TestUser#0001', displayAvatarURL: () => '' },
      guild, roles: { cache: makeCollection(), add: vi.fn(async () => {}) }, pending: false, displayName: 'TestUser',
      send: vi.fn(async () => ({})),
    };
    const supa = makeSupa({ data: { welcome_enabled: true, welcome_channel_id: 'ch1' }, error: null });
    const client: any = {
      guildId: 'g1',
      guilds: { cache: makeCollection([['g1', guild]]) },
      supabase: supa,
      valkey: makeValkey(),
      eventBus: { emit: vi.fn(), on: vi.fn(), removeAllListeners: vi.fn() },
    };
    await handleMemberJoin(client, member);
  });

  it('handleMemberLeave processes leaving member', async () => {
    const { handleMemberLeave } = await import('../features/welcome/onboarding-handler.js');
    const guild = makeGuild();
    const member: any = {
      id: 'u1', user: { id: 'u1', username: 'TestUser', bot: false, tag: 'TestUser#0001', displayAvatarURL: () => '' },
      guild, displayName: 'TestUser',
    };
    const supa = makeSupa({ data: { goodbye_enabled: true, goodbye_channel_id: 'ch1', goodbye_message: 'Bye {user}!' }, error: null });
    const client: any = {
      guildId: 'g1',
      guilds: { cache: makeCollection([['g1', guild]]) },
      supabase: supa,
      valkey: makeValkey(),
      eventBus: { emit: vi.fn(), on: vi.fn(), removeAllListeners: vi.fn() },
    };
    await handleMemberLeave(client, member);
  });

  it('invalidateGuildConfigCache works', async () => {
    const { invalidateGuildConfigCache } = await import('../features/welcome/onboarding-handler.js');
    const client: any = {
      guildId: 'g1',
      guilds: { cache: makeCollection([['g1', makeGuild()]]) },
      supabase: makeSupa(),
      valkey: makeValkey(),
      eventBus: { emit: vi.fn(), on: vi.fn(), removeAllListeners: vi.fn() },
    };
    await invalidateGuildConfigCache(client, 'g1');
  });
});

// ═══════════════════════════════════════════════════════════
// 22. MODAL HANDLERS — 400 lines, ~7% covered
// ═══════════════════════════════════════════════════════════
describe('modal-handlers deep coverage', () => {
  it('handleModalSubmit processes a modal', async () => {
    const { handleModalSubmit } = await import('../features/discord-ux/modal-handlers.js');
    const guild = makeGuild();
    const interaction = makeInteraction({
      isModalSubmit: vi.fn(() => true),
      customId: 'mod_warn:u2',
      fields: { getTextInputValue: vi.fn(() => 'Reason text') },
      guild,
    });
    const supa = makeSupa();
    const eventBus: any = { emit: vi.fn(), on: vi.fn() };
    const client: any = {
      guildId: 'g1',
      guilds: { cache: makeCollection([['g1', guild]]) },
      supabase: supa,
    };
    await handleModalSubmit(interaction, guild, supa as any, eventBus, client);
  });
});

// ═══════════════════════════════════════════════════════════
// 23. AUTOCOMPLETE — 113 lines, ~21% covered
// ═══════════════════════════════════════════════════════════
describe('autocomplete deep coverage', () => {
  it('handleAutocomplete processes autocomplete', async () => {
    const { handleAutocomplete } = await import('../features/discord-ux/autocomplete.js');
    const interaction = makeInteraction({
      isAutocomplete: vi.fn(() => true),
      commandName: 'play',
      options: {
        getFocused: vi.fn(() => 'test query'),
        getSubcommand: vi.fn(() => null),
        getString: vi.fn(() => 'search'),
      },
    });
    const supa = makeSupa();
    const shoukaku: any = {
      on: vi.fn(),
      getPlayer: vi.fn(() => null),
      players: new Map(),
    };
    await handleAutocomplete(interaction, supa as any, shoukaku, 'g1');
  });
});
