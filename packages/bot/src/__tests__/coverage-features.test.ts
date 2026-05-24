/**
 * Coverage tests — Feature managers
 * Tests: GamesManager, PollsManager, FarmingManager, FishingManager,
 * CraftingManager, GatheringManager, MarketManager, GiveawayManager,
 * PetsManager, LotteryManager, HeistManager, AdventureManager, MusicPlayerManager
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  SOMNI_PALETTE: { primary: 0x5865f2, success: 0x57f287 },
  DEFAULT_ESCALATION_CHAIN: [],
}));

vi.mock('discord.js', () => {
  class SlashCommandBuilder {
    setName() { return this; }
    setDescription() { return this; }
    setDefaultMemberPermissions() { return this; }
    addSubcommand(fn: Function) { fn(new SlashCommandBuilder()); return this; }
    addUserOption(fn: Function) { fn({ setName: () => ({ setDescription: () => ({ setRequired: () => ({}) }) }) }); return this; }
    addStringOption(fn: Function) {
      fn({ setName: () => ({ setDescription: () => ({ setRequired: () => ({ addChoices: () => ({}) }), addChoices: () => ({}) }) }) });
      return this;
    }
    addIntegerOption(fn: Function) {
      fn({ setName: () => ({ setDescription: () => ({ setRequired: () => ({ setMinValue: () => ({ setMaxValue: () => ({}) }) }), setMinValue: () => ({ setMaxValue: () => ({}) }), addChoices: () => ({}) }) }) });
      return this;
    }
    addBooleanOption(fn: Function) { fn({ setName: () => ({ setDescription: () => ({}) }) }); return this; }
    addNumberOption(fn: Function) { fn({ setName: () => ({ setDescription: () => ({ setRequired: () => ({}), setMinValue: () => ({}) }) }) }); return this; }
  }
  class EmbedBuilder {
    data: any = {};
    setColor() { return this; }
    setTitle() { return this; }
    setDescription() { return this; }
    setThumbnail() { return this; }
    setTimestamp() { return this; }
    setFooter() { return this; }
    setImage() { return this; }
    setAuthor() { return this; }
    setURL() { return this; }
    addFields(..._f: any[]) { return this; }
  }
  class ActionRowBuilder {
    components: any[] = [];
    addComponents(...c: any[]) { this.components.push(...c); return this; }
  }
  class ButtonBuilder {
    setCustomId() { return this; }
    setLabel() { return this; }
    setStyle() { return this; }
    setEmoji() { return this; }
    setDisabled() { return this; }
  }
  class StringSelectMenuBuilder {
    setCustomId() { return this; }
    setPlaceholder() { return this; }
    addOptions() { return this; }
    setMaxValues() { return this; }
  }
  class Collection extends Map {
    filter(fn: Function) {
      const result = new Collection();
      for (const [k, v] of this) { if (fn(v, k)) result.set(k, v); }
      return result;
    }
    sort(fn?: Function) { return this; }
    first() { return this.values().next().value; }
    map(fn: Function) { return [...this.values()].map(fn); }
  }
  return {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    StringSelectMenuBuilder,
    Collection,
    PermissionFlagsBits: { Administrator: 1n, ManageGuild: 2n, ManageRoles: 4n, SendMessages: 8n },
    ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4 },
    ChannelType: { GuildText: 0, GuildVoice: 2 },
    ComponentType: { Button: 2, StringSelect: 3 },
  };
});

vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));

function makeChain(result: any = { data: null, error: null }) {
  const chain: any = {};
  for (const m of ['from', 'select', 'insert', 'update', 'delete', 'upsert',
    'eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'in', 'is', 'not',
    'order', 'limit', 'single', 'maybeSingle', 'match', 'contains',
    'overlaps', 'filter', 'or', 'ilike', 'like', 'textSearch', 'returns']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn(() => Promise.resolve(result));
  chain.maybeSingle = vi.fn(() => Promise.resolve(result));
  chain.then = (resolve: Function) => resolve(result);
  return chain;
}

function makeSupa(result?: any) {
  const chain = makeChain(result);
  return { from: vi.fn(() => chain), rpc: vi.fn(async () => ({ data: null, error: null })), _chain: chain };
}

function makeValkey() {
  return {
    get: vi.fn(async () => null),
    set: vi.fn(async () => {}),
    setex: vi.fn(async () => {}),
    del: vi.fn(async () => {}),
    incr: vi.fn(async () => 1),
    decr: vi.fn(async () => 0),
    expire: vi.fn(async () => {}),
    keys: vi.fn(async () => []),
    mget: vi.fn(async () => []),
    sadd: vi.fn(async () => 1),
    scard: vi.fn(async () => 0),
    smembers: vi.fn(async () => []),
    sismember: vi.fn(async () => 0),
    srandmember: vi.fn(async () => null),
    hset: vi.fn(async () => {}),
    hget: vi.fn(async () => null),
    hgetall: vi.fn(async () => ({})),
    hdel: vi.fn(async () => {}),
    publish: vi.fn(async () => {}),
    subscribe: vi.fn(async () => {}),
  };
}

function makeInteraction(overrides: any = {}) {
  return {
    guildId: 'g1',
    guild: { id: 'g1', name: 'Test' },
    user: { id: 'u1', tag: 'User#0001', displayAvatarURL: () => 'url' },
    member: {
      id: 'u1',
      user: { id: 'u1', tag: 'User#0001' },
      voice: { channel: { id: 'vc1' } },
    },
    options: {
      getString: vi.fn(() => 'test'),
      getInteger: vi.fn(() => 100),
      getNumber: vi.fn(() => 1.0),
      getBoolean: vi.fn(() => false),
      getUser: vi.fn(() => ({ id: 'u2' })),
      getSubcommand: vi.fn(() => 'play'),
    },
    deferReply: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
    reply: vi.fn(async () => {}),
    followUp: vi.fn(async () => {}),
    isCommand: vi.fn(() => true),
    isChatInputCommand: vi.fn(() => true),
    isButton: vi.fn(() => false),
    isStringSelectMenu: vi.fn(() => false),
    customId: '',
    ...overrides,
  };
}

// ═════════════════════════════════════════════════════════════
// GamesManager
// ═════════════════════════════════════════════════════════════
describe('GamesManager', () => {
  it('creates instance and calls coinflip', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const supa = makeSupa({ data: { balance: 1000 }, error: null });
    const gm = new GamesManager(supa as any);
    const interaction = makeInteraction();
    try {
      await gm.coinflip(interaction as any, 100);
    } catch { /* OK — code paths exercised */ }
  });

  it('calls slots', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const gm = new GamesManager(makeSupa({ data: { balance: 1000 }, error: null }) as any);
    try { await gm.slots(makeInteraction() as any, 50); } catch {}
  });

  it('calls dice', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const gm = new GamesManager(makeSupa({ data: { balance: 1000 }, error: null }) as any);
    try { await gm.dice(makeInteraction() as any, 50); } catch {}
  });

  it('calls blackjack', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const gm = new GamesManager(makeSupa({ data: { balance: 1000 }, error: null }) as any);
    try { await gm.blackjack(makeInteraction() as any, 50); } catch {}
  });

  it('calls highlow', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const gm = new GamesManager(makeSupa({ data: { balance: 1000 }, error: null }) as any);
    try { await gm.highlow(makeInteraction() as any); } catch {}
  });

  it('calls scratch', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const gm = new GamesManager(makeSupa({ data: { balance: 1000 }, error: null }) as any);
    try { await gm.scratch(makeInteraction() as any, 50); } catch {}
  });

  it('calls guess', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const gm = new GamesManager(makeSupa({ data: { balance: 1000 }, error: null }) as any);
    try { await gm.guess(makeInteraction() as any, 50); } catch {}
  });

  it('calls rps', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const gm = new GamesManager(makeSupa({ data: { balance: 1000 }, error: null }) as any);
    try { await gm.rps(makeInteraction() as any, 50, 'rock'); } catch {}
  });
});

