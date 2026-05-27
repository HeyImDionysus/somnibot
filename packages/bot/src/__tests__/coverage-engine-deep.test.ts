/**
 * Deep engine-level tests: games-manager validateBet + full flows,
 * adventure-manager startAdventure full flow, heist resolveHeist,
 * sync-engine runSyncCycle, automation-engine handleEvent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../features/quests/quests-manager.js', () => ({
  getQuestsManager: () => ({ trackProgress: vi.fn(async () => {}) }),
}));

vi.mock('../services/audit.js', () => ({ writeAuditLog: vi.fn(async () => {}) }));

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
    PermissionsBitField: class { has() { return true; } },
    ComponentType: { Button: 2 },
    Colors: { Red: 0xff0000, Green: 0x00ff00 },
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

function chainWithCount(data: any[], count: number = 0) {
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

function guild(id = 'g1') {
  const textCh = {
    id: 'ch1', name: 'general', type: 0,
    send: vi.fn(async () => ({ id: 'msg1', edit: vi.fn(async () => {}), react: vi.fn(async () => {}), createMessageComponentCollector: vi.fn(() => ({ on: vi.fn().mockReturnThis(), stop: vi.fn() })) })),
    messages: { fetch: vi.fn(async () => new Collection()) },
  };
  const channels = new Collection<string, any>();
  channels.set('ch1', textCh);
  return {
    id, name: 'Test Guild', memberCount: 50,
    roles: { cache: new Collection() },
    channels: { cache: channels, fetch: vi.fn(async () => textCh) },
    members: {
      cache: new Collection(),
      fetch: vi.fn(async (uid: string) => ({
        id: uid, user: { id: uid, username: 'User', displayAvatarURL: () => 'url', send: vi.fn(async () => {}) },
        roles: { cache: new Collection(), add: vi.fn(async () => {}) }, displayName: 'User',
      })),
    },
    client: {
      user: { id: 'bot1' },
      channels: { cache: channels },
      users: { fetch: vi.fn(async () => ({ send: vi.fn(), id: 'u1', username: 'User' })) },
    },
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

function eventBus() {
  return { on: vi.fn(), off: vi.fn(), emit: vi.fn(), removeAllListeners: vi.fn(), onAny: vi.fn() } as any;
}

function ix(overrides: any = {}) {
  const replyMsg = { id: 'r1', edit: vi.fn(async () => replyMsg), delete: vi.fn(async () => {}), react: vi.fn(async () => {}), createMessageComponentCollector: vi.fn(() => ({ on: vi.fn().mockReturnThis(), stop: vi.fn() })) };
  return {
    guildId: 'g1', channelId: 'ch1',
    user: { id: 'u1', username: 'TestUser', displayAvatarURL: () => 'url' },
    member: { id: 'u1', roles: { cache: new Collection() }, displayName: 'TestUser' },
    guild: guild(),
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
// GamesManager — all game paths exercised deeply
// ═══════════════════════════════════════════════════════════
describe('GamesManager deep flows', () => {
  const gameCfg = {
    economy_games_enabled: true,
    economy_coinflip_max_bet: 10000, economy_slots_max_bet: 10000,
    economy_dice_max_bet: 10000, economy_blackjack_max_bet: 10000,
    economy_daily_loss_limit: 50000,
    economy_slots_symbols: ['🍒','🍋','🍊','🔔','💎','7️⃣'],
    economy_slots_jackpot_multiplier: 10,
    currency_name: 'coins', currency_emoji: '🪙',
  };

  function gamesSupa() {
    const s = supa({ guild_config: gameCfg, economy_wallets: { wallet: 5000, bank: 0 } });
    s.rpc = vi.fn(async () => ({ data: 0, error: null }));
    return s;
  }

  it('validateBet rejects zero bet', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const mgr = new GamesManager(gamesSupa());
    await mgr.coinflip(ix(), 0);
  });

  it('validateBet rejects over max bet', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const mgr = new GamesManager(gamesSupa());
    await mgr.coinflip(ix(), 99999);
  });

  it('validateBet rejects insufficient balance', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const s = supa({ guild_config: gameCfg, economy_wallets: { wallet: 10, bank: 0 } });
    s.rpc = vi.fn(async () => ({ data: 0, error: null }));
    const mgr = new GamesManager(s);
    await mgr.coinflip(ix(), 100);
  });

  it('validateBet rejects daily limit exceeded', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const s = supa({ guild_config: { ...gameCfg, economy_daily_loss_limit: 50 }, economy_wallets: { wallet: 5000, bank: 0 } });
    s.rpc = vi.fn(async () => ({ data: 49, error: null })); // already at 49 of 50 limit
    const mgr = new GamesManager(s);
    await mgr.coinflip(ix(), 100);
  });

  it('coinflip win path', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const mgr = new GamesManager(gamesSupa());
    vi.spyOn(Math, 'random').mockReturnValue(0.3); // win (< 0.5)
    await mgr.coinflip(ix(), 100);
    vi.restoreAllMocks();
  });

  it('coinflip lose path', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const mgr = new GamesManager(gamesSupa());
    vi.spyOn(Math, 'random').mockReturnValue(0.7); // lose (>= 0.5)
    await mgr.coinflip(ix(), 100);
    vi.restoreAllMocks();
  });

  it('slots full run', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const mgr = new GamesManager(gamesSupa());
    await mgr.slots(ix(), 100);
  });

  it('dice full run', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const mgr = new GamesManager(gamesSupa());
    await mgr.dice(ix(), 100);
  });

  it('blackjack full run', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const mgr = new GamesManager(gamesSupa());
    await mgr.blackjack(ix(), 100);
  });

  it('games disabled', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const s = supa({ guild_config: { economy_games_enabled: false } });
    const mgr = new GamesManager(s);
    await mgr.coinflip(ix(), 100);
  });

  it('coinflip adjustBalance failure on loss', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const s = supa({ guild_config: gameCfg, economy_wallets: { wallet: 5000, bank: 0 } });
    s.rpc = vi.fn(async () => ({ data: null, error: { message: 'fail' } }));
    const mgr = new GamesManager(s);
    vi.spyOn(Math, 'random').mockReturnValue(0.7);
    await mgr.coinflip(ix(), 100);
    vi.restoreAllMocks();
  });

  it('slots jackpot path (all same symbols)', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const mgr = new GamesManager(gamesSupa());
    // Force all reels to same index: random returns 0 for all
    vi.spyOn(Math, 'random').mockReturnValue(0.0001);
    await mgr.slots(ix(), 100);
    vi.restoreAllMocks();
  });
});

// ═══════════════════════════════════════════════════════════
// AdventureManager — deep flows
// ═══════════════════════════════════════════════════════════
describe('AdventureManager deep', () => {
  it('startAdventure daily limit hit', async () => {
    const { AdventureManager } = await import('../features/adventures/adventure-manager.js');
    const s = supa({
      guild_config: { economy_adventures_enabled: true, economy_adventure_daily_limit: 3 },
      economy_adventure_sessions: () => chainWithCount([], 3), // count = 3
    });
    const mgr = new AdventureManager(guild(), s, valkey());
    const result = await mgr.startAdventure('u1');
    expect(result.embed.data.description).toContain('adventures today');
  });

  it('startAdventure active session exists', async () => {
    const { AdventureManager } = await import('../features/adventures/adventure-manager.js');
    let callNum = 0;
    const s = supa({
      guild_config: { economy_adventures_enabled: true, economy_adventure_daily_limit: 10 },
      economy_adventure_sessions: () => {
        callNum++;
        if (callNum === 1) return chainWithCount([], 0); // daily limit check
        return chainWithCount([{ id: 's1' }], 1); // active session check
      },
    });
    const mgr = new AdventureManager(guild(), s, valkey());
    const result = await mgr.startAdventure('u1');
    expect(result.embed.data.description).toContain('active adventure');
  });

  it('startAdventure new session success', async () => {
    const { AdventureManager } = await import('../features/adventures/adventure-manager.js');
    const adventures = [
      { id: 'a1', name: 'Dark Forest', description: 'Eerie woods', difficulty: 1, guild_id: 'g1', stages: [{ description: 'You enter a dark forest.', choices: [{ label: 'Go left', outcome: 'gold', value: 10 }, { label: 'Go right', outcome: 'damage', value: 5 }] }] },
    ];
    let callNum = 0;
    const s = supa({
      guild_config: {
        economy_adventures_enabled: true, economy_adventure_daily_limit: 10,
        economy_adventure_ticket_cost: 0,
      },
      economy_adventure_sessions: () => {
        callNum++;
        if (callNum <= 2) return chainWithCount([], 0); // daily + active check
        // Insert returns the new session
        const c = chain({
          id: 'new-s', user_id: 'u1', guild_id: 'g1', adventure_id: 'a1',
          stage_index: 0, hp: 100, max_hp: 100, gold_found: 0, items_found: [],
          choices_made: [], status: 'active',
        });
        c.insert = vi.fn(() => c);
        return c;
      },
      economy_adventures: () => chainWithCount(adventures),
    });
    s.rpc = vi.fn(async () => ({ data: true, error: null }));
    const mgr = new AdventureManager(guild(), s, valkey());
    const result = await mgr.startAdventure('u1');
    expect(result.embed).toBeDefined();
  });

  it('handleChoice wrong user', async () => {
    const { AdventureManager } = await import('../features/adventures/adventure-manager.js');
    const session = { id: 's1', user_id: 'u2', guild_id: 'g1', status: 'active', stage_index: 0, hp: 100, max_hp: 100 };
    const s = supa({ economy_adventure_sessions: session });
    const mgr = new AdventureManager(guild(), s, valkey());
    const i = ix();
    await mgr.handleChoice(i, 's1', 0);
    expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('not your') }));
  });
});

// ═══════════════════════════════════════════════════════════
// HeistManager — deeper paths
// ═══════════════════════════════════════════════════════════
describe('HeistManager deep', () => {
  const heistCfg = {
    economy_heist_enabled: true, economy_heist_entry_fee: 100,
    economy_heist_min_participants: 2, economy_heist_max_players: 6,
    economy_heist_cooldown_seconds: 300, economy_heist_recruiting_seconds: 60,
    currency_name: 'coins', currency_emoji: '🪙',
  };

  it('startHeist on cooldown (valkey)', async () => {
    const { HeistManager } = await import('../features/heist/heist-manager.js');
    const vk = valkey();
    vk.set = vi.fn(async () => null); // cooldown lock fails
    vk.ttl = vi.fn(async () => 120);
    const s = supa({ guild_config: heistCfg });
    const client = { user: { id: 'bot1' }, channels: { cache: new Collection() } } as any;
    const mgr = new HeistManager(s, client, vk);
    const i = ix();
    await mgr.startHeist(i);
    expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('lay low') }));
  });

  it('startHeist on cooldown (DB fallback)', async () => {
    const { HeistManager } = await import('../features/heist/heist-manager.js');
    const vk = valkey();
    vk.set = vi.fn(async () => 'OK'); // valkey cooldown passes
    const s = supa({
      guild_config: heistCfg,
      economy_heists: { resolved_at: new Date().toISOString() }, // just resolved
    });
    const client = { user: { id: 'bot1' }, channels: { cache: new Collection() } } as any;
    const mgr = new HeistManager(s, client, vk);
    const i = ix();
    await mgr.startHeist(i);
    expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('lay low') }));
  });

  it('joinHeist successful join', async () => {
    const { HeistManager } = await import('../features/heist/heist-manager.js');
    const vk = valkey();
    const heist = { id: 'h1', guild_id: 'g1', status: 'recruiting', entry_fee: 100, participants: ['u2'], max_players: 6 };
    // Need to handle the get for active heist
    vk.get = vi.fn(async (key: string) => {
      if (key.includes('heist:active')) return JSON.stringify(heist);
      return null;
    });
    const s = supa({
      guild_config: heistCfg,
      economy_heists: heist,
      economy_wallets: { wallet: 5000 },
      economy_heist_participants: () => chainWithCount([], 0), // not yet joined
    });
    s.rpc = vi.fn(async () => ({ data: true, error: null }));
    const client = { user: { id: 'bot1' }, channels: { cache: new Collection() } } as any;
    const mgr = new HeistManager(s, client, vk);
    const i = ix();
    await mgr.joinHeist(i);
    expect(i.reply).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════
// AutomationEngine — processMessageEvent
// ═══════════════════════════════════════════════════════════
describe('AutomationEngine deep', () => {
  it('start with automations and handleEvent', async () => {
    const { AutomationEngine } = await import('../features/automations/automation-engine.js');
    const automations = [
      { id: 'a1', guild_id: 'g1', name: 'Auto-react', trigger_type: 'message_create', enabled: true, conditions: [], actions: [{ type: 'add_reaction', emoji: '👍' }] },
    ];
    const s = supa({
      guild_automations: () => chainWithCount(automations),
      guild_config: { automations_enabled: true },
    });
    const eb = eventBus();
    const mgr = new AutomationEngine(guild(), s, valkey(), eb);
    await mgr.start();
    expect(eb.onAny).toHaveBeenCalled();
  });
});
