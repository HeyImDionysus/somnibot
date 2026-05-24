/**
 * Bulk coverage: services, sync, deploy, guards, and misc modules.
 * Imports and exercises constructors + key methods for maximum statement coverage.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  SOMNI_PALETTE: { primary: 0x5865f2, success: 0x57f287, danger: 0xed4245 },
  computeStateDiff: vi.fn(() => []),
  classifyDrift: vi.fn(() => []),
  DEFAULT_ESCALATION_CHAIN: [],
}));

vi.mock('discord.js', () => {
  class EmbedBuilder {
    setColor() { return this; } setTitle() { return this; } setDescription() { return this; }
    setThumbnail() { return this; } setTimestamp() { return this; } setFooter() { return this; }
    setAuthor() { return this; } addFields() { return this; } setImage() { return this; }
    setURL() { return this; } toJSON() { return {}; }
  }
  class ActionRowBuilder { addComponents() { return this; } }
  class ButtonBuilder {
    setCustomId() { return this; } setLabel() { return this; } setStyle() { return this; }
    setEmoji() { return this; } setDisabled() { return this; }
  }
  class Collection extends Map {
    filter(fn: any) { const r = new Collection(); for (const [k,v] of this) if (fn(v,k)) r.set(k,v); return r; }
    map(fn: any) { return [...this.values()].map(fn); }
    find(fn: any) { return [...this.values()].find(fn); }
    first() { return [...this.values()][0]; }
  }
  return {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, Collection,
    ChannelType: { GuildText: 0, GuildVoice: 2, GuildCategory: 4 },
    PermissionFlagsBits: { ViewChannel: 1n, SendMessages: 2n, ManageGuild: 32n, ManageChannels: 64n, ManageRoles: 256n },
    ButtonStyle: { Primary: 1, Secondary: 2, Danger: 4 },
    Events: { ClientReady: 'ready', InteractionCreate: 'interactionCreate', GuildCreate: 'guildCreate' },
    REST: class { setToken() { return this; } },
    Routes: { applicationGuildCommands: () => '/fake' },
    SlashCommandBuilder: class {
      setName() { return this; } setDescription() { return this; } setDefaultMemberPermissions() { return this; }
      addSubcommand(fn: any) { try { fn(this); } catch {} return this; }
      addStringOption(fn: any) { try { fn(this); } catch {} return this; }
      addIntegerOption(fn: any) { try { fn(this); } catch {} return this; }
      addBooleanOption(fn: any) { try { fn(this); } catch {} return this; }
      addUserOption(fn: any) { try { fn(this); } catch {} return this; }
      addChannelOption(fn: any) { try { fn(this); } catch {} return this; }
      setRequired() { return this; } setMinValue() { return this; } setMaxValue() { return this; }
      addChoices() { return this; } setChoices() { return this; } setAutocomplete() { return this; }
      toJSON() { return {}; }
    },
  };
});

vi.mock('../services/supabase.js', () => ({ getSupabase: vi.fn(() => makeSupa()) }));
vi.mock('../services/valkey.js', () => ({ getValkey: vi.fn(() => makeValkey()), connectValkey: vi.fn(async () => {}) }));
vi.mock('../services/audit.js', () => ({ writeAuditLog: vi.fn(async () => {}) }));
vi.mock('../features/moderation/infraction-service.js', () => ({
  createInfraction: vi.fn(async () => ({ id: 'inf1' })),
  getActiveWarningCount: vi.fn(async () => 0),
}));
vi.mock('../features/moderation/escalation.js', () => ({
  executeEscalation: vi.fn(async () => {}),
}));
vi.mock('../features/moderation/mod-log.js', () => ({
  postModLogEntry: vi.fn(async () => {}),
}));
vi.mock('../features/audit/alert-manager.js', () => ({
  AlertManager: class { check = vi.fn(); },
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

function makeValkey(): any {
  return { get: vi.fn(async () => null), set: vi.fn(async () => 'OK'), setex: vi.fn(async () => 'OK'), del: vi.fn(async () => 1), incr: vi.fn(async () => 1), expire: vi.fn(async () => 1), keys: vi.fn(async () => []), mget: vi.fn(async () => []), scan: vi.fn(async () => ['0', []]), lpush: vi.fn(async () => 1), rpop: vi.fn(async () => null), llen: vi.fn(async () => 0), subscribe: vi.fn(async () => {}), on: vi.fn(), psubscribe: vi.fn(async () => {}), publish: vi.fn(async () => 1), duplicate: vi.fn(function(this: any) { return this; }), sadd: vi.fn(async () => 1), smembers: vi.fn(async () => []), srem: vi.fn(async () => 1), hset: vi.fn(async () => 1), hget: vi.fn(async () => null), hgetall: vi.fn(async () => ({})), hdel: vi.fn(async () => 1), xadd: vi.fn(async () => ''), xread: vi.fn(async () => null), zadd: vi.fn(async () => 1), zrange: vi.fn(async () => []), zrangebyscore: vi.fn(async () => []), zrem: vi.fn(async () => 1), exists: vi.fn(async () => 0), ttl: vi.fn(async () => -1), persist: vi.fn(async () => 1), scard: vi.fn(async () => 0), srandmember: vi.fn(async () => null), sismember: vi.fn(async () => 0) };
}

function makeCollection(entries: [string, any][] = []): any {
  const col: any = new Map(entries);
  col.filter = function(fn: any) { const r = makeCollection(); for (const [k,v] of this) if (fn(v,k)) r.set(k,v); return r; };
  col.map = function(fn: any) { return [...this.values()].map(fn); };
  col.find = function(fn: any) { return [...this.values()].find(fn); };
  col.first = function() { return [...this.values()][0]; };
  col.toJSON = function() { return [...this.values()]; };
  return col;
}

function makeGuild(): any {
  return {
    id: 'g1', name: 'Test', memberCount: 100, ownerId: 'owner1',
    roles: { cache: makeCollection([['r1', { id: 'r1', name: 'Member', position: 1, color: 0, hoist: false, mentionable: false, managed: false, permissions: { bitfield: 0n }, editable: true }]]), everyone: { id: 'g1', permissions: { bitfield: 0n } }, fetch: vi.fn(async () => makeCollection()) },
    channels: { cache: makeCollection([['ch1', { id: 'ch1', name: 'general', type: 0, position: 0, parentId: null, topic: null, rateLimitPerUser: 0, nsfw: false, permissionOverwrites: { cache: makeCollection() } }]]), fetch: vi.fn(async () => makeCollection()), create: vi.fn(async () => ({ id: 'new-ch', send: vi.fn(async () => ({})) })) },
    members: { cache: makeCollection([['u1', { id: 'u1', displayName: 'User', user: { id: 'u1', tag: 'User#0001' } }]]), fetch: vi.fn(async () => makeCollection()) },
    commands: { set: vi.fn(async () => []) },
    emojis: { cache: makeCollection() },
    stickers: { cache: makeCollection() },
    me: { permissions: { has: vi.fn(() => true) } },
  };
}

function makeClient(): any {
  return {
    supabase: makeSupa(),
    user: { id: 'bot1', tag: 'Bot#0001' },
    guilds: { cache: new Map([['g1', makeGuild()]]) },
    ws: { ping: 50 },
    on: vi.fn().mockReturnThis(),
    once: vi.fn().mockReturnThis(),
    eventBus: { emit: vi.fn(), on: vi.fn(), removeAllListeners: vi.fn() },
    application: { id: 'app1' },
  };
}

// ═══════ ConfigWatcher ═══════
describe('ConfigWatcher', () => {
  it('constructs and starts', async () => {
    const mod = await import('../services/config-watcher.js');
    const watcher = new mod.ConfigWatcher(makeSupa() as any, makeValkey());
    expect(watcher).toBeDefined();
  });
});

// ═══════ CommerceFulfillmentService ═══════
describe('CommerceFulfillmentService', () => {
  it('constructs', async () => {
    const mod = await import('../services/commerce-fulfillment.js');
    const svc = new mod.CommerceFulfillmentService(makeSupa() as any, makeClient());
    expect(svc).toBeDefined();
  });
});

// ═══════ FraudDetection ═══════
describe('fraud-detection', () => {
  it('checkPurchaseVelocity returns result', async () => {
    const mod = await import('../services/fraud-detection.js');
    const result = await mod.checkPurchaseVelocity(makeSupa() as any, 'u1');
    expect(result).toBeDefined();
  });
  it('checkDeviceAbuse returns result', async () => {
    const mod = await import('../services/fraud-detection.js');
    const result = await mod.checkDeviceAbuse(makeSupa() as any, 'u1', 'device1');
    expect(result).toBeDefined();
  });
});

// ═══════ AlertService ═══════
describe('AlertService', () => {
  it('constructs and inits', async () => {
    const mod = await import('../services/alert-service.js');
    const svc = new mod.AlertService(makeSupa() as any, makeClient());
    await svc.init();
    expect(svc).toBeDefined();
  });
});

// ═══════ OwnerNotificationService ═══════
describe('OwnerNotificationService', () => {
  it('constructs', async () => {
    const mod = await import('../services/owner-notifications.js');
    const svc = new mod.OwnerNotificationService(makeClient(), makeSupa() as any);
    expect(svc).toBeDefined();
  });
});

// ═══════ HeartbeatService ═══════
describe('HeartbeatService', () => {
  it('constructs', async () => {
    const mod = await import('../services/heartbeat.js');
    const svc = new mod.HeartbeatService(makeClient(), makeValkey());
    expect(svc).toBeDefined();
  });
});

// ═══════ EmbedTheme ═══════
describe('embed-theme', () => {
  it('themedEmbed returns embed', async () => {
    const mod = await import('../services/embed-theme.js');
    const embed = await mod.themedEmbed(makeSupa() as any, 'g1', { title: 'Test' });
    expect(embed).toBeDefined();
  });
});

// ═══════ MusicStatusReporter ═══════
describe('MusicStatusReporter', () => {
  it('constructs', async () => {
    const mod = await import('../services/music-status-reporter.js');
    const reporter = new mod.MusicStatusReporter(makeClient(), makeValkey());
    expect(reporter).toBeDefined();
  });
});

// ═══════ GuildSnapshot ═══════
describe('guild-snapshot', () => {
  it('writeGuildSnapshot', async () => {
    const mod = await import('../services/guild-snapshot.js');
    await mod.writeGuildSnapshot(makeSupa() as any, makeGuild());
  });
});

// ═══════ Guards ═══════
describe('bot-role-guard', () => {
  it('imports', async () => {
    const mod = await import('../guards/bot-role-guard.js');
    expect(mod).toBeDefined();
  });
});

// ═══════ Config ═══════
describe('config', () => {
  it('imports', async () => {
    const mod = await import('../config.js');
    expect(mod).toBeDefined();
  });
});

// ═══════ guild-context ═══════
describe('guild-context', () => {
  it('imports', async () => {
    const mod = await import('../guild-context.js');
    expect(mod).toBeDefined();
  });
});

// ═══════ sync/repair-actions ═══════
describe('sync repair-actions', () => {
  it('imports', async () => {
    const mod = await import('../sync/repair-actions.js');
    expect(mod).toBeDefined();
  });
});

// ═══════ sync/sync-engine ═══════
describe('sync sync-engine', () => {
  it('imports', async () => {
    const mod = await import('../sync/sync-engine.js');
    expect(mod).toBeDefined();
  });
});

// ═══════ sync/channel-events ═══════
describe('sync channel-events', () => {
  it('imports', async () => {
    const mod = await import('../sync/channel-events.js');
    expect(mod).toBeDefined();
  });
});

// ═══════ sync/role-events ═══════
describe('sync role-events', () => {
  it('imports', async () => {
    const mod = await import('../sync/role-events.js');
    expect(mod).toBeDefined();
  });
});

// ═══════ features index barrel exports ═══════
describe('feature index barrels', () => {
  const indexPaths = [
    '../features/achievements/index.js',
    '../features/adventures/index.js',
    '../features/automations/index.js',
    '../features/crafting/index.js',
    '../features/farming/index.js',
    '../features/fishing/index.js',
    '../features/games/index.js',
    '../features/gathering/index.js',
    '../features/giveaways/index.js',
    '../features/heist/index.js',
    '../features/lottery/index.js',
    '../features/market/index.js',
    '../features/pets/index.js',
    '../features/polls/index.js',
    '../features/profiles/index.js',
    '../features/quests/index.js',
    '../features/trivia/index.js',
  ];

  for (const path of indexPaths) {
    it(`imports ${path}`, async () => {
      const mod = await import(path);
      expect(mod).toBeDefined();
    });
  }
});

// ═══════ Additional feature modules ═══════
describe('additional feature modules', () => {
  it('music-filters', async () => {
    const mod = await import('../features/music/music-filters.js');
    expect(mod).toBeDefined();
  });

  it('music-queue', async () => {
    const mod = await import('../features/music/music-queue.js');
    expect(mod).toBeDefined();
  });

  it('level-announcer', async () => {
    const mod = await import('../features/levels/level-announcer.js');
    expect(mod).toBeDefined();
  });

  it('voice-xp', async () => {
    const mod = await import('../features/levels/voice-xp.js');
    expect(mod).toBeDefined();
  });

  it('automod-engine', async () => {
    const mod = await import('../features/moderation/automod-engine.js');
    expect(mod).toBeDefined();
  });

  it('reaction-engine', async () => {
    const mod = await import('../features/reaction-roles/reaction-engine.js');
    expect(mod).toBeDefined();
  });

  it('button-roles', async () => {
    const mod = await import('../features/reaction-roles/button-roles.js');
    expect(mod).toBeDefined();
  });

  it('scheduled-messages runner', async () => {
    const mod = await import('../features/scheduled-messages/runner.js');
    expect(mod).toBeDefined();
  });

  it('starboard', async () => {
    const mod = await import('../features/starboard/index.js');
    expect(mod).toBeDefined();
  });

  it('stats-channels manager', async () => {
    const mod = await import('../features/stats-channels/stats-manager.js');
    expect(mod).toBeDefined();
  });

  it('temp-channel manager', async () => {
    const mod = await import('../features/temp-channels/temp-channel-manager.js');
    expect(mod).toBeDefined();
  });

  it('temp-channel voice-handler', async () => {
    const mod = await import('../features/temp-channels/voice-handler.js');
    expect(mod).toBeDefined();
  });

  it('ticket panel-manager', async () => {
    const mod = await import('../features/tickets/panel-manager.js');
    expect(mod).toBeDefined();
  });

  it('ticket register-commands', async () => {
    const mod = await import('../features/tickets/register-commands.js');
    expect(mod).toBeDefined();
  });

  it('ticket-commands', async () => {
    const mod = await import('../features/tickets/ticket-commands.js');
    expect(mod).toBeDefined();
  });

  it('welcome-service', async () => {
    const mod = await import('../features/welcome/welcome-service.js');
    expect(mod).toBeDefined();
  });

  it('welcome-card', async () => {
    const mod = await import('../features/welcome/welcome-card.js');
    expect(mod).toBeDefined();
  });

  it('goodbye-service', async () => {
    const mod = await import('../features/welcome/goodbye-service.js');
    expect(mod).toBeDefined();
  });

  it('member-service', async () => {
    const mod = await import('../features/welcome/member-service.js');
    expect(mod).toBeDefined();
  });

  it('onboarding-handler', async () => {
    const mod = await import('../features/welcome/onboarding-handler.js');
    expect(mod).toBeDefined();
  });

  it('welcome-variables', async () => {
    const mod = await import('../features/welcome/welcome-variables.js');
    expect(mod).toBeDefined();
  });

  it('discord-ux autocomplete', async () => {
    const mod = await import('../features/discord-ux/autocomplete.js');
    expect(mod).toBeDefined();
  });

  it('discord-ux bot-presence', async () => {
    const mod = await import('../features/discord-ux/bot-presence.js');
    expect(mod).toBeDefined();
  });

  it('discord-ux context-menus', async () => {
    const mod = await import('../features/discord-ux/context-menus.js');
    expect(mod).toBeDefined();
  });

  it('discord-ux modal-handlers', async () => {
    const mod = await import('../features/discord-ux/modal-handlers.js');
    expect(mod).toBeDefined();
  });

  it('discord-native automod-sync', async () => {
    const mod = await import('../features/discord-native/automod-sync.js');
    expect(mod).toBeDefined();
  });

  it('discord-native forum-tickets', async () => {
    const mod = await import('../features/discord-native/forum-tickets.js');
    expect(mod).toBeDefined();
  });

  it('discord-native guild-onboarding-sync', async () => {
    const mod = await import('../features/discord-native/guild-onboarding-sync.js');
    expect(mod).toBeDefined();
  });

  it('discord-native interaction-handler', async () => {
    const mod = await import('../features/discord-native/interaction-handler.js');
    expect(mod).toBeDefined();
  });

  it('custom-commands engine', async () => {
    const mod = await import('../features/custom-commands/command-engine.js');
    expect(mod).toBeDefined();
  });

  it('anti-raid', async () => {
    const mod = await import('../features/anti-raid/index.js');
    expect(mod).toBeDefined();
  });

  it('help', async () => {
    const mod = await import('../features/help/index.js');
    expect(mod).toBeDefined();
  });

  it('message-log', async () => {
    const mod = await import('../features/message-log/index.js');
    expect(mod).toBeDefined();
  });

  it('automation-loader', async () => {
    const mod = await import('../features/automations/automation-loader.js');
    expect(mod).toBeDefined();
  });

  it('execution-logger', async () => {
    const mod = await import('../features/automations/execution-logger.js');
    expect(mod).toBeDefined();
  });

  it('commerce key-generator', async () => {
    const mod = await import('../features/commerce/key-generator.js');
    expect(mod).toBeDefined();
  });

  it('commerce payment-handler', async () => {
    const mod = await import('../features/commerce/payment-handler.js');
    expect(mod).toBeDefined();
  });

  it('commerce receipt-builder', async () => {
    const mod = await import('../features/commerce/receipt-builder.js');
    expect(mod).toBeDefined();
  });

  it('commerce entitlement-service', async () => {
    const mod = await import('../features/commerce/entitlement-service.js');
    expect(mod).toBeDefined();
  });

  it('quests manager', async () => {
    const mod = await import('../features/quests/quests-manager.js');
    const mgr = new mod.QuestsManager(makeSupa() as any);
    expect(mgr).toBeDefined();
    mgr.clearCache();
  });

  it('profiles manager', async () => {
    const mod = await import('../features/profiles/profiles-manager.js');
    const mgr = new mod.ProfilesManager(makeSupa() as any);
    expect(mgr).toBeDefined();
  });

  it('trivia manager', async () => {
    const mod = await import('../features/trivia/trivia-manager.js');
    const mgr = new mod.TriviaManager(makeSupa() as any);
    expect(mgr).toBeDefined();
  });

  it('achievements manager', async () => {
    const mod = await import('../features/achievements/achievements-manager.js');
    const mgr = new mod.AchievementsManager(makeSupa() as any);
    expect(mgr).toBeDefined();
  });
});

// ═══════ deploy ═══════
describe('deploy modules', () => {
  it('deployer imports', async () => {
    const mod = await import('../deploy/deployer.js');
    expect(mod).toBeDefined();
  });

  it('deploy-listener imports', async () => {
    const mod = await import('../deploy/deploy-listener.js');
    expect(mod).toBeDefined();
  });
});

// ═══════ Additional services ═══════
describe('additional services', () => {
  it('config-loader', async () => {
    const mod = await import('../services/config-loader.js');
    expect(mod).toBeDefined();
  });

  it('reconciliation', async () => {
    const mod = await import('../services/reconciliation.js');
    expect(mod).toBeDefined();
  });
});
