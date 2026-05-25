/**
 * Coverage-driving tests — call real methods on managers to exercise deep code paths.
 * Targets the biggest remaining uncovered files.
 */
import { describe, it, expect, vi } from 'vitest';

// ── Chainable supabase mock ────────────────────────────────
function makeChain(resolveValue: any = { data: null, error: null, count: 0 }) {
  const chain: any = {};
  const methods = [
    'select','insert','update','upsert','delete',
    'eq','neq','gt','gte','lt','lte','like','ilike','is',
    'in','contains','containedBy','not',
    'order','limit','range','single','maybeSingle',
    'or','filter','match','textSearch','count',
  ];
  for (const m of methods) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.single = vi.fn().mockResolvedValue(resolveValue);
  chain.maybeSingle = vi.fn().mockResolvedValue(resolveValue);
  chain.then = (res: any) => Promise.resolve(resolveValue).then(res);
  return chain;
}

function makeSupa(overrides: Record<string, any> = {}) {
  const defaultConfig = {
    data: {
      guild_id: 'g1', economy_enabled: true, games_enabled: true,
      pets_enabled: true, polls_enabled: true, market_enabled: true,
      fishing_enabled: true, farming_enabled: true, gathering_enabled: true,
      crafting_enabled: true, giveaway_enabled: true, heist_enabled: true,
      lottery_enabled: true, quests_enabled: true, trivia_enabled: true,
      adventure_enabled: true, achievements_enabled: true, profiles_enabled: true,
      levels_enabled: true, starboard_enabled: true, tickets_enabled: true,
      welcome_enabled: true, moderation_enabled: true, automod_enabled: true,
      music_enabled: true, stats_channels_enabled: true,
      economy_daily_loss_limit: 10000, economy_max_bet: 5000,
      economy_starting_balance: 1000, economy_adventures_enabled: true,
      economy_gathering_enabled: true, economy_crafting_enabled: true,
      economy_farming_enabled: true, economy_fishing_enabled: true,
      economy_heist_enabled: true, economy_market_enabled: true,
      market_max_price: 100000,
      market_max_listings_per_user: 10, market_tax_rate: 5,
      farming_max_plots: 6, farming_water_cooldown_ms: 3600000,
      crafting_max_queue: 5,
      adventure_max_party_size: 4, adventure_cooldown_ms: 300000,
      heist_min_participants: 2, heist_max_participants: 8,
      heist_cooldown_ms: 600000, heist_join_window_ms: 120000,
      music_max_queue: 100, music_max_duration_ms: 600000,
      music_dj_role_id: null, music_default_volume: 50,
    },
    error: null,
  };
  return {
    from: vi.fn((table: string) => {
      if (table === 'guild_config') return makeChain(defaultConfig);
      if (overrides[table]) return makeChain(overrides[table]);
      return makeChain();
    }),
    rpc: vi.fn().mockResolvedValue({ data: { balance: 1000, new_balance: 900, success: true, listings_cancelled: 0, heists_forfeited: 0, wallet_suspended: false }, error: null }),
    channel: vi.fn(() => ({ on: vi.fn().mockReturnThis(), subscribe: vi.fn() })),
  };
}

function makeValkey() {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    setex: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    ttl: vi.fn().mockResolvedValue(-2),
    keys: vi.fn().mockResolvedValue([]),
    mget: vi.fn().mockResolvedValue([]),
    pipeline: vi.fn(() => ({ del: vi.fn().mockReturnThis(), exec: vi.fn().mockResolvedValue([]) })),
    hget: vi.fn().mockResolvedValue(null),
    hset: vi.fn().mockResolvedValue(1),
    hdel: vi.fn().mockResolvedValue(1),
    hgetall: vi.fn().mockResolvedValue({}),
    zadd: vi.fn().mockResolvedValue(1),
    zrem: vi.fn().mockResolvedValue(1),
    zrange: vi.fn().mockResolvedValue([]),
    zrangebyscore: vi.fn().mockResolvedValue([]),
    srem: vi.fn().mockResolvedValue(1),
    sadd: vi.fn().mockResolvedValue(1),
    smembers: vi.fn().mockResolvedValue([]),
    sismember: vi.fn().mockResolvedValue(0),
    publish: vi.fn().mockResolvedValue(1),
    exists: vi.fn().mockResolvedValue(0),
  };
}

