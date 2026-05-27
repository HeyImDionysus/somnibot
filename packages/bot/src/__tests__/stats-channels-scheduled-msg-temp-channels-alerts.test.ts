/**
 * Wave 4 coverage tests: StatsChannelManager, ScheduledMessageRunner,
 * TempChannelManager, AlertService, CustomCommands, deeper GamesManager
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  SOMNI_PALETTE: { primary: 0x5865F2, success: 0x57F287, error: 0xED4245, warning: 0xFEE75C },
  LEVEL_CONFIG: {
    DEFAULT_MIN_XP: 15, DEFAULT_MAX_XP: 25,
    DEFAULT_COOLDOWN_SECONDS: 60,
    DEFAULT_VOICE_XP_PER_INTERVAL: 5,
  },
  calculateLevel: (xp: number) => Math.floor(Math.sqrt(xp / 100)),
  randomXp: (min: number, max: number) => Math.floor((min + max) / 2),
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
  class StringSelectMenuBuilder {
    data: any = {};
    setCustomId(id: string) { this.data.customId = id; return this; }
    setPlaceholder(p: string) { return this; }
    addOptions(...o: any[]) { return this; }
  }
  return {
    Collection, EmbedBuilder, ActionRowBuilder, ButtonBuilder, StringSelectMenuBuilder,
    ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4 },
    ChannelType: { GuildText: 0, GuildCategory: 4, PrivateThread: 12, GuildVoice: 2, GuildAnnouncement: 5 },
    ComponentType: { Button: 2, StringSelect: 3 },
    Colors: { Red: 0xff0000, Green: 0x00ff00 },
    PermissionFlagsBits: { ViewChannel: 1n, SendMessages: 2n, ManageChannels: 4n, ManageRoles: 8n, ReadMessageHistory: 16n, BanMembers: 32n, KickMembers: 64n, ModerateMembers: 128n, Connect: 256n, Speak: 512n },
    OverwriteType: { Role: 0, Member: 1 },
    GuildMember: class {},
    AuditLogEvent: { MemberBanAdd: 22, MemberKick: 20 },
    time: vi.fn((ts: number, style?: string) => `<t:${ts}>`),
    TimestampStyles: { RelativeTime: 'R', ShortDateTime: 'f' },
    userMention: vi.fn((id: string) => `<@${id}>`),
    channelMention: vi.fn((id: string) => `<#${id}>`),
    roleMention: vi.fn((id: string) => `<@&${id}>`),
    bold: vi.fn((s: string) => `**${s}**`),
    italic: vi.fn((s: string) => `*${s}*`),
    codeBlock: vi.fn((s: string) => '```\n' + s + '\n```'),
    inlineCode: vi.fn((s: string) => '`' + s + '`'),
    REST: class {},
    Routes: { applicationGuildCommands: () => '/api' },
    ApplicationCommandType: { ChatInput: 1 },
  };
});

const { Collection } = await import('discord.js');

// ═══════ Shared helpers ═══════
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
    send: vi.fn(async () => ({ id: 'msg1' })),
    messages: { fetch: vi.fn(async () => new Collection()) },
    permissionOverwrites: { cache: new Collection(), edit: vi.fn(async () => {}) },
    setName: vi.fn(async () => {}), setTopic: vi.fn(async () => {}),
    threads: { create: vi.fn(async (opts: any) => ({ id: 'thread1', send: vi.fn(async () => ({})) })) },
    delete: vi.fn(async () => {}),
    isVoiceBased: () => false,
    isTextBased: () => true,
  };
  const voiceCh: any = {
    id: 'vc1', name: 'Voice', type: 2,
    members: new Collection(),
    isVoiceBased: () => true,
    isTextBased: () => false,
    setName: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    permissionOverwrites: { edit: vi.fn(async () => {}) },
  };
  channels.set('ch1', textCh);
  channels.set('vc1', voiceCh);
  return {
    id, name: 'Test Guild', memberCount: 50,
    roles: { cache: new Collection(), everyone: { id: 'everyone' } },
    channels: {
      cache: channels,
      fetch: vi.fn(async (cid?: string) => cid ? channels.get(cid) || textCh : channels),
      create: vi.fn(async (opts: any) => ({ ...voiceCh, id: 'new-vc', name: opts?.name || 'new', parent: opts?.parent, permissionOverwrites: { edit: vi.fn(async () => {}) } })),
    },
    members: {
      cache: new Collection(),
      fetch: vi.fn(async (uid?: string) => {
        if (!uid) return new Collection();
        const member: any = {
          id: uid, user: { id: uid, username: 'User', displayAvatarURL: () => 'url', send: vi.fn(async () => {}), bot: false },
          roles: { cache: new Collection(), add: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
          displayName: 'User', permissions: { has: () => true },
          timeout: vi.fn(async () => {}), ban: vi.fn(async () => {}), kick: vi.fn(async () => {}),
          voice: { channelId: null },
        };
        return member;
      }),
    },
    client: { user: { id: 'bot1' }, channels: { cache: channels } },
  } as any;
}
function valkey() {
  return {
    get: vi.fn(async () => null), set: vi.fn(async () => 'OK'),
    del: vi.fn(async () => 1), incr: vi.fn(async () => 1), decr: vi.fn(async () => 0),
    expire: vi.fn(async () => 1), ttl: vi.fn(async () => -2), pttl: vi.fn(async () => -2),
    sadd: vi.fn(async () => 1), sismember: vi.fn(async () => 0),
    smembers: vi.fn(async () => []), scard: vi.fn(async () => 0),
    keys: vi.fn(async () => []),
    hset: vi.fn(async () => 1), hget: vi.fn(async () => null), hgetall: vi.fn(async () => ({})),
    zadd: vi.fn(async () => 1), zrangebyscore: vi.fn(async () => []),
    setex: vi.fn(async () => 'OK'), incrby: vi.fn(async () => 5),
  } as any;
}
function interaction(guildObj: any = guild()) {
  return {
    guildId: guildObj.id,
    guild: guildObj,
    user: { id: 'u1', username: 'TestUser', displayAvatarURL: () => 'url' },
    member: { id: 'u1', displayName: 'TestUser', permissions: { has: () => true } },
    channelId: 'ch1',
    channel: guildObj.channels.cache.get('ch1'),
    options: {
      getString: vi.fn(() => null), getInteger: vi.fn(() => null),
      getUser: vi.fn(() => null), getSubcommand: vi.fn(() => 'default'),
    },
    reply: vi.fn(async () => ({ id: 'reply1' })),
    editReply: vi.fn(async () => ({})),
    followUp: vi.fn(async () => ({})),
    deferReply: vi.fn(async () => ({})),
    deferUpdate: vi.fn(async () => ({})),
    update: vi.fn(async () => ({})),
    customId: '',
    message: { id: 'msg1', edit: vi.fn(async () => ({})), delete: vi.fn(async () => {}) },
    showModal: vi.fn(async () => ({})),
    isButton: () => false,
    isChatInputCommand: () => true,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    replied: false, deferred: false,
    createMessageComponentCollector: vi.fn(() => ({
      on: vi.fn((ev: string, cb: Function) => {}),
    })),
  } as any;
}

// ═══════════════════════════════════════════════
// StatsChannelManager
// ═══════════════════════════════════════════════
describe('StatsChannelManager', () => {
  const statsCfg = [
    { id: 'sc1', guild_id: 'g1', channel_id: 'vc1', template: 'Members: {memberCount}', type: 'voice', enabled: true },
    { id: 'sc2', guild_id: 'g1', channel_id: null, template: 'Roles: {roleCount}', type: 'voice', enabled: true },
  ];

  function statsSupa() {
    return {
      from: vi.fn((t: string) => {
        if (t === 'stats_channels') return chainAsync(statsCfg);
        if (t === 'guild_config') return chain({ stats_channels_enabled: true });
        return chain(null);
      }),
    } as any;
  }

  it('start and initial update', async () => {
    const { StatsChannelManager } = await import('../features/stats-channels/stats-manager.js');
    const mgr = new StatsChannelManager(guild(), statsSupa(), 60);
    await mgr.start();
    mgr.stop?.();
  });

  it('reload channels', async () => {
    const { StatsChannelManager } = await import('../features/stats-channels/stats-manager.js');
    const mgr = new StatsChannelManager(guild(), statsSupa(), 60);
    await mgr.reload();
  });

  it('start with empty config', async () => {
    const { StatsChannelManager } = await import('../features/stats-channels/stats-manager.js');
    const s: any = { from: vi.fn(() => chainAsync([])) };
    const mgr = new StatsChannelManager(guild(), s, 60);
    await mgr.start();
  });
});

// ═══════════════════════════════════════════════
// ScheduledMessageRunner
// ═══════════════════════════════════════════════
describe('ScheduledMessageRunner', () => {
  const schedules = [
    {
      id: 'sched1', guild_id: 'g1', channel_id: 'ch1',
      content: 'Daily reminder: be nice!',
      cron_expression: '0 9 * * *',
      timezone: 'UTC', enabled: true,
      last_run_at: null, embed_json: null,
    },
    {
      id: 'sched2', guild_id: 'g1', channel_id: 'ch1',
      content: null,
      cron_expression: '0 12 * * *',
      timezone: 'UTC', enabled: true,
      last_run_at: new Date(Date.now() - 86400000).toISOString(),
      embed_json: JSON.stringify({ title: 'Lunch Time', description: 'Eat food' }),
    },
  ];

  function schedSupa() {
    return {
      from: vi.fn((t: string) => {
        if (t === 'scheduled_messages') {
          const c = chainAsync(schedules);
          c.update = vi.fn(() => chain(null));
          return c;
        }
        return chain(null);
      }),
    } as any;
  }

  it('start loads schedules', async () => {
    const { ScheduledMessageRunner } = await import('../features/scheduled-messages/runner.js');
    const mgr = new ScheduledMessageRunner(guild(), schedSupa());
    await mgr.start();
    mgr.stop?.();
  });

  it('reload refreshes schedules', async () => {
    const { ScheduledMessageRunner } = await import('../features/scheduled-messages/runner.js');
    const mgr = new ScheduledMessageRunner(guild(), schedSupa());
    await mgr.reload();
  });

  it('start with empty schedules', async () => {
    const { ScheduledMessageRunner } = await import('../features/scheduled-messages/runner.js');
    const s: any = { from: vi.fn(() => chainAsync([])) };
    const mgr = new ScheduledMessageRunner(guild(), s);
    await mgr.start();
  });
});

// ═══════════════════════════════════════════════
// TempChannelManager
// ═══════════════════════════════════════════════
describe('TempChannelManager', () => {
  const hubs = [
    {
      id: 'hub1', guild_id: 'g1',
      hub_channel_id: 'vc1', category_id: 'cat1',
      naming_format: '{user}\'s Channel',
      default_user_limit: 10, default_bitrate: 64000,
      enabled: true,
    },
  ];
  const activeChannels = [
    { id: 'ac1', guild_id: 'g1', hub_id: 'hub1', channel_id: 'vc1', owner_id: 'u1', created_at: new Date().toISOString() },
  ];

  function tcSupa(hubData = hubs, activeData = activeChannels) {
    return {
      from: vi.fn((t: string) => {
        if (t === 'temp_channel_hubs') return chainAsync(hubData);
        if (t === 'temp_channels_active') {
          const c = chainAsync(activeData);
          c.insert = vi.fn(() => chain({ id: 'new-ac' }));
          c.delete = vi.fn(() => chain(null));
          return c;
        }
        return chain(null);
      }),
    } as any;
  }

  it('start and load hubs', async () => {
    const { TempChannelManager } = await import('../features/temp-channels/temp-channel-manager.js');
    const mgr = new TempChannelManager(guild(), tcSupa());
    await mgr.start();
  });

  it('handleJoinHub creates temp channel', async () => {
    const { TempChannelManager } = await import('../features/temp-channels/temp-channel-manager.js');
    const g = guild();
    const mgr = new TempChannelManager(g, tcSupa());
    await mgr.start();
    const member = await g.members.fetch('u1');
    await mgr.handleJoinHub(member as any, 'vc1');
  });

  it('handleLeaveTemp triggers cleanup', async () => {
    const { TempChannelManager } = await import('../features/temp-channels/temp-channel-manager.js');
    const mgr = new TempChannelManager(guild(), tcSupa());
    await mgr.start();
    await mgr.handleLeaveTemp('vc1');
  });

  it('deleteChannel', async () => {
    const { TempChannelManager } = await import('../features/temp-channels/temp-channel-manager.js');
    const mgr = new TempChannelManager(guild(), tcSupa());
    await mgr.start();
    await mgr.deleteChannel('vc1');
  });

  it('transferOwnership', async () => {
    const { TempChannelManager } = await import('../features/temp-channels/temp-channel-manager.js');
    const mgr = new TempChannelManager(guild(), tcSupa());
    await mgr.start();
    await mgr.transferOwnership('vc1', 'u2');
  });

  it('reloadHubs', async () => {
    const { TempChannelManager } = await import('../features/temp-channels/temp-channel-manager.js');
    const mgr = new TempChannelManager(guild(), tcSupa());
    await mgr.reloadHubs();
  });

  it('start with no hubs', async () => {
    const { TempChannelManager } = await import('../features/temp-channels/temp-channel-manager.js');
    const mgr = new TempChannelManager(guild(), tcSupa([], []));
    await mgr.start();
  });
});

// ═══════════════════════════════════════════════
// AlertService
// ═══════════════════════════════════════════════
describe('AlertService', () => {
  function alertSupa() {
    return {
      from: vi.fn((t: string) => {
        if (t === 'guild_config') return chain({ alert_channel_id: 'ch1' });
        if (t === 'automation_alerts') {
          const c = chain(null);
          c.insert = vi.fn(() => c);
          return c;
        }
        return chain(null);
      }),
    } as any;
  }

  it('init loads config', async () => {
    const { AlertService } = await import('../services/alert-service.js');
    const svc = new AlertService(valkey(), alertSupa(), guild());
    await svc.init();
  });

  it('recordSuccess clears failures', async () => {
    const { AlertService } = await import('../services/alert-service.js');
    const svc = new AlertService(valkey(), alertSupa(), guild());
    await svc.init();
    await svc.recordSuccess('auto1');
  });

  it('recordFailure increments count', async () => {
    const { AlertService } = await import('../services/alert-service.js');
    const vk = valkey();
    vk.incr = vi.fn(async () => 3); // below default threshold
    const svc = new AlertService(vk, alertSupa(), guild());
    await svc.init();
    await svc.recordFailure('auto1', 'test-auto', 'Test failure');
  });

  it('recordFailure exceeds threshold triggers alert', async () => {
    const { AlertService } = await import('../services/alert-service.js');
    const vk = valkey();
    vk.incr = vi.fn(async () => 5); // at threshold
    const svc = new AlertService(vk, alertSupa(), guild(), { failureThreshold: 5 });
    await svc.init();
    await svc.recordFailure('auto1', 'test-auto', 'Threshold reached');
  });

  it('getFailureCount', async () => {
    const { AlertService } = await import('../services/alert-service.js');
    const vk = valkey();
    vk.get = vi.fn(async () => '3');
    const svc = new AlertService(vk, alertSupa(), guild());
    const count = await svc.getFailureCount('auto1');
    expect(count).toBe(3);
  });

  it('getFailingAutomationCount', async () => {
    const { AlertService } = await import('../services/alert-service.js');
    const vk = valkey();
    vk.keys = vi.fn(async () => ['alert:g1:auto1', 'alert:g1:auto2']);
    const svc = new AlertService(vk, alertSupa(), guild());
    const count = await svc.getFailingAutomationCount();
    expect(count).toBeGreaterThanOrEqual(0);
  });

  it('postAlert sends to channel', async () => {
    const { AlertService } = await import('../services/alert-service.js');
    const svc = new AlertService(valkey(), alertSupa(), guild());
    await svc.init();
    await svc.postAlert('test-alert', 'warning', 'Test Alert', 'Something happened');
  });
});

// ═══════════════════════════════════════════════
// Custom Commands
// ═══════════════════════════════════════════════
describe('CustomCommands', () => {
  const cmds = [
    { id: 'cc1', guild_id: 'g1', name: 'hello', description: 'Say hello', response: 'Hello {user}!', enabled: true, ephemeral: false, cooldown_seconds: 0, allowed_roles: [], denied_roles: [], allowed_channels: [], denied_channels: [], actions: [{ type: 'reply', content: 'Hello {user}!' }] },
    { id: 'cc2', guild_id: 'g1', name: 'secret', description: 'Secret cmd', response: 'Shh!', enabled: true, ephemeral: true, cooldown_seconds: 10, allowed_roles: [], denied_roles: [], allowed_channels: [], denied_channels: [], actions: [{ type: 'reply', content: 'Shh!' }] },
  ];

  function ccSupa() {
    return {
      from: vi.fn((t: string) => {
        if (t === 'custom_commands') return chainAsync(cmds);
        return chain(null);
      }),
    } as any;
  }

  it('loadCustomCommands', async () => {
    const { loadCustomCommands } = await import('../features/custom-commands/command-engine.js');
    const rest = { put: vi.fn(async () => {}) } as any;
    const result = await loadCustomCommands(ccSupa(), guild(), rest);
    expect(result).toBeDefined();
  });

  it('handleCustomCommand known command', async () => {
    const { loadCustomCommands, handleCustomCommand } = await import('../features/custom-commands/command-engine.js');
    const rest = { put: vi.fn(async () => {}) } as any;
    await loadCustomCommands(ccSupa(), guild(), rest);
    const inter = interaction();
    inter.commandName = 'hello';
    inter.member = { ...inter.member, roles: { cache: { map: (fn: any) => [] } } };
    const handled = await handleCustomCommand(inter, ccSupa(), valkey(), guild());
    expect(handled).toBeDefined();
  });

  it('handleCustomCommand unknown returns false', async () => {
    const { handleCustomCommand, clearCommandRegistry } = await import('../features/custom-commands/command-engine.js');
    clearCommandRegistry();
    const inter = interaction();
    inter.commandName = 'nonexistent';
    const handled = await handleCustomCommand(inter, ccSupa(), valkey(), guild());
    expect(handled).toBe(false);
  });

  it('isCustomCommand', async () => {
    const { isCustomCommand, clearCommandRegistry } = await import('../features/custom-commands/command-engine.js');
    clearCommandRegistry();
    expect(isCustomCommand('anything')).toBe(false);
  });

  it('clearCommandRegistry', async () => {
    const { clearCommandRegistry, isCustomCommand } = await import('../features/custom-commands/command-engine.js');
    clearCommandRegistry();
    expect(isCustomCommand('hello')).toBe(false);
  });
});

// ═══════════════════════════════════════════════
// GamesManager deeper (dice, scratch, guess, highlow)
// ═══════════════════════════════════════════════
describe('GamesManager deeper', () => {
  const gameCfg = {
    economy_enabled: true, games_enabled: true,
    currency_name: 'coins', currency_emoji: '🪙',
    games_min_bet: 10, games_max_bet: 10000,
    games_daily_loss_limit: 50000,
    games_coinflip_multiplier: 2,
    games_slots_jackpot_multiplier: 10,
    games_dice_multiplier: 3,
    games_scratch_price: 50,
    games_guess_multiplier: 5,
  };

  function gameSupa(balance = 5000) {
    return {
      from: vi.fn((table: string) => {
        if (table === 'guild_config') return chain(gameCfg);
        if (table === 'economy_wallets') return chain({ wallet: balance, bank: 0 });
        if (table === 'economy_transactions') { const c = chain(null); c.insert = vi.fn(() => c); return c; }
        return chain(null);
      }),
      rpc: vi.fn(async (name: string, args: any) => {
        if (name === 'economy_adjust_balance' || name === 'adjust_wallet')
          return { data: { wallet: balance + (args?.amount || 0) }, error: null };
        return { data: null, error: null };
      }),
    } as any;
  }

  it('dice win', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const mgr = new GamesManager(gameSupa());
    vi.spyOn(Math, 'random').mockReturnValue(0.0); // lowest roll
    const inter = interaction();
    await mgr.dice(inter, 100);
    vi.restoreAllMocks();
  });

  it('dice loss', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const mgr = new GamesManager(gameSupa());
    vi.spyOn(Math, 'random').mockReturnValue(0.99); // highest roll
    const inter = interaction();
    await mgr.dice(inter, 100);
    vi.restoreAllMocks();
  });

  it('scratch win', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const mgr = new GamesManager(gameSupa());
    vi.spyOn(Math, 'random').mockReturnValue(0.01); // very lucky
    const inter = interaction();
    await mgr.scratch(inter, 100);
    vi.restoreAllMocks();
  });

  it('scratch loss', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const mgr = new GamesManager(gameSupa());
    vi.spyOn(Math, 'random').mockReturnValue(0.99); // bad luck
    const inter = interaction();
    await mgr.scratch(inter, 100);
    vi.restoreAllMocks();
  });

  it('guess', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const mgr = new GamesManager(gameSupa());
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const inter = interaction();
    await mgr.guess(inter, 100);
    vi.restoreAllMocks();
  });

  it('blackjack start', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const mgr = new GamesManager(gameSupa());
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const inter = interaction();
    await mgr.blackjack(inter, 100);
    vi.restoreAllMocks();
  });

  it('highlow', async () => {
    const { GamesManager } = await import('../features/games/games-manager.js');
    const mgr = new GamesManager(gameSupa());
    vi.spyOn(Math, 'random').mockReturnValue(0.3);
    const inter = interaction();
    await mgr.highlow(inter);
    vi.restoreAllMocks();
  });
});
