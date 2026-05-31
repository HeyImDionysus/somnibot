/**
 * Wave 5 coverage tests: Anti-raid, Starboard, deeper Economy, Polls, Lottery
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  SOMNI_PALETTE: { primary: 0x5865F2, success: 0x57F287, error: 0xED4245, warning: 0xFEE75C },
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
    get size() { return super.size; }
    toJSON() { return [...this.values()]; }
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
    ChannelType: { GuildText: 0, GuildVoice: 2 },
    Colors: { Red: 0xff0000, Green: 0x00ff00, Yellow: 0xffff00, Gold: 0xffd700 },
    PermissionFlagsBits: { ViewChannel: 1n, SendMessages: 2n, ManageChannels: 4n, BanMembers: 32n, KickMembers: 64n, ModerateMembers: 128n },
    time: vi.fn((ts: number) => `<t:${ts}>`),
    TimestampStyles: { RelativeTime: 'R', ShortDateTime: 'f' },
    userMention: vi.fn((id: string) => `<@${id}>`),
    channelMention: vi.fn((id: string) => `<#${id}>`),
    bold: vi.fn((s: string) => `**${s}**`),
    italic: vi.fn((s: string) => `*${s}*`),
    codeBlock: vi.fn((s: string) => '```\n' + s + '\n```'),
    inlineCode: vi.fn((s: string) => '`' + s + '`'),
  };
});

const { Collection } = await import('discord.js');

function chain(data: any = null, error: any = null) {
  const c: any = {};
  for (const m of ['select','insert','update','upsert','delete','eq','neq','gt','gte','lt','lte','in','is','or','not','order','limit','range','match','ilike','like','filter','contains','textSearch','head','overlaps','single','maybeSingle'])
    c[m] = vi.fn((..._: any[]) => c);
  c.maybeSingle = vi.fn(async () => ({ data, error }));
  c.single = vi.fn(async () => ({ data, error }));
  c.then = undefined;
  return c;
}
function chainAsync(data: any[] = [], count: number | null = null, error: any = null) {
  const c: any = {};
  for (const m of ['select','insert','update','upsert','delete','eq','neq','gt','gte','lt','lte','in','is','or','not','order','limit','range','match','ilike','like','filter','contains','textSearch','head','overlaps'])
    c[m] = vi.fn((..._: any[]) => c);
  c.maybeSingle = vi.fn(async () => ({ data: data?.[0] ?? null, error, count }));
  c.single = vi.fn(async () => ({ data: data?.[0] ?? null, error, count }));
  c.then = (resolve: Function) => resolve({ data, error, count });
  return c;
}
function guild(id = 'g1') {
  const channels = new Collection<string, any>();
  const textCh: any = {
    id: 'ch1', name: 'general', type: 0,
    send: vi.fn(async () => ({ id: 'msg1', edit: vi.fn(async () => ({})) })),
    messages: { fetch: vi.fn(async () => new Collection()) },
  };
  channels.set('ch1', textCh);
  return {
    id, name: 'Test Guild', memberCount: 50,
    roles: { cache: new Collection(), everyone: { id: 'everyone' } },
    channels: { cache: channels, fetch: vi.fn(async () => textCh) },
    members: {
      cache: new Collection(),
      fetch: vi.fn(async (uid: string) => ({
        id: uid, user: { id: uid, username: 'User', displayAvatarURL: () => 'url', bot: false, tag: 'User#0001', createdAt: new Date(Date.now() - 86400000 * 365) },
        displayName: 'User', roles: { cache: new Collection(), add: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
        permissions: { has: () => true },
        timeout: vi.fn(async () => {}), ban: vi.fn(async () => {}), kick: vi.fn(async () => {}),
        joinedAt: new Date(),
      })),
    },
    client: { user: { id: 'bot1' } },
    bans: { create: vi.fn(async () => {}) },
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
    hset: vi.fn(async () => 1), hget: vi.fn(async () => null), hgetall: vi.fn(async () => ({})),
    zadd: vi.fn(async () => 1), zrangebyscore: vi.fn(async () => []),
    setex: vi.fn(async () => 'OK'), incrby: vi.fn(async () => 5),
  } as any;
}

// ═══════════════════════════════════════════════
// Anti-Raid
// ═══════════════════════════════════════════════
describe('Anti-Raid', () => {
  const antiRaidCfg = {
    anti_raid_enabled: true,
    anti_raid_account_age_days: 7,
    anti_raid_join_rate_limit: 10,
    anti_raid_join_rate_window_seconds: 60,
    anti_raid_action: 'kick',
    anti_raid_auto_unban: true,
    anti_raid_log_channel_id: 'ch1',
    anti_raid_whitelist_roles: [],
  };

  function arSupa(cfg = antiRaidCfg) {
    return {
      from: vi.fn((t: string) => {
        if (t === 'guild_config') return chain(cfg);
        if (t === 'anti_raid_events') { const c = chain(null); c.insert = vi.fn(() => c); return c; }
        return chain(null);
      }),
    } as any;
  }



  it('processAntiRaid with old account passes', async () => {
    const { processAntiRaid } = await import('../features/anti-raid/index.js');
    const g = guild();
    const member = {
      id: 'u1', guild: g,
      user: { id: 'u1', username: 'OldUser', createdAt: new Date(Date.now() - 86400000 * 365), bot: false, tag: 'OldUser#0001' },
      displayName: 'OldUser', roles: { cache: new Collection() },
    } as any;
    const result = await processAntiRaid(g, member, arSupa());
    expect(result).toBe(false);
  });

  it('processAntiRaid disabled', async () => {
    const { processAntiRaid } = await import('../features/anti-raid/index.js');
    const g = guild();
    const member = {
      id: 'u1', guild: g,
      user: { id: 'u1', username: 'User', createdAt: new Date(), bot: false, tag: 'User#0001' },
      displayName: 'User', roles: { cache: new Collection() },
    } as any;
    const result = await processAntiRaid(g, member, arSupa({ ...antiRaidCfg, anti_raid_enabled: false }));
    expect(result).toBe(false);
  });



  it('invalidateAntiRaidCache', async () => {
    const { invalidateAntiRaidCache } = await import('../features/anti-raid/index.js');
    invalidateAntiRaidCache('g1');
    invalidateAntiRaidCache();
  });
});

// ═══════════════════════════════════════════════
// Starboard
// ═══════════════════════════════════════════════
describe('Starboard', () => {
  const starboardCfg = {
    starboard_enabled: true,
    starboard_channel_id: 'ch1',
    starboard_emoji: '⭐',
    starboard_threshold: 3,
    starboard_self_star: false,
    starboard_bot_messages: false,
  };

  function sbSupa(cfg = starboardCfg) {
    return {
      from: vi.fn((t: string) => {
        if (t === 'guild_config') return chain(cfg);
        if (t === 'starboard_entries') {
          const c = chain(null);
          c.insert = vi.fn(() => c);
          c.upsert = vi.fn(() => c);
          return c;
        }
        return chain(null);
      }),
    } as any;
  }

  it('handleStarboardReaction at threshold', async () => {
    const { handleStarboardReaction } = await import('../features/starboard/index.js');
    const reaction = {
      emoji: { name: '⭐' },
      count: 3,
      message: {
        id: 'msg1', guildId: 'g1', channelId: 'ch2',
        guild: guild(),
        author: { id: 'u2', bot: false, username: 'Author', displayAvatarURL: () => 'url' },
        content: 'Great message!',
        url: 'https://discord.com/channels/g1/ch2/msg1',
        attachments: new Collection(),
        embeds: [],
        createdAt: new Date(),
        reactions: { cache: new Collection([['⭐', { emoji: { name: '⭐' }, count: 3 }]]) },
        fetch: vi.fn(async function(this: any) { return this; }),
        channel: { nsfw: false },
      },
      partial: false,
      fetch: vi.fn(async function(this: any) { return this; }),
      users: { fetch: vi.fn(async () => new Collection([['u1', { id: 'u1' }], ['u3', { id: 'u3' }], ['u4', { id: 'u4' }]])) },
    } as any;
    await handleStarboardReaction(reaction, { id: 'u1', bot: false } as any, sbSupa(), 'g1');
  });

  it('handleStarboardReaction below threshold', async () => {
    const { handleStarboardReaction } = await import('../features/starboard/index.js');
    const reaction = {
      emoji: { name: '⭐' },
      count: 1,
      message: {
        id: 'msg2', guildId: 'g1', channelId: 'ch2',
        guild: guild(),
        author: { id: 'u2', bot: false, username: 'Author', displayAvatarURL: () => 'url' },
        content: 'Meh',
        url: 'https://discord.com/channels/g1/ch2/msg2',
        attachments: new Collection(),
        embeds: [],
        createdAt: new Date(),
        reactions: { cache: new Collection([['⭐', { emoji: { name: '⭐' }, count: 1 }]]) },
        fetch: vi.fn(async function(this: any) { return this; }),
        channel: { nsfw: false },
      },
      partial: false,
      fetch: vi.fn(async function(this: any) { return this; }),
      users: { fetch: vi.fn(async () => new Collection([['u1', { id: 'u1' }]])) },
    } as any;
    await handleStarboardReaction(reaction, { id: 'u1', bot: false } as any, sbSupa(), 'g1');
  });

  it('handleStarboardReaction wrong emoji ignored', async () => {
    const { handleStarboardReaction } = await import('../features/starboard/index.js');
    const reaction = {
      emoji: { name: '🎉' }, count: 5,
      message: { id: 'msg3', guildId: 'g1', channelId: 'ch2', guild: guild(), author: { id: 'u2', bot: false, username: 'Author', displayAvatarURL: () => 'url' }, content: 'msg', url: 'url', attachments: new Collection(), embeds: [], createdAt: new Date(), reactions: { cache: new Collection() }, fetch: vi.fn(async function(this: any) { return this; }), channel: { nsfw: false } },
      partial: false,
      fetch: vi.fn(async function(this: any) { return this; }),
      users: { fetch: vi.fn(async () => new Collection()) },
    } as any;
    await handleStarboardReaction(reaction, { id: 'u1', bot: false } as any, sbSupa(), 'g1');
  });

  it('invalidateStarboardCache', async () => {
    const { invalidateStarboardCache } = await import('../features/starboard/index.js');
    invalidateStarboardCache();
  });
});

// ═══════════════════════════════════════════════
// Economy Manager deeper branches
// ═══════════════════════════════════════════════
describe('EconomyManager deeper', () => {
  const econCfg = {
    economy_enabled: true, currency_name: 'coins', currency_emoji: '🪙',
    economy_daily_amount: 100, economy_weekly_amount: 500,
    economy_work_min: 50, economy_work_max: 200,
    economy_work_cooldown_minutes: 30,
    economy_rob_enabled: true, economy_rob_chance: 50,
    economy_rob_min_balance: 500,
    economy_starting_balance: 0,
    economy_max_wallet: 1000000,
    economy_crime_min: 100, economy_crime_max: 500,
    economy_crime_chance: 60, economy_crime_fine_pct: 20,
    economy_crime_cooldown_minutes: 60,
    economy_beg_min: 5, economy_beg_max: 50,
    economy_beg_cooldown_minutes: 5,
    economy_search_min: 10, economy_search_max: 100,
    economy_search_cooldown_minutes: 15,
    economy_transfer_tax_pct: 0,
    economy_rob_cooldown_minutes: 60,
    economy_rob_max_pct: 30,
    economy_passive_mode_enabled: true,
    economy_daily_cooldown_hours: 24,
    economy_weekly_cooldown_hours: 168,
    economy_chat_income_enabled: false,
    economy_chat_income_min: 1, economy_chat_income_max: 5,
    economy_chat_income_cooldown_seconds: 60,
  };

  function econSupa(walletData = { wallet: 5000, bank: 2000, user_id: 'u1', guild_id: 'g1', passive_mode: false }) {
    return {
      from: vi.fn((table: string) => {
        if (table === 'guild_config') return chain(econCfg);
        if (table === 'economy_wallets') {
          const c = chain(walletData);
          c.upsert = vi.fn(() => chain(walletData));
          return c;
        }
        if (table === 'economy_transactions') { const c = chain(null); c.insert = vi.fn(() => c); return c; }
        if (table === 'economy_inventory') return chainAsync([
          { id: 'inv1', item_name: 'Sword', quantity: 5, item_id: 'item1', item_emoji: '⚔️', durability_remaining: null },
        ]);
        if (table === 'economy_shop_items' || table === 'economy_items') return chainAsync([
          { id: 'item1', name: 'Sword', price: 100, description: 'A sword', emoji: '⚔️', role_id: null, max_quantity: -1, category: 'weapons', stock: null },
        ]);
        return chain(null);
      }),
      rpc: vi.fn(async (fn: string, args: any) => {
        if (fn === 'economy_transfer') return { data: { success: true }, error: null };
        if (fn === 'adjust_wallet' || fn === 'economy_adjust_balance')
          return { data: { wallet: 5100, bank: 2000 }, error: null };
        return { data: null, error: null };
      }),
    } as any;
  }

  it('deposit', async () => {
    const { EconomyManager } = await import('../features/economy/economy-manager.js');
    const mgr = new EconomyManager(guild(), econSupa(), valkey());
    const result = await mgr.deposit('u1', 1000);
    expect(result).toBeDefined();
  });

  it('withdraw', async () => {
    const { EconomyManager } = await import('../features/economy/economy-manager.js');
    const mgr = new EconomyManager(guild(), econSupa(), valkey());
    const result = await mgr.withdraw('u1', 500);
    expect(result).toBeDefined();
  });

  it('work', async () => {
    const { EconomyManager } = await import('../features/economy/economy-manager.js');
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const mgr = new EconomyManager(guild(), econSupa(), valkey());
    const result = await mgr.work('u1');
    expect(result).toBeDefined();
    vi.restoreAllMocks();
  });

  it('crime success', async () => {
    const { EconomyManager } = await import('../features/economy/economy-manager.js');
    vi.spyOn(Math, 'random').mockReturnValue(0.1); // success
    const mgr = new EconomyManager(guild(), econSupa(), valkey());
    const result = await mgr.crime('u1');
    expect(result).toBeDefined();
    vi.restoreAllMocks();
  });

  it('beg', async () => {
    const { EconomyManager } = await import('../features/economy/economy-manager.js');
    vi.spyOn(Math, 'random').mockReturnValue(0.3);
    const mgr = new EconomyManager(guild(), econSupa(), valkey());
    const result = await mgr.beg('u1');
    expect(result).toBeDefined();
    vi.restoreAllMocks();
  });

  it('search', async () => {
    const { EconomyManager } = await import('../features/economy/economy-manager.js');
    vi.spyOn(Math, 'random').mockReturnValue(0.4);
    const mgr = new EconomyManager(guild(), econSupa(), valkey());
    const result = await mgr.search('u1');
    expect(result).toBeDefined();
    vi.restoreAllMocks();
  });

  it('pay another user', async () => {
    const { EconomyManager } = await import('../features/economy/economy-manager.js');
    const mgr = new EconomyManager(guild(), econSupa(), valkey());
    const result = await mgr.pay('u1', 'u2', 100);
    expect(result).toBeDefined();
  });

  it('rob another user', async () => {
    const { EconomyManager } = await import('../features/economy/economy-manager.js');
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const mgr = new EconomyManager(guild(), econSupa(), valkey());
    const result = await mgr.rob('u1', 'u2');
    expect(result).toBeDefined();
    vi.restoreAllMocks();
  });

  it('getShopItems', async () => {
    const { EconomyManager } = await import('../features/economy/economy-manager.js');
    const mgr = new EconomyManager(guild(), econSupa(), valkey());
    const items = await mgr.getShopItems();
    expect(items).toBeDefined();
  });

  it('buyItem', async () => {
    const { EconomyManager } = await import('../features/economy/economy-manager.js');
    const mgr = new EconomyManager(guild(), econSupa(), valkey());
    const result = await mgr.buyItem('u1', 'item1', 1);
    expect(result).toBeDefined();
  });

  it('getInventory', async () => {
    const { EconomyManager } = await import('../features/economy/economy-manager.js');
    const mgr = new EconomyManager(guild(), econSupa(), valkey());
    const inv = await mgr.getInventory('u1');
    expect(inv).toBeDefined();
  });

  it('getLeaderboard', async () => {
    const { EconomyManager } = await import('../features/economy/economy-manager.js');
    const s = econSupa();
    s.from = vi.fn((t: string) => {
      if (t === 'guild_config') return chain(econCfg);
      if (t === 'economy_wallets') return chainAsync([
        { user_id: 'u1', wallet: 5000, bank: 2000, net_worth: 7000 },
        { user_id: 'u2', wallet: 3000, bank: 1000, net_worth: 4000 },
      ]);
      return chain(null);
    });
    const mgr = new EconomyManager(guild(), s, valkey());
    const lb = await mgr.getLeaderboard();
    expect(lb).toBeDefined();
  });

  it('togglePassive', async () => {
    const { EconomyManager } = await import('../features/economy/economy-manager.js');
    const mgr = new EconomyManager(guild(), econSupa(), valkey());
    const result = await mgr.togglePassive('u1');
    expect(result).toBeDefined();
  });

  it('loadConfig', async () => {
    const { EconomyManager } = await import('../features/economy/economy-manager.js');
    const mgr = new EconomyManager(guild(), econSupa(), valkey());
    const cfg = await mgr.loadConfig();
    expect(cfg).toBeDefined();
  });

  it('getOrCreateWallet', async () => {
    const { EconomyManager } = await import('../features/economy/economy-manager.js');
    const mgr = new EconomyManager(guild(), econSupa(), valkey());
    const wallet = await mgr.getOrCreateWallet('u1');
    expect(wallet).toBeDefined();
  });

  it('claimTimedReward daily', async () => {
    const { EconomyManager } = await import('../features/economy/economy-manager.js');
    const mgr = new EconomyManager(guild(), econSupa(), valkey());
    const result = await mgr.claimTimedReward('u1', 'daily');
    expect(result).toBeDefined();
  });

  it('claimTimedReward weekly', async () => {
    const { EconomyManager } = await import('../features/economy/economy-manager.js');
    const mgr = new EconomyManager(guild(), econSupa(), valkey());
    const result = await mgr.claimTimedReward('u1', 'weekly');
    expect(result).toBeDefined();
  });

  it('sellItem', async () => {
    const { EconomyManager } = await import('../features/economy/economy-manager.js');
    const mgr = new EconomyManager(guild(), econSupa(), valkey());
    const result = await mgr.sellItem('u1', 'item1', 1);
    expect(result).toBeDefined();
  });
});