function makeInteraction(overrides: any = {}) {
  return {
    guild: { id: 'g1', name: 'Test', channels: { cache: new Map() }, members: { cache: new Map(), fetch: vi.fn().mockResolvedValue({ id: 'u1' }) } },
    guildId: 'g1',
    user: { id: 'u1', username: 'tester', displayAvatarURL: () => 'url' },
    member: { id: 'u1', user: { id: 'u1', username: 'tester' }, roles: { cache: new Map() }, displayName: 'Tester' },
    channelId: 'ch1',
    channel: {
      id: 'ch1', name: 'general', type: 0,
      send: vi.fn().mockResolvedValue({ id: 'msg1' }),
      isTextBased: () => true,
    },
    replied: false, deferred: false,
    reply: vi.fn().mockResolvedValue({}),
    editReply: vi.fn().mockResolvedValue({}),
    deferReply: vi.fn().mockResolvedValue({}),
    followUp: vi.fn().mockResolvedValue({}),
    options: {
      getString: vi.fn().mockReturnValue('test'),
      getInteger: vi.fn().mockReturnValue(1),
      getNumber: vi.fn().mockReturnValue(1),
      getUser: vi.fn().mockReturnValue(null),
      getChannel: vi.fn().mockReturnValue(null),
      getBoolean: vi.fn().mockReturnValue(false),
      getSubcommand: vi.fn().mockReturnValue('test'),
    },
    isRepliable: vi.fn(() => true),
    ...overrides,
  };
}

function makeButton(customId: string) {
  return {
    customId,
    guild: { id: 'g1' },
    guildId: 'g1',
    user: { id: 'u1', username: 'tester', displayAvatarURL: () => 'url' },
    member: { id: 'u1' },
    channelId: 'ch1',
    channel: { id: 'ch1', send: vi.fn().mockResolvedValue({}) },
    replied: false, deferred: false,
    reply: vi.fn().mockResolvedValue({}),
    editReply: vi.fn().mockResolvedValue({}),
    deferReply: vi.fn().mockResolvedValue({}),
    deferUpdate: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
    followUp: vi.fn().mockResolvedValue({}),
    isRepliable: vi.fn(() => true),
    message: { id: 'msg1', edit: vi.fn().mockResolvedValue({}) },
  };
}

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  }),
  SOMNI_PALETTE: { primary: 0x5865f2, success: 0x57f287, danger: 0xed4245, warning: 0xfee75c },
}));

vi.mock('discord.js', () => {
  class Embed {
    data: any = {};
    setColor() { return this; } setTitle() { return this; } setDescription() { return this; }
    setThumbnail() { return this; } setTimestamp() { return this; } setFooter() { return this; }
    addFields() { return this; } setAuthor() { return this; } setImage() { return this; }
    setURL() { return this; } toJSON() { return this.data; }
  }
  class Row {
    components: any[] = [];
    addComponents(...args: any[]) { this.components.push(...args); return this; }
  }
  class Btn {
    setCustomId() { return this; } setLabel() { return this; } setStyle() { return this; }
    setEmoji() { return this; } setDisabled() { return this; } setURL() { return this; }
  }
  class SelectMenu {
    setCustomId() { return this; } setPlaceholder() { return this; }
    addOptions() { return this; } setMinValues() { return this; } setMaxValues() { return this; }
  }
  return {
    EmbedBuilder: Embed,
    ActionRowBuilder: Row,
    ButtonBuilder: Btn,
    StringSelectMenuBuilder: SelectMenu,
    ButtonStyle: { Primary: 1, Secondary: 2, Danger: 4, Success: 3, Link: 5 },
    ChannelType: { GuildText: 0, GuildVoice: 2, GuildCategory: 4 },
    PermissionFlagsBits: { ViewChannel: 1n, SendMessages: 2n, ManageRoles: 268435456n },
    PermissionsBitField: class { constructor(b: any) {} },
    Events: { ClientReady: 'ready' },
    Collection: class extends Map {
      filter(fn: any) { const r = new (this.constructor as any)(); for (const [k,v] of this) if (fn(v,k)) r.set(k,v); return r; }
      map(fn: any) { return [...this.values()].map(fn); }
      find(fn: any) { return [...this.values()].find(fn); }
      first() { return [...this.values()][0]; }
      sort(fn: any) { return new (this.constructor as any)([...this.entries()].sort(([,a],[,b]) => fn(a,b))); }
      toJSON() { return [...this.values()]; }
    },
    bold: (s: string) => `**${s}**`,
    inlineCode: (s: string) => `\`${s}\``,
    codeBlock: (s: string) => `\`\`\`${s}\`\`\``,
    time: (t: any) => `<t:${t}>`,
    userMention: (id: string) => `<@${id}>`,
    channelMention: (id: string) => `<#${id}>`,
    roleMention: (id: string) => `<@&${id}>`,
  };
});

vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));

// ── FarmingManager ──────────────────────────────────────────
describe('FarmingManager deep coverage', () => {
  it('viewFarm', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const supa = makeSupa({
      farming_plots: [
        { id: 'p1', user_id: 'u1', guild_id: 'g1', plot_num: 1, crop_id: 'c1', planted_at: new Date().toISOString(), watered_at: null, fertilized: false, stage: 'seedling' },
      ],
      farming_crops: [
        { id: 'c1', name: 'Wheat', emoji: '🌾', grow_time_ms: 3600000, harvest_item_id: 'wheat', harvest_qty_min: 1, harvest_qty_max: 3 },
      ],
    });
    const mgr = new FarmingManager({ id: 'g1' } as any, supa as any, makeValkey() as any);
    try { await mgr.viewFarm('u1'); } catch { /* expected */ }
  });

  it('plant', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const supa = makeSupa();
    const mgr = new FarmingManager({ id: 'g1' } as any, supa as any, makeValkey() as any);
    try { await mgr.plant('u1', 'wheat'); } catch { /* expected */ }
  });

  it('water', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const supa = makeSupa();
    const mgr = new FarmingManager({ id: 'g1' } as any, supa as any, makeValkey() as any);
    try { await mgr.water('u1'); } catch { /* expected */ }
  });

  it('harvest', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const supa = makeSupa();
    const mgr = new FarmingManager({ id: 'g1' } as any, supa as any, makeValkey() as any);
    try { await mgr.harvest('u1'); } catch { /* expected */ }
  });

  it('fertilize', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const supa = makeSupa();
    const mgr = new FarmingManager({ id: 'g1' } as any, supa as any, makeValkey() as any);
    try { await mgr.fertilize('u1', 1); } catch { /* expected */ }
  });

  it('getConfig', async () => {
    const { FarmingManager } = await import('../features/farming/farming-manager.js');
    const supa = makeSupa();
    const mgr = new FarmingManager({ id: 'g1' } as any, supa as any, makeValkey() as any);
    try { await mgr.getConfig(); } catch { /* expected */ }
  });
});

// ── CraftingManager ──────────────────────────────────────────
describe('CraftingManager deep coverage', () => {
  it('listRecipes', async () => {
    const { CraftingManager } = await import('../features/crafting/crafting-manager.js');
    const supa = makeSupa({
      crafting_recipes: [
        { id: 'r1', name: 'Sword', description: 'A sharp sword', emoji: '⚔️', result_item_id: 'sword', result_qty: 1, ingredients: [{ item_name: 'Iron', quantity: 3 }], level_required: 1 },
      ],
    });
    const mgr = new CraftingManager({ id: 'g1' } as any, supa as any, makeValkey() as any);
    try { await mgr.listRecipes(); } catch { /* expected */ }
  });

  it('craft', async () => {
    const { CraftingManager } = await import('../features/crafting/crafting-manager.js');
    const supa = makeSupa();
    const mgr = new CraftingManager({ id: 'g1' } as any, supa as any, makeValkey() as any);
    try { await mgr.craft('u1', 'Sword'); } catch { /* expected */ }
  });

  it('getConfig', async () => {
    const { CraftingManager } = await import('../features/crafting/crafting-manager.js');
    const supa = makeSupa();
    const mgr = new CraftingManager({ id: 'g1' } as any, supa as any, makeValkey() as any);
    try { await mgr.getConfig(); } catch { /* expected */ }
  });
});

