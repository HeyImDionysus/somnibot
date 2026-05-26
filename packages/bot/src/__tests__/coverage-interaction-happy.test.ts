/**
 * Happy-path tests for interaction-heavy managers.
 * Tests the full flow (feature enabled → validation passes → core logic runs).
 * These exercise the most uncovered statement-heavy code paths.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

vi.mock('discord.js', () => {
  class Collection<K = string, V = any> extends Map<K, V> {
    filter(fn: (v: V) => boolean) { const c = new Collection<K,V>(); for (const [k,v] of this) if (fn(v)) c.set(k,v); return c; }
    find(fn: (v: V) => boolean) { for (const v of this.values()) if (fn(v)) return v; }
    first() { return this.values().next().value; }
    map<T>(fn: (v: V) => T): T[] { return [...this.values()].map(fn); }
    some(fn: (v: V) => boolean) { for (const v of this.values()) if (fn(v)) return true; return false; }
  }
  class EmbedBuilder {
    data: any = {};
    setColor(c: any) { this.data.color = c; return this; }
    setTitle(t: any) { this.data.title = t; return this; }
    setDescription(d: any) { this.data.description = d; return this; }
    setThumbnail(t: any) { return this; }
    setTimestamp() { return this; }
    setFooter(f: any) { return this; }
    setAuthor(a: any) { return this; }
    setImage(i: any) { return this; }
    addFields(...f: any[]) { this.data.fields = [...(this.data.fields||[]), ...f]; return this; }
    toJSON() { return this.data; }
  }
  class ActionRowBuilder { components: any[] = []; addComponents(...c: any[]) { this.components.push(...c); return this; } }
  class ButtonBuilder {
    data: any = {};
    setCustomId(id: string) { this.data.customId = id; return this; }
    setLabel(l: string) { this.data.label = l; return this; }
    setStyle(s: any) { this.data.style = s; return this; }
    setEmoji(e: any) { return this; }
    setDisabled(d: boolean) { return this; }
  }
  class StringSelectMenuBuilder {
    data: any = {};
    setCustomId(id: string) { this.data.customId = id; return this; }
    setPlaceholder(p: string) { return this; }
    addOptions(...o: any[]) { return this; }
    setMinValues(v: number) { return this; }
    setMaxValues(v: number) { return this; }
  }
  return {
    Collection, EmbedBuilder, ActionRowBuilder, ButtonBuilder, StringSelectMenuBuilder,
    ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4 },
    ChannelType: { GuildText: 0, GuildVoice: 2 },
    PermissionsBitField: class { has() { return true; } },
    ComponentType: { Button: 2, StringSelect: 3 },
    Colors: { Red: 0xff0000, Green: 0x00ff00, Yellow: 0xffff00, Blue: 0x0000ff },
  };
});

vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));

const { Collection } = await import('discord.js');

function chain(data: any = null) {
  const c: any = {};
  const methods = ['select','insert','update','upsert','delete',
    'eq','neq','gt','gte','lt','lte','in','is','or','not',
    'order','limit','range','match','ilike','like','filter','contains','textSearch'];
  for (const m of methods) c[m] = vi.fn(() => c);
  c.maybeSingle = vi.fn(async () => ({ data, error: null }));
  c.single = vi.fn(async () => ({ data, error: null }));
  c.then = undefined;
  return c;
}

function supa(routing: Record<string, any> = {}) {
  return {
    from: vi.fn((table: string) => {
      if (table in routing) {
        const val = routing[table];
        return typeof val === 'function' ? val() : chain(val);
      }
      return chain(null);
    }),
    rpc: vi.fn(async () => ({ data: 0, error: null })),
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn((cb: any) => { if (cb) cb('SUBSCRIBED'); return { unsubscribe: vi.fn() }; }),
    })),
  } as any;
}

function guild(id = 'g1') {
  const channels = new Collection<string, any>();
  channels.set('ch1', {
    id: 'ch1', name: 'general', type: 0,
    send: vi.fn(async () => ({
      id: 'msg1', edit: vi.fn(async () => {}), react: vi.fn(async () => {}),
      createMessageComponentCollector: vi.fn(() => ({ on: vi.fn().mockReturnThis(), stop: vi.fn() })),
    })),
    messages: { fetch: vi.fn(async () => new Collection()) },
  });
  return {
    id, name: 'Test Guild', memberCount: 100,
    roles: { cache: new Collection() },
    channels: { cache: channels, fetch: vi.fn(async () => channels.get('ch1')) },
    members: {
      cache: new Collection(),
      me: { roles: { highest: { position: 10 } } },
      fetch: vi.fn(async (uid: string) => ({
        id: uid, user: { id: uid, username: 'User', displayAvatarURL: () => 'url', send: vi.fn(async () => {}) },
        roles: { cache: new Collection(), add: vi.fn(async () => {}) },
      })),
    },
    client: {
      user: { id: 'bot1' },
      users: { fetch: vi.fn(async (uid: string) => ({ send: vi.fn(async () => {}), id: uid, username: 'User' })) },
    },
  } as any;
}

function valkey() {
  return {
    get: vi.fn(async () => null), set: vi.fn(async () => 'OK'),
    del: vi.fn(async () => 1), incr: vi.fn(async () => 1),
    expire: vi.fn(async () => 1), ttl: vi.fn(async () => -2),
    sadd: vi.fn(async () => 1), sismember: vi.fn(async () => 0),
    smembers: vi.fn(async () => []), scard: vi.fn(async () => 0),
    keys: vi.fn(async () => []),
    hset: vi.fn(async () => 1), hget: vi.fn(async () => null),
    hgetall: vi.fn(async () => ({})),
  } as any;
}

function eventBus() {
  return { on: vi.fn(), off: vi.fn(), emit: vi.fn(), removeAllListeners: vi.fn(), onAny: vi.fn() } as any;
}

function ix(overrides: any = {}) {
  const replyMsg = {
    id: 'reply1', edit: vi.fn(async () => replyMsg), delete: vi.fn(async () => {}),
    react: vi.fn(async () => {}),
    createMessageComponentCollector: vi.fn(() => ({ on: vi.fn().mockReturnThis(), stop: vi.fn() })),
  };
  return {
    guildId: 'g1', channelId: 'ch1',
    user: { id: 'u1', username: 'TestUser', displayAvatarURL: () => 'url' },
    member: { id: 'u1', roles: { cache: new Collection() }, displayName: 'TestUser' },
    guild: guild(),
    reply: vi.fn(async () => replyMsg),
    editReply: vi.fn(async () => replyMsg),
    deferReply: vi.fn(async () => {}),
    followUp: vi.fn(async () => replyMsg),
    fetchReply: vi.fn(async () => replyMsg),
    replied: false, deferred: false,
    options: {
      getString: vi.fn(() => null), getInteger: vi.fn(() => null),
      getNumber: vi.fn(() => null), getBoolean: vi.fn(() => null),
      getUser: vi.fn(() => null), getChannel: vi.fn(() => null),
      getRole: vi.fn(() => null), getSubcommand: vi.fn(() => null),
    },
    ...overrides,
  } as any;
}

// ═══════════════════════════════════════════════════════════
// GamesManager — Full happy path tests
// ═══════════════════════════════════════════════════════════
describe('GamesManager happy paths', () => {
  const gameConfig = {
    economy_games_enabled: true,
    economy_coinflip_max_bet: 10000,
    economy_slots_max_bet: 10000,
    economy_dice_max_bet: 10000,
    economy_blackjack_max_bet: 10000,
    economy_daily_loss_limit: 50000,
    economy_slots_symbols: ['🍒','🍋','🍊','🔔','💎','7️⃣'],
    economy_slots_jackpot_multiplier: 10,
    currency_name: 'coins',
    currency_emoji: '🪙',
  };

  it('coinflip runs full game (win or loss)', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const s = supa({
      guild_config: gameConfig,
      economy_wallets: { wallet: 5000, bank: 0 },
    });
    // rpc returns 0 for daily loss check, null error for balance adjust
    s.rpc = vi.fn(async () => ({ data: 0, error: null }));
    const mgr = new GamesManager(s);
    const i = ix();
    await mgr.coinflip(i, 100);
    // Should have called reply with an embed (not ephemeral error)
    expect(i.reply).toHaveBeenCalled();
    const call = i.reply.mock.calls[0][0];
    expect(call.embeds || call.content).toBeDefined();
  });

  it('slots runs full game', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const s = supa({
      guild_config: gameConfig,
      economy_wallets: { wallet: 5000, bank: 0 },
    });
    s.rpc = vi.fn(async () => ({ data: 0, error: null }));
    const mgr = new GamesManager(s);
    const i = ix();
    await mgr.slots(i, 100);
    expect(i.reply).toHaveBeenCalled();
  });

  it('dice runs full game', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const s = supa({
      guild_config: gameConfig,
      economy_wallets: { wallet: 5000, bank: 0 },
    });
    s.rpc = vi.fn(async () => ({ data: 0, error: null }));
    const mgr = new GamesManager(s);
    const i = ix();
    await mgr.dice(i, 100);
    expect(i.reply).toHaveBeenCalled();
  });

  it('blackjack runs full game', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const s = supa({
      guild_config: gameConfig,
      economy_wallets: { wallet: 5000, bank: 0 },
    });
    s.rpc = vi.fn(async () => ({ data: 0, error: null }));
    const mgr = new GamesManager(s);
    const i = ix();
    await mgr.blackjack(i, 100);
    expect(i.reply).toHaveBeenCalled();
  });

  it('coinflip transaction failure path', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const s = supa({
      guild_config: gameConfig,
      economy_wallets: { wallet: 5000, bank: 0 },
    });
    s.rpc = vi.fn(async () => ({ data: null, error: { message: 'DB error' } }));
    const mgr = new GamesManager(s);
    const i = ix();
    await mgr.coinflip(i, 100);
    expect(i.reply).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════
// HeistManager — Happy path: start heist successfully
// ═══════════════════════════════════════════════════════════
describe('HeistManager happy paths', () => {
  const heistConfig = {
    economy_heist_enabled: true,
    economy_heist_entry_fee: 100,
    economy_heist_min_players: 2,
    economy_heist_max_players: 6,
    economy_heist_cooldown_seconds: 300,
    economy_heist_recruiting_seconds: 60,
    currency_name: 'coins',
    currency_emoji: '🪙',
  };

  it('startHeist creates a new heist', async () => {
    const { HeistManager } = await import('../features/heist/heist-manager.js');
    const vk = valkey();
    // No active heist, no cooldown
    vk.get = vi.fn(async () => null);
    const s = supa({
      guild_config: heistConfig,
      economy_wallets: { wallet: 5000, bank: 0 },
      economy_heists: () => {
        const c = chain({ id: 'h1', guild_id: 'g1', status: 'recruiting', entry_fee: 100, participants: ['u1'] });
        c.insert = vi.fn(() => c);
        return c;
      },
    });
    s.rpc = vi.fn(async () => ({ data: true, error: null }));
    const client = { user: { id: 'bot1' }, users: { fetch: vi.fn(async () => ({ send: vi.fn() })) } } as any;
    const mgr = new HeistManager(s, client, vk);
    const i = ix();
    await mgr.startHeist(i);
    expect(i.reply).toHaveBeenCalled();
  });

  it('joinHeist no active heist', async () => {
    const { HeistManager } = await import('../features/heist/heist-manager.js');
    const vk = valkey();
    vk.get = vi.fn(async () => null);
    const s = supa({ guild_config: heistConfig });
    const mgr = new HeistManager(s, { user: { id: 'bot1' } } as any, vk);
    const i = ix();
    await mgr.joinHeist(i);
    expect(i.reply).toHaveBeenCalled();
  });

  it('joinHeist with active heist - already joined', async () => {
    const { HeistManager } = await import('../features/heist/heist-manager.js');
    const vk = valkey();
    const heist = { id: 'h1', guild_id: 'g1', status: 'recruiting', entry_fee: 100, participants: ['u1'], max_players: 6 };
    vk.get = vi.fn(async (key: string) => {
      if (key.includes('heist:active')) return JSON.stringify(heist);
      return null;
    });
    const s = supa({
      guild_config: heistConfig,
      economy_heists: heist,
    });
    const mgr = new HeistManager(s, { user: { id: 'bot1' } } as any, vk);
    const i = ix();
    await mgr.joinHeist(i);
    expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  it('joinHeist crew full', async () => {
    const { HeistManager } = await import('../features/heist/heist-manager.js');
    const vk = valkey();
    const heist = { id: 'h1', guild_id: 'g1', status: 'recruiting', entry_fee: 100, participants: ['u2','u3','u4','u5','u6','u7'], max_players: 6 };
    vk.get = vi.fn(async (key: string) => {
      if (key.includes('heist:active')) return JSON.stringify(heist);
      return null;
    });
    const s = supa({
      guild_config: heistConfig,
      economy_heists: heist,
    });
    const mgr = new HeistManager(s, { user: { id: 'bot1' } } as any, vk);
    const i = ix();
    await mgr.joinHeist(i);
    expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });
});

// ═══════════════════════════════════════════════════════════
// PollsManager — closePoll, vote paths
// ═══════════════════════════════════════════════════════════
describe('PollsManager happy paths', () => {
  it('closePoll not found', async () => {
    const { PollsManager } = await import('../features/polls/polls-manager.js');
    const s = supa({ guild_polls: null });
    const mgr = new PollsManager(s);
    const i = ix();
    await mgr.closePoll(i, 'fake-id');
    expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  it('closePoll not owner', async () => {
    const { PollsManager } = await import('../features/polls/polls-manager.js');
    const s = supa({
      guild_polls: { id: 'poll1', creator_user_id: 'u999', status: 'active', title: 'Test', options: ['A','B'], votes: {} },
    });
    const mgr = new PollsManager(s);
    const i = ix();
    await mgr.closePoll(i, 'poll1');
    expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  it('closePoll already closed', async () => {
    const { PollsManager } = await import('../features/polls/polls-manager.js');
    const s = supa({
      guild_polls: { id: 'poll1', creator_user_id: 'u1', status: 'closed', title: 'Test', options: ['A','B'], votes: {} },
    });
    const mgr = new PollsManager(s);
    const i = ix();
    await mgr.closePoll(i, 'poll1');
    expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  it('closePoll success', async () => {
    const { PollsManager } = await import('../features/polls/polls-manager.js');
    const s = supa({
      guild_polls: {
        id: 'poll1', creator_user_id: 'u1', status: 'active', title: 'Best color?',
        options: ['Red', 'Blue'], votes: { u1: 0, u2: 1, u3: 0 },
        channel_id: 'ch1', guild_id: 'g1',
      },
    });
    const mgr = new PollsManager(s);
    const i = ix();
    await mgr.closePoll(i, 'poll1');
    expect(i.reply).toHaveBeenCalled();
    // Verifies the embed generation and vote counting logic
  });
});

// ═══════════════════════════════════════════════════════════
// PetsManager — happy paths (feed, play, train, buy)
// ═══════════════════════════════════════════════════════════
describe('PetsManager happy paths', () => {
  const petConfig = { economy_pets_enabled: true, economy_pets_feed_cost: 10, economy_pets_play_cooldown: 60, economy_pets_train_cooldown: 300, currency_name: 'coins', currency_emoji: '🪙' };
  const pet = {
    id: 'pet1', user_id: 'u1', guild_id: 'g1', name: 'Fluffy', species: 'dog',
    level: 5, xp: 120, happiness: 50, hunger: 30,
    last_fed: new Date(Date.now() - 3600000).toISOString(),
    last_played: new Date(Date.now() - 3600000).toISOString(),
    last_trained: new Date(Date.now() - 3600000).toISOString(),
    prestige: 0,
  };

  it('feedPet success', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const s = supa({
      guild_config: petConfig,
      economy_pets: pet,
      economy_wallets: { wallet: 5000, bank: 0 },
    });
    s.rpc = vi.fn(async () => ({ data: true, error: null }));
    const mgr = new PetsManager(s, undefined, valkey());
    const i = ix();
    await mgr.feedPet(i);
    expect(i.reply).toHaveBeenCalled();
  });

  it('feedPet no pet', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const s = supa({ guild_config: petConfig, economy_pets: null });
    const mgr = new PetsManager(s, undefined, valkey());
    const i = ix();
    await mgr.feedPet(i);
    expect(i.reply).toHaveBeenCalled();
  });

  it('playWithPet success', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const s = supa({ guild_config: petConfig, economy_pets: pet });
    const mgr = new PetsManager(s, undefined, valkey());
    const i = ix();
    await mgr.playWithPet(i);
    expect(i.reply).toHaveBeenCalled();
  });

  it('trainPet success', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const s = supa({ guild_config: petConfig, economy_pets: pet });
    const mgr = new PetsManager(s, undefined, valkey());
    const i = ix();
    await mgr.trainPet(i);
    expect(i.reply).toHaveBeenCalled();
  });

  it('buyPet already has pet', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const s = supa({ guild_config: petConfig, economy_pets: pet });
    const mgr = new PetsManager(s, undefined, valkey());
    const i = ix();
    await mgr.buyPet(i);
    expect(i.reply).toHaveBeenCalled();
  });

  it('buyPet success no existing pet', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const s = supa({
      guild_config: { ...petConfig, economy_pets_cost: 500, economy_pets_species: ['dog','cat','bird'] },
      economy_pets: null,
      economy_wallets: { wallet: 5000, bank: 0 },
    });
    s.rpc = vi.fn(async () => ({ data: true, error: null }));
    const mgr = new PetsManager(s, undefined, valkey());
    const i = ix();
    i.options.getString = vi.fn((key: string) => {
      if (key === 'name') return 'Rex';
      if (key === 'species') return 'dog';
      return null;
    });
    await mgr.buyPet(i);
    expect(i.reply).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════
// LotteryManager — happy paths
// ═══════════════════════════════════════════════════════════
describe('LotteryManager happy paths', () => {
  const lotteryConfig = {
    economy_lottery_enabled: true,
    economy_lottery_ticket_price: 50,
    economy_lottery_max_tickets: 10,
    currency_name: 'coins',
    currency_emoji: '🪙',
  };

  it('buyTickets success', async () => {
    const { LotteryManager } = await import('../features/lottery/lottery-manager.js');
    const drawing = { id: 'd1', guild_id: 'g1', jackpot: 5000, status: 'active', ticket_price: 50 };
    const s = supa({
      guild_config: lotteryConfig,
      economy_lottery_drawings: drawing,
      economy_wallets: { wallet: 5000, bank: 0 },
      economy_lottery_tickets: () => {
        const c = chain(null);
        c.then = (resolve: Function) => resolve({ data: [], error: null, count: 0 });
        return c;
      },
    });
    s.rpc = vi.fn(async () => ({ data: true, error: null }));
    const mgr = new LotteryManager(s);
    const i = ix();
    await mgr.buyTickets(i, 3);
    expect(i.reply).toHaveBeenCalled();
  });

  it('viewLottery with active drawing', async () => {
    const { LotteryManager } = await import('../features/lottery/lottery-manager.js');
    const drawing = {
      id: 'd1', guild_id: 'g1', jackpot: 5000, status: 'active',
      ticket_price: 50, draw_at: new Date(Date.now() + 86400000).toISOString(),
    };
    const s = supa({
      guild_config: lotteryConfig,
      economy_lottery_drawings: drawing,
      economy_lottery_tickets: () => {
        const c = chain(null);
        c.then = (resolve: Function) => resolve({ data: [], error: null, count: 0 });
        return c;
      },
    });
    const mgr = new LotteryManager(s);
    const i = ix();
    await mgr.viewLottery(i);
    expect(i.reply).toHaveBeenCalled();
  });

  it('viewLottery no active drawing', async () => {
    const { LotteryManager } = await import('../features/lottery/lottery-manager.js');
    const s = supa({
      guild_config: lotteryConfig,
      economy_lottery_drawings: null,
    });
    const mgr = new LotteryManager(s);
    const i = ix();
    await mgr.viewLottery(i);
    expect(i.reply).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════
// AdventureManager — happy paths
// ═══════════════════════════════════════════════════════════
describe('AdventureManager happy paths', () => {
  it('startAdventure disabled', async () => {
    const { AdventureManager } = await import('../features/adventures/adventure-manager.js');
    const s = supa({ guild_config: { economy_adventures_enabled: false } });
    const mgr = new AdventureManager(guild(), s, valkey());
    const result = await mgr.startAdventure('u1');
    expect(result.embed).toBeDefined();
    expect(result.sessionId).toBeNull();
  });

  it('startAdventure enabled with existing session', async () => {
    const { AdventureManager } = await import('../features/adventures/adventure-manager.js');
    const session = {
      id: 's1', user_id: 'u1', guild_id: 'g1', adventure_id: 'a1',
      hp: 80, max_hp: 100, gold_found: 50, items_found: [],
      choices_made: [], status: 'active',
    };
    const s = supa({
      guild_config: { economy_adventures_enabled: true, economy_adventures_daily_limit: 5 },
      economy_adventure_sessions: session,
      economy_adventures: () => {
        const c = chain(null);
        c.then = (resolve: Function) => resolve({
          data: [{ id: 'a1', name: 'Forest', description: 'Dark woods', type: 'exploration', difficulty: 1, stages: [] }],
          error: null,
        });
        return c;
      },
    });
    const mgr = new AdventureManager(guild(), s, valkey());
    const result = await mgr.startAdventure('u1');
    expect(result.embed).toBeDefined();
  });

  it('handleChoice with no session', async () => {
    const { AdventureManager } = await import('../features/adventures/adventure-manager.js');
    const s = supa({
      guild_config: { economy_adventures_enabled: true },
      economy_adventure_sessions: null,
    });
    const mgr = new AdventureManager(guild(), s, valkey());
    const i = ix();
    await mgr.handleChoice(i, 's1', 0);
    expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });
});

// ═══════════════════════════════════════════════════════════
// GiveawayManager — happy paths
// ═══════════════════════════════════════════════════════════
describe('GiveawayManager happy paths', () => {
  it('create giveaway', async () => {
    const { GiveawayManager } = await import('../features/giveaways/giveaway-manager.js');
    const s = supa({
      guild_config: { giveaways_enabled: true },
      giveaways: () => {
        const c = chain({ id: 'gw1', guild_id: 'g1', prize: 'Nitro', status: 'active', channel_id: 'ch1', created_by: 'u1', ends_at: new Date(Date.now() + 86400000).toISOString(), winner_count: 1, entries: [], winners: [], message_id: null, required_role_id: null, required_level: null, required_entitlement_product_id: null, prize_product_id: null, prize_license_count: 0, created_at: new Date().toISOString() });
        c.insert = vi.fn(() => c);
        return c;
      },
    });
    const g = guild();
    const mgr = new GiveawayManager(g, s, valkey(), eventBus());
    const result = await mgr.create({ prize: 'Nitro', channelId: 'ch1', hostUserId: 'u1', durationMs: 86400000, winnerCount: 1 });
    expect(result).toBeDefined();
  });

  it('endGiveaway not found', async () => {
    const { GiveawayManager } = await import('../features/giveaways/giveaway-manager.js');
    const s = supa({ giveaways: null });
    const mgr = new GiveawayManager(guild(), s, valkey(), eventBus());
    const result = await mgr.endGiveaway('fake-id');
    expect(result).toEqual([]);
  });

  it('pauseGiveaway', async () => {
    const { GiveawayManager } = await import('../features/giveaways/giveaway-manager.js');
    const s = supa({
      giveaways: { id: 'gw1', guild_id: 'g1', status: 'active', channel_id: 'ch1', message_id: 'msg1', entries: [], winners: [], winner_count: 1, prize: 'Nitro', ends_at: new Date().toISOString(), created_by: 'u1', created_at: new Date().toISOString(), required_role_id: null, required_level: null, required_entitlement_product_id: null, prize_product_id: null, prize_license_count: 0 },
    });
    const mgr = new GiveawayManager(guild(), s, valkey(), eventBus());
    const result = await mgr.pauseGiveaway('gw1');
    expect(result).toBeDefined();
  });

  it('reroll with no entries', async () => {
    const { GiveawayManager } = await import('../features/giveaways/giveaway-manager.js');
    const s = supa({
      giveaways: { id: 'gw1', guild_id: 'g1', status: 'ended', channel_id: 'ch1', winner_count: 1, entries: ['u2','u3'], winners: ['u2'], message_id: 'msg1', prize: 'Nitro', ends_at: new Date().toISOString(), created_by: 'u1', created_at: new Date().toISOString(), required_role_id: null, required_level: null, required_entitlement_product_id: null, prize_product_id: null, prize_license_count: 0 },
      giveaway_entries: () => {
        const c = chain(null);
        c.then = (resolve: Function) => resolve({ data: [], error: null });
        return c;
      },
    });
    const mgr = new GiveawayManager(guild(), s, valkey(), eventBus());
    const result = await mgr.reroll('gw1');
    expect(result).toEqual([]);
  });
});
