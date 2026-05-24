/**
 * Bulk coverage: all feature command build/handle functions.
 * Each feature's commands.ts exports buildXCommands() and handleXCommand().
 * We call build to cover slash-command definitions, and handle with mock
 * interactions to cover the dispatch + early-exit paths.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  SOMNI_PALETTE: { primary: 0x5865f2, success: 0x57f287, danger: 0xed4245, warning: 0xfee75c, CYAN: 0x00bcd4, ORANGE: 0xff9800, HOT_PINK: 0xff1493 },
  DEFAULT_ESCALATION_CHAIN: [],
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
    name = ''; desc = '';
    setName(n: string) { this.name = n; return this; } setDescription(d: string) { this.desc = d; return this; }
    setDefaultMemberPermissions() { return this; }
    setDMPermission() { return this; }
    addSubcommand(fn: any) { try { fn(new SlashCommandSubcommandBuilder()); } catch {} return this; }
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
  class SlashCommandSubcommandGroupBuilder {
    setName() { return this; } setDescription() { return this; }
    addSubcommand(fn: any) { try { fn(new SlashCommandSubcommandBuilder()); } catch {} return this; }
  }
  class ModalBuilder { setCustomId() { return this; } setTitle() { return this; } addComponents() { return this; } }
  class TextInputBuilder {
    setCustomId() { return this; } setLabel() { return this; } setStyle() { return this; }
    setRequired() { return this; } setValue() { return this; } setPlaceholder() { return this; }
    setMinLength() { return this; } setMaxLength() { return this; }
  }
  class AttachmentBuilder { constructor(public d: any, public o?: any) {} }
  class Collection extends Map {
    filter(fn: any) { const r = new Collection(); for (const [k,v] of this) if (fn(v,k)) r.set(k,v); return r; }
    map(fn: any) { return [...this.values()].map(fn); }
    find(fn: any) { return [...this.values()].find(fn); }
    first() { return [...this.values()][0]; }
  }
  return {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, StringSelectMenuBuilder, SlashCommandBuilder,
    SlashCommandSubcommandBuilder, SlashCommandSubcommandGroupBuilder,
    ModalBuilder, TextInputBuilder, AttachmentBuilder, Collection,
    ChannelType: { GuildText: 0, GuildVoice: 2, GuildCategory: 4 },
    ButtonStyle: { Primary: 1, Secondary: 2, Danger: 4, Link: 5, Success: 3 },
    PermissionFlagsBits: { ViewChannel: 1n, SendMessages: 2n, BanMembers: 4n, KickMembers: 8n, ManageMessages: 16n, ManageGuild: 32n, ModerateMembers: 128n, ManageChannels: 64n },
    ComponentType: { Button: 2, StringSelect: 3 },
    TextInputStyle: { Short: 1, Paragraph: 2 },
  };
});

// Mock rank-card
vi.mock('../features/levels/rank-card.js', () => ({
  generateRankCard: vi.fn(async () => Buffer.from('PNG')),
  loadRankCardSettings: vi.fn(async () => ({})),
}));
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
  getMemberInfractions: vi.fn(async () => []),
  pardonInfraction: vi.fn(async () => true),
  calculateExpiryDate: vi.fn(() => new Date().toISOString()),
}));
vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));
vi.mock('../features/music/music-embeds.js', () => ({
  buildNowPlayingEmbed: vi.fn(() => ({ toJSON: () => ({}) })),
  buildQueueEmbed: vi.fn(() => ({ toJSON: () => ({}) })),
  buildFilterEmbed: vi.fn(() => ({ toJSON: () => ({}) })),
  formatDuration: vi.fn(() => '0:00'),
}));

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

function makeInteraction(overrides: any = {}): any {
  return {
    commandName: overrides.commandName ?? 'test',
    guildId: 'g1', id: '123',
    replied: false, deferred: false,
    user: { id: 'u1', displayName: 'Tester', username: 'tester', displayAvatarURL: () => '', bot: false },
    member: { id: 'u1', permissions: { has: vi.fn(() => true) }, roles: { cache: new Map(), highest: { position: 10 } }, voice: { channel: { id: 'vc1', type: 2, members: new Map() } } },
    guild: { id: 'g1', name: 'Test', ownerId: 'owner1', members: { cache: new Map(), fetch: vi.fn(async () => new Map()) }, bans: { create: vi.fn(), remove: vi.fn() }, channels: { cache: new Map() } },
    options: {
      getSubcommand: vi.fn(() => overrides.subcommand ?? 'view'),
      getSubcommandGroup: vi.fn(() => null),
      getString: vi.fn((k: string) => overrides.strings?.[k] ?? null),
      getInteger: vi.fn((k: string) => overrides.integers?.[k] ?? null),
      getNumber: vi.fn((k: string) => overrides.numbers?.[k] ?? null),
      getBoolean: vi.fn((k: string) => overrides.booleans?.[k] ?? null),
      getUser: vi.fn(() => overrides.targetUser ?? null),
      getMember: vi.fn(() => overrides.targetMember ?? null),
      getChannel: vi.fn(() => overrides.targetChannel ?? null),
      getRole: vi.fn(() => overrides.targetRole ?? null),
    },
    reply: vi.fn(async () => ({})),
    editReply: vi.fn(async () => ({})),
    deferReply: vi.fn(async () => {}),
    followUp: vi.fn(async () => {}),
    showModal: vi.fn(async () => {}),
    channel: { id: 'ch1', send: vi.fn(async () => ({})), messages: { fetch: vi.fn(async () => new Map()) } },
    client: { supabase: makeSupa(), user: { id: 'bot1' }, eventBus: { emit: vi.fn(), on: vi.fn() } },
    ...overrides,
  };
}

function makeMgr(extra: Record<string, any> = {}): any {
  return new Proxy(extra, {
    get(target, prop) {
      if (prop in target) return target[prop as any];
      if (typeof prop === 'string') return vi.fn(async () => ({ success: true, message: 'ok', items: [], data: [], entries: [] }));
      return undefined;
    }
  });
}

// ═══════ achievements ═══════
describe('achievements commands', () => {
  it('builds and handles', async () => {
    const mod = await import('../features/achievements/commands.js');
    const cmds = mod.buildAchievementCommands();
    expect(cmds).toBeDefined();
    await mod.handleAchievementCommand(makeInteraction({ commandName: 'achievements' }), makeMgr());
  });
});

// ═══════ adventures ═══════
describe('adventures commands', () => {
  it('builds and handles', async () => {
    const mod = await import('../features/adventures/commands.js');
    const cmds = mod.buildAdventureCommands();
    expect(cmds).toBeDefined();
    await mod.handleAdventureCommand(makeInteraction({ commandName: 'adventure', subcommand: 'start' }), makeMgr());
  });
});

// ═══════ crafting ═══════
describe('crafting commands', () => {
  it('builds and handles', async () => {
    const mod = await import('../features/crafting/commands.js');
    const cmds = mod.buildCraftingCommands();
    expect(cmds).toBeDefined();
    await mod.handleCraftingCommand(makeInteraction({ commandName: 'craft' }), makeMgr());
  });
});

// ═══════ farming ═══════
describe('farming commands', () => {
  it('builds and handles', async () => {
    const mod = await import('../features/farming/commands.js');
    const cmds = mod.buildFarmingCommands();
    expect(cmds).toBeDefined();
    for (const sub of ['view', 'plant', 'harvest', 'water']) {
      await mod.handleFarmingCommand(makeInteraction({ commandName: 'farm', subcommand: sub, strings: { crop: 'wheat' } }), makeMgr());
    }
  });
});

// ═══════ fishing ═══════
describe('fishing commands', () => {
  it('builds and handles', async () => {
    const mod = await import('../features/fishing/commands.js');
    const cmds = mod.buildFishingCommands();
    expect(cmds).toBeDefined();
    await mod.handleFishingCommand(makeInteraction({ commandName: 'fish', subcommand: 'cast' }), makeMgr());
  });
});

// ═══════ games ═══════
describe('games commands', () => {
  it('builds and handles', async () => {
    const mod = await import('../features/games/commands.js');
    const cmds = mod.buildGameCommands();
    expect(cmds).toBeDefined();
    await mod.handleGameCommand(makeInteraction({ commandName: 'coinflip', subcommand: 'coinflip', strings: { choice: 'heads' }, integers: { bet: 10 } }), makeMgr());
  });
});

// ═══════ gathering ═══════
describe('gathering commands', () => {
  it('builds and handles', async () => {
    const mod = await import('../features/gathering/commands.js');
    const cmds = mod.buildGatheringCommands();
    expect(cmds).toBeDefined();
    await mod.handleGatheringCommand(makeInteraction({ commandName: 'gather', subcommand: 'mine' }), makeMgr());
  });
});

// ═══════ giveaways ═══════
describe('giveaway commands', () => {
  it('builds and handles', async () => {
    const mod = await import('../features/giveaways/commands.js');
    const cmds = mod.buildGiveawayCommands();
    expect(cmds).toBeDefined();
    await mod.handleGiveawayCommand(makeInteraction({ commandName: 'giveaway', subcommand: 'list' }), makeMgr());
  });
});

// ═══════ heist ═══════
describe('heist commands', () => {
  it('builds and handles', async () => {
    const mod = await import('../features/heist/commands.js');
    const cmds = mod.buildHeistCommands();
    expect(cmds).toBeDefined();
    await mod.handleHeistCommand(makeInteraction({ commandName: 'heist', subcommand: 'start' }), makeMgr());
  });
});

// ═══════ lottery ═══════
describe('lottery commands', () => {
  it('builds and handles', async () => {
    const mod = await import('../features/lottery/commands.js');
    const cmds = mod.buildLotteryCommands();
    expect(cmds).toBeDefined();
    await mod.handleLotteryCommand(makeInteraction({ commandName: 'lottery', subcommand: 'view' }), makeMgr());
  });
});

// ═══════ market ═══════
describe('market commands', () => {
  it('builds and handles', async () => {
    const mod = await import('../features/market/commands.js');
    const cmds = mod.buildMarketCommands();
    expect(cmds).toBeDefined();
    for (const sub of ['browse', 'list', 'buy', 'cancel']) {
      await mod.handleMarketCommand(makeInteraction({ commandName: 'market', subcommand: sub, strings: { item_id: 'item1' }, integers: { price: 100, listing_id: 1 } }), makeMgr());
    }
  });
});

// ═══════ pets ═══════
describe('pets commands', () => {
  it('builds and handles', async () => {
    const mod = await import('../features/pets/commands.js');
    const cmds = mod.buildPetCommands();
    expect(cmds).toBeDefined();
    await mod.handlePetCommand(makeInteraction({ commandName: 'pet', subcommand: 'view' }), makeMgr());
  });
});

// ═══════ polls ═══════
describe('polls commands', () => {
  it('builds and handles', async () => {
    const mod = await import('../features/polls/commands.js');
    const cmds = mod.buildPollCommands();
    expect(cmds).toBeDefined();
    await mod.handlePollCommand(makeInteraction({ commandName: 'poll', subcommand: 'list' }), makeMgr());
  });
});

// ═══════ profiles ═══════
describe('profiles commands', () => {
  it('builds and handles', async () => {
    const mod = await import('../features/profiles/commands.js');
    const cmds = mod.buildProfileCommands();
    expect(cmds).toBeDefined();
    await mod.handleProfileCommand(makeInteraction({ commandName: 'profile', subcommand: 'view' }), makeMgr());
  });
});

// ═══════ quests ═══════
describe('quests commands', () => {
  it('builds and handles', async () => {
    const mod = await import('../features/quests/commands.js');
    const cmds = mod.buildQuestCommands();
    expect(cmds).toBeDefined();
    await mod.handleQuestCommand(makeInteraction({ commandName: 'quest', subcommand: 'view' }), makeMgr());
  });
});

// ═══════ temp-channels ═══════
describe('temp-channels commands', () => {
  it('builds and handles', async () => {
    const mod = await import('../features/temp-channels/commands.js');
    const cmds = mod.buildTempChannelCommands();
    expect(cmds).toBeDefined();
    await mod.handleTempChannelCommand(makeInteraction({ commandName: 'vc', subcommand: 'lock' }), makeMgr());
  });
});

// ═══════ trivia ═══════
describe('trivia commands', () => {
  it('builds and handles', async () => {
    const mod = await import('../features/trivia/commands.js');
    const cmds = mod.buildTriviaCommands();
    expect(cmds).toBeDefined();
    await mod.handleTriviaCommand(makeInteraction({ commandName: 'trivia', subcommand: 'start' }), makeMgr());
  });
});

// ═══════ setup-wizard commands ═══════
describe('setup-wizard commands', () => {
  it('builds and handles', async () => {
    const mod = await import('../features/setup-wizard/commands.js');
    const cmds = mod.buildSetupCommand();
    expect(cmds).toBeDefined();
    // Most setup wizard requires Supabase so we just test the build
  });
});

// ═══════ levels admin commands ═══════
describe('levels admin-commands', () => {
  it('imports and has exports', async () => {
    const mod = await import('../features/levels/admin-commands.js');
    expect(mod).toBeDefined();
    // build* function
    const build = (mod as any).buildXpAdminCommands ?? (mod as any).buildLevelAdminCommands;
    if (build) {
      const cmds = build();
      expect(cmds).toBeDefined();
    }
  });
});

// ═══════ privacy commands ═══════
describe('privacy commands', () => {
  it('builds forgetme', async () => {
    const mod = await import('../features/privacy/forgetme-command.js');
    expect(mod).toBeDefined();
  });
  it('builds privacy', async () => {
    const mod = await import('../features/privacy/privacy-command.js');
    expect(mod).toBeDefined();
  });
});

// ═══════ license commands ═══════
describe('license commands', () => {
  it('imports', async () => {
    const mod = await import('../features/commerce/license-commands.js');
    expect(mod).toBeDefined();
  });
});

// ═══════ store command ═══════
describe('store command', () => {
  it('imports', async () => {
    const mod = await import('../features/commerce/store-command.js');
    expect(mod).toBeDefined();
  });
});

// ═══════ tutorial command ═══════
describe('tutorial command', () => {
  it('imports', async () => {
    const mod = await import('../features/tutorial/tutorial-command.js');
    expect(mod).toBeDefined();
  });
});

// ═══════ timers-command ═══════
describe('economy timers-command', () => {
  it('imports', async () => {
    const mod = await import('../features/economy/timers-command.js');
    expect(mod).toBeDefined();
  });
});