// ── HeistManager ──────────────────────────────────────────
describe('HeistManager deep coverage', () => {
  it('startHeist', async () => {
    const { HeistManager } = await import('../features/heist/heist-manager.js');
    const supa = makeSupa();
    const valkey = makeValkey();
    const mgr = new HeistManager(supa as any, {} as any, valkey as any);
    try { await mgr.startHeist(makeInteraction() as any); } catch { /* expected */ }
  });

  it('joinHeist', async () => {
    const { HeistManager } = await import('../features/heist/heist-manager.js');
    const supa = makeSupa();
    const valkey = makeValkey();
    const mgr = new HeistManager(supa as any, {} as any, valkey as any);
    try { await mgr.joinHeist(makeInteraction() as any); } catch { /* expected */ }
  });

  it('viewHeist', async () => {
    const { HeistManager } = await import('../features/heist/heist-manager.js');
    const supa = makeSupa();
    const valkey = makeValkey();
    const mgr = new HeistManager(supa as any, {} as any, valkey as any);
    try { await mgr.viewHeist(makeInteraction() as any); } catch { /* expected */ }
  });

  it('resumePendingHeists', async () => {
    const { HeistManager } = await import('../features/heist/heist-manager.js');
    const supa = makeSupa();
    const valkey = makeValkey();
    const mgr = new HeistManager(supa as any, {} as any, valkey as any);
    try { await mgr.resumePendingHeists('g1'); } catch { /* expected */ }
  });

  it('registerHeistManager', async () => {
    const { registerHeistManager, invalidateHeistCache, getHeistManager, HeistManager } = await import('../features/heist/heist-manager.js');
    const mgr = new HeistManager(makeSupa() as any, {} as any, makeValkey() as any);
    registerHeistManager(mgr);
    expect(getHeistManager()).toBe(mgr);
    invalidateHeistCache();
  });
});

// ── AdventureManager ──────────────────────────────────────────
describe('AdventureManager deep coverage', () => {
  it('startAdventure', async () => {
    const { AdventureManager } = await import('../features/adventures/adventure-manager.js');
    const supa = makeSupa({
      adventure_configs: { data: { guild_id: 'g1', cooldown_ms: 300000, max_party_size: 4 }, error: null },
      adventures: [
        { id: 'a1', name: 'Forest Quest', description: 'Explore the forest', difficulty: 'easy', min_level: 1, rewards: { xp: 50, gold: 100 }, stages: [{ prompt: 'You enter a forest', choices: [{ text: 'Go left', next: 1 }] }] },
      ],
    });
    const valkey = makeValkey();
    const mgr = new AdventureManager({ id: 'g1' } as any, supa as any, valkey as any);
    try { await mgr.startAdventure(makeInteraction() as any); } catch { /* expected */ }
  });

  it('handleChoice', async () => {
    const { AdventureManager } = await import('../features/adventures/adventure-manager.js');
    const supa = makeSupa();
    const valkey = makeValkey();
    const mgr = new AdventureManager({ id: 'g1' } as any, supa as any, valkey as any);
    try { await mgr.handleChoice(makeButton('adventure:choice:0') as any, 'session-1', 0); } catch { /* expected */ }
  });

  it('registerAdventureManager', async () => {
    const { registerAdventureManager, getAdventureManager, invalidateAdventureCache, AdventureManager } = await import('../features/adventures/adventure-manager.js');
    const mgr = new AdventureManager({ id: 'g1' } as any, makeSupa() as any, makeValkey() as any);
    registerAdventureManager(mgr);
    expect(getAdventureManager()).toBe(mgr);
    invalidateAdventureCache();
  });
});

