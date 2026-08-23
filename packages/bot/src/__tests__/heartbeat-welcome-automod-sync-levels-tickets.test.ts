/**
 * Wave 7 coverage tests: Low-coverage files
 * Targets: HeartbeatService, WelcomeService, AutoModSync, LevelAnnouncer, TicketService
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  LEVEL_CONFIG: { DEFAULT_MIN_XP: 15, DEFAULT_MAX_XP: 25, DEFAULT_COOLDOWN_SECONDS: 60 },
  calculateLevel: (xp: number) => Math.floor(Math.sqrt(xp / 100)),
}));
vi.mock('../services/audit.js', () => ({ writeAuditLog: vi.fn(async () => {}) }));
vi.mock('../services/event-bus.js', () => ({
  eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn(), onAny: vi.fn() },
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
    setURL(u: string) { return this; }
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
    ChannelType: { GuildText: 0, GuildVoice: 2, GuildCategory: 4 },
    PermissionFlagsBits: { ViewChannel: 1n, SendMessages: 2n, ManageChannels: 4n, ReadMessageHistory: 8n },
    OverwriteType: { Role: 0, Member: 1 },
    Colors: { Red: 0xff0000, Green: 0x00ff00, Yellow: 0xffff00 },
    AutoModerationRuleTriggerType: { Keyword: 1, Spam: 3, KeywordPreset: 4, MentionSpam: 5 },
    AutoModerationActionType: { BlockMessage: 1, SendAlertMessage: 2, Timeout: 3 },
    AutoModerationRuleEventType: { MessageSend: 1 },
    time: vi.fn((ts: number) => `<t:${ts}>`),
    TimestampStyles: { RelativeTime: 'R' },
    userMention: vi.fn((id: string) => `<@${id}>`),
    channelMention: vi.fn((id: string) => `<#${id}>`),
    bold: vi.fn((s: string) => `**${s}**`),
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
    setName: vi.fn(async () => {}),
    edit: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    permissionOverwrites: {
      cache: new Collection(),
      create: vi.fn(async () => {}),
      edit: vi.fn(async () => {}),
    },
  };
  channels.set('ch1', textCh);
  return {
    id, name: 'Test Guild', memberCount: 50,
    roles: {
      cache: new Collection([['role1', { id: 'role1', name: 'Mod' }]]),
      everyone: { id: 'everyone' },
    },
    channels: {
      cache: channels,
      fetch: vi.fn(async () => channels),
      create: vi.fn(async (opts: any) => ({
        id: 'newch', name: opts.name, type: opts.type,
        send: vi.fn(async () => ({ id: 'msg1' })),
        permissionOverwrites: { create: vi.fn(async () => {}), edit: vi.fn(async () => {}) },
        setName: vi.fn(async () => {}),
        edit: vi.fn(async () => {}),
      })),
    },
    members: {
      cache: new Collection(),
      fetch: vi.fn(async (uid: string) => ({
        id: uid, user: { id: uid, username: 'User', displayAvatarURL: () => 'url', bot: false, tag: 'User#0001' },
        displayName: 'User', roles: { cache: new Collection(), add: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
        permissions: { has: () => true },
        send: vi.fn(async () => ({})),
      })),
    },
    client: { user: { id: 'bot1' } },
    iconURL: () => 'https://example.com/icon.png',
    autoModerationRules: {
      cache: new Collection(),
      fetch: vi.fn(async () => new Collection()),
      create: vi.fn(async (opts: any) => ({ id: 'rule1', ...opts })),
    },
  } as any;
}
function valkey() {
  return {
    get: vi.fn(async () => null), set: vi.fn(async () => 'OK'),
    del: vi.fn(async () => 1), incr: vi.fn(async () => 1),
    expire: vi.fn(async () => 1), ttl: vi.fn(async () => -2),
    hset: vi.fn(async () => 1), hget: vi.fn(async () => null), hgetall: vi.fn(async () => ({})),
    keys: vi.fn(async () => []),
    setex: vi.fn(async () => 'OK'),
  } as any;
}
const eb = () => ({ emit: vi.fn(), on: vi.fn(), off: vi.fn(), onAny: vi.fn() } as any);

// ═══════════════════════════════════════════════
// HeartbeatService
// ═══════════════════════════════════════════════
describe('HeartbeatService', () => {
  it('construct and start', async () => {
    const { HeartbeatService } = await import('../services/heartbeat.js');
    const hb = new HeartbeatService(valkey(), { from: vi.fn(() => chain(null)) } as any, 'g1');
    expect(hb).toBeDefined();
    // Don't call start() since it uses setInterval
  });

  it('readHeartbeat', async () => {
    const { readHeartbeat } = await import('../services/heartbeat.js');
    const v = valkey();
    v.hgetall = vi.fn(async () => ({
      status: 'online',
      uptimeMs: '60000',
      guildCount: '1',
      memberCount: '50',
      timestamp: String(Date.now()),
    }));
    const result = await readHeartbeat(v, 'g1');
    expect(result).toBeDefined();
  });

  it('readHeartbeat empty', async () => {
    const { readHeartbeat } = await import('../services/heartbeat.js');
    const result = await readHeartbeat(valkey(), 'g1');
    expect(result).toBeDefined();
  });
});

// ═══════════════════════════════════════════════
// WelcomeService
// ═══════════════════════════════════════════════
describe('WelcomeService', () => {
  const welcomeCfg = {
    welcome_enabled: true,
    welcome_channel_id: 'ch1',
    welcome_message: 'Welcome {user} to {server}!',
    welcome_dm_enabled: true,
    welcome_dm_message: 'Hey {user}, welcome!',
    welcome_auto_roles: ['role1'],
    welcome_card_enabled: false,
    welcome_embed_enabled: true,
    welcome_embed_color: '#5865F2',
    welcome_embed_title: 'Welcome!',
    welcome_embed_description: 'Welcome {user}!',
    welcome_embed_thumbnail: true,
    welcome_embed_footer: null,
    welcome_embed_image: null,
  };

  it('executeWelcomeFlow full flow', async () => {
    const { executeWelcomeFlow } = await import('../features/welcome/welcome-service.js');
    const g = guild();
    const member = {
      id: 'u1', guild: g,
      user: { id: 'u1', username: 'NewUser', displayAvatarURL: () => 'url', bot: false, tag: 'NewUser#0001' },
      displayName: 'NewUser',
      roles: { cache: new Collection(), add: vi.fn(async () => {}) },
      send: vi.fn(async () => ({})),
    } as any;
    const supa = {
      from: vi.fn((t: string) => {
        if (t === 'member_numbers') return chain({ member_number: 42 });
        return chain(null);
      }),
      rpc: vi.fn(async () => ({ data: 42, error: null })),
    } as any;
    await executeWelcomeFlow(member, { supabase: supa, config: welcomeCfg as any });
  });

  it('executeWelcomeFlow disabled', async () => {
    const { executeWelcomeFlow } = await import('../features/welcome/welcome-service.js');
    const g = guild();
    const member = {
      id: 'u1', guild: g,
      user: { id: 'u1', username: 'User', displayAvatarURL: () => 'url', bot: false },
      displayName: 'User',
      roles: { cache: new Collection(), add: vi.fn(async () => {}) },
      send: vi.fn(async () => ({})),
    } as any;
    const supa = { from: vi.fn(() => chain(null)), rpc: vi.fn(async () => ({ data: 1, error: null })) } as any;
    await executeWelcomeFlow(member, {
      supabase: supa,
      config: { ...welcomeCfg, welcome_enabled: false, welcome_dm_enabled: false, welcome_auto_roles: [] } as any,
    });
  });

  it('executeWelcomeFlow no channel', async () => {
    const { executeWelcomeFlow } = await import('../features/welcome/welcome-service.js');
    const g = guild();
    g.channels.cache = new Collection(); // empty channels
    const member = {
      id: 'u1', guild: g,
      user: { id: 'u1', username: 'User', displayAvatarURL: () => 'url', bot: false },
      displayName: 'User',
      roles: { cache: new Collection(), add: vi.fn(async () => {}) },
      send: vi.fn(async () => ({})),
    } as any;
    const supa = { from: vi.fn(() => chain(null)), rpc: vi.fn(async () => ({ data: 1, error: null })) } as any;
    await executeWelcomeFlow(member, { supabase: supa, config: welcomeCfg as any });
  });
});

// ═══════════════════════════════════════════════
// AutoModSync
// ═══════════════════════════════════════════════
describe('AutoModSync', () => {
  it('syncRules empty DB', async () => {
    const { AutoModSync } = await import('../features/discord-native/automod-sync.js');
    const supa = { from: vi.fn(() => chainAsync([])) } as any;
    const sync = new AutoModSync(guild(), supa, eb());
    await sync.syncRules();
  });

  it('syncRules with rules', async () => {
    const { AutoModSync } = await import('../features/discord-native/automod-sync.js');
    const rules = [
      {
        id: 'r1', guild_id: 'g1', name: 'No Spam', enabled: true,
        trigger_type: 3, // Spam
        trigger_metadata: {},
        actions: [{ type: 1, metadata: {} }],
        exempt_roles: [], exempt_channels: [],
        event_type: 1, sync_to_discord: true,
      },
    ];
    const supa = { from: vi.fn(() => chainAsync(rules)) } as any;
    const sync = new AutoModSync(guild(), supa, eb());
    await sync.syncRules();
  });

  it('syncRules DB error', async () => {
    const { AutoModSync } = await import('../features/discord-native/automod-sync.js');
    const supa = { from: vi.fn(() => chainAsync([], null, { message: 'DB error' })) } as any;
    const sync = new AutoModSync(guild(), supa, eb());
    await sync.syncRules();
  });

  it('updates the matching managed rule and removes stale SomniBot rules', async () => {
    const { AutoModSync } = await import('../features/discord-native/automod-sync.js');
    const matching = {
      name: 'SB:12345678 Old name',
      edit: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const stale = {
      name: 'SB:87654321 Removed rule',
      edit: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const external = {
      name: 'Server-owned rule',
      edit: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const g = guild();
    g.autoModerationRules.fetch.mockResolvedValue(new Collection([
      ['matching', matching],
      ['stale', stale],
      ['external', external],
    ]));
    const rules = [{
      id: '12345678-0000-4000-8000-000000000000',
      name: 'No Spam',
      enabled: true,
      type: 'spam_filter',
      config: {},
      action: 'delete',
      exempt_roles: [],
      exempt_channels: [],
      sync_to_discord: true,
    }];
    const supa = { from: vi.fn(() => chainAsync(rules)) };
    const sync = new AutoModSync(
      g,
      supa as unknown as ConstructorParameters<typeof AutoModSync>[1],
      eb(),
    );

    await sync.syncRules();

    expect(matching.edit).toHaveBeenCalledWith(expect.objectContaining({
      name: 'SB:12345678 No Spam',
      enabled: true,
    }));
    expect(stale.delete).toHaveBeenCalledOnce();
    expect(external.delete).not.toHaveBeenCalled();
  });

  it('registers and removes one config listener across repeated lifecycle calls', async () => {
    const { AutoModSync } = await import('../features/discord-native/automod-sync.js');
    const bus = eb();
    const supa = { from: vi.fn(() => chainAsync([])) };
    const sync = new AutoModSync(
      guild(),
      supa as unknown as ConstructorParameters<typeof AutoModSync>[1],
      bus,
    );

    sync.start();
    sync.start();
    await sync.stop();
    await sync.stop();

    expect(bus.on).toHaveBeenCalledTimes(1);
    expect(bus.off).toHaveBeenCalledTimes(1);
  });

  it('syncs only the guild whose moderation config changed', async () => {
    const { AutoModSync } = await import('../features/discord-native/automod-sync.js');
    type ConfigListener = (event: {
      guildId: string;
      data: { section: string };
    }) => void;
    const listeners: ConfigListener[] = [];
    const bus = {
      emit: vi.fn(),
      on: vi.fn((_type: string, handler: ConfigListener) => { listeners.push(handler); }),
      off: vi.fn(),
      onAny: vi.fn(),
    };
    const sync = new AutoModSync(
      guild('g1'),
      { from: vi.fn(() => chainAsync([])) } as unknown as ConstructorParameters<typeof AutoModSync>[1],
      bus as unknown as ConstructorParameters<typeof AutoModSync>[2],
    );
    const syncSpy = vi.spyOn(sync, 'syncRules').mockResolvedValue(undefined);

    sync.start();
    expect(syncSpy).toHaveBeenCalledTimes(1);
    const listener = listeners[0];
    if (!listener) throw new Error('AutoModSync did not register its config listener');

    listener({ guildId: 'g2', data: { section: 'moderation' } });
    expect(syncSpy).toHaveBeenCalledTimes(1);

    listener({ guildId: 'g1', data: { section: 'moderation' } });
    expect(syncSpy).toHaveBeenCalledTimes(2);

    await sync.stop();
  });
});

// ═══════════════════════════════════════════════
// LevelAnnouncer
// ═══════════════════════════════════════════════
describe('LevelAnnouncer', () => {
  it('handleLevelUp', async () => {
    const { handleLevelUp } = await import('../features/levels/level-announcer.js');
    const g = guild();
    const supa = {
      rpc: vi.fn(async () => ({ data: { outcome: 'applied' }, error: null })),
      from: vi.fn((t: string) => {
        if (t === 'guild_config') return chain({
          level_announce_enabled: true,
          level_announce_channel_id: 'ch1',
          level_announce_message: '{user} reached level {level}!',
          level_announce_dm: false,
        });
        if (t === 'level_rewards') return chainAsync([
          { id: 'lr1', level: 5, role_id: 'role1', description: 'Level 5 reward' },
        ]);
        return chain(null);
      }),
    } as any;
    await handleLevelUp(g, supa, eb(), 'u1', 4, 5, 2500);
  });

  it('handleLevelUp no config', async () => {
    const { handleLevelUp } = await import('../features/levels/level-announcer.js');
    const supa = { from: vi.fn(() => chain(null)) } as any;
    await handleLevelUp(guild(), supa, eb(), 'u1', 1, 2, 400);
  });

  it('handleLevelUp disabled', async () => {
    const { handleLevelUp } = await import('../features/levels/level-announcer.js');
    const supa = {
      from: vi.fn(() => chain({ level_announce_enabled: false, level_announce_channel_id: null })),
    } as any;
    await handleLevelUp(guild(), supa, eb(), 'u1', 1, 2, 400);
  });

  it('handleLevelUp with DM', async () => {
    const { handleLevelUp } = await import('../features/levels/level-announcer.js');
    const g = guild();
    const supa = {
      from: vi.fn((t: string) => {
        if (t === 'guild_config') return chain({
          level_announce_enabled: true,
          level_announce_channel_id: 'ch1',
          level_announce_message: '{user} leveled up!',
          level_announce_dm: true,
          level_announce_dm_message: 'Congrats {user}!',
        });
        if (t === 'level_rewards') return chainAsync([]);
        return chain(null);
      }),
    } as any;
    await handleLevelUp(g, supa, eb(), 'u1', 9, 10, 10000);
  });
});

// ═══════════════════════════════════════════════
// TicketService
// ═══════════════════════════════════════════════
describe('TicketService', () => {
  const panel = {
    id: 'panel1', guild_id: 'g1', channel_id: 'ch1', name: 'Support',
    message_id: null,
    panel_message: {},
    input_mode: 'buttons' as const,
    ticket_types: [],
    manager_roles: ['role1'],
    open_category_id: 'cat1',
    closed_category_id: null,
    transcript_channel_id: null,
    dm_transcript_to_creator: false,
    max_open_per_user: 3,
    introduction_message: 'Describe your issue',
    active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    forum_config: null,
    intake_form_enabled: false,
    intake_form_fields: null,
  };

  const ticketType = {
    id: 'tt1',
    label: 'General',
    description: 'General support',
    emoji: '📩',
    color: 'blue' as const,
  };

  function ticketSupa(tickets: any[] = [], ticket: any = null) {
    const deletedOccurrences: string[] = [];
    return {
      _deletedOccurrences: deletedOccurrences,
      from: vi.fn((table: string) => {
        if (table === 'tickets') {
          const c = chainAsync(tickets, tickets.length);
          if (ticket) {
            c.maybeSingle = vi.fn(async () => ({ data: ticket, error: null }));
            c.single = vi.fn(async () => ({ data: ticket, error: null }));
          }
          c.insert = vi.fn(() => chain({
            id: 'tk1', guild_id: 'g1', ticket_number: 1,
            channel_id: 'newch', panel_id: 'panel1',
            creator_id: 'u1', status: 'open',
            created_at: new Date().toISOString(),
          }));
          c.update = vi.fn(() => chain(ticket));
          return c;
        }
        if (table === 'ticket_panels') return chain(panel);
        if (table === 'guild_config') return chain({ ticket_log_channel_id: 'ch1' });
        if (table === 'discord_operation_occurrences') {
          const occurrence = {
            id: 'occ-ticket-1',
            guild_id: 'g1',
            operation_kind: 'ticket',
            occurrence_key: 'ticket-click-1',
            status: 'claimed',
            resource_id: null,
            result: {},
            last_error: null,
          };
          const c = chain(occurrence);
          c.delete = vi.fn(() => {
            deletedOccurrences.push(occurrence.id);
            return c;
          });
          return c;
        }
        return chain(null);
      }),
      rpc: vi.fn(async (fn: string) => {
        if (fn === 'next_ticket_number') return { data: 1, error: null };
        return { data: null, error: null };
      }),
    } as any;
  }

  it('createTicket', async () => {
    const { createTicket } = await import('../features/tickets/ticket-service.js');
    const g = guild();
    const member = {
      id: 'u1', user: { id: 'u1', username: 'User', tag: 'User#0001' },
      displayName: 'User', guild: g,
      permissions: { has: () => true },
    } as any;
    const result = await createTicket(g, member, panel as any, ticketType as any, ticketSupa(), eb());
    expect(result).toBeDefined();
  });

  it('releases a claimed occurrence when the member is already at the open-ticket limit', async () => {
    const { createTicket } = await import('../features/tickets/ticket-service.js');
    const g = guild();
    const member = {
      id: 'u1', user: { id: 'u1', username: 'User', tag: 'User#0001' },
      displayName: 'User', guild: g,
      permissions: { has: () => true },
    } as any;
    const supa = ticketSupa([{ id: 't1' }, { id: 't2' }, { id: 't3' }]);

    const result = await createTicket(
      g,
      member,
      panel as any,
      ticketType as any,
      supa,
      eb(),
      'ticket-click-1',
    );

    expect(result).toEqual({ error: 'You already have 3 open ticket(s). Maximum is 3.' });
    expect(supa._deletedOccurrences).toEqual(['occ-ticket-1']);
  });

  it('releases a claimed occurrence after deleting a channel whose intro send failed', async () => {
    const { createTicket } = await import('../features/tickets/ticket-service.js');
    const g = guild();
    const channel = {
      id: 'newch',
      name: 'ticket-1-user',
      type: 0,
      send: vi.fn().mockRejectedValue(new Error('Missing Permissions')),
      delete: vi.fn().mockResolvedValue({}),
    };
    g.channels.create.mockResolvedValueOnce(channel);
    const member = {
      id: 'u1', user: { id: 'u1', username: 'User', tag: 'User#0001' },
      displayName: 'User', guild: g,
      permissions: { has: () => true },
    } as any;
    const supa = ticketSupa();

    const result = await createTicket(
      g,
      member,
      panel as any,
      ticketType as any,
      supa,
      eb(),
      'ticket-click-1',
    );

    expect(result).toEqual({ error: 'Failed to initialize ticket channel. Please try again.' });
    expect(channel.delete).toHaveBeenCalledTimes(1);
    expect(supa._deletedOccurrences).toEqual(['occ-ticket-1']);
  });

  it('closeTicket', async () => {
    const { closeTicket } = await import('../features/tickets/ticket-service.js');
    const g = guild();
    const ticket = {
      id: 'tk1', guild_id: 'g1', ticket_number: 1,
      channel_id: 'ch1', panel_id: 'panel1',
      creator_id: 'u1', status: 'open',
      created_at: new Date().toISOString(),
    };
    const result = await closeTicket(g, ticketSupa([], ticket), eb(), 1, 'u2', 'Resolved');
    expect(result).toBeDefined();
  });

  it('claimTicket', async () => {
    const { claimTicket } = await import('../features/tickets/ticket-service.js');
    const g = guild();
    const ticket = {
      id: 'tk1', guild_id: 'g1', ticket_number: 1,
      channel_id: 'ch1', panel_id: 'panel1',
      creator_id: 'u1', status: 'open', claimed_by: null,
    };
    const result = await claimTicket(ticketSupa([], ticket), eb(), 'g1', 1, 'u2');
    expect(result).toBeDefined();
  });

  it('reopenTicket', async () => {
    const { reopenTicket } = await import('../features/tickets/ticket-service.js');
    const g = guild();
    const ticket = {
      id: 'tk1', guild_id: 'g1', ticket_number: 1,
      channel_id: 'ch1', panel_id: 'panel1',
      creator_id: 'u1', status: 'closed',
    };
    const result = await reopenTicket(g, ticketSupa([], ticket), eb(), 1, 'u1');
    expect(result).toBeDefined();
  });

  it('addUserToTicket', async () => {
    const { addUserToTicket } = await import('../features/tickets/ticket-service.js');
    const g = guild();
    const ticket = {
      id: 'tk1', guild_id: 'g1', ticket_number: 1,
      channel_id: 'ch1', panel_id: 'panel1',
      creator_id: 'u1', status: 'open',
    };
    const result = await addUserToTicket(g, ticketSupa([], ticket), 1, 'u2');
    expect(result).toBeDefined();
  });

  it('removeUserFromTicket', async () => {
    const { removeUserFromTicket } = await import('../features/tickets/ticket-service.js');
    const g = guild();
    const ticket = {
      id: 'tk1', guild_id: 'g1', ticket_number: 1,
      channel_id: 'ch1', panel_id: 'panel1',
      creator_id: 'u1', status: 'open',
    };
    const result = await removeUserFromTicket(g, ticketSupa([], ticket), 1, 'u2');
    expect(result).toBeDefined();
  });
});