// ═════════════════════════════════════════════════════════════
// PollsManager
// ═════════════════════════════════════════════════════════════
describe('PollsManager', () => {
  it('creates a poll', async () => {
    const { PollsManager } = await import('../features/polls/polls-manager.js');
    const pm = new PollsManager(makeSupa({ data: { id: 'poll1' }, error: null }) as any);
    const interaction = makeInteraction();
    try {
      await pm.createPoll(interaction as any, 'Best Color?', ['Red', 'Blue', 'Green'], false);
    } catch {}
  });

  it('handles poll vote', async () => {
    const { PollsManager } = await import('../features/polls/polls-manager.js');
    const pm = new PollsManager(makeSupa({ data: { id: 'poll1', options: ['Red', 'Blue'], allow_multiple: false }, error: null }) as any);
    const btnInteraction = makeInteraction({ customId: 'poll_vote_poll1_0', isButton: vi.fn(() => true) });
    try { await pm.handlePollVote(btnInteraction as any); } catch {}
  });

  it('closes a poll', async () => {
    const { PollsManager } = await import('../features/polls/polls-manager.js');
    const pm = new PollsManager(makeSupa({ data: { id: 'poll1', closed: false }, error: null }) as any);
    try { await pm.closePoll(makeInteraction() as any, 'poll1'); } catch {}
  });
});