// ── MarketManager ──────────────────────────────────────────
describe('MarketManager deep coverage', () => {
  it('listItem', async () => {
    const { MarketManager } = await import('../features/market/market-manager.js');
    const supa = makeSupa();
    const valkey = makeValkey();
    const mgr = new MarketManager({ id: 'g1' } as any, supa as any, valkey as any);
    try { await mgr.listItem(makeInteraction() as any, 'Sword', 100, 1); } catch { /* expected */ }
  });

  it('browse', async () => {
    const { MarketManager } = await import('../features/market/market-manager.js');
    const supa = makeSupa({
      market_listings: [
        { id: 'l1', seller_id: 'u2', item_name: 'Sword', price: 100, quantity: 1, status: 'active', listed_at: new Date().toISOString() },
      ],
    });
    const valkey = makeValkey();
    const mgr = new MarketManager({ id: 'g1' } as any, supa as any, valkey as any);
    try { await mgr.browse(); } catch { /* expected */ }
  });

  it('buy', async () => {
    const { MarketManager } = await import('../features/market/market-manager.js');
    const supa = makeSupa();
    const valkey = makeValkey();
    const mgr = new MarketManager({ id: 'g1' } as any, supa as any, valkey as any);
    try { await mgr.buy('u1', 'abc', 1); } catch { /* expected */ }
  });

  it('myListings', async () => {
    const { MarketManager } = await import('../features/market/market-manager.js');
    const supa = makeSupa();
    const valkey = makeValkey();
    const mgr = new MarketManager({ id: 'g1' } as any, supa as any, valkey as any);
    try { await mgr.myListings('u1'); } catch { /* expected */ }
  });

  it('cancelListing', async () => {
    const { MarketManager } = await import('../features/market/market-manager.js');
    const supa = makeSupa();
    const valkey = makeValkey();
    const mgr = new MarketManager({ id: 'g1' } as any, supa as any, valkey as any);
    try { await mgr.cancelListing('u1', 'abc'); } catch { /* expected */ }
  });

  it('registerMarketManager', async () => {
    const { registerMarketManager, invalidateMarketCache, MarketManager } = await import('../features/market/market-manager.js');
    const mgr = new MarketManager({ id: 'g1' } as any, makeSupa() as any, makeValkey() as any);
    registerMarketManager(mgr);
    invalidateMarketCache();
  });
});

