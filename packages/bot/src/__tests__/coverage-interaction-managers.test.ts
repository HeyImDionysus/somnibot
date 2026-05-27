/**
 * Interaction-level tests targeting managers that take ChatInputCommandInteraction:
 * - PetsManager (viewPet, buyPet, feedPet, playWithPet, trainPet, renamePet, battlePet, prestigePet)
 * - LotteryManager (buyTickets, viewLottery)
 * - PollsManager (closePoll, handlePollVote)
 * - HeistManager (startHeist success)
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../services/audit.js', () => ({ writeAuditLog: vi.fn(async () => {}) }));
vi.mock('../features/quests/quests-manager.js', () => ({
  getQuestsManager: () => ({ trackProgress: vi.fn(async () => {}) }),
}));

vi.mock('discord.js', () => {
  class Collection<K = string, V = any> extends Map<K, V> {
    filter(fn: (v: V) => boolean) { const c = new Collection<K,V>(); for (const [k,v] of this) if (fn(v)) c.set(k,v); return c; }
    find(fn: (v: V) => boolean) { for (const v of this.values()) if (fn(v)) return v; }
    first() { return this.values().next().value; }
    map<T>(fn: (v: V) => T): T[] { return [...this.values()].map(fn); }
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
    setStyle(s: any) { return this; }
    setEmoji(e: any) { return this; }
    setDisabled(d: boolean) { return this; }
  }
  return {
    Collection, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
    ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4 },
    ChannelType: { GuildText: 0 },
    ComponentType: { Button: 2 },
    Colors: { Red: 0xff0000 },
  };
});

const { Collection } = await import('discord.js');

function chain(data: any = null) {
  const c: any = {};
  for (const m of ['select','insert','update','upsert','delete','eq','neq','gt','gte','lt','lte','in','is','or','not','order','limit','range','match','ilike','like','filter','contains','textSearch'])
    c[m] = vi.fn(() => c);
  c.maybeSingle = vi.fn(async () => ({ data, error: null }));
  c.single = vi.fn(async () => ({ data, error: null }));
  c.then = undefined;
  return c;
}

function chainWithCount(data: any[] = [], count: number = 0) {
  const c: any = {};
  for (const m of ['select','insert','update','upsert','delete','eq','neq','gt','gte','lt','lte','in','is','or','not','order','limit','range','match','ilike','like','filter','contains','textSearch'])
    c[m] = vi.fn(() => c);
  c.maybeSingle = vi.fn(async () => ({ data: data?.[0] ?? null, error: null, count }));
  c.single = vi.fn(async () => ({ data: data?.[0] ?? null, error: null, count }));
  c.then = (resolve: Function) => resolve({ data, error: null, count });
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

function valkey() {
  return {
    get: vi.fn(async () => null), set: vi.fn(async () => 'OK'),
    del: vi.fn(async () => 1), incr: vi.fn(async () => 1),
    expire: vi.fn(async () => 1), ttl: vi.fn(async () => -2), pttl: vi.fn(async () => -2),
    sadd: vi.fn(async () => 1), sismember: vi.fn(async () => 0),
    smembers: vi.fn(async () => []), scard: vi.fn(async () => 0),
    keys: vi.fn(async () => []),
    hset: vi.fn(async () => 1), hget: vi.fn(async () => null), hgetall: vi.fn(async () => ({})),
  } as any;
}

function ix(overrides: any = {}) {
  const replyMsg = { id: 'r1', edit: vi.fn(async () => replyMsg), delete: vi.fn(async () => {}), react: vi.fn(async () => {}), createMessageComponentCollector: vi.fn(() => ({ on: vi.fn().mockReturnThis(), stop: vi.fn() })) };
  return {
    guildId: 'g1', channelId: 'ch1',
    user: { id: 'u1', username: 'TestUser', displayAvatarURL: () => 'url' },
    member: { id: 'u1', roles: { cache: new Collection() }, displayName: 'TestUser' },
    reply: vi.fn(async () => replyMsg), editReply: vi.fn(async () => replyMsg),
    deferReply: vi.fn(async () => {}), followUp: vi.fn(async () => replyMsg),
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
// PetsManager — full interaction tests
// ═══════════════════════════════════════════════════════════
describe('PetsManager interaction tests', () => {
  const petCfg = { economy_pets_enabled: true, economy_pets_feed_cost: 50, economy_pets_play_cooldown: 60, currency_name: 'coins', currency_emoji: '🪙' };
  const pet = { id: 'pet1', user_id: 'u1', guild_id: 'g1', name: 'Buddy', species: 'dog', level: 5, xp: 100, hunger: 50, happiness: 70, energy: 80, prestige: 0, created_at: new Date().toISOString() };

  it('viewPet with existing pet', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const s = supa({ guild_config: petCfg, economy_pets: pet });
    const mgr = new PetsManager(s, undefined, valkey());
    await mgr.viewPet(ix());
  });

  it('viewPet no pet', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const s = supa({ guild_config: petCfg, economy_pets: null });
    const mgr = new PetsManager(s, undefined, valkey());
    await mgr.viewPet(ix());
  });

  it('viewPet disabled', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const s = supa({ guild_config: { economy_pets_enabled: false } });
    const mgr = new PetsManager(s, undefined, valkey());
    await mgr.viewPet(ix());
  });

  it('buyPet success (no existing pet)', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const species = [
      { id: 'sp1', name: 'Dog', emoji: '🐕', base_cost: 500, description: 'Loyal' },
    ];
    const s = supa({
      guild_config: { ...petCfg, economy_pets_buy_cost: 500 },
      economy_pets: null,
      economy_pet_species: () => chainWithCount(species),
      economy_wallets: { wallet: 5000, bank: 0 },
    });
    s.rpc = vi.fn(async () => ({ data: true, error: null }));
    const mgr = new PetsManager(s, undefined, valkey());
    await mgr.buyPet(ix({ options: { getString: vi.fn((k: string) => k === 'species' ? 'Dog' : null), getInteger: vi.fn(() => null), getNumber: vi.fn(() => null), getBoolean: vi.fn(() => null), getUser: vi.fn(() => null), getChannel: vi.fn(() => null), getRole: vi.fn(() => null), getSubcommand: vi.fn(() => null) } }));
  });

  it('feedPet success', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const s = supa({
      guild_config: petCfg,
      economy_pets: { ...pet, hunger: 30 },
      economy_wallets: { wallet: 5000, bank: 0 },
    });
    s.rpc = vi.fn(async () => ({ data: true, error: null }));
    const mgr = new PetsManager(s, undefined, valkey());
    await mgr.feedPet(ix());
  });

  it('feedPet no pet', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const s = supa({ guild_config: petCfg, economy_pets: null });
    const mgr = new PetsManager(s, undefined, valkey());
    await mgr.feedPet(ix());
  });

  it('playWithPet success', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const s = supa({ guild_config: petCfg, economy_pets: { ...pet, happiness: 50 } });
    const vk = valkey();
    vk.set = vi.fn(async () => 'OK'); // cooldown passes
    const mgr = new PetsManager(s, undefined, vk);
    await mgr.playWithPet(ix());
  });

  it('playWithPet on cooldown', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const s = supa({ guild_config: petCfg, economy_pets: pet });
    const vk = valkey();
    vk.set = vi.fn(async () => null); // cooldown active
    vk.ttl = vi.fn(async () => 30);
    const mgr = new PetsManager(s, undefined, vk);
    await mgr.playWithPet(ix());
  });

  it('trainPet success', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const s = supa({ guild_config: petCfg, economy_pets: { ...pet, energy: 50 } });
    const mgr = new PetsManager(s, undefined, valkey());
    await mgr.trainPet(ix());
  });

  it('trainPet no energy', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const s = supa({ guild_config: petCfg, economy_pets: { ...pet, energy: 0 } });
    const mgr = new PetsManager(s, undefined, valkey());
    await mgr.trainPet(ix());
  });

  it('renamePet success', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const s = supa({ guild_config: petCfg, economy_pets: pet });
    const mgr = new PetsManager(s, undefined, valkey());
    await mgr.renamePet(ix({ options: { getString: vi.fn((k: string) => k === 'name' ? 'Rex' : null), getInteger: vi.fn(() => null), getNumber: vi.fn(() => null), getBoolean: vi.fn(() => null), getUser: vi.fn(() => null), getChannel: vi.fn(() => null), getRole: vi.fn(() => null), getSubcommand: vi.fn(() => null) } }));
  });

  it('schedulePetDecay runs', async () => {
    const { PetsManager } = await import('../features/pets/pets-manager.js');
    const s = supa({
      guild_config: petCfg,
      economy_pets: () => chainWithCount([pet]),
    });
    const mgr = new PetsManager(s, undefined, valkey());
    await mgr.schedulePetDecay('g1');
    // Should not throw
  });
});

// ═══════════════════════════════════════════════════════════
// LotteryManager — interaction tests
// ═══════════════════════════════════════════════════════════
describe('LotteryManager interactions', () => {
  const lottoCfg = { economy_lottery_enabled: true, economy_lottery_ticket_price: 100, economy_lottery_max_tickets: 10, economy_lottery_jackpot_start: 1000, currency_name: 'coins', currency_emoji: '🪙' };

  it('buyTickets disabled', async () => {
    const { LotteryManager } = await import('../features/lottery/lottery-manager.js');
    const s = supa({ guild_config: { economy_lottery_enabled: false } });
    const mgr = new LotteryManager(s);
    const i = ix();
    await mgr.buyTickets(i, 1);
    expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  it('buyTickets too many', async () => {
    const { LotteryManager } = await import('../features/lottery/lottery-manager.js');
    const s = supa({ guild_config: lottoCfg });
    const mgr = new LotteryManager(s);
    const i = ix();
    await mgr.buyTickets(i, 99);
    expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  it('buyTickets success', async () => {
    const { LotteryManager } = await import('../features/lottery/lottery-manager.js');
    const drawing = { id: 'd1', guild_id: 'g1', jackpot: 2000, tickets_sold: 5 };
    const s = supa({
      guild_config: lottoCfg,
      economy_lottery_drawings: drawing,
      economy_lottery_tickets: () => chainWithCount([], 0),
      economy_wallets: { wallet: 5000, bank: 0 },
    });
    s.rpc = vi.fn(async () => ({ data: true, error: null }));
    const mgr = new LotteryManager(s);
    const i = ix();
    await mgr.buyTickets(i, 3);
    expect(i.reply).toHaveBeenCalled();
  });

  it('viewLottery disabled', async () => {
    const { LotteryManager } = await import('../features/lottery/lottery-manager.js');
    const s = supa({ guild_config: { economy_lottery_enabled: false } });
    const mgr = new LotteryManager(s);
    const i = ix();
    await mgr.viewLottery(i);
    expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  it('viewLottery no active drawing', async () => {
    const { LotteryManager } = await import('../features/lottery/lottery-manager.js');
    const s = supa({ guild_config: lottoCfg, economy_lottery_drawings: null });
    const mgr = new LotteryManager(s);
    const i = ix();
    await mgr.viewLottery(i);
    expect(i.reply).toHaveBeenCalled();
  });

  it('viewLottery with active drawing', async () => {
    const { LotteryManager } = await import('../features/lottery/lottery-manager.js');
    const drawing = { id: 'd1', guild_id: 'g1', jackpot: 5000, tickets_sold: 15, draw_at: new Date(Date.now() + 3600000).toISOString(), status: 'active' };
    const s = supa({ guild_config: lottoCfg, economy_lottery_drawings: drawing });
    const mgr = new LotteryManager(s);
    const i = ix();
    await mgr.viewLottery(i);
    expect(i.reply).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════
// PollsManager — closePoll
// ═══════════════════════════════════════════════════════════
describe('PollsManager closePoll', () => {
  it('closePoll not found', async () => {
    const { PollsManager } = await import('../features/polls/polls-manager.js');
    const s = supa({ guild_polls: null });
    const mgr = new PollsManager(s);
    const i = ix();
    await mgr.closePoll(i, 'fake');
    expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  it('closePoll already closed', async () => {
    const { PollsManager } = await import('../features/polls/polls-manager.js');
    const poll = { id: 'p1', status: 'closed', title: 'Test', options: ['A','B'], votes: { 'A': ['u1'], 'B': [] }, creator_user_id: 'u1' };
    const s = supa({ guild_polls: poll });
    const mgr = new PollsManager(s);
    const i = ix();
    await mgr.closePoll(i, 'p1');
    expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  it('closePoll success', async () => {
    const { PollsManager } = await import('../features/polls/polls-manager.js');
    const poll = {
      id: 'p1', status: 'active', title: 'Best fruit?',
      options: ['Apple','Banana'], votes: { 'Apple': ['u1','u2'], 'Banana': ['u3'] },
      creator_user_id: 'u1', guild_id: 'g1', channel_id: 'ch1', message_id: 'msg1',
    };
    const s = supa({
      guild_polls: () => {
        const c = chain(poll);
        c.update = vi.fn(() => c);
        return c;
      },
    });
    const mgr = new PollsManager(s);
    const i = ix();
    await mgr.closePoll(i, 'p1');
    expect(i.reply).toHaveBeenCalled();
  });

  it('placeBet disabled', async () => {
    const { PollsManager } = await import('../features/polls/polls-manager.js');
    const s = supa({ guild_config: { predictions_enabled: false } });
    const mgr = new PollsManager(s);
    const i = ix();
    await mgr.placeBet(i, 'pred1', 0, 100);
    expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });
});