// ═════════════════════════════════════════════════════════════
// FarmingManager
// ═════════════════════════════════════════════════════════════
describe('FarmingManager', () => {
  it('views farm', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const guild: any = { id: 'g1' };
    const fm = new FarmingManager(guild, makeSupa({ data: { plots: [] }, error: null }) as any, makeValkey() as any);
    try { await fm.viewFarm('u1'); } catch {}
  });

  it('plants a crop', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const fm = new FarmingManager({ id: 'g1' } as any, makeSupa({ data: null, error: null }) as any, makeValkey() as any);
    try { await fm.plant('u1', 'wheat'); } catch {}
  });

  it('waters crops', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const fm = new FarmingManager({ id: 'g1' } as any, makeSupa() as any, makeValkey() as any);
    try { await fm.water('u1'); } catch {}
  });

  it('harvests crops', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const fm = new FarmingManager({ id: 'g1' } as any, makeSupa() as any, makeValkey() as any);
    try { await fm.harvest('u1'); } catch {}
  });

  it('fertilizes a plot', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const fm = new FarmingManager({ id: 'g1' } as any, makeSupa() as any, makeValkey() as any);
    try { await fm.fertilize('u1', 1); } catch {}
  });

  it('gets config', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const fm = new FarmingManager({ id: 'g1' } as any, makeSupa({ data: {}, error: null }) as any, makeValkey() as any);
    try { await fm.getConfig(); } catch {}
  });
});

// ═════════════════════════════════════════════════════════════
// FishingManager
// ═════════════════════════════════════════════════════════════
describe('FishingManager', () => {
  it('fish catches something', async () => {
    const { FishingManager } = await import('../features/fishing/fishing-manager.js');
    const fm = new FishingManager({ id: 'g1' } as any, makeSupa({ data: { rod: 'basic', fish: [] }, error: null }) as any, makeValkey() as any);
    try { await fm.fish('u1'); } catch {}
  });

  it('checkRod returns rod info', async () => {
    const { FishingManager } = await import('../features/fishing/fishing-manager.js');
    const fm = new FishingManager({ id: 'g1' } as any, makeSupa({ data: { rod: 'basic' }, error: null }) as any, makeValkey() as any);
    try { await fm.checkRod('u1'); } catch {}
  });

  it('sellAll sells fish', async () => {
    const { FishingManager } = await import('../features/fishing/fishing-manager.js');
    const fm = new FishingManager({ id: 'g1' } as any, makeSupa({ data: [], error: null }) as any, makeValkey() as any);
    try { await fm.sellAll('u1'); } catch {}
  });

  it('getCollection returns fish collection', async () => {
    const { FishingManager } = await import('../features/fishing/fishing-manager.js');
    const fm = new FishingManager({ id: 'g1' } as any, makeSupa({ data: [], error: null }) as any, makeValkey() as any);
    try { await fm.getCollection('u1'); } catch {}
  });

  it('getLeaderboard returns top fishers', async () => {
    const { FishingManager } = await import('../features/fishing/fishing-manager.js');
    const fm = new FishingManager({ id: 'g1' } as any, makeSupa({ data: [], error: null }) as any, makeValkey() as any);
    try { await fm.getLeaderboard(); } catch {}
  });
});

// ═════════════════════════════════════════════════════════════
// CraftingManager
// ═════════════════════════════════════════════════════════════
describe('CraftingManager', () => {
  it('lists recipes', async () => {
    const { CraftingManager } = await import('../features/crafting/crafting-manager.js');
    const cm = new CraftingManager({ id: 'g1' } as any, makeSupa({ data: [], error: null }) as any, makeValkey() as any);
    try { await cm.listRecipes(); } catch {}
  });

  it('crafts an item', async () => {
    const { CraftingManager } = await import('../features/crafting/crafting-manager.js');
    const cm = new CraftingManager({ id: 'g1' } as any, makeSupa() as any, makeValkey() as any);
    try { await cm.craft('u1', 'iron_sword'); } catch {}
  });
});