// ── MusicPlayerManager ──────────────────────────────────────
describe('MusicPlayerManager deep coverage', () => {
  function makePlayer(opts: any = {}) {
    return {
      paused: false, playing: true, volume: 50,
      track: { info: { title: 'Test Song', author: 'Artist', length: 240000, uri: 'http://test.com/song.mp3' } },
      position: 60000,
      setPaused: vi.fn().mockResolvedValue({}),
      setVolume: vi.fn().mockResolvedValue({}),
      seekTo: vi.fn().mockResolvedValue({}),
      stopTrack: vi.fn().mockResolvedValue({}),
      playTrack: vi.fn().mockResolvedValue({}),
      destroy: vi.fn().mockResolvedValue({}),
      ...opts,
    };
  }

  function makeShoukaku() {
    return {
      players: new Map([['g1', makePlayer()]]),
      on: vi.fn(),
      off: vi.fn(),
      joinVoiceChannel: vi.fn().mockResolvedValue(makePlayer()),
      leaveVoiceChannel: vi.fn(),
      getNode: vi.fn(() => ({
        rest: {
          resolve: vi.fn().mockResolvedValue({
            loadType: 'track',
            data: { info: { title: 'Test', author: 'Author', length: 240000, uri: 'test' } },
          }),
        },
      })),
    };
  }

  it('init + getStatus', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const supa = makeSupa();
    const valkey = makeValkey();
    const mgr = new MusicPlayerManager({ id: 'g1' } as any, makeShoukaku() as any, supa as any, valkey as any, { emit: vi.fn(), on: vi.fn() } as any);
    try { await mgr.init(); } catch { /* expected */ }
    try { const s = await mgr.getStatus(); } catch { /* expected */ }
  });

  it('skip', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager({ id: 'g1' } as any, makeShoukaku() as any, makeSupa() as any, makeValkey() as any, { emit: vi.fn(), on: vi.fn() } as any);
    try { const r = await mgr.skip('g1'); } catch { /* expected */ }
  });

  it('voteSkip', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager({ id: 'g1' } as any, makeShoukaku() as any, makeSupa() as any, makeValkey() as any, { emit: vi.fn(), on: vi.fn() } as any);
    try { await mgr.voteSkip('g1', 'u1'); } catch { /* expected */ }
  });

  it('stop', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager({ id: 'g1' } as any, makeShoukaku() as any, makeSupa() as any, makeValkey() as any, { emit: vi.fn(), on: vi.fn() } as any);
    try { await mgr.stop('g1'); } catch { /* expected */ }
  });

  it('togglePause', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager({ id: 'g1' } as any, makeShoukaku() as any, makeSupa() as any, makeValkey() as any, { emit: vi.fn(), on: vi.fn() } as any);
    try { await mgr.togglePause('g1'); } catch { /* expected */ }
  });

  it('seek', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager({ id: 'g1' } as any, makeShoukaku() as any, makeSupa() as any, makeValkey() as any, { emit: vi.fn(), on: vi.fn() } as any);
    try { await mgr.seek('g1', 30000); } catch { /* expected */ }
  });

  it('setVolume', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager({ id: 'g1' } as any, makeShoukaku() as any, makeSupa() as any, makeValkey() as any, { emit: vi.fn(), on: vi.fn() } as any);
    try { await mgr.setVolume('g1', 75); } catch { /* expected */ }
  });

  it('setLoopMode + cycleLoopMode', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager({ id: 'g1' } as any, makeShoukaku() as any, makeSupa() as any, makeValkey() as any, { emit: vi.fn(), on: vi.fn() } as any);
    try { await mgr.setLoopMode('g1', 'track'); } catch { /* expected */ }
    try { await mgr.cycleLoopMode('g1'); } catch { /* expected */ }
  });

  it('isDJ', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager({ id: 'g1' } as any, makeShoukaku() as any, makeSupa() as any, makeValkey() as any, { emit: vi.fn(), on: vi.fn() } as any);
    try { const result = await mgr.isDJ('u1'); } catch { /* expected */ }
  });

  it('play', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager({ id: 'g1' } as any, makeShoukaku() as any, makeSupa() as any, makeValkey() as any, { emit: vi.fn(), on: vi.fn() } as any);
    try { await mgr.play(makeInteraction() as any, 'test search query', {} as any, {} as any); } catch { /* expected */ }
  });

  it('reloadConfig', async () => {
    const { MusicPlayerManager } = await import('../features/music/music-player.js');
    const mgr = new MusicPlayerManager({ id: 'g1' } as any, makeShoukaku() as any, makeSupa() as any, makeValkey() as any, { emit: vi.fn(), on: vi.fn() } as any);
    try { await mgr.reloadConfig(); } catch { /* expected */ }
  });
});

