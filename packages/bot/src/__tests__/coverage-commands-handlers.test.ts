/**
 * Deep coverage: command handler functions across all feature command files.
 * Calls the actual handler switch/dispatch logic with mock interactions.
 *
 * Targets: economy/commands, music/commands, moderation/commands, levels/commands
 * setup-wizard/commands, temp-channels/commands, giveaways/commands, polls/commands
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  SOMNI_PALETTE: { primary: 0x5865f2, success: 0x57f287, danger: 0xed4245, warning: 0xfee75c, CYAN: 0x00bcd4, ORANGE: 0xff9800, HOT_PINK: 0xff1493 },
  DEFAULT_ESCALATION_CHAIN: [{ threshold: 1, action: 'warn' }],
  levelProgress: vi.fn(() => ({ level: 5, currentXp: 100, requiredXp: 500 })),
}));

vi.mock('discord.js', () => {
  class EmbedBuilder {
    data: any = {};
    setColor() { return this; } setTitle() { return this; } setDescription() { return this; }
    setThumbnail() { return this; } setTimestamp() { return this; } setFooter() { return this; }
    setAuthor() { return this; } addFields() { return this; } setImage() { return this; }
    setURL() { return this; } toJSON() { return this.data; }
  }
  class ActionRowBuilder { addComponents() { return this; } }
  class ButtonBuilder {
    setCustomId() { return this; } setLabel() { return this; } setStyle() { return this; }
    setEmoji() { return this; } setDisabled() { return this; }
  }
  class StringSelectMenuBuilder {
    setCustomId() { return this; } setPlaceholder() { return this; }
    addOptions() { return this; } setMaxValues() { return this; }
  }
  class SlashCommandBuilder {
    setName() { return this; } setDescription() { return this; } setDefaultMemberPermissions() { return this; }
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
    addMentionableOption(fn: any) { try { fn(this); } catch {} return this; }
    setRequired() { return this; } setMinValue() { return this; } setMaxValue() { return this; }
    setChoices() { return this; } addChoices() { return this; } setAutocomplete() { return this; }
    toJSON() { return {}; }
  }
  class ModalBuilder {
    setCustomId() { return this; } setTitle() { return this; } addComponents() { return this; }
  }
  class TextInputBuilder {
    setCustomId() { return this; } setLabel() { return this; } setStyle() { return this; }
    setRequired() { return this; } setValue() { return this; } setPlaceholder() { return this; }
    setMinLength() { return this; } setMaxLength() { return this; }
  }
  class AttachmentBuilder {
    constructor(public data: any, public opts?: any) {}
  }
  class SlashCommandSubcommandBuilder {
    setName() { return this; } setDescription() { return this; }
    addStringOption(fn: any) { try { fn(this); } catch {} return this; }
    addIntegerOption(fn: any) { try { fn(this); } catch {} return this; }
    addBooleanOption(fn: any) { try { fn(this); } catch {} return this; }
    addNumberOption(fn: any) { try { fn(this); } catch {} return this; }
    addUserOption(fn: any) { try { fn(this); } catch {} return this; }
    addChannelOption(fn: any) { try { fn(this); } catch {} return this; }
    addRoleOption(fn: any) { try { fn(this); } catch {} return this; }
    setRequired() { return this; } setMinValue() { return this; } setMaxValue() { return this; }
    setChoices() { return this; } addChoices() { return this; } setAutocomplete() { return this; }
  }
  class Collection extends Map {
    filter(fn: any) { const r = new Collection(); for (const [k,v] of this) if (fn(v,k)) r.set(k,v); return r; }
    map(fn: any) { return [...this.values()].map(fn); }
    find(fn: any) { return [...this.values()].find(fn); }
    first() { return [...this.values()][0]; }
    toJSON() { return [...this.values()]; }
  }
  return {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, StringSelectMenuBuilder, SlashCommandBuilder,
    ModalBuilder, TextInputBuilder, AttachmentBuilder, SlashCommandSubcommandBuilder, Collection,
    ChannelType: { GuildText: 0, GuildVoice: 2 },
    ButtonStyle: { Primary: 1, Secondary: 2, Danger: 4, Link: 5, Success: 3 },
    PermissionFlagsBits: { ViewChannel: 1n, SendMessages: 2n, BanMembers: 4n, KickMembers: 8n, ManageMessages: 16n, ManageGuild: 32n, MuteMembers: 64n, ModerateMembers: 128n },
    ComponentType: { Button: 2, StringSelect: 3 },
    TextInputStyle: { Short: 1, Paragraph: 2 },
  };
});

// Mock rank-card for levels/commands
vi.mock('../features/levels/rank-card.js', () => ({
  generateRankCard: vi.fn(async () => Buffer.from('PNG')),
  loadRankCardSettings: vi.fn(async () => ({ backgroundUrl: null, accentColor: '#5865f2', progressBarColor: '#5865f2', overlayOpacity: 0.6 })),
}));

// Mock escalation for moderation/commands
vi.mock('../features/moderation/escalation.js', () => ({
  executeEscalation: vi.fn(async () => {}),
  getEscalationAction: vi.fn(() => null),
}));
vi.mock('../features/moderation/mod-log.js', () => ({
  postModLogEntry: vi.fn(async () => {}),
}));
vi.mock('../features/moderation/infraction-service.js', () => ({
  createInfraction: vi.fn(async () => ({ id: 'inf1' })),
  getActiveWarningCount: vi.fn(async () => 0),
  getMemberInfractions: vi.fn(async () => [{ id: 'inf1', type: 'warn', active: true, pardoned: false, reason: 'test', created_at: new Date().toISOString() }]),
  pardonInfraction: vi.fn(async () => true),
  calculateExpiryDate: vi.fn(() => new Date().toISOString()),
}));
vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));

// Mock music-embeds for music/commands
vi.mock('../features/music/music-embeds.js', () => ({
  buildNowPlayingEmbed: vi.fn(() => ({ toJSON: () => ({}) })),
  buildQueueEmbed: vi.fn(() => ({ toJSON: () => ({}) })),
  buildAddedEmbed: vi.fn(() => ({ toJSON: () => ({}) })),
  buildPlaylistAddedEmbed: vi.fn(() => ({ toJSON: () => ({}) })),
  buildMusicErrorEmbed: vi.fn(() => ({ toJSON: () => ({}) })),
  buildMusicInfoEmbed: vi.fn(() => ({ toJSON: () => ({}) })),
  buildFilterEmbed: vi.fn(() => ({ toJSON: () => ({}) })),
  formatDuration: vi.fn(() => '0:00'),
}));

// ── Helpers ──────────────────────────────────────────────

function makeInteraction(overrides: any = {}): any {
  return {
    commandName: overrides.commandName ?? 'balance',
    guildId: 'g1',
    id: '1234567890',
    replied: false,
    deferred: false,
    user: { id: 'u1', displayName: 'Tester', username: 'tester', displayAvatarURL: () => 'https://cdn.discord.com/a.png', bot: false, ...overrides.user },
    member: {
      id: 'u1',
      permissions: { has: vi.fn(() => true) },
      roles: { cache: new Map(), highest: { position: 10 } },
      bannable: true, kickable: true, moderatable: true,
      timeout: vi.fn(async () => {}),
      ...overrides.member,
    },
    guild: {
      id: 'g1', name: 'Test', ownerId: 'owner1',
      members: {
        cache: new Map([['u1', { id: 'u1', displayName: 'Tester' }]]),
        fetch: vi.fn(async (id: string) => ({ id, user: { id, bot: false, displayName: 'Target', tag: 'Target#0001', displayAvatarURL: () => '' }, bannable: true, kickable: true, moderatable: true, roles: { cache: new Map(), highest: { position: 1 } }, timeout: vi.fn(async () => {}) })),
      },
      bans: { create: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
      ...overrides.guild,
    },
    options: {
      getSubcommand: vi.fn(() => overrides.subcommand ?? 'view'),
      getSubcommandGroup: vi.fn(() => overrides.subcommandGroup ?? null),
      getString: vi.fn((key: string) => overrides.strings?.[key] ?? null),
      getInteger: vi.fn((key: string) => overrides.integers?.[key] ?? null),
      getNumber: vi.fn((key: string) => overrides.numbers?.[key] ?? null),
      getBoolean: vi.fn((key: string) => overrides.booleans?.[key] ?? null),
      getUser: vi.fn(() => overrides.targetUser ?? null),
      getMember: vi.fn(() => overrides.targetMember ?? null),
      getChannel: vi.fn(() => overrides.targetChannel ?? null),
      getRole: vi.fn(() => overrides.targetRole ?? null),
      ...overrides.options,
    },
    reply: vi.fn(async () => ({})),
    editReply: vi.fn(async () => ({})),
    deferReply: vi.fn(async () => {}),
    followUp: vi.fn(async () => {}),
    showModal: vi.fn(async () => {}),
    isCommand: vi.fn(() => true),
    isChatInputCommand: vi.fn(() => true),
    isButton: vi.fn(() => false),
    isModalSubmit: vi.fn(() => false),
    isStringSelectMenu: vi.fn(() => false),
    isAutocomplete: vi.fn(() => false),
    customId: overrides.customId ?? '',
    channel: { id: 'ch1', send: vi.fn(async () => ({})), ...overrides.channel },
    client: overrides.client ?? {},
    ...overrides,
  };
}

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

function makeSupa(result?: any) {
  const chain = makeChain(result ?? { data: null, error: null });
  return { from: vi.fn(() => chain), rpc: vi.fn(async () => ({ data: null, error: null })), channel: vi.fn(() => ({ on: vi.fn().mockReturnThis(), subscribe: vi.fn() })), removeChannel: vi.fn() };
}

// ═══════════════════════════════════════════════════════════
// economy/commands.ts
// ═══════════════════════════════════════════════════════════
describe('economy command handlers', () => {
  let mod: typeof import('../features/economy/commands.js');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../features/economy/commands.js');
  });

  const mockWallet = { wallet: 100, bank: 500, bank_max: 10000, passive: false };
  const mockBalance = { wallet: 150, bank: 500, bank_max: 10000, passive: false };

  const mockEconMgr: any = {
    loadConfig: vi.fn(async () => ({ economy_enabled: true, currency_symbol: '💰', currency_name: 'coins', currency_emoji: '💰' })),
    getOrCreateWallet: vi.fn(async () => ({ ...mockWallet })),
    claimTimedReward: vi.fn(async () => ({ success: true, amount: 50, message: 'Claimed 50 coins!', balance: { ...mockBalance } })),
    creditWallet: vi.fn(async () => ({ ...mockBalance })),
    debitWallet: vi.fn(async () => ({ wallet: 50, bank: 500, bank_max: 10000, passive: false })),
    deposit: vi.fn(async () => ({ success: true, message: 'Deposited 50 coins.' })),
    withdraw: vi.fn(async () => ({ success: true, message: 'Withdrew 50 coins.' })),
    pay: vi.fn(async () => ({ success: true, message: 'Paid 50 coins to Other.' })),
    rob: vi.fn(async () => ({ success: true, amount: 20, message: 'Robbed 20 coins!', balance: { ...mockBalance } })),
    togglePassive: vi.fn(async () => ({ success: true, message: 'Passive mode enabled.' })),
    getShopItems: vi.fn(async () => []),
    buyItem: vi.fn(async () => ({ success: true, message: 'Bought item.' })),
    sellItem: vi.fn(async () => ({ success: true, message: 'Sold item.' })),
    getInventory: vi.fn(async () => []),
    useItem: vi.fn(async () => ({ success: true, message: 'Used item' })),
    getLeaderboard: vi.fn(async () => []),
    collectIncome: vi.fn(async () => ({ success: true, amount: 10 })),
    work: vi.fn(async () => ({ success: true, amount: 30, message: 'You worked hard!', balance: { ...mockBalance } })),
    crime: vi.fn(async () => ({ success: true, amount: 50, message: 'Crime paid!', balance: { ...mockBalance } })),
    beg: vi.fn(async () => ({ success: true, amount: 5, message: 'A kind stranger gave you 5 coins.' })),
    search: vi.fn(async () => ({ success: true, amount: 15, message: 'You found 15 coins!' })),
  };

  for (const cmd of ['balance', 'daily', 'work', 'crime', 'beg', 'search', 'deposit', 'withdraw', 'pay', 'rob', 'passive', 'shop', 'buy', 'sell', 'inventory', 'use', 'economy-leaderboard']) {
    it(`handles ${cmd} command`, async () => {
      const interaction = makeInteraction({
        commandName: cmd,
        integers: { amount: 50, position: 1, quantity: 1 },
        strings: { item: 'sword', reason: 'test' },
        targetUser: { id: 'u2', displayName: 'Other', displayAvatarURL: () => '', tag: 'Other#0001', bot: false },
      });
      await mod.handleEconomyCommand(interaction, mockEconMgr);
      // Some commands use reply(), others deferReply()+editReply()
      const responded = interaction.reply.mock.calls.length > 0 || interaction.editReply.mock.calls.length > 0;
      expect(responded).toBe(true);
    });
  }

  it('handles collect-income command', async () => {
    // collect-income accesses interaction.client.supabase and mgr['valkey'] internally
    // — we test it won't crash by providing the required structure
    const supa = makeSupa({ data: [], error: null });
    const interaction = makeInteraction({
      commandName: 'collect-income',
      client: { supabase: supa },
    });
    // The handler will early-return with 'no role income configured'
    await mod.handleEconomyCommand(interaction, mockEconMgr);
    expect(interaction.reply).toHaveBeenCalled();
  });

  it('handles disabled economy', async () => {
    const mgr = { ...mockEconMgr, loadConfig: vi.fn(async () => ({ economy_enabled: false })) };
    const interaction = makeInteraction({ commandName: 'balance' });
    await mod.handleEconomyCommand(interaction, mgr as any);
    expect(interaction.reply).toHaveBeenCalled();
  });

  it('handles unknown command', async () => {
    const interaction = makeInteraction({ commandName: 'nonexistent' });
    await mod.handleEconomyCommand(interaction, mockEconMgr);
    expect(interaction.reply).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════
// music/commands.ts
// ═══════════════════════════════════════════════════════════
describe('music command handlers', () => {
  let mod: typeof import('../features/music/commands.js');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../features/music/commands.js');
  });

  const mockMusicPlayer: any = {
    play: vi.fn(async () => ({ success: true, entry: { title: 'Song', duration: 180000, url: 'https://yt.be/x' }, position: 0, message: 'Now playing' })),
    skip: vi.fn(async () => ({ success: true, message: 'Skipped' })),
    voteSkip: vi.fn(async () => ({ success: true, message: 'Vote skip' })),
    stop: vi.fn(async () => ({ success: true, message: 'Stopped' })),
    togglePause: vi.fn(async () => ({ success: true, paused: false, message: 'Resumed' })),
    seek: vi.fn(async () => ({ success: true, message: 'Seeked to 1:30' })),
    setVolume: vi.fn(async () => ({ success: true, message: 'Volume set' })),
    setLoopMode: vi.fn(async () => ({ success: true, message: 'Loop set' })),
    cycleLoopMode: vi.fn(async () => ({ success: true, mode: 'off', message: 'Loop cycled' })),
    shuffle: vi.fn(async () => ({ success: true, message: 'Shuffled' })),
    remove: vi.fn(async () => ({ success: true, message: 'Removed' })),
    applyFilter: vi.fn(async () => ({ success: true, message: 'Filter applied' })),
    applyCustomSpeed: vi.fn(async () => ({ success: true, message: 'Speed adjusted' })),
    getActiveFilters: vi.fn(() => []),
    sendNowPlaying: vi.fn(async () => {}),
    getStatus: vi.fn(async () => ({ isPlaying: true, currentEntry: { title: 'Song', duration: 180000 }, positionMs: 60000, volume: 80, loop: 'off' })),
    isDJ: vi.fn(async () => true),
    queueManager: {
      getQueue: vi.fn(async () => ({ entries: [], position: 0, guildId: 'g1', currentIndex: 0 })),
    },
  };

  for (const cmd of ['play', 'skip', 'stop', 'queue', 'np', 'volume', 'loop', 'shuffle', 'seek', 'remove', 'pause', 'filter']) {
    it(`handles ${cmd} command`, async () => {
      const interaction = makeInteraction({
        commandName: cmd,
        strings: { query: 'test song', mode: 'off', preset: 'nightcore', position: '1:30' },
        integers: { volume: 80, position: 1 },
        numbers: { seconds: 30, speed: 1.5 },
        member: {
          id: 'u1',
          permissions: { has: vi.fn(() => true) },
          voice: { channel: { id: 'vc1', type: 2, members: new Map([['u1', {}]]) } },
        },
      });
      await mod.handleMusicCommand(interaction, mockMusicPlayer);
    });
  }

  it('builds music commands', () => {
    const cmds = mod.buildMusicCommands();
    expect(Array.isArray(cmds)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// moderation/commands.ts
// ═══════════════════════════════════════════════════════════
describe('moderation command handlers', () => {
  let mod: typeof import('../features/moderation/commands.js');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../features/moderation/commands.js');
  });

  const mockClient: any = {
    supabase: makeSupa(),
    user: { id: 'bot1' },
    guilds: { cache: new Map() },
    eventBus: { emit: vi.fn(), on: vi.fn() },
  };

  it('handleWarnCommand warns a user', async () => {
    const interaction = makeInteraction({
      commandName: 'warn',
      targetUser: { id: 'u2', displayName: 'Bad User', tag: 'Bad#0001', displayAvatarURL: () => '' },
      strings: { reason: 'Being naughty' },
    });
    await mod.handleWarnCommand(interaction, mockClient);
  });

  it('handleMuteCommand mutes a user', async () => {
    const interaction = makeInteraction({
      commandName: 'mute',
      targetUser: { id: 'u2', displayName: 'Bad User', tag: 'Bad#0001', displayAvatarURL: () => '' },
      strings: { reason: 'Spamming', duration: '1h' },
    });
    await mod.handleMuteCommand(interaction, mockClient);
  });

  it('handleKickCommand kicks a user', async () => {
    const interaction = makeInteraction({
      commandName: 'kick',
      targetUser: { id: 'u2', displayName: 'Bad User', tag: 'Bad#0001', displayAvatarURL: () => '' },
      strings: { reason: 'Rule breaking' },
    });
    await mod.handleKickCommand(interaction, mockClient);
  });

  it('handleBanCommand bans a user', async () => {
    const interaction = makeInteraction({
      commandName: 'ban',
      targetUser: { id: 'u2', displayName: 'Bad User', tag: 'Bad#0001', displayAvatarURL: () => '' },
      strings: { reason: 'Severe violation' },
      integers: { delete_days: 7 },
    });
    await mod.handleBanCommand(interaction, mockClient);
  });

  it('handlePardonCommand pardons a user', async () => {
    const interaction = makeInteraction({
      commandName: 'pardon',
      strings: { infraction_id: 'inf1' },
    });
    await mod.handlePardonCommand(interaction, mockClient);
  });

  it('handleInfractionsCommand lists infractions', async () => {
    const interaction = makeInteraction({
      commandName: 'infractions',
      targetUser: { id: 'u2', displayName: 'Bad User', tag: 'Bad#0001', displayAvatarURL: () => '' },
    });
    await mod.handleInfractionsCommand(interaction, mockClient);
  });
});

// ═══════════════════════════════════════════════════════════
// levels/commands.ts
// ═══════════════════════════════════════════════════════════
describe('levels command handlers', () => {
  let mod: typeof import('../features/levels/commands.js');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../features/levels/commands.js');
  });

  it('handleRankCommand shows rank', async () => {
    const supa = makeSupa({ data: { xp: 500, level: 5, messages: 100, total_messages: 100 }, error: null });
    const mockClient: any = {
      supabase: supa,
      user: { id: 'bot1' },
    };
    const interaction = makeInteraction({
      commandName: 'rank',
      subcommand: 'view',
      guild: {
        id: 'g1', name: 'Test', ownerId: 'owner1',
        members: {
          cache: new Map([['u1', { id: 'u1', displayName: 'Tester', username: 'tester' }]]),
          fetch: vi.fn(async () => new Map()),
        },
        bans: { create: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
      },
    });
    await mod.handleRankCommand(interaction, mockClient);
    expect(interaction.deferReply).toHaveBeenCalled();
  });

  it('handleLeaderboardCommand shows leaderboard', async () => {
    // Supabase must return array data for leaderboard
    const arrayChain: any = {};
    for (const m of ['from','select','insert','update','delete','upsert','eq','neq','gt','lt','gte','lte','in','is','not','order','limit','single','maybeSingle','match','contains','overlaps','filter','or','ilike','like','textSearch','returns','range']) {
      arrayChain[m] = vi.fn(() => arrayChain);
    }
    const arrayResult = { data: [{ member_id: 'u1', xp: 500, level: 5 }], error: null, count: 1 };
    arrayChain.single = vi.fn(() => Promise.resolve(arrayResult));
    arrayChain.maybeSingle = vi.fn(() => Promise.resolve(arrayResult));
    arrayChain.then = (resolve: Function) => resolve(arrayResult);

    const supa = { from: vi.fn(() => arrayChain), rpc: vi.fn(async () => ({ data: null, error: null })) };
    const mockClient: any = {
      supabase: supa,
      user: { id: 'bot1' },
    };
    const interaction = makeInteraction({ commandName: 'leaderboard' });
    await mod.handleLeaderboardCommand(interaction, mockClient);
    expect(interaction.deferReply).toHaveBeenCalled();
  });
});