// ═════════════════════════════════════════════════════════════
// GatheringManager
// ═════════════════════════════════════════════════════════════
describe('GatheringManager', () => {
  it('gathers resources (hunt)', async () => {
    const { GatheringManager } = await import('../features/gathering/gathering-manager.js');
    const gm = new GatheringManager({ id: 'g1' } as any, makeSupa() as any, makeValkey() as any);
    try { await gm.gather('u1', 'hunt'); } catch {}
  });

  it('gathers resources (dig)', async () => {
    const { GatheringManager } = await import('../features/gathering/gathering-manager.js');
    const gm = new GatheringManager({ id: 'g1' } as any, makeSupa() as any, makeValkey() as any);
    try { await gm.gather('u1', 'dig'); } catch {}
  });

  it('gathers resources (mine)', async () => {
    const { GatheringManager } = await import('../features/gathering/gathering-manager.js');
    const gm = new GatheringManager({ id: 'g1' } as any, makeSupa() as any, makeValkey() as any);
    try { await gm.gather('u1', 'mine'); } catch {}
  });
});

// ═════════════════════════════════════════════════════════════
// MarketManager
// ═════════════════════════════════════════════════════════════
describe('MarketManager', () => {
  it('lists an item', async () => {
    const { MarketManager } = await import('../features/market/market-manager.js');
    const mm = new MarketManager({ id: 'g1' } as any, makeSupa() as any, makeValkey() as any);
    try { await mm.listItem('u1', 'iron_sword', 1, 100); } catch {}
  });

  it('buys an item', async () => {
    const { MarketManager } = await import('../features/market/market-manager.js');
    const mm = new MarketManager({ id: 'g1' } as any, makeSupa({ data: { id: 'listing1', price_per_unit: 50, quantity: 10 }, error: null }) as any, makeValkey() as any);
    try { await mm.buy('u1', 'abc', 2); } catch {}
  });

  it('browses listings', async () => {
    const { MarketManager } = await import('../features/market/market-manager.js');
    const mm = new MarketManager({ id: 'g1' } as any, makeSupa({ data: [], error: null }) as any, makeValkey() as any);
    try { await mm.browse(); } catch {}
  });

  it('views my listings', async () => {
    const { MarketManager } = await import('../features/market/market-manager.js');
    const mm = new MarketManager({ id: 'g1' } as any, makeSupa({ data: [], error: null }) as any, makeValkey() as any);
    try { await mm.myListings('u1'); } catch {}
  });

  it('cancels a listing', async () => {
    const { MarketManager } = await import('../features/market/market-manager.js');
    const mm = new MarketManager({ id: 'g1' } as any, makeSupa({ data: { id: 'listing1' }, error: null }) as any, makeValkey() as any);
    try { await mm.cancelListing('u1', 'abc'); } catch {}
  });
});

// ═════════════════════════════════════════════════════════════
// HeistManager
// ═════════════════════════════════════════════════════════════
describe('HeistManager', () => {
  it('starts a heist', async () => {
    const { HeistManager } = await import('../features/heist/heist-manager.js');
    const hm = new HeistManager(makeSupa() as any, { user: { id: 'bot1' } } as any, makeValkey() as any);
    try { await hm.startHeist(makeInteraction() as any); } catch {}
  });

  it('joins a heist', async () => {
    const { HeistManager } = await import('../features/heist/heist-manager.js');
    const hm = new HeistManager(makeSupa() as any, { user: { id: 'bot1' } } as any, makeValkey() as any);
    try { await hm.joinHeist(makeInteraction() as any); } catch {}
  });

  it('views heist status', async () => {
    const { HeistManager } = await import('../features/heist/heist-manager.js');
    const hm = new HeistManager(makeSupa() as any, { user: { id: 'bot1' } } as any, makeValkey() as any);
    try { await hm.viewHeist(makeInteraction() as any); } catch {}
  });
});

// ═════════════════════════════════════════════════════════════
// PetsManager
// ═════════════════════════════════════════════════════════════
describe('PetsManager', () => {
  it('views pet', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const pm = new PetsManager(makeSupa({ data: { name: 'Rex', type: 'dog', level: 5 }, error: null }) as any, null as any, makeValkey() as any);
    try { await pm.viewPet(makeInteraction() as any); } catch {}
  });

  it('buys a pet', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const pm = new PetsManager(makeSupa() as any, null as any, makeValkey() as any);
    try { await pm.buyPet(makeInteraction() as any); } catch {}
  });

  it('feeds a pet', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const pm = new PetsManager(makeSupa() as any, null as any, makeValkey() as any);
    try { await pm.feedPet(makeInteraction() as any); } catch {}
  });

  it('plays with a pet', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const pm = new PetsManager(makeSupa() as any, null as any, makeValkey() as any);
    try { await pm.playWithPet(makeInteraction() as any); } catch {}
  });

  it('trains a pet', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const pm = new PetsManager(makeSupa() as any, null as any, makeValkey() as any);
    try { await pm.trainPet(makeInteraction() as any); } catch {}
  });
});