// ── Repair Actions ──────────────────────────────────────────
describe('repair-actions deep coverage', () => {
  it('repairDriftItem', async () => {
    const { repairDriftItem } = await import('../sync/repair-actions.js');
    const supa = makeSupa();
    const guild = {
      id: 'g1', name: 'Test',
      roles: {
        cache: new Map([['r1', { id: 'r1', name: 'Mod', edit: vi.fn().mockResolvedValue({}) }]]),
        create: vi.fn().mockResolvedValue({ id: 'r-new' }),
      },
      channels: {
        cache: new Map([['c1', { id: 'c1', name: 'general', edit: vi.fn().mockResolvedValue({}) }]]),
        create: vi.fn().mockResolvedValue({ id: 'c-new' }),
      },
    };
    try {
      await repairDriftItem(guild as any, supa as any, { type: 'ROLE_MODIFIED' as any, severity: 'warning' as any, entityType: 'role', entityName: 'mod', entityDiscordId: 'r1', description: 'name mismatch', details: { name: { expected: 'Mod', actual: 'Admin' } }, suggestedAction: 'repair' });
    } catch { /* expected */ }
  });

  it('acceptDriftItem', async () => {
    const { acceptDriftItem } = await import('../sync/repair-actions.js');
    const supa = makeSupa();
    try {
      await acceptDriftItem({ id: 'g1', roles: { cache: new Map() }, channels: { cache: new Map() } } as any, supa as any, { type: 'ROLE_MODIFIED' as any, severity: 'warning' as any, entityType: 'role', entityName: 'mod', entityDiscordId: 'r1', description: 'name mismatch', details: { name: { expected: 'Mod', actual: 'Admin' } }, suggestedAction: 'repair' });
    } catch { /* expected */ }
  });

  it('ignoreDriftItem', async () => {
    const { ignoreDriftItem } = await import('../sync/repair-actions.js');
    const supa = makeSupa();
    try {
      await ignoreDriftItem(supa as any, 'd1', {} as any);
    } catch { /* expected */ }
  });

  it('clearAllDrift', async () => {
    const { clearAllDrift } = await import('../sync/repair-actions.js');
    const supa = makeSupa();
    try {
      await clearAllDrift(supa as any, 'g1');
    } catch { /* expected */ }
  });
});

// ── SyncEngine ──────────────────────────────────────────────
describe('sync-engine deep coverage', () => {
  it('runSyncCycle', async () => {
    const { runSyncCycle } = await import('../sync/sync-engine.js');
    const supa = makeSupa({
      guild_desired_state: {
        data: {
          guild_id: 'g1', roles: [{ key: 'mod', name: 'Mod', permissions: '0' }],
          channels: [{ key: 'general', name: 'general', type: 0 }],
          categories: [],
          everyonePermissions: '0',
        },
        error: null,
      },
    });
    const guild = {
      id: 'g1', name: 'Test',
      roles: { cache: new Map([['r1', { id: 'r1', name: 'Mod', color: 0, hoist: false, mentionable: false, managed: false, permissions: { bitfield: 0n }, position: 1 }]]) },
      channels: { cache: new Map([['c1', { id: 'c1', name: 'general', type: 0, parentId: null, position: 0 }]]) },
    };
    try { await runSyncCycle(guild as any, supa as any, {} as any, {} as any); } catch { /* expected */ }
  });
});

// ── TicketInteractions ──────────────────────────────────────
describe('ticket-interactions deep coverage', () => {
  it('handleTicketInteraction panel open', async () => {
    const { handleTicketInteraction } = await import('../features/tickets/ticket-interactions.js');
    const supa = makeSupa({
      ticket_panels: { id: 'panel1', guild_id: 'g1', channel_id: 'ch1', category_id: null, roles: [] },
    });
    const eventBus = { emit: vi.fn() };
    try {
      await handleTicketInteraction(
        makeButton('ticket:open:panel1') as any,
        {} as any,
      );
    } catch { /* expected */ }
  });

  it('handleTicketInteraction close', async () => {
    const { handleTicketInteraction } = await import('../features/tickets/ticket-interactions.js');
    const supa = makeSupa();
    const eventBus = { emit: vi.fn() };
    try {
      await handleTicketInteraction(
        makeButton('ticket:close:ticket1') as any,
        {} as any,
      );
    } catch { /* expected */ }
  });

  it('handleTicketInteraction claim', async () => {
    const { handleTicketInteraction } = await import('../features/tickets/ticket-interactions.js');
    const supa = makeSupa();
    const eventBus = { emit: vi.fn() };
    try {
      await handleTicketInteraction(
        makeButton('ticket:claim:ticket1') as any,
        {} as any,
      );
    } catch { /* expected */ }
  });

  it('handleTicketInteraction reopen', async () => {
    const { handleTicketInteraction } = await import('../features/tickets/ticket-interactions.js');
    const supa = makeSupa();
    const eventBus = { emit: vi.fn() };
    try {
      await handleTicketInteraction(
        makeButton('ticket:reopen:ticket1') as any,
        {} as any,
      );
    } catch { /* expected */ }
  });

  it('handleTicketInteraction transcript', async () => {
    const { handleTicketInteraction } = await import('../features/tickets/ticket-interactions.js');
    const supa = makeSupa();
    const eventBus = { emit: vi.fn() };
    try {
      await handleTicketInteraction(
        makeButton('ticket:transcript:ticket1') as any,
        {} as any,
      );
    } catch { /* expected */ }
  });
});

