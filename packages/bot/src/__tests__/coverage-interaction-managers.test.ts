/**
 * Production-grade tests for interaction-heavy managers:
 * HeistManager, GamesManager, PollsManager, PetsManager, TicketService.
 * Uses proper interaction mock factory for realistic testing.
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
    rpc: vi.fn(async () => ({ data: true, error: null })),
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
    send: vi.fn(async () => ({ id: 'msg1', edit: vi.fn(async () => {}), react: vi.fn(async () => {}),
      createMessageComponentCollector: vi.fn(() => ({ on: vi.fn().mockReturnThis(), stop: vi.fn() })) })),
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

function interaction(overrides: any = {}) {
  const replyMsg = {
    id: 'reply1', edit: vi.fn(async () => replyMsg), delete: vi.fn(async () => {}),
    react: vi.fn(async () => {}),
    createMessageComponentCollector: vi.fn(() => ({ on: vi.fn().mockReturnThis(), stop: vi.fn() })),
  };
  return {
    guildId: 'g1', channelId: 'ch1',
    user: { id: 'u1', username: 'TestUser', displayAvatarURL: () => 'url' },
    member: { id: 'u1', roles: { cache: new Collection() }, displayName: 'TestUser' },
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
// HeistManager — interaction-based methods
// ═══════════════════════════════════════════════════════════
describe('HeistManager interaction tests', () => {
  it('startHeist disabled', async () => {
    const { HeistManager } = await import('../features/heist/heist-manager.js');
    const s = supa({ guild_config: { economy_heist_enabled: false } });
    const mgr = new HeistManager(s, { user: { id: 'bot1' } } as any, valkey());
    const ix = interaction();
    await mgr.startHeist(ix);
    expect(ix.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  it('startHeist already active', async () => {
    const { HeistManager } = await import('../features/heist/heist-manager.js');
    const vk = valkey();
    vk.get = vi.fn(async (key: string) => {
      if (key.includes('heist:active')) return JSON.stringify({ id: 'h1', status: 'recruiting' });
      return null;
    });
    const s = supa({ guild_config: { economy_heist_enabled: true, economy_heist_entry_fee: 100, economy_heist_min_players: 2, economy_heist_max_players: 6, economy_heist_cooldown_seconds: 300 } });
    const mgr = new HeistManager(s, { user: { id: 'bot1' } } as any, vk);
    const ix = interaction();
    await mgr.startHeist(ix);
    // Should inform about existing heist
    expect(ix.reply).toHaveBeenCalled();
  });

  it('joinHeist disabled', async () => {
    const { HeistManager } = await import('../features/heist/heist-manager.js');
    const s = supa({ guild_config: { economy_heist_enabled: false } });
    const mgr = new HeistManager(s, { user: { id: 'bot1' } } as any, valkey());
    const ix = interaction();
    await mgr.joinHeist(ix);
    expect(ix.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  it('resumePendingHeists with none', async () => {
    const { HeistManager } = await import('../features/heist/heist-manager.js');
    const s = supa({
      economy_heists: () => {
        const c = chain(null);
        c.then = (resolve: Function) => resolve({ data: [], error: null });
        return c;
      },
    });
    const mgr = new HeistManager(s, { user: { id: 'bot1' } } as any, valkey());
    await mgr.resumePendingHeists('g1');
    // Should not throw
    expect(true).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// GamesManager — coinflip, dice, slots, blackjack
// ═══════════════════════════════════════════════════════════
describe('GamesManager interaction tests', () => {
  it('coinflip disabled', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const s = supa({ guild_config: { economy_games_enabled: false } });
    const mgr = new GamesManager(s);
    const ix = interaction();
    await mgr.coinflip(ix, 100, 'heads');
    expect(ix.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  it('dice disabled', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const s = supa({ guild_config: { economy_games_enabled: false } });
    const mgr = new GamesManager(s);
    const ix = interaction();
    await mgr.dice(ix, 100, 6);
    expect(ix.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  it('slots disabled', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const s = supa({ guild_config: { economy_games_enabled: false } });
    const mgr = new GamesManager(s);
    const ix = interaction();
    await mgr.slots(ix, 100);
    expect(ix.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  it('blackjack disabled', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const s = supa({ guild_config: { economy_games_enabled: false } });
    const mgr = new GamesManager(s);
    const ix = interaction();
    await mgr.blackjack(ix, 100);
    expect(ix.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  it('coinflip with insufficient balance', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const s = supa({
      guild_config: { economy_games_enabled: true, economy_games_max_bet: 10000, economy_games_daily_loss_limit: 5000 },
      economy_wallets: { wallet: 50, bank: 0 },
    });
    const mgr = new GamesManager(s);
    const ix = interaction();
    await mgr.coinflip(ix, 100, 'heads');
    expect(ix.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  it('coinflip with zero bet', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const s = supa({ guild_config: { economy_games_enabled: true } });
    const mgr = new GamesManager(s);
    const ix = interaction();
    await mgr.coinflip(ix, 0, 'heads');
    expect(ix.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  it('coinflip exceeds max bet', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const s = supa({
      guild_config: { economy_games_enabled: true, economy_games_max_bet: 100 },
    });
    const mgr = new GamesManager(s);
    const ix = interaction();
    await mgr.coinflip(ix, 500, 'heads');
    expect(ix.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });
});

// ═══════════════════════════════════════════════════════════
// PollsManager — createPoll, createPrediction
// ═══════════════════════════════════════════════════════════
describe('PollsManager interaction tests', () => {
  it('createPoll disabled', async () => {
    const { PollsManager } = await import('../features/polls/polls-manager.js');
    const s = supa({ guild_config: { polls_enabled: false } });
    const mgr = new PollsManager(s);
    const ix = interaction();
    await mgr.createPoll(ix, 'Best color?', ['Red', 'Blue'], false);
    expect(ix.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  it('createPoll too few options', async () => {
    const { PollsManager } = await import('../features/polls/polls-manager.js');
    const s = supa({ guild_config: { polls_enabled: true } });
    const mgr = new PollsManager(s);
    const ix = interaction();
    await mgr.createPoll(ix, 'Best color?', ['Red'], false);
    expect(ix.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  it('createPoll success', async () => {
    const { PollsManager } = await import('../features/polls/polls-manager.js');
    const s = supa({
      guild_config: { polls_enabled: true },
      guild_polls: () => {
        const c = chain({ id: 'poll1', title: 'Best color?', options: ['Red','Blue'], votes: {}, allow_multiple: false, status: 'active', guild_id: 'g1', channel_id: 'ch1', creator_user_id: 'u1' });
        c.insert = vi.fn(() => c);
        return c;
      },
    });
    const mgr = new PollsManager(s);
    const ix = interaction();
    await mgr.createPoll(ix, 'Best color?', ['Red', 'Blue'], false);
    expect(ix.reply).toHaveBeenCalled();
  });

  it('createPrediction disabled', async () => {
    const { PollsManager } = await import('../features/polls/polls-manager.js');
    const s = supa({ guild_config: { predictions_enabled: false } });
    const mgr = new PollsManager(s);
    const ix = interaction();
    await mgr.createPrediction(ix, 'Will it rain?', ['Yes', 'No']);
    expect(ix.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  it('createPrediction success', async () => {
    const { PollsManager } = await import('../features/polls/polls-manager.js');
    const s = supa({
      guild_config: { predictions_enabled: true },
      guild_predictions: () => {
        const c = chain({ id: 'pred1', title: 'Will it rain?', outcomes: ['Yes','No'], pool: {}, status: 'active' });
        c.insert = vi.fn(() => c);
        return c;
      },
    });
    const mgr = new PollsManager(s);
    const ix = interaction();
    await mgr.createPrediction(ix, 'Will it rain?', ['Yes', 'No']);
    expect(ix.reply).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════
// PetsManager — interaction methods
// ═══════════════════════════════════════════════════════════
describe('PetsManager interaction tests', () => {
  it('viewPet disabled', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const s = supa({ guild_config: { economy_pets_enabled: false } });
    const mgr = new PetsManager(s);
    const ix = interaction();
    await mgr.viewPet(ix);
    expect(ix.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  it('viewPet no pet', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const s = supa({
      guild_config: { economy_pets_enabled: true },
      economy_pets: null,
    });
    const mgr = new PetsManager(s);
    const ix = interaction();
    await mgr.viewPet(ix);
    expect(ix.reply).toHaveBeenCalled();
  });

  it('viewPet with pet', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const s = supa({
      guild_config: { economy_pets_enabled: true },
      economy_pets: {
        id: 'pet1', user_id: 'u1', guild_id: 'g1', name: 'Fluffy',
        species: 'dog', level: 5, xp: 120, happiness: 80, hunger: 60,
        last_fed: new Date().toISOString(), last_played: new Date().toISOString(),
        prestige: 0,
      },
    });
    const mgr = new PetsManager(s);
    const ix = interaction();
    await mgr.viewPet(ix);
    expect(ix.reply).toHaveBeenCalled();
  });

  it('feedPet disabled', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const s = supa({ guild_config: { economy_pets_enabled: false } });
    const mgr = new PetsManager(s);
    const ix = interaction();
    await mgr.feedPet(ix);
    expect(ix.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  it('playWithPet disabled', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const s = supa({ guild_config: { economy_pets_enabled: false } });
    const mgr = new PetsManager(s);
    const ix = interaction();
    await mgr.playWithPet(ix);
    expect(ix.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  it('trainPet disabled', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const s = supa({ guild_config: { economy_pets_enabled: false } });
    const mgr = new PetsManager(s);
    const ix = interaction();
    await mgr.trainPet(ix);
    expect(ix.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  it('buyPet disabled', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const s = supa({ guild_config: { economy_pets_enabled: false } });
    const mgr = new PetsManager(s);
    const ix = interaction();
    await mgr.buyPet(ix);
    expect(ix.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });
});

// ═══════════════════════════════════════════════════════════
// LotteryManager — interaction methods
// ═══════════════════════════════════════════════════════════
describe('LotteryManager interaction tests', () => {
  it('buyTickets disabled', async () => {
    const { LotteryManager } = await import('../features/lottery/lottery-manager.js');
    const s = supa({ guild_config: { economy_lottery_enabled: false } });
    const mgr = new LotteryManager(s);
    const ix = interaction();
    await mgr.buyTickets(ix, 5);
    expect(ix.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  it('viewLottery disabled', async () => {
    const { LotteryManager } = await import('../features/lottery/lottery-manager.js');
    const s = supa({ guild_config: { economy_lottery_enabled: false } });
    const mgr = new LotteryManager(s);
    const ix = interaction();
    await mgr.viewLottery(ix);
    expect(ix.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });
});