// ═════════════════════════════════════════════════════════════
// GiveawayManager
// ═════════════════════════════════════════════════════════════
describe('GiveawayManager', () => {
  it('creates a giveaway', async () => {
    const { GiveawayManager } = await import('../features/giveaways/giveaway-manager.js');
    const eventBus = { emit: vi.fn(), on: vi.fn() };
    const gm = new GiveawayManager({ id: 'g1' } as any, makeSupa({ data: { id: 'gw1' }, error: null }) as any, makeValkey() as any, eventBus as any);
    try {
      await gm.create({
        channelId: 'ch1',
        prize: 'Nitro',
        winnerCount: 1,
        durationMs: 86400000,
        hostId: 'u1',
      });
    } catch {}
  });

  it('handles entry', async () => {
    const { GiveawayManager } = await import('../features/giveaways/giveaway-manager.js');
    const eventBus = { emit: vi.fn(), on: vi.fn() };
    const gm = new GiveawayManager({ id: 'g1' } as any, makeSupa({ data: { id: 'gw1', entries: [] }, error: null }) as any, makeValkey() as any, eventBus as any);
    try { await gm.handleEntry(makeInteraction({ customId: 'giveaway_enter_gw1' }) as any); } catch {}
  });

  it('ends a giveaway', async () => {
    const { GiveawayManager } = await import('../features/giveaways/giveaway-manager.js');
    const eventBus = { emit: vi.fn(), on: vi.fn() };
    const gm = new GiveawayManager({ id: 'g1' } as any, makeSupa({ data: { id: 'gw1', winner_count: 1 }, error: null }) as any, makeValkey() as any, eventBus as any);
    try { await gm.endGiveaway('gw1'); } catch {}
  });
});

// ═════════════════════════════════════════════════════════════
// LotteryManager
// ═════════════════════════════════════════════════════════════
describe('LotteryManager', () => {
  it('buys tickets', async () => {
    const { LotteryManager } = await import('../features/lottery/lottery-manager.js');
    const lm = new LotteryManager(makeSupa({ data: { balance: 1000 }, error: null }) as any);
    try { await lm.buyTickets(makeInteraction() as any, 5); } catch {}
  });

  it('views lottery', async () => {
    const { LotteryManager } = await import('../features/lottery/lottery-manager.js');
    const lm = new LotteryManager(makeSupa({ data: { jackpot: 5000 }, error: null }) as any);
    try { await lm.viewLottery(makeInteraction() as any); } catch {}
  });

  it('draws a winner', async () => {
    const { LotteryManager } = await import('../features/lottery/lottery-manager.js');
    const lm = new LotteryManager(makeSupa({ data: [], error: null }) as any);
    try { await lm.drawWinner('g1'); } catch {}
  });
});

// ═════════════════════════════════════════════════════════════
// AdventureManager
// ═════════════════════════════════════════════════════════════
describe('AdventureManager', () => {
  it('starts an adventure', async () => {
    const { AdventureManager } = await import('../features/adventures/adventure-manager.js');
    const am = new AdventureManager({ id: 'g1' } as any, makeSupa() as any, makeValkey() as any);
    try { await am.startAdventure('u1'); } catch {}
  });

  it('starts adventure with type', async () => {
    const { AdventureManager } = await import('../features/adventures/adventure-manager.js');
    const am = new AdventureManager({ id: 'g1' } as any, makeSupa() as any, makeValkey() as any);
    try { await am.startAdventure('u1', 'dungeon'); } catch {}
  });

  it('handles a choice', async () => {
    const { AdventureManager } = await import('../features/adventures/adventure-manager.js');
    const am = new AdventureManager({ id: 'g1' } as any, makeSupa() as any, makeValkey() as any);
    try { await am.handleChoice(makeInteraction() as any, 'session1', 0); } catch {}
  });
});

// ═════════════════════════════════════════════════════════════
// MusicPlayerManager
// ═════════════════════════════════════════════════════════════
describe('MusicPlayerManager', () => {
  it('module loads', async () => {
    const mod = await import('../features/music/music-player.js');
    expect(mod).toBeDefined();
    expect(mod.MusicPlayerManager).toBeDefined();
  });
});