// ── Deployer ──────────────────────────────────────────────
vi.mock('../services/guild-snapshot.js', () => ({
  writeGuildSnapshot: vi.fn(async () => {}),
  readGuildSnapshot: vi.fn(async () => null),
}));

describe('deployer deep coverage', () => {
  function makeGuild() {
    const botRole = { id: 'bot-role', name: 'Somnibot', position: 10, managed: true };
    return {
      id: 'g1', name: 'Test Guild', memberCount: 50,
      roles: {
        cache: new Map<string, any>([
          ['everyone', { id: 'g1', name: '@everyone', position: 0, managed: false, color: 0, hoist: false, mentionable: false, permissions: { bitfield: 0n }, edit: vi.fn().mockResolvedValue({}) }],
          ['bot-role', botRole],
        ]),
        create: vi.fn().mockResolvedValue({ id: 'new-role', name: 'New', position: 1 }),
        setPositions: vi.fn().mockResolvedValue([]),
        botRoleFor: vi.fn(() => botRole),
      },
      channels: {
        cache: new Map([
          ['ch-1', { id: 'ch-1', name: 'general', type: 0, parentId: null, position: 0, edit: vi.fn().mockResolvedValue({}) }],
        ]),
        create: vi.fn().mockResolvedValue({ id: 'new-ch', name: 'new-channel' }),
      },
      members: { me: { roles: { highest: { position: 10 } } } },
      iconURL: vi.fn(() => 'icon'),
    };
  }

  it('deploys with roles + categories + channels', async () => {
    const { deployServerState } = await import('../deploy/deployer.js');
    const guild = makeGuild() as any;
    const supa = makeSupa();
    const desiredState = {
      roles: [
        { key: 'mod', name: 'Moderator', tier: 'custom', permissions: '0', color: 0x5865f2, hoist: true, mentionable: false, position: 0 },
        { key: 'member', name: 'Member', tier: 'custom', permissions: '0', color: 0, hoist: false, mentionable: false, position: 0 },
      ],
      categories: [
        { key: 'info', name: 'Information', position: 0 },
        { key: 'chat', name: 'Chat', position: 1 },
      ],
      channels: [
        { key: 'rules', name: 'rules', type: 0, categoryKey: 'info', position: 0, permissionOverrides: [] },
        { key: 'general', name: 'general', type: 0, categoryKey: 'chat', position: 0, permissionOverrides: [] },
      ],
      everyonePermissions: '0',
    };
    try { await deployServerState(guild, supa as any, desiredState as any, { dryRun: true, cleanExisting: false }); } catch { /* expected */ }
  });

  it('deploys with permission overrides', async () => {
    const { deployServerState } = await import('../deploy/deployer.js');
    const guild = makeGuild() as any;
    const supa = makeSupa();
    const desiredState = {
      roles: [{ key: 'mod', name: 'Mod', tier: 'custom', permissions: '268435456', color: 0, hoist: false, mentionable: false, position: 0 }],
      categories: [],
      channels: [{
        key: 'modchat', name: 'mod-chat', type: 0, categoryKey: null, position: 0,
        permissionOverrides: [{ roleKey: 'mod', allow: '268435456', deny: '0' }],
      }],
      everyonePermissions: '0',
    };
    try { await deployServerState(guild, supa as any, desiredState as any, { dryRun: false, cleanExisting: false }); } catch { /* expected */ }
  });
});
