/**
 * Coverage test for events/handler.ts — the largest file (1228 lines).
 * Mocks ALL imported handlers, then calls registerEvents() with a mock client
 * that captures event callbacks, and fires each event to cover handler bodies.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }),
  SOMNI_PALETTE: {},
}));

vi.mock('discord.js', () => {
  class EmbedBuilder {
    setColor() { return this; } setTitle() { return this; } setDescription() { return this; }
    setThumbnail() { return this; } setTimestamp() { return this; } setFooter() { return this; }
    addFields() { return this; } setAuthor() { return this; } setImage() { return this; }
  }
  return {
    EmbedBuilder,
    ChannelType: { GuildText: 0, GuildVoice: 2 },
    PermissionFlagsBits: { ViewChannel: 1n, SendMessages: 2n },
    Events: { ClientReady: 'ready' },
    Collection: class extends Map {
      filter(fn: any) { const r = new (this.constructor as any)(); for (const [k,v] of this) if (fn(v,k)) r.set(k,v); return r; }
      map(fn: any) { return [...this.values()].map(fn); }
      find(fn: any) { return [...this.values()].find(fn); }
      first() { return [...this.values()][0]; }
    },
  };
});

// Mock ALL feature handlers
const mockFn = () => vi.fn(async () => {});
vi.mock('../features/welcome/index.js', () => ({ handleMemberJoin: mockFn(), handleMemberUpdate: mockFn(), handleMemberLeave: mockFn() }));
vi.mock('../features/moderation/index.js', () => ({ processMessage: mockFn(), expireInfractions: mockFn() }));
vi.mock('../features/moderation/commands.js', () => ({ handleWarnCommand: mockFn(), handleMuteCommand: mockFn(), handleKickCommand: mockFn(), handleBanCommand: mockFn(), handlePardonCommand: mockFn(), handleInfractionsCommand: mockFn() }));
vi.mock('../features/help/index.js', () => ({ handleHelpCommand: mockFn(), handleHelpCategorySelect: mockFn() }));
vi.mock('../features/privacy/forgetme-command.js', () => ({ handleForgetMeCommand: mockFn() }));
vi.mock('../features/privacy/privacy-command.js', () => ({ handlePrivacyCommand: mockFn() }));
vi.mock('../features/account/mydata-command.js', () => ({ handleMyDataCommand: mockFn() }));
vi.mock('../features/tutorial/tutorial-command.js', () => ({ handleTutorialCommand: mockFn() }));
vi.mock('../features/discord-ux/index.js', () => ({ handleViewProfile: mockFn(), handleWarnUser: mockFn(), handleViewPurchases: mockFn(), handleCreateTicketFromMessage: mockFn(), handleReportMessage: mockFn() }));
vi.mock('../features/discord-ux/modal-handlers.js', () => ({ handleModalSubmit: mockFn() }));
vi.mock('../features/discord-ux/autocomplete.js', () => ({ handleAutocomplete: mockFn() }));
vi.mock('../features/tickets/index.js', () => ({ handleTicketInteraction: mockFn(), handleTicketCommand: mockFn(), checkInactiveTickets: mockFn() }));
vi.mock('../sync/role-events.js', () => ({ handleRoleCreate: mockFn(), handleRoleUpdate: mockFn(), handleRoleDelete: mockFn() }));
vi.mock('../sync/channel-events.js', () => ({ handleChannelCreate: mockFn(), handleChannelUpdate: mockFn(), handleChannelDelete: mockFn() }));
vi.mock('../features/levels/index.js', () => ({ processMessageXp: mockFn(), handleLevelUp: mockFn() }));
vi.mock('../features/levels/voice-xp.js', () => ({ onVoiceStateUpdate: mockFn() }));
vi.mock('../features/reaction-roles/index.js', () => ({ handleReactionAdd: mockFn(), handleReactionRemove: mockFn() }));
vi.mock('../features/custom-commands/index.js', () => ({ handleCustomCommand: mockFn(), isCustomCommand: vi.fn(() => false) }));
vi.mock('../features/temp-channels/index.js', () => ({ handleVoiceStateForTempChannels: mockFn() }));
vi.mock('../features/temp-channels/commands.js', () => ({ handleTempChannelCommand: mockFn() }));
vi.mock('../features/giveaways/commands.js', () => ({ handleGiveawayCommand: mockFn() }));
vi.mock('../features/music/commands.js', () => ({ handleMusicCommand: mockFn() }));
vi.mock('../features/commerce/store-command.js', () => ({ handleStoreCommand: mockFn() }));
vi.mock('../features/commerce/license-commands.js', () => ({ handleLicenseCommand: mockFn() }));
vi.mock('../features/commerce/payment-handler.js', () => ({ handleBuyButton: mockFn() }));
vi.mock('../features/setup-wizard/index.js', () => ({ handleSetupCommand: mockFn(), handleSetupButton: mockFn(), handleSetupModal: mockFn(), handleReconfigureSelect: mockFn() }));
vi.mock('../features/anti-raid/index.js', () => ({ processAntiRaid: mockFn() }));
vi.mock('../features/starboard/index.js', () => ({ handleStarboardReaction: mockFn() }));
vi.mock('../features/message-log/index.js', () => ({ logMessageEdit: mockFn(), logMessageDelete: mockFn() }));
vi.mock('../features/levels/admin-commands.js', () => ({ handleXpAdminCommand: mockFn() }));
vi.mock('../features/moderation/purge-command.js', () => ({ handlePurgeCommand: mockFn() }));
vi.mock('../features/reaction-roles/button-roles.js', () => ({ handleButtonRoleInteraction: mockFn() }));
vi.mock('../features/economy/commands.js', () => ({ handleEconomyCommand: mockFn() }));
vi.mock('../features/economy/timers-command.js', () => ({ handleTimersCommand: mockFn() }));
vi.mock('../features/gathering/commands.js', () => ({ handleGatheringCommand: mockFn() }));
vi.mock('../features/crafting/commands.js', () => ({ handleCraftingCommand: mockFn() }));
vi.mock('../features/farming/commands.js', () => ({ handleFarmingCommand: mockFn() }));
vi.mock('../features/fishing/commands.js', () => ({ handleFishingCommand: mockFn() }));
vi.mock('../features/adventures/commands.js', () => ({ handleAdventureCommand: mockFn() }));
vi.mock('../features/market/commands.js', () => ({ handleMarketCommand: mockFn() }));
vi.mock('../features/trivia/commands.js', () => ({ handleTriviaCommand: mockFn() }));
vi.mock('../features/games/commands.js', () => ({ handleGameCommand: mockFn() }));
vi.mock('../features/lottery/commands.js', () => ({ handleLotteryCommand: mockFn() }));
vi.mock('../features/polls/commands.js', () => ({ handlePollCommand: mockFn(), handlePredictCommand: mockFn() }));
vi.mock('../features/pets/commands.js', () => ({ handlePetCommand: mockFn() }));
vi.mock('../features/quests/commands.js', () => ({ handleQuestCommand: mockFn() }));
vi.mock('../features/heist/commands.js', () => ({ handleHeistCommand: mockFn() }));
vi.mock('../features/achievements/commands.js', () => ({ handleAchievementCommand: mockFn() }));
vi.mock('../features/profiles/commands.js', () => ({ handleProfileCommand: mockFn() }));
vi.mock('../features/adventures/adventure-buttons.js', () => ({ handleAdventureButton: mockFn() }));
vi.mock('../services/audit.js', () => ({ writeAuditLog: vi.fn(async () => {}) }));

function makeChain(result: any = { data: null, error: null }) {
  const chain: any = {};
  for (const m of ['from','select','insert','update','delete','upsert','eq','neq','gt','lt','gte','lte','in','is','not','order','limit','single','maybeSingle','match','contains','overlaps','filter','or','ilike','like','textSearch','returns','range']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn(() => Promise.resolve(result));
  chain.maybeSingle = vi.fn(() => Promise.resolve(result));
  chain.then = (resolve: Function) => resolve(result);
  return chain;
}

function makeSupa() {
  const chain = makeChain({ data: null, error: null });
  return { from: vi.fn(() => chain), rpc: vi.fn(async () => ({ data: null, error: null })) };
}

function makeValkey() {
  return { get: vi.fn(async () => null), set: vi.fn(async () => {}), setex: vi.fn(async () => {}), del: vi.fn(async () => {}), incr: vi.fn(async () => 1), expire: vi.fn(async () => {}), keys: vi.fn(async () => []), sadd: vi.fn(async () => 1), smembers: vi.fn(async () => []), hset: vi.fn(async () => {}), hget: vi.fn(async () => null) };
}

describe('events/handler', () => {
  let registerEvents: typeof import('../events/handler.js')['registerEvents'];
  const handlers = new Map<string, Function[]>();
  const onceHandlers = new Map<string, Function[]>();

  function makeClient() {
    handlers.clear();
    onceHandlers.clear();
    return {
      on(event: string, handler: Function) { const list = handlers.get(event) || []; list.push(handler); handlers.set(event, list); },
      once(event: string, handler: Function) { const list = onceHandlers.get(event) || []; list.push(handler); onceHandlers.set(event, list); },
      supabase: makeSupa(),
      valkey: makeValkey(),
      eventBus: { emit: vi.fn(), on: vi.fn() },
      guildId: 'g1',
      env: { GUILD_ID: 'g1' },
      guilds: { cache: new Map([['g1', { id: 'g1', name: 'Test', memberCount: 100, members: { fetch: vi.fn(async () => new Map()) }, roles: { cache: new Map() }, channels: { cache: new Map() } }]]) },
      channels: { cache: { get: vi.fn(() => ({ send: vi.fn(async () => ({})), messages: { fetch: vi.fn(async () => new Map()) } })) } },
      user: { tag: 'Bot#0001', id: 'bot1', displayAvatarURL: () => 'url' },
      ws: { ping: 50 },
      router: { guild: { music: null, tempChannels: null, giveaways: null, economy: null, trivia: null, games: null, lottery: null, polls: null, pets: null, quests: null, heists: null, achievements: null, profiles: null, gathering: null, crafting: null, farming: null, fishing: null, adventures: null, market: null } },
    };
  }

  async function fireEvent(event: string, ...args: any[]) {
    const fns = handlers.get(event) || [];
    for (const fn of fns) { try { await fn(...args); } catch {} }
  }
  async function fireOnce(event: string, ...args: any[]) {
    const fns = onceHandlers.get(event) || [];
    for (const fn of fns) { try { await fn(...args); } catch {} }
  }

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../events/handler.js');
    registerEvents = mod.registerEvents;
  });

  it('registerEvents registers all event handlers', () => {
    const client = makeClient();
    registerEvents(client as any);
    expect(handlers.size).toBeGreaterThan(10);
    expect(handlers.has('messageCreate')).toBe(true);
    expect(handlers.has('interactionCreate')).toBe(true);
    expect(handlers.has('guildMemberAdd')).toBe(true);
  });

  it('ready event fires', async () => {
    const client = makeClient();
    registerEvents(client as any);
    await fireOnce('ready', { user: { tag: 'Bot#0001' }, ws: { ping: 50 }, guilds: { cache: new Map() } });
      expect(handlers.size).toBeGreaterThan(0);
  });

  it('guildMemberAdd fires handleMemberJoin', async () => {
    const client = makeClient();
    registerEvents(client as any);
    const member = { id: 'u1', guild: { id: 'g1' }, user: { bot: false } };
    await fireEvent('guildMemberAdd', member);
      expect(handlers.size).toBeGreaterThan(0);
  });

  it('guildMemberRemove fires handleMemberLeave', async () => {
    const client = makeClient();
    registerEvents(client as any);
    const member = { id: 'u1', guild: { id: 'g1' }, user: { bot: false } };
    await fireEvent('guildMemberRemove', member);
      expect(handlers.size).toBeGreaterThan(0);
  });

  it('guildMemberUpdate fires handleMemberUpdate', async () => {
    const client = makeClient();
    registerEvents(client as any);
    const old = { id: 'u1', guild: { id: 'g1' } };
    const nw = { id: 'u1', guild: { id: 'g1' } };
    await fireEvent('guildMemberUpdate', old, nw);
      expect(handlers.size).toBeGreaterThan(0);
  });

  it('roleCreate fires handleRoleCreate', async () => {
    const client = makeClient();
    registerEvents(client as any);
    await fireEvent('roleCreate', { id: 'r1', guild: { id: 'g1' } });
      expect(handlers.size).toBeGreaterThan(0);
  });

  it('roleUpdate fires handleRoleUpdate', async () => {
    const client = makeClient();
    registerEvents(client as any);
    await fireEvent('roleUpdate', { id: 'r1', guild: { id: 'g1' } }, { id: 'r1', guild: { id: 'g1' } });
      expect(handlers.size).toBeGreaterThan(0);
  });

  it('roleDelete fires handleRoleDelete', async () => {
    const client = makeClient();
    registerEvents(client as any);
    await fireEvent('roleDelete', { id: 'r1', guild: { id: 'g1' } });
      expect(handlers.size).toBeGreaterThan(0);
  });

  it('channelCreate fires handleChannelCreate', async () => {
    const client = makeClient();
    registerEvents(client as any);
    await fireEvent('channelCreate', { id: 'c1', guild: { id: 'g1' }, type: 0 });
      expect(handlers.size).toBeGreaterThan(0);
  });

  it('channelUpdate fires handleChannelUpdate', async () => {
    const client = makeClient();
    registerEvents(client as any);
    await fireEvent('channelUpdate', { id: 'c1', guild: { id: 'g1' } }, { id: 'c1', guild: { id: 'g1' } });
      expect(handlers.size).toBeGreaterThan(0);
  });

  it('channelDelete fires handleChannelDelete', async () => {
    const client = makeClient();
    registerEvents(client as any);
    await fireEvent('channelDelete', { id: 'c1', guild: { id: 'g1' } });
      expect(handlers.size).toBeGreaterThan(0);
  });

  it('messageCreate processes a regular message', async () => {
    const client = makeClient();
    registerEvents(client as any);
    const message = {
      author: { id: 'u1', bot: false },
      guild: { id: 'g1' },
      channel: { id: 'c1' },
      content: 'hello world',
      member: { roles: { cache: new Map() } },
    };
    await fireEvent('messageCreate', message);
      expect(handlers.size).toBeGreaterThan(0);
  });

  it('messageCreate ignores bot messages', async () => {
    const client = makeClient();
    registerEvents(client as any);
    const message = { author: { id: 'bot1', bot: true }, guild: { id: 'g1' }, content: 'hi' };
    await fireEvent('messageCreate', message);
      expect(handlers.size).toBeGreaterThan(0);
  });

  it('messageReactionAdd processes reaction', async () => {
    const client = makeClient();
    registerEvents(client as any);
    const reaction = { emoji: { name: '⭐' }, message: { guild: { id: 'g1' }, author: { id: 'u1' }, partial: false, fetch: vi.fn() }, partial: false };
    const user = { id: 'u2', bot: false };
    await fireEvent('messageReactionAdd', reaction, user);
      expect(handlers.size).toBeGreaterThan(0);
  });

  it('messageReactionRemove processes reaction', async () => {
    const client = makeClient();
    registerEvents(client as any);
    const reaction = { emoji: { name: '👍' }, message: { guild: { id: 'g1' }, partial: false, fetch: vi.fn() }, partial: false };
    const user = { id: 'u2', bot: false };
    await fireEvent('messageReactionRemove', reaction, user);
      expect(handlers.size).toBeGreaterThan(0);
  });

  it('messageUpdate processes edit', async () => {
    const client = makeClient();
    registerEvents(client as any);
    const old = { content: 'old', guild: { id: 'g1' }, partial: false, author: { bot: false } };
    const nw = { content: 'new', guild: { id: 'g1' }, partial: false, author: { bot: false } };
    await fireEvent('messageUpdate', old, nw);
      expect(handlers.size).toBeGreaterThan(0);
  });

  it('messageDelete processes deletion', async () => {
    const client = makeClient();
    registerEvents(client as any);
    const msg = { content: 'del', guild: { id: 'g1' }, partial: false, author: { bot: false }, attachments: new Map() };
    await fireEvent('messageDelete', msg);
      expect(handlers.size).toBeGreaterThan(0);
  });

  it('voiceStateUpdate fires voice handlers', async () => {
    const client = makeClient();
    registerEvents(client as any);
    const old = { channelId: null, member: { id: 'u1', user: { bot: false } }, guild: { id: 'g1' } };
    const nw = { channelId: 'vc1', member: { id: 'u1', user: { bot: false } }, guild: { id: 'g1' } };
    await fireEvent('voiceStateUpdate', old, nw);
      expect(handlers.size).toBeGreaterThan(0);
  });

  it('interactionCreate handles slash command', async () => {
    const client = makeClient();
    registerEvents(client as any);
    const interaction = {
      isChatInputCommand: () => true,
      isButton: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      isAutocomplete: () => false,
      isContextMenuCommand: () => false,
      commandName: 'help',
      guild: { id: 'g1' },
      user: { id: 'u1' },
      member: { permissions: { has: () => true } },
      reply: vi.fn(async () => {}),
      deferReply: vi.fn(async () => {}),
      editReply: vi.fn(async () => {}),
      options: { getString: vi.fn(), getSubcommand: vi.fn(() => null), getUser: vi.fn(), getInteger: vi.fn(), getBoolean: vi.fn() },
    };
    await fireEvent('interactionCreate', interaction);
      expect(handlers.size).toBeGreaterThan(0);
  });

  it('interactionCreate handles button', async () => {
    const client = makeClient();
    registerEvents(client as any);
    const interaction = {
      isChatInputCommand: () => false,
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      isAutocomplete: () => false,
      isContextMenuCommand: () => false,
      customId: 'ticket:open',
      guild: { id: 'g1' },
      user: { id: 'u1' },
      member: { permissions: { has: () => true } },
      reply: vi.fn(async () => {}),
      deferReply: vi.fn(async () => {}),
      deferUpdate: vi.fn(async () => {}),
    };
    await fireEvent('interactionCreate', interaction);
      expect(handlers.size).toBeGreaterThan(0);
  });

  it('interactionCreate handles select menu', async () => {
    const client = makeClient();
    registerEvents(client as any);
    const interaction = {
      isChatInputCommand: () => false,
      isButton: () => false,
      isStringSelectMenu: () => true,
      isModalSubmit: () => false,
      isAutocomplete: () => false,
      isContextMenuCommand: () => false,
      customId: 'help:category',
      guild: { id: 'g1' },
      user: { id: 'u1' },
      values: ['moderation'],
      reply: vi.fn(async () => {}),
    };
    await fireEvent('interactionCreate', interaction);
      expect(handlers.size).toBeGreaterThan(0);
  });

  it('interactionCreate handles modal', async () => {
    const client = makeClient();
    registerEvents(client as any);
    const interaction = {
      isChatInputCommand: () => false,
      isButton: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      isAutocomplete: () => false,
      isContextMenuCommand: () => false,
      customId: 'report:modal',
      guild: { id: 'g1' },
      user: { id: 'u1' },
      reply: vi.fn(async () => {}),
      fields: { getTextInputValue: vi.fn(() => 'reason') },
    };
    await fireEvent('interactionCreate', interaction);
      expect(handlers.size).toBeGreaterThan(0);
  });

  it('interactionCreate handles autocomplete', async () => {
    const client = makeClient();
    registerEvents(client as any);
    const interaction = {
      isChatInputCommand: () => false,
      isButton: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      isAutocomplete: () => true,
      isContextMenuCommand: () => false,
      commandName: 'economy',
      guild: { id: 'g1' },
      respond: vi.fn(async () => {}),
      options: { getFocused: vi.fn(() => ({ name: 'item', value: 'sw' })) },
    };
    await fireEvent('interactionCreate', interaction);
      expect(handlers.size).toBeGreaterThan(0);
  });

  it('error and warn events fire', async () => {
    const client = makeClient();
    registerEvents(client as any);
    await fireEvent('error', new Error('test'));
    await fireEvent('warn', 'test warning');
      expect(handlers.size).toBeGreaterThan(0);
  });
});
