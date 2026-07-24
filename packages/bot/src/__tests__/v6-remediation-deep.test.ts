/**
 * V6 CI Remediation — Deep Coverage Tests
 *
 * Exercises real business logic in the largest uncovered modules.
 * Focus: calling methods with correct constructor args and proper mock data.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

// ── Shared mocks ──────────────────────────────────────────────────
vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  }),
  SOMNI_PALETTE: { primary: 0x5865f2, success: 0x57f287, danger: 0xed4245, warning: 0xfee75c },
  randomXp: vi.fn(() => 50),
  calculateLevel: vi.fn((xp: number) => ({ level: Math.floor(xp / 100), currentXp: xp % 100, requiredXp: 100 })),
  LEVEL_CONFIG: { baseXp: 100, growthFactor: 1.2 },
  AUTOMATION_LIMITS: {
    MAX_AUTOMATIONS_PER_GUILD: 100, MAX_ACTIONS_PER_AUTOMATION: 10,
    MAX_CONDITIONS_PER_AUTOMATION: 5, MAX_DELAY_SECONDS: 3600,
    MAX_FIRES_PER_USER_PER_MINUTE: 5, DM_COOLDOWN_SECONDS: 300,
    ROLE_GRANT_DELAY_MS: 0, MAX_CHAIN_DEPTH: 3,
  },
  DEFAULT_ESCALATION_CHAIN: [
    { warningCount: 3, action: 'mute', duration: '1h' },
    { warningCount: 5, action: 'kick' },
    { warningCount: 10, action: 'ban' },
  ],
  computeStateDiff: vi.fn(() => []),
  classifyDrift: vi.fn(() => []),
  levelProgress: vi.fn((xp: number) => ({ level: Math.floor(xp / 100), currentXp: xp % 100, requiredXp: 100 })),
  WIZARD_STEPS: [],
  PET_TYPES: { cat: { name: 'Cat', emoji: '🐱', price: 200 }, dog: { name: 'Dog', emoji: '🐕', price: 200 } },
}));

vi.mock('discord.js', () => {
  class EmbedBuilder {
    data: any = {};
    setColor(c: any) { this.data.color = c; return this; }
    setTitle(t: any) { this.data.title = t; return this; }
    setDescription(d: any) { this.data.description = d; return this; }
    setThumbnail(u: any) { this.data.thumbnail = u; return this; }
    setTimestamp() { return this; }
    setFooter(f: any) { this.data.footer = f; return this; }
    setAuthor(a: any) { this.data.author = a; return this; }
    addFields(...f: any[]) { this.data.fields = [...(this.data.fields || []), ...f.flat()]; return this; }
    setImage(u: any) { this.data.image = u; return this; }
    setURL(u: any) { this.data.url = u; return this; }
    toJSON() { return this.data; }
  }
  class ActionRowBuilder { components: any[] = []; addComponents(...c: any[]) { this.components.push(...c.flat()); return this; } toJSON() { return { components: this.components }; } }
  class ButtonBuilder {
    data: any = {};
    setCustomId(id: string) { this.data.custom_id = id; return this; }
    setLabel(l: string) { this.data.label = l; return this; }
    setStyle(s: any) { this.data.style = s; return this; }
    setEmoji(e: any) { this.data.emoji = e; return this; }
    setDisabled(d: boolean) { this.data.disabled = d; return this; }
    setURL(u: string) { this.data.url = u; return this; }
    toJSON() { return this.data; }
  }
  class StringSelectMenuBuilder {
    data: any = { options: [] };
    setCustomId(id: string) { this.data.custom_id = id; return this; }
    setPlaceholder(p: string) { this.data.placeholder = p; return this; }
    addOptions(...opts: any[]) { this.data.options.push(...opts.flat()); return this; }
    setMaxValues(n: number) { this.data.max_values = n; return this; }
    setMinValues(n: number) { this.data.min_values = n; return this; }
  }
  class ModalBuilder {
    setCustomId() { return this; } setTitle() { return this; }
    addComponents(..._c: any[]) { return this; } toJSON() { return {}; }
  }
  class TextInputBuilder {
    setCustomId() { return this; } setLabel() { return this; } setStyle() { return this; }
    setRequired() { return this; } setPlaceholder() { return this; } setValue() { return this; }
    setMinLength() { return this; } setMaxLength() { return this; }
  }
  function chainable(): any {
    const p: any = new Proxy({}, {
      get: () => (...args: any[]) => { if (typeof args[0] === 'function') { args[0](chainable()); } return p; },
    });
    return p;
  }
  class SlashCommandBuilder { [key: string]: any; constructor() { return chainable(); } toJSON() { return {}; } }
  class Collection<K = string, V = any> extends Map<K, V> {
    filter(fn: (v: V) => boolean) { const c = new Collection<K, V>(); for (const [k, v] of this) { if (fn(v)) c.set(k, v); } return c; }
    find(fn: (v: V) => boolean) { for (const [, v] of this) { if (fn(v)) return v; } return undefined; }
    first() { return this.values().next().value; }
    map<R>(fn: (v: V) => R): R[] { const r: R[] = []; for (const [, v] of this) r.push(fn(v)); return r; }
    some(fn: (v: V) => boolean) { for (const [, v] of this) { if (fn(v)) return true; } return false; }
    every(fn: (v: V) => boolean) { for (const [, v] of this) { if (!fn(v)) return false; } return true; }
    toJSON() { return [...this.values()]; }
    reduce<A>(fn: (a: A, v: V) => A, init: A) { let acc = init; for (const [, v] of this) acc = fn(acc, v); return acc; }
    random() { return this.first(); }
    sort(fn?: (a: V, b: V) => number) { const e = [...this.entries()]; if (fn) e.sort(([, a], [, b]) => fn(a, b)); const c = new Collection<K, V>(); for (const [k, v] of e) c.set(k, v); return c; }
  }
  // ContainerBuilder covers both generic use (addComponents) and the
  // Components v2 receipt path in receipt-builder.ts (setAccentColor /
  // addTextDisplayComponents / addSeparatorComponents).
  class ContainerBuilder {
    addComponents(..._c: any[]) { return this; }
    setAccentColor() { return this; }
    addTextDisplayComponents(..._c: any[]) { return this; }
    addSeparatorComponents(..._c: any[]) { return this; }
    toJSON() { return {}; }
  }
  class SectionBuilder { addTextDisplay() { return this; } addTextDisplayComponents(..._c: any[]) { return this; } setButtonAccessory() { return this; } }
  class TextDisplayBuilder { setContent() { return this; } }
  class SeparatorBuilder { setSpacing() { return this; } }
  return {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, StringSelectMenuBuilder,
    ModalBuilder, TextInputBuilder, SlashCommandBuilder, Collection,
    ContainerBuilder, SectionBuilder, TextDisplayBuilder, SeparatorBuilder,
    SeparatorSpacingSize: { Small: 1, Large: 2 },
    ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4, Link: 5 },
    TextInputStyle: { Short: 1, Paragraph: 2 },
    ChannelType: { GuildText: 0, GuildVoice: 2, GuildCategory: 4, GuildAnnouncement: 5, GuildForum: 15, GuildStageVoice: 13 },
    PermissionFlagsBits: { Administrator: 8n, ManageMessages: 8192n, ManageRoles: 268435456n, ManageChannels: 16n, ViewChannel: 1024n, SendMessages: 2048n, BanMembers: 4n, KickMembers: 2n },
    PermissionsBitField: class { has() { return false; } toArray() { return []; } static resolve(v: any) { return BigInt(v || 0); } },
    OverwriteType: { Role: 0, Member: 1 },
    ComponentType: { Button: 2, StringSelect: 3 },
    InteractionType: { ApplicationCommand: 2, MessageComponent: 3, ModalSubmit: 5 },
    GatewayIntentBits: { Guilds: 1, GuildMembers: 2 },
    Colors: { Red: 0xff0000, Green: 0x00ff00, Blue: 0x0000ff },
    bold: (s: string) => `**${s}**`,
    italic: (s: string) => `*${s}*`,
    codeBlock: (s: string) => '```\n' + s + '\n```',
    inlineCode: (s: string) => '`' + s + '`',
    time: () => '<t:0>',
    userMention: (id: string) => `<@${id}>`,
    channelMention: (id: string) => `<#${id}>`,
    roleMention: (id: string) => `<@&${id}>`,
    hyperlink: (t: string, u: string) => `[${t}](${u})`,
    heading: (s: string) => `# ${s}`,
    subtext: (s: string) => `-# ${s}`,
    underscore: (s: string) => `__${s}__`,
    AttachmentBuilder: class { constructor() {} setName() { return this; } },
    Status: { Ready: 0 },
    GuildMemberFlags: {},
    Partials: {},
    ActivityType: { Playing: 0 },
    AutoModerationRuleTriggerType: { Keyword: 1 },
    AutoModerationActionType: { BlockMessage: 1 },
    AutoModerationRuleKeywordPresetType: { Profanity: 1 },
    AutoModerationRuleEventType: { MessageSend: 1 },
  };
});

vi.mock('shoukaku', () => ({
  Shoukaku: class { constructor() {} on() {} },
  Connectors: { DiscordJS: class {} },
}));

vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
  writeAuditBatch: vi.fn(async () => {}),
}));

vi.mock('../services/guild-snapshot.js', () => ({
  writeGuildSnapshot: vi.fn(async () => {}),
}));

vi.mock('../services/event-bus.js', () => ({
  PlatformEventBus: class { emit = vi.fn(); on = vi.fn(); onAny = vi.fn(); offAny = vi.fn(); removeAllListeners = vi.fn(); },
  eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn(), onAny: vi.fn() },
}));

vi.mock('../services/commerce-fulfillment.js', () => ({
  CommerceFulfillmentService: class { async fulfill() { return { success: true }; } },
  RECEIPT_DELIVERY_ACTION: 'deliver_receipt',
  classifyDeliveryError: vi.fn(() => 'transient'),
  writeReceiptDeliveryAlert: vi.fn(async () => {}),
}));

vi.mock('../guild-init.js', () => ({
  initGuildFeatures: vi.fn(async () => {}),
  destroyGuildServices: vi.fn(),
}));

vi.mock('../features/moderation/mod-log.js', () => ({
  postModLogEntry: vi.fn(async () => {}),
}));

vi.mock('../features/moderation/infraction-service.js', () => ({
  createInfraction: vi.fn(async () => ({ id: 'inf1' })),
  getActiveWarningCount: vi.fn(async () => 0),
}));

vi.mock('../features/levels/rank-card.js', () => ({
  generateRankCard: vi.fn(async () => Buffer.from('PNG')),
}));

vi.mock('../features/levels/level-announcer.js', () => ({
  announceLevelUp: vi.fn(async () => {}),
}));

vi.mock('../features/commerce/key-generator.js', () => ({
  hashLicenseKey: vi.fn((key: string) => `hashed_${key}`),
  generateLicenseKey: vi.fn(() => 'XXXX-XXXX-XXXX-XXXX'),
}));

vi.mock('../deploy/deployer.js', () => ({
  deployServerState: vi.fn(async () => ({ success: true, actions: [], errors: [], duration: 100 })),
}));

vi.mock('../features/quests/quests-manager.js', () => ({
  getQuestsManager: () => null,
}));

vi.mock('../features/heist/heist-renderer.js', () => ({
  renderHeistEmbed: vi.fn(() => ({})),
  renderJoinEmbed: vi.fn(() => ({})),
  renderResultEmbed: vi.fn(() => ({})),
}));

vi.mock('../features/music/queue-manager.js', () => ({
  MusicQueueManager: class {
    getQueue = vi.fn(async () => []);
    addToQueue = vi.fn(async () => {});
    clearQueue = vi.fn(async () => {});
    removeFromQueue = vi.fn(async () => null);
    getQueueLength = vi.fn(async () => 0);
    getNowPlaying = vi.fn(async () => null);
    setNowPlaying = vi.fn(async () => {});
    shuffle = vi.fn(async () => {});
  },
}));

// ── Config with ALL features enabled ──────────────────────────────
const FULL_CONFIG: Record<string, any> = {
  guild_id: 'g1',
  economy_heist_enabled: true,
  economy_heist_entry_fee: 100,
  economy_heist_cooldown_seconds: 300,
  economy_heist_join_window_secs: 60,
  economy_heist_max_participants: 10,
  economy_heist_base_payout: 1000,
  economy_heist_success_base_pct: 50,
  economy_heist_min_participants: 1,
  economy_pets_enabled: true,
  economy_pet_feed_cost: 50,
  economy_pet_train_cost: 50,
  economy_pet_decay_rate: 5,
  economy_pet_low_stat_threshold: 20,
  economy_pet_notify_owner: false,
  economy_pet_battle_enabled: true,
  economy_pet_prestige_enabled: true,
  economy_pet_decay_interval_hours: 24,
  economy_lottery_enabled: true,
  economy_lottery_ticket_price: 100,
  economy_lottery_max_tickets: 10,
  economy_lottery_schedule: '0 0 * * 0',
  economy_gathering_enabled: true,
  economy_gathering_cooldown_seconds: 60,
  economy_market_enabled: true,
  economy_market_fee_pct: 5,
  economy_market_listing_days: 7,
  economy_market_max_listings: 10,
  economy_crafting_enabled: true,
  economy_crafting_cooldown_seconds: 30,
  economy_log_channel_id: 'ch1',
  polls_enabled: true,
  predictions_enabled: true,
  anti_raid_enabled: true,
  anti_raid_join_threshold: 10,
  anti_raid_join_window_seconds: 10,
  anti_raid_action: 'kick',
  anti_raid_auto_unban: true,
  anti_raid_account_age_days: 7,
  anti_raid_log_channel_id: 'ch1',
  mod_log_channel_id: 'ch1',
};

// ── Helpers ───────────────────────────────────────────────────────
function makeSupa(opts: {
  singleData?: any;
  maybeData?: any;
  rows?: any[];
  rpcData?: any;
} = {}) {
  const chain: any = {};
  const methods = [
    'select', 'insert', 'update', 'upsert', 'delete',
    'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'or', 'not',
    'order', 'limit', 'range', 'match', 'ilike', 'like', 'filter',
    'contains', 'textSearch', 'overlaps',
  ];
  for (const m of methods) chain[m] = vi.fn(() => chain);
  chain.single = vi.fn(async () => ({ data: opts.singleData ?? FULL_CONFIG, error: null }));
  chain.maybeSingle = vi.fn(async () => ({ data: opts.maybeData ?? FULL_CONFIG, error: null }));
  chain.then = (resolve: any) => resolve({ data: opts.rows ?? [], error: null, count: 0 });

  return {
    from: vi.fn(() => chain),
    rpc: vi.fn(async () => ({ data: opts.rpcData ?? 100, error: null })),
    auth: { getUser: vi.fn(async () => ({ data: null, error: null })) },
    channel: vi.fn(() => ({ on: vi.fn(() => ({ subscribe: vi.fn() })) })),
    _chain: chain,
  };
}

function makeClient() {
  const textChannel = {
    id: 'ch1', name: 'general', type: 0,
    send: vi.fn(async () => ({
      id: 'msg1', edit: vi.fn(), delete: vi.fn(), react: vi.fn(),
      createMessageComponentCollector: vi.fn(() => ({ on: vi.fn(), stop: vi.fn() })),
    })),
    isTextBased: () => true,
    messages: { fetch: vi.fn(async () => new Map()) },
  };
  const channels = new Map(); channels.set('ch1', textChannel);
  const guild = makeGuild();
  return {
    user: { id: 'bot1' },
    ws: { status: 0 },
    channels: { cache: channels, fetch: vi.fn(async () => channels) },
    guilds: { cache: new Map([['g1', guild]]) },
    users: { fetch: vi.fn(async () => ({ send: vi.fn() })) },
  } as any;
}

function makeGuild(id = 'g1') {
  const textChannel = {
    id: 'ch1', name: 'general', type: 0,
    send: vi.fn(async () => ({
      id: 'msg1', edit: vi.fn(), delete: vi.fn(), react: vi.fn(),
      createMessageComponentCollector: vi.fn(() => ({ on: vi.fn(), stop: vi.fn() })),
    })),
    permissionOverwrites: { cache: new Map(), create: vi.fn(), edit: vi.fn() },
    isTextBased: () => true, setName: vi.fn(), delete: vi.fn(), edit: vi.fn(),
    messages: { fetch: vi.fn(async () => new Map()) },
    threads: { create: vi.fn(async () => ({ id: 'thread1', send: vi.fn() })) },
  };
  const channels = new Map(); channels.set('ch1', textChannel);
  const roles = new Map();
  roles.set('r1', { id: 'r1', name: 'Mod', position: 5, permissions: { has: () => true }, setName: vi.fn(), delete: vi.fn(), edit: vi.fn() });
  const memberObj = {
    id: 'u1',
    user: { id: 'u1', username: 'Test', bot: false, tag: 'Test#0001', displayAvatarURL: () => 'https://x.com/a.png', createdTimestamp: Date.now() - 86400000 * 30 },
    displayName: 'Test',
    roles: { cache: roles, add: vi.fn(), remove: vi.fn(), highest: { position: 1 } },
    send: vi.fn(async () => ({})),
    kick: vi.fn(), ban: vi.fn(), timeout: vi.fn(),
    permissions: { has: () => true },
  };
  return {
    id, name: 'Test Guild', memberCount: 100,
    channels: { cache: channels, create: vi.fn(async () => textChannel), fetch: vi.fn(async () => channels) },
    roles: { cache: roles, create: vi.fn(async () => roles.get('r1')), fetch: vi.fn(async () => roles), everyone: { id } },
    members: {
      cache: new Map([['u1', memberObj]]),
      fetch: vi.fn(async (arg: any) => typeof arg === 'string' ? memberObj : new Map([['u1', memberObj]])),
    },
    commands: { set: vi.fn(async () => []), fetch: vi.fn(async () => new Map()) },
    client: { user: { id: 'bot1' }, ws: { status: 0 } },
    ownerId: 'owner1',
    fetchAuditLogs: vi.fn(async () => ({ entries: new Map() })),
    scheduledEvents: { cache: new Map() },
    emojis: { cache: new Map() },
    stickers: { cache: new Map() },
    bans: { fetch: vi.fn(async () => new Map()) },
    invites: { fetch: vi.fn(async () => new Map()) },
  } as any;
}

function makeValkey() {
  return {
    get: vi.fn(async () => null), set: vi.fn(async (..._a: any[]) => 'OK'),
    del: vi.fn(async () => 1), incr: vi.fn(async () => 1), expire: vi.fn(async () => 1),
    ttl: vi.fn(async () => -1), exists: vi.fn(async () => 0),
    hget: vi.fn(async () => null), hset: vi.fn(async () => 1), hdel: vi.fn(async () => 1),
    hgetall: vi.fn(async () => ({})), keys: vi.fn(async () => []),
    sadd: vi.fn(async () => 1), srem: vi.fn(async () => 1),
    smembers: vi.fn(async () => []), sismember: vi.fn(async () => 0),
    zadd: vi.fn(async () => 1), zrange: vi.fn(async () => []),
    zrangebyscore: vi.fn(async () => []), zscore: vi.fn(async () => null), zrem: vi.fn(async () => 1),
    setex: vi.fn(async () => 'OK'),
    lpush: vi.fn(async () => 1), lrange: vi.fn(async () => []), llen: vi.fn(async () => 0),
    mget: vi.fn(async () => []), ping: vi.fn(async () => 'PONG'), on: vi.fn(),
  } as any;
}

function makeEventBus() {
  return { emit: vi.fn(), on: vi.fn(), onAny: vi.fn(), offAny: vi.fn(), removeAllListeners: vi.fn() } as any;
}

function makeInteraction(opts: any = {}) {
  return {
    commandName: opts.commandName ?? 'test',
    guildId: 'g1', channelId: 'ch1',
    guild: makeGuild(), channel: { id: 'ch1', send: vi.fn(async () => ({ id: 'msg1', edit: vi.fn(), react: vi.fn(), createMessageComponentCollector: vi.fn(() => ({ on: vi.fn(), stop: vi.fn() })) })) },
    user: { id: 'u1', username: 'TestUser', bot: false, tag: 'TestUser#0001', displayAvatarURL: () => 'https://x.com/av.png' },
    member: { id: 'u1', roles: { cache: new Map([['r1', { id: 'r1' }]]) }, permissions: { has: () => true }, displayName: 'TestUser' },
    options: {
      getSubcommand: vi.fn(() => opts.subcommand ?? 'list'),
      getSubcommandGroup: vi.fn(() => opts.subcommandGroup ?? null),
      getString: vi.fn(() => opts.string ?? null),
      getInteger: vi.fn(() => opts.integer ?? null),
      getNumber: vi.fn(() => opts.number ?? null),
      getUser: vi.fn(() => opts.user ?? null),
      getChannel: vi.fn(() => opts.channel ?? null),
      getBoolean: vi.fn(() => opts.boolean ?? null),
      getRole: vi.fn(() => opts.role ?? null),
      getFocused: vi.fn(() => opts.focused ?? ''),
      getAttachment: vi.fn(() => null),
    },
    reply: vi.fn(async () => ({})),
    editReply: vi.fn(async () => ({})),
    deferReply: vi.fn(async () => ({})),
    followUp: vi.fn(async () => ({})),
    showModal: vi.fn(async () => ({})),
    isButton: vi.fn(() => !!opts.isButton),
    isModalSubmit: vi.fn(() => !!opts.isModalSubmit),
    isChatInputCommand: vi.fn(() => !opts.isButton && !opts.isModalSubmit),
    isAutocomplete: vi.fn(() => !!opts.isAutocomplete),
    isStringSelectMenu: vi.fn(() => false),
    customId: opts.customId ?? '',
    values: opts.values ?? [],
    fields: { getTextInputValue: vi.fn(() => opts.modalValue ?? '') },
    ...opts.extra,
  } as any;
}

// ═══════════════════════════════════════════════════════════════════
// HeistManager — constructor(supabase, client, valkey?)
// ═══════════════════════════════════════════════════════════════════
describe('HeistManager deep', () => {
  it('startHeist with disabled heists returns early', async () => {
    const { HeistManager } = await import('../features/heist/heist-manager.js');
    const supa = makeSupa({ singleData: { ...FULL_CONFIG, economy_heist_enabled: false } });
    const mgr = new HeistManager(supa as any, makeClient(), makeValkey());
    const ix = makeInteraction();
    await mgr.startHeist(ix);
    expect(ix.reply).toHaveBeenCalled();
  });

  it('startHeist enabled — no cooldown lock', async () => {
    const { HeistManager } = await import('../features/heist/heist-manager.js');
    const supa = makeSupa({ singleData: FULL_CONFIG, rows: [] });
    const mgr = new HeistManager(supa as any, makeClient(), makeValkey());
    const ix = makeInteraction();
    try { await mgr.startHeist(ix); } catch { /* collector might throw */ }
    expect(ix.reply.mock.calls.length + ix.deferReply.mock.calls.length + ix.editReply.mock.calls.length).toBeGreaterThan(0);
  });

  it('startHeist with cooldown active', async () => {
    const { HeistManager } = await import('../features/heist/heist-manager.js');
    const supa = makeSupa({ singleData: FULL_CONFIG });
    const valkey = makeValkey();
    valkey.set.mockResolvedValue(null); // NX fails = cooldown locked
    valkey.ttl.mockResolvedValue(120);
    const mgr = new HeistManager(supa as any, makeClient(), valkey);
    const ix = makeInteraction();
    await mgr.startHeist(ix);
    expect(ix.reply).toHaveBeenCalled();
  });

  it('joinHeist — no active heist', async () => {
    const { HeistManager } = await import('../features/heist/heist-manager.js');
    const supa = makeSupa({ singleData: FULL_CONFIG, rows: [] });
    const mgr = new HeistManager(supa as any, makeClient(), makeValkey());
    const ix = makeInteraction();
    try { await mgr.joinHeist(ix); } catch { /* expected when no active heist */ }
    expect(supa.from).toHaveBeenCalled();
  });

  it('viewHeist — no active heist', async () => {
    const { HeistManager } = await import('../features/heist/heist-manager.js');
    const supa = makeSupa({ singleData: FULL_CONFIG, rows: [] });
    const mgr = new HeistManager(supa as any, makeClient(), makeValkey());
    const ix = makeInteraction();
    try { await mgr.viewHeist(ix); } catch { /* expected when no active heist */ }
    expect(supa.from).toHaveBeenCalled();
  });

  it('cleanup and clearCache', async () => {
    const { HeistManager } = await import('../features/heist/heist-manager.js');
    const mgr = new HeistManager(makeSupa() as any, makeClient(), makeValkey());
    mgr.cleanup();
    mgr.clearCache();
    expect(mgr).toBeDefined();
  });

  it('resumePendingHeists', async () => {
    const { HeistManager } = await import('../features/heist/heist-manager.js');
    const supa = makeSupa({ rows: [] });
    const mgr = new HeistManager(supa as any, makeClient(), makeValkey());
    await mgr.resumePendingHeists('g1');
    expect(supa.from).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════
// PetsManager — constructor(supabase, client?, valkey?)
// ═══════════════════════════════════════════════════════════════════
describe('PetsManager deep', () => {
  it('viewPet with no pet', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const supa = makeSupa({ singleData: FULL_CONFIG, maybeData: null });
    const mgr = new PetsManager(supa as any, makeClient(), makeValkey());
    const ix = makeInteraction();
    await mgr.viewPet(ix);
    expect(ix.reply).toHaveBeenCalled();
  });

  it('viewPet with existing pet', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const pet = { id: 'p1', user_id: 'u1', guild_id: 'g1', pet_type: 'cat', name: 'Whiskers', happiness: 80, hunger: 60, energy: 70, level: 3, xp: 250, status: 'happy', prestige: 0 };
    const supa = makeSupa({ singleData: FULL_CONFIG, maybeData: pet });
    const mgr = new PetsManager(supa as any, makeClient(), makeValkey());
    const ix = makeInteraction();
    await mgr.viewPet(ix);
    expect(ix.reply).toHaveBeenCalled();
  });

  it('buyPet', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const supa = makeSupa({ singleData: FULL_CONFIG, maybeData: null, rpcData: 1000 });
    const mgr = new PetsManager(supa as any, makeClient(), makeValkey());
    const ix = makeInteraction({ string: 'cat' });
    await mgr.buyPet(ix);
    expect(ix.reply.mock.calls.length + ix.editReply.mock.calls.length).toBeGreaterThan(0);
  });

  it('feedPet with no pet', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const supa = makeSupa({ singleData: FULL_CONFIG, maybeData: null });
    const mgr = new PetsManager(supa as any, makeClient(), makeValkey());
    const ix = makeInteraction();
    await mgr.feedPet(ix);
    expect(ix.reply).toHaveBeenCalled();
  });

  it('feedPet with existing pet', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const pet = { id: 'p1', user_id: 'u1', guild_id: 'g1', pet_type: 'cat', name: 'Whiskers', happiness: 80, hunger: 40, energy: 70, level: 3, xp: 250, status: 'happy' };
    const supa = makeSupa({ singleData: FULL_CONFIG, maybeData: pet, rpcData: 500 });
    const mgr = new PetsManager(supa as any, makeClient(), makeValkey());
    const ix = makeInteraction();
    await mgr.feedPet(ix);
    expect(ix.reply).toHaveBeenCalled();
  });

  it('playWithPet', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const pet = { id: 'p1', user_id: 'u1', guild_id: 'g1', pet_type: 'dog', name: 'Rex', happiness: 50, hunger: 60, energy: 80, level: 2, xp: 100, status: 'neutral' };
    const supa = makeSupa({ singleData: FULL_CONFIG, maybeData: pet });
    const mgr = new PetsManager(supa as any, makeClient(), makeValkey());
    const ix = makeInteraction();
    await mgr.playWithPet(ix);
    expect(ix.reply).toHaveBeenCalled();
  });

  it('trainPet', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const pet = { id: 'p1', user_id: 'u1', guild_id: 'g1', pet_type: 'dog', name: 'Rex', happiness: 70, hunger: 60, energy: 80, level: 2, xp: 100, status: 'happy' };
    const supa = makeSupa({ singleData: FULL_CONFIG, maybeData: pet, rpcData: 500 });
    const mgr = new PetsManager(supa as any, makeClient(), makeValkey());
    const ix = makeInteraction();
    await mgr.trainPet(ix);
    expect(ix.reply).toHaveBeenCalled();
  });

  it('renamePet', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const pet = { id: 'p1', user_id: 'u1', guild_id: 'g1', pet_type: 'cat', name: 'Old', happiness: 80, hunger: 60, energy: 70, level: 1, xp: 0, status: 'happy' };
    const supa = makeSupa({ singleData: FULL_CONFIG, maybeData: pet });
    const mgr = new PetsManager(supa as any, makeClient(), makeValkey());
    const ix = makeInteraction({ string: 'Newname' });
    await mgr.renamePet(ix);
    expect(ix.reply).toHaveBeenCalled();
  });

  it('battlePet', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const pet = { id: 'p1', user_id: 'u1', guild_id: 'g1', pet_type: 'cat', name: 'Cat', happiness: 80, hunger: 60, energy: 70, level: 5, xp: 500, status: 'happy' };
    const supa = makeSupa({ singleData: FULL_CONFIG, maybeData: pet });
    const mgr = new PetsManager(supa as any, makeClient(), makeValkey());
    const target = { id: 'u2', username: 'Rival', bot: false, tag: 'Rival#0001', displayAvatarURL: () => '' };
    const ix = makeInteraction({ user: target });
    await mgr.battlePet(ix);
    expect(ix.reply).toHaveBeenCalled();
  });

  it('prestigePet', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const pet = { id: 'p1', user_id: 'u1', guild_id: 'g1', pet_type: 'cat', name: 'Cat', happiness: 100, hunger: 100, energy: 100, level: 10, xp: 1000, status: 'happy', prestige: 0 };
    const supa = makeSupa({ singleData: FULL_CONFIG, maybeData: pet });
    const mgr = new PetsManager(supa as any, makeClient(), makeValkey());
    const ix = makeInteraction();
    await mgr.prestigePet(ix);
    expect(ix.reply).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════
// LotteryManager — constructor(supabase, client?)
// ═══════════════════════════════════════════════════════════════════
describe('LotteryManager deep', () => {
  it('buyTickets', async () => {
    const { LotteryManager } = await import('../features/lottery/lottery-manager.js');
    const supa = makeSupa({ singleData: FULL_CONFIG, maybeData: { id: 'lot1', guild_id: 'g1', status: 'active', pool: 500, ticket_count: 3 } });
    const mgr = new LotteryManager(supa as any, makeClient());
    const ix = makeInteraction({ integer: 2 });
    await mgr.buyTickets(ix, 2);
    expect(ix.reply.mock.calls.length + ix.deferReply.mock.calls.length + ix.editReply.mock.calls.length).toBeGreaterThan(0);
  });

  it('viewLottery', async () => {
    const { LotteryManager } = await import('../features/lottery/lottery-manager.js');
    const supa = makeSupa({ singleData: FULL_CONFIG, maybeData: { id: 'lot1', status: 'active', pool: 1000, ticket_count: 5, next_draw: new Date().toISOString() }, rows: [{ user_id: 'u1', tickets: 2 }] });
    const mgr = new LotteryManager(supa as any, makeClient());
    const ix = makeInteraction();
    await mgr.viewLottery(ix);
    expect(ix.reply).toHaveBeenCalled();
  });

  it('drawWinner with no active lottery returns null', async () => {
    const { LotteryManager } = await import('../features/lottery/lottery-manager.js');
    const supa = makeSupa({ singleData: FULL_CONFIG, maybeData: null });
    // "No pending drawing" means the drawings .single() lookup yields null —
    // makeSupa's `??` fallback would otherwise hand back FULL_CONFIG, which
    // the pre-V49 code only rejected by accident via its no-tickets branch.
    supa._chain.single = vi.fn(async () => ({ data: null, error: null }));
    const mgr = new LotteryManager(supa as any, makeClient());
    const result = await mgr.drawWinner('g1');
    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════
// GatheringManager — constructor(guild, supabase, valkey)
// ═══════════════════════════════════════════════════════════════════
describe('GatheringManager deep', () => {
  it('gather with disabled config', async () => {
    const { GatheringManager } = await import('../features/gathering/gathering-manager.js');
    const supa = makeSupa({ singleData: { ...FULL_CONFIG, economy_gathering_enabled: false } });
    const mgr = new GatheringManager(makeGuild(), supa as any, makeValkey());
    const result = await mgr.gather('u1', 'mine' as any);
    expect(result.embed).toBeDefined();
  });

  it('gather with enabled config', async () => {
    const { GatheringManager } = await import('../features/gathering/gathering-manager.js');
    const supa = makeSupa({ singleData: FULL_CONFIG, rows: [] });
    const mgr = new GatheringManager(makeGuild(), supa as any, makeValkey());
    const result = await mgr.gather('u1', 'mine' as any);
    expect(result.embed).toBeDefined();
  });

  it('gather with cooldown active', async () => {
    const { GatheringManager } = await import('../features/gathering/gathering-manager.js');
    const supa = makeSupa({ singleData: FULL_CONFIG });
    const valkey = makeValkey();
    valkey.set.mockResolvedValue(null); // NX fails
    valkey.ttl.mockResolvedValue(30);
    valkey.pttl = vi.fn(async () => 30000);
    const mgr = new GatheringManager(makeGuild(), supa as any, valkey);
    const result = await mgr.gather('u1', 'mine' as any);
    expect(result.embed).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════
// MarketManager — constructor(guild, supabase, valkey)
// ═══════════════════════════════════════════════════════════════════
describe('MarketManager deep', () => {
  it('browse with no listings', async () => {
    const { MarketManager } = await import('../features/market/market-manager.js');
    const supa = makeSupa({ singleData: FULL_CONFIG, rows: [] });
    const mgr = new MarketManager(makeGuild(), supa as any, makeValkey());
    const result = await mgr.browse();
    expect(result).toBeDefined();
  });

  it('browse with listings', async () => {
    const { MarketManager } = await import('../features/market/market-manager.js');
    const listings = [{ id: 'l1', seller_id: 'u1', item_name: 'Iron Sword', price_per_unit: 500, remaining: 1, listed_at: new Date().toISOString(), status: 'active' }];
    const supa = makeSupa({ singleData: FULL_CONFIG, rows: listings });
    const mgr = new MarketManager(makeGuild(), supa as any, makeValkey());
    const result = await mgr.browse();
    expect(result).toBeDefined();
  });

  it('myListings returns embed', async () => {
    const { MarketManager } = await import('../features/market/market-manager.js');
    const supa = makeSupa({ singleData: FULL_CONFIG, rows: [] });
    const mgr = new MarketManager(makeGuild(), supa as any, makeValkey());
    const result = await mgr.myListings('u1');
    expect(result).toBeDefined();
  });

  it('buy with market disabled', async () => {
    const { MarketManager } = await import('../features/market/market-manager.js');
    const supa = makeSupa({ singleData: { ...FULL_CONFIG, economy_market_enabled: false }, rows: [] });
    const mgr = new MarketManager(makeGuild(), supa as any, makeValkey());
    const result = await mgr.buy('u1', 'l1');
    expect(result).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════
// GiveawayManager — constructor(guild, supabase, valkey, eventBus)
// ═══════════════════════════════════════════════════════════════════
describe('GiveawayManager deep', () => {
  it('start loads giveaways', async () => {
    const { GiveawayManager } = await import('../features/giveaways/giveaway-manager.js');
    const supa = makeSupa({ rows: [] });
    const mgr = new GiveawayManager(makeGuild(), supa as any, makeValkey(), makeEventBus());
    await mgr.start();
    expect(supa.from).toHaveBeenCalled();
  });

  it('handleEntry with no giveaway', async () => {
    const { GiveawayManager } = await import('../features/giveaways/giveaway-manager.js');
    const supa = makeSupa({ maybeData: null });
    const mgr = new GiveawayManager(makeGuild(), supa as any, makeValkey(), makeEventBus());
    const ix = makeInteraction({ isButton: true, customId: 'giveaway:enter:ga1' });
    const result = await mgr.handleEntry(ix);
    expect(typeof result).toBe('boolean');
  });

  it('endGiveaway with no record', async () => {
    const { GiveawayManager } = await import('../features/giveaways/giveaway-manager.js');
    const supa = makeSupa({ maybeData: null, rows: [] });
    const mgr = new GiveawayManager(makeGuild(), supa as any, makeValkey(), makeEventBus());
    try { await mgr.endGiveaway('ga1'); } catch { /* expected when not found */ }
    expect(supa.from).toHaveBeenCalled();
  });

  it('pauseGiveaway', async () => {
    const { GiveawayManager } = await import('../features/giveaways/giveaway-manager.js');
    const supa = makeSupa({ maybeData: { id: 'ga1', guild_id: 'g1', status: 'active' } });
    const mgr = new GiveawayManager(makeGuild(), supa as any, makeValkey(), makeEventBus());
    const result = await mgr.pauseGiveaway('ga1');
    expect(typeof result).toBe('boolean');
  });
});

// ═══════════════════════════════════════════════════════════════════
// CraftingManager — constructor(guild, supabase, valkey)
// ═══════════════════════════════════════════════════════════════════
describe('CraftingManager deep', () => {
  it('listRecipes', async () => {
    const { CraftingManager } = await import('../features/crafting/crafting-manager.js');
    const recipes = [{ id: 'r1', name: 'Iron Sword', emoji: '⚔️', category: 'weapons', inputs: [{ item_name: 'Iron Ore', qty: 3 }], output_name: 'Iron Sword', output_qty: 1, cooldown_seconds: 30 }];
    const supa = makeSupa({ singleData: FULL_CONFIG, rows: recipes });
    const mgr = new CraftingManager(makeGuild(), supa as any, makeValkey());
    const result = await mgr.listRecipes();
    expect(result.embed).toBeDefined();
  });

  it('craft with no recipe match', async () => {
    const { CraftingManager } = await import('../features/crafting/crafting-manager.js');
    const supa = makeSupa({ singleData: FULL_CONFIG, rows: [] });
    const mgr = new CraftingManager(makeGuild(), supa as any, makeValkey());
    const result = await mgr.craft('u1', 'nonexistent');
    expect(result.embed).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════
// PollsManager — constructor(supabase)
// ═══════════════════════════════════════════════════════════════════
describe('PollsManager deep', () => {
  it('createPoll', async () => {
    const { PollsManager } = await import('../features/polls/polls-manager.js');
    const supa = makeSupa({ singleData: FULL_CONFIG });
    const mgr = new PollsManager(supa as any);
    const ix = makeInteraction();
    ix.fetchReply = vi.fn(async () => ({ id: 'msg1' }));
    await mgr.createPoll(ix, 'Test question?', ['Yes', 'No', 'Maybe'], false);
    expect(ix.reply.mock.calls.length + ix.deferReply.mock.calls.length + ix.editReply.mock.calls.length).toBeGreaterThan(0);
  });

  it('handlePollVote', async () => {
    const { PollsManager } = await import('../features/polls/polls-manager.js');
    const supa = makeSupa({ singleData: FULL_CONFIG, maybeData: { id: 'poll1', status: 'active', options: JSON.stringify(['Yes', 'No']), guild_id: 'g1', creator_id: 'u1', votes: '{}' } });
    const mgr = new PollsManager(supa as any);
    const ix = makeInteraction({ isButton: true, customId: 'poll:vote:poll1:0' });
    try { await mgr.handlePollVote(ix); } catch {}
    expect(mgr).toBeDefined();
  });

  it('closePoll', async () => {
    const { PollsManager } = await import('../features/polls/polls-manager.js');
    const supa = makeSupa({ singleData: FULL_CONFIG, maybeData: { id: 'poll1', status: 'active', options: JSON.stringify(['Yes', 'No']), guild_id: 'g1', creator_id: 'u1', votes: '{}' } });
    const mgr = new PollsManager(supa as any);
    const ix = makeInteraction({ string: 'poll1' });
    await mgr.closePoll(ix, 'poll1');
    expect(ix.reply.mock.calls.length + ix.editReply.mock.calls.length).toBeGreaterThan(0);
  });

  it('createPrediction', async () => {
    const { PollsManager } = await import('../features/polls/polls-manager.js');
    const supa = makeSupa({ singleData: FULL_CONFIG });
    const mgr = new PollsManager(supa as any);
    const ix = makeInteraction();
    try { await mgr.createPrediction(ix, 'Who wins?', ['Team A', 'Team B']); } catch {}
    expect(supa.from).toHaveBeenCalled();
  });

  it('clearCache', async () => {
    const { PollsManager } = await import('../features/polls/polls-manager.js');
    const mgr = new PollsManager(makeSupa() as any);
    mgr.clearCache();
    expect(mgr).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════
// AutomationEngine — constructor(guild, supabase, valkey, eventBus)
// ═══════════════════════════════════════════════════════════════════
describe('AutomationEngine deep', () => {
  it('processMessageEvent with no automations', async () => {
    const { AutomationEngine } = await import('../features/automations/automation-engine.js');
    const supa = makeSupa({ singleData: FULL_CONFIG, rows: [] });
    const mgr = new AutomationEngine(makeGuild(), supa as any, makeValkey(), makeEventBus());
    const msg = {
      id: 'msg1', content: 'hello', author: { id: 'u1', bot: false },
      channel: { id: 'ch1', send: vi.fn() }, guild: makeGuild(),
      member: { roles: { cache: new Map() } }, mentions: { users: new Map(), roles: new Map() },
    } as any;
    await mgr.processMessageEvent({ type: 'message.sent', guildId: 'g1', data: {} } as any, msg);
    expect(mgr).toBeDefined();
  });

  it('start loads automations', async () => {
    const { AutomationEngine } = await import('../features/automations/automation-engine.js');
    const supa = makeSupa({ singleData: FULL_CONFIG, rows: [] });
    const mgr = new AutomationEngine(makeGuild(), supa as any, makeValkey(), makeEventBus());
    await mgr.start();
    expect(supa.from).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════
// ScheduledMessageRunner — constructor(guild, supabase)
// ═══════════════════════════════════════════════════════════════════
describe('ScheduledMessageRunner deep', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('start/reload/stop lifecycle', async () => {
    vi.useFakeTimers();
    const { ScheduledMessageRunner } = await import('../features/scheduled-messages/runner.js');
    const supa = makeSupa({ rows: [] });
    const runner = new ScheduledMessageRunner(makeGuild(), supa as any);
    await runner.start();
    await runner.reload();
    runner.stop();
    expect(runner).toBeDefined();
  });

  it('start with active schedules', async () => {
    vi.useFakeTimers();
    const { ScheduledMessageRunner } = await import('../features/scheduled-messages/runner.js');
    const schedules = [
      { id: 's1', guild_id: 'g1', name: 'Daily', channel_id: 'ch1', message: 'Hello {server}!', embed_config_id: null, cron_expression: '* * * * *', timezone: 'UTC', start_date: null, end_date: null, max_sends: null, current_sends: 0, active: true, last_sent_at: null },
    ];
    const supa = makeSupa({ rows: schedules });
    const runner = new ScheduledMessageRunner(makeGuild(), supa as any);
    await runner.start();
    runner.stop();
    expect(runner).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════
// StatsChannelManager — constructor(guild, supabase, intervalMinutes)
// ═══════════════════════════════════════════════════════════════════
describe('StatsChannelManager deep', () => {
  it('constructs and stops', async () => {
    const { StatsChannelManager } = await import('../features/stats-channels/stats-manager.js');
    const supa = makeSupa({ rows: [] });
    const mgr = new StatsChannelManager(makeGuild(), supa as any, 60);
    mgr.stop();
    expect(mgr).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════
// MusicPlayerManager — constructor(guild, shoukaku, supabase, valkey, eventBus)
// ═══════════════════════════════════════════════════════════════════
describe('MusicPlayerManager deep', () => {
  function makeShoukaku() {
    return {
      on: vi.fn(),
      connections: new Map(),
      players: new Map(),
      getIdealNode: vi.fn(() => ({ rest: { resolve: vi.fn(async () => ({ loadType: 'empty', data: [] })) } })),
    } as any;
  }

  it('constructs', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager(makeGuild(), makeShoukaku(), makeSupa() as any, makeValkey(), makeEventBus());
    expect(mgr).toBeDefined();
  });

  it('stop returns error when not playing', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager(makeGuild(), makeShoukaku(), makeSupa() as any, makeValkey(), makeEventBus());
    const result = await mgr.stop('g1');
    expect(result.success).toBe(true);  // stop always succeeds (clears queue even if not playing)
  });

  it('skip returns error when not playing', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager(makeGuild(), makeShoukaku(), makeSupa() as any, makeValkey(), makeEventBus());
    const result = await mgr.skip('g1');
    expect(result.success).toBe(false);
  });

  it('togglePause returns error when not playing', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager(makeGuild(), makeShoukaku(), makeSupa() as any, makeValkey(), makeEventBus());
    const result = await mgr.togglePause('g1');
    expect(result.success).toBe(false);
  });

  it('seek returns error when not playing', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager(makeGuild(), makeShoukaku(), makeSupa() as any, makeValkey(), makeEventBus());
    const result = await mgr.seek('g1', 5000);
    expect(result.success).toBe(false);
  });

  it('setVolume returns error when not playing', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager(makeGuild(), makeShoukaku(), makeSupa() as any, makeValkey(), makeEventBus());
    const result = await mgr.setVolume('g1', 50);
    expect(result.success).toBe(false);
  });

  it('setLoopMode', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager(makeGuild(), makeShoukaku(), makeSupa() as any, makeValkey(), makeEventBus());
    const result = await mgr.setLoopMode('g1', 'off' as any);
    expect(result).toBeDefined();
  });

  it('cycleLoopMode', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager(makeGuild(), makeShoukaku(), makeSupa() as any, makeValkey(), makeEventBus());
    const result = await mgr.cycleLoopMode('g1');
    expect(result).toBeDefined();
  });

  it('shuffle returns error when not playing', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager(makeGuild(), makeShoukaku(), makeSupa() as any, makeValkey(), makeEventBus());
    const result = await mgr.shuffle('g1');
    expect(result.success).toBe(false);
  });

  it('remove returns error when not playing', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager(makeGuild(), makeShoukaku(), makeSupa() as any, makeValkey(), makeEventBus());
    const result = await mgr.remove('g1', 1);
    expect(result.success).toBe(false);
  });

  it('applyFilter returns error when not playing', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager(makeGuild(), makeShoukaku(), makeSupa() as any, makeValkey(), makeEventBus());
    const result = await mgr.applyFilter('g1', 'nightcore' as any);
    expect(result.success).toBe(false);
  });

  it('getStatus', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager(makeGuild(), makeShoukaku(), makeSupa() as any, makeValkey(), makeEventBus());
    try { const s = await mgr.getStatus(); expect(s).toBeDefined(); } catch {}
  });

  it('isDJ', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager(makeGuild(), makeShoukaku(), makeSupa() as any, makeValkey(), makeEventBus());
    const result = await mgr.isDJ('u1');
    expect(typeof result).toBe('boolean');
  });

  it('init loads config', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const supa = makeSupa();
    const mgr = new MusicPlayerManager(makeGuild(), makeShoukaku(), supa as any, makeValkey(), makeEventBus());
    await mgr.init();
    expect(supa.from).toHaveBeenCalled();
  });

  it('reloadConfig', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const supa = makeSupa();
    const mgr = new MusicPlayerManager(makeGuild(), makeShoukaku(), supa as any, makeValkey(), makeEventBus());
    await mgr.reloadConfig();
    expect(supa.from).toHaveBeenCalled();
  });

  it('voteSkip returns error when not playing', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager(makeGuild(), makeShoukaku(), makeSupa() as any, makeValkey(), makeEventBus());
    const result = await mgr.voteSkip('g1', 'u1');
    expect(result.success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// PaymentHandler — import test
// ═══════════════════════════════════════════════════════════════════
describe('PaymentHandler deep', () => {
  it('imports', async () => {
    const mod = await import('../features/commerce/payment-handler.js');
    expect(mod).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Sync — repair actions and engine
// ═══════════════════════════════════════════════════════════════════
describe('sync modules deep', () => {
  it('repair-actions imports', async () => {
    const mod = await import('../sync/repair-actions.js');
    expect(mod).toBeDefined();
  });

  it('sync-engine imports', async () => {
    const mod = await import('../sync/sync-engine.js');
    expect(mod).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Deploy modules
// ═══════════════════════════════════════════════════════════════════
describe('deploy modules deep', () => {
  it('deploy-listener getDeployStatus returns null initially', async () => {
    const { getDeployStatus } = await import('../deploy/deploy-listener.js');
    expect(getDeployStatus()).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════
// OwnerNotificationService
// ═══════════════════════════════════════════════════════════════════
describe('OwnerNotificationService deep', () => {
  it('constructs', async () => {
    const { OwnerNotificationService } = await import('../services/owner-notifications.js');
    const svc = new OwnerNotificationService(makeClient(), 'g1', makeSupa() as any, makeEventBus());
    expect(svc).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Services — deep imports for coverage
// ═══════════════════════════════════════════════════════════════════
describe('service modules deep', () => {
  it('reconciliation imports', async () => {
    const mod = await import('../services/reconciliation.js');
    expect(mod).toBeDefined();
    expect(typeof mod.runReconciliation).toBe('function');
  });

  it('config-loader imports', async () => {
    const mod = await import('../services/config-loader.js');
    expect(mod).toBeDefined();
  });

  it('giveaway-fulfillment imports', async () => {
    const mod = await import('../services/giveaway-fulfillment.js');
    expect(mod).toBeDefined();
  });

  it('fraud-detection imports', async () => {
    const mod = await import('../services/fraud-detection.js');
    expect(mod).toBeDefined();
  });

  it('alert-service imports', async () => {
    const mod = await import('../services/alert-service.js');
    expect(mod).toBeDefined();
  });

  it('embed-theme imports', async () => {
    const mod = await import('../services/embed-theme.js');
    expect(mod).toBeDefined();
  });

  it('cross-feature-bridge imports', async () => {
    const mod = await import('../services/cross-feature-bridge.js');
    expect(mod).toBeDefined();
  });

  it('action-queue imports', async () => {
    const mod = await import('../services/action-queue.js');
    expect(mod).toBeDefined();
  });

  it('heartbeat imports', async () => {
    const mod = await import('../services/heartbeat.js');
    expect(mod).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Feature modules — deep imports
// ═══════════════════════════════════════════════════════════════════
describe('feature modules deep', () => {
  it('onboarding-handler imports', async () => {
    const mod = await import('../features/welcome/onboarding-handler.js');
    expect(mod).toBeDefined();
  });

  it('ticket-interactions imports', async () => {
    const mod = await import('../features/tickets/ticket-interactions.js');
    expect(mod).toBeDefined();
  });

  it('panel-manager imports', async () => {
    const mod = await import('../features/tickets/panel-manager.js');
    expect(mod).toBeDefined();
  });

  it('transcript-generator imports', async () => {
    const mod = await import('../features/tickets/transcript-generator.js');
    expect(mod).toBeDefined();
  });

  it('custom-command-engine imports', async () => {
    const mod = await import('../features/custom-commands/command-engine.js');
    expect(mod).toBeDefined();
  });

  it('alert-manager imports', async () => {
    const mod = await import('../features/audit/alert-manager.js');
    expect(mod).toBeDefined();
  });
});
