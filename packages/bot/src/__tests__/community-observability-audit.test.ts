/**
 * Observability-gap coverage for the `community` domain family.
 *
 * Each block asserts that the feature emits its append-only audit event (spying
 * the eventBus) at the relevant state change / failure branch, and — where the
 * catalog contracts an owner alert — that a row is written to the `alerts` table.
 * These events are mapped to audit_logs rows by the AuditService integrator.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  }),
  calculateLevel: (xp: number) => Math.floor(Math.sqrt(Math.max(0, xp) / 100)),
  randomXp: (min: number) => min,
  totalXpForLevel: (l: number) => l * 100,
  LEVEL_CONFIG: {
    DEFAULT_MIN_XP: 15, DEFAULT_MAX_XP: 25, DEFAULT_COOLDOWN_SECONDS: 60,
    DEFAULT_VOICE_XP_PER_INTERVAL: 5, DEFAULT_VOICE_INTERVAL_MINUTES: 1,
    XP_FORMULA: (l: number) => l * 100,
  },
}));

vi.mock('discord.js', () => {
  class Chainable { [k: string]: any; constructor() { return new Proxy(this, { get: () => () => this }); } }
  return {
    EmbedBuilder: class { data: any = {};
      setColor() { return this; } setTitle() { return this; } setDescription() { return this; }
      addFields() { return this; } setFooter() { return this; } setTimestamp() { return this; }
      setAuthor() { return this; } setThumbnail() { return this; } setImage() { return this; } },
    ActionRowBuilder: class { addComponents() { return this; } },
    ButtonBuilder: class { setCustomId() { return this; } setLabel() { return this; } setStyle() { return this; } setEmoji() { return this; } setDisabled() { return this; } },
    SlashCommandBuilder: Chainable,
    ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4 },
    ChannelType: { GuildText: 0, GuildVoice: 2, GuildCategory: 4 },
    PermissionFlagsBits: { ManageGuild: 32n, ManageChannels: 16n, MoveMembers: 1n, MuteMembers: 2n, DeafenMembers: 4n, ViewChannel: 8n, SendMessages: 64n, ManageMessages: 128n, Connect: 256n },
  };
});

vi.mock('../services/audit.js', () => ({ writeAuditLog: vi.fn(async () => {}) }));
vi.mock('../features/quests/quests-manager.js', () => ({ getQuestsManager: () => null }));

// ── Shared test doubles ─────────────────────────────────────

function chain(result: any) {
  const c: any = {};
  for (const m of ['select', 'insert', 'update', 'delete', 'upsert', 'eq', 'neq', 'gt', 'gte',
    'lt', 'lte', 'in', 'is', 'not', 'order', 'limit', 'match', 'contains', 'or', 'filter', 'range']) {
    c[m] = vi.fn(() => c);
  }
  c.single = vi.fn(() => Promise.resolve(result));
  c.maybeSingle = vi.fn(() => Promise.resolve(result));
  c.then = (resolve: (v: any) => any) => resolve(result);
  return c;
}

function makeSupa(tables: Record<string, any> = {}, rpc?: any) {
  return {
    from: vi.fn((t: string) => chain(tables[t] ?? { data: null, error: null })),
    rpc: rpc ?? vi.fn(async () => ({ data: null, error: null })),
  } as any;
}

const bus = () => ({ emit: vi.fn() }) as any;

// ── community-giveaways ─────────────────────────────────────

describe('community-giveaways audit', () => {
  it('emits giveaway.paused on pause', async () => {
    const { GiveawayManager } = await import('../features/giveaways/giveaway-manager.js');
    const eventBus = bus();
    const supa = makeSupa({
      giveaways: { data: { id: 'gw1', guild_id: 'g1', status: 'active', prize: 'Prize', message_id: null }, error: null },
    });
    const guild: any = { id: 'g1', channels: { cache: new Map() } };
    const mgr = new GiveawayManager(guild, supa, {} as any, eventBus);

    await mgr.pauseGiveaway('gw1', 'mod1');

    expect(eventBus.emit).toHaveBeenCalledWith('giveaway.paused', 'g1',
      expect.objectContaining({ giveawayId: 'gw1', actorId: 'mod1' }));
  });

  it('emits giveaway.failed and writes an owner alert when create fails', async () => {
    const { GiveawayManager } = await import('../features/giveaways/giveaway-manager.js');
    const eventBus = bus();
    const supa = makeSupa({
      giveaways: { data: null, error: { message: 'boom' } },
      guild_config: { data: null, error: null },
    });
    const guild: any = { id: 'g1', channels: { cache: new Map() } };
    const mgr = new GiveawayManager(guild, supa, {} as any, eventBus);

    const result = await mgr.create({ channelId: 'ch1', prize: 'Prize', winnerCount: 1, durationMs: 1000, creatorId: 'c1' });

    expect(result).toBeNull();
    expect(eventBus.emit).toHaveBeenCalledWith('giveaway.failed', 'g1',
      expect.objectContaining({ stage: 'create' }));
    expect(supa.from).toHaveBeenCalledWith('alerts');
  });
});

// ── community-levels ────────────────────────────────────────

describe('community-levels audit', () => {
  it('emits xp.admin_adjusted on a successful /xp add', async () => {
    const { handleXpAdminCommand } = await import('../features/levels/admin-commands.js');
    const eventBus = bus();
    const client: any = {
      supabase: makeSupa({}, vi.fn(async () => ({ data: { new_xp: 100, new_level: 2 }, error: null }))),
      eventBus,
    };
    const interaction: any = {
      deferReply: vi.fn(async () => {}),
      editReply: vi.fn(async () => {}),
      guildId: 'g1',
      user: { id: 'mod1' },
      memberPermissions: { has: () => true },
      options: {
        getSubcommand: () => 'add',
        getUser: () => ({ id: 'target1' }),
        getInteger: () => 50,
      },
    };

    await handleXpAdminCommand(interaction, client);

    expect(eventBus.emit).toHaveBeenCalledWith('xp.admin_adjusted', 'g1',
      expect.objectContaining({ operation: 'add', actorId: 'mod1', targetId: 'target1', newXp: 100, newLevel: 2 }));
  });
});

// ── community-profiles ──────────────────────────────────────

describe('community-profiles audit', () => {
  it('emits profile.updated on /title save', async () => {
    const { ProfilesManager } = await import('../features/profiles/profiles-manager.js');
    const eventBus = bus();
    const supa = makeSupa({
      guild_config: { data: { profiles_enabled: true, title_max_length: 64, content_filter_mode: 'lenient' }, error: null },
      economy_profiles: { data: { user_id: 'u1' }, error: null },
    });
    const mgr = new ProfilesManager(supa, eventBus);
    const interaction: any = {
      id: 'int1',
      guildId: 'g1',
      user: { id: 'u1' },
      reply: vi.fn(async () => {}),
      options: { getString: (k: string) => (k === 'title' ? 'My Title' : null) },
    };

    await mgr.setTitle(interaction);

    expect(eventBus.emit).toHaveBeenCalledWith('profile.updated', 'g1',
      expect.objectContaining({ field: 'title', value: 'My Title', userId: 'u1' }));
  });
});

// ── community-starboard ─────────────────────────────────────

describe('community-starboard audit', () => {
  function starboardReaction() {
    return {
      partial: false,
      count: 5,
      emoji: { name: '⭐', id: null, toString: () => '⭐' },
      users: { fetch: vi.fn(async () => ({ has: () => false })) },
      message: {
        partial: false,
        id: 'm1',
        url: 'https://discord/msg',
        content: 'hello',
        createdAt: new Date(),
        author: { id: 'author1', tag: 'A#1', displayAvatarURL: () => 'avatar' },
        channel: { id: 'src1' },
        attachments: { find: () => undefined },
      },
    } as any;
  }

  it('emits starboard.post_created when a message crosses the threshold', async () => {
    const { handleStarboardReaction } = await import('../features/starboard/index.js');
    const eventBus = bus();
    const sbChannel = { messages: { fetch: vi.fn() }, send: vi.fn(async () => ({ id: 'sbmsg1' })) };
    const reaction = starboardReaction();
    reaction.message.guild = { id: 'g1', channels: { cache: new Map([['sb1', sbChannel]]) } };
    const supa = makeSupa({
      guild_config: { data: { starboard_enabled: true, starboard_channel_id: 'sb1', starboard_threshold: 3, starboard_emoji: '⭐', starboard_self_star: false }, error: null },
      starboard_entries: { data: null, error: null },
    });

    await handleStarboardReaction(reaction, { id: 'u1', bot: false } as any, supa, 'g1', eventBus);

    expect(eventBus.emit).toHaveBeenCalledWith('starboard.post_created', 'g1',
      expect.objectContaining({ sourceMessageId: 'm1', starboardMessageId: 'sbmsg1' }));
  });

  it('writes an owner alert when the starboard channel is missing', async () => {
    const { handleStarboardReaction } = await import('../features/starboard/index.js');
    const eventBus = bus();
    const reaction = starboardReaction();
    reaction.message.guild = { id: 'g1', channels: { cache: new Map() } }; // channel gone
    const supa = makeSupa({
      guild_config: { data: { starboard_enabled: true, starboard_channel_id: 'sb1', starboard_threshold: 3, starboard_emoji: '⭐', starboard_self_star: false }, error: null },
      alerts: { data: null, error: null },
    });

    await handleStarboardReaction(reaction, { id: 'u1', bot: false } as any, supa, 'g1', eventBus);

    expect(supa.from).toHaveBeenCalledWith('alerts');
  });
});

// ── community-statistics-channels ───────────────────────────

describe('community-statistics-channels audit', () => {
  it('emits stats_channel.updated when a counter value changes', async () => {
    const { StatsChannelManager } = await import('../features/stats-channels/stats-manager.js');
    const eventBus = bus();
    const cfg = {
      id: 'sc1', guild_id: 'g1', channel_id: 'vc1', stat_type: 'custom_counter',
      stat_config: { value: '42' }, name_format: 'Count: {value}', active: true, last_value: 'old',
    };
    const vc = { setName: vi.fn(async () => {}) };
    const guild: any = {
      id: 'g1', name: 'Test', memberCount: 10, premiumSubscriptionCount: 0,
      members: { fetch: vi.fn(async () => {}), cache: { filter: () => ({ size: 0 }) } },
      roles: { cache: new Map([['r', {}]]) },
      channels: { cache: new Map([['vc1', vc]]) },
    };
    const supa = makeSupa({
      stats_channels: { data: [cfg], error: null },
      tickets: { count: 0, data: null, error: null },
      member_levels: { data: null, error: null },
    });
    const mgr = new StatsChannelManager(guild, supa, 10, eventBus);

    await mgr.reload();

    expect(eventBus.emit).toHaveBeenCalledWith('stats_channel.updated', 'g1',
      expect.objectContaining({ statChannelId: 'sc1', value: '42', created: false }));
  });

  it('emits an update failure and writes an owner alert when Discord rejects a rename', async () => {
    const { StatsChannelManager } = await import('../features/stats-channels/stats-manager.js');
    const eventBus = bus();
    const cfg = {
      id: 'sc-fail', guild_id: 'g1', channel_id: 'vc1', stat_type: 'custom_counter',
      stat_config: { value: 42 }, name_format: 'Members: {value}', active: true, last_value: null,
    };
    const supa = makeSupa({ stats_channels: { data: [cfg], error: null } });
    const channel = { setName: vi.fn(async () => { throw new Error('Missing Permissions'); }) };
    const guild: any = {
      id: 'g1', memberCount: 5, premiumSubscriptionCount: 0,
      channels: { cache: new Map([['vc1', channel]]) },
      roles: { cache: new Map() },
      members: { fetch: vi.fn(async () => {}), cache: { filter: () => ({ size: 0 }) } },
    };
    const mgr = new StatsChannelManager(guild, supa, 10, eventBus);

    await mgr.reload();

    expect(eventBus.emit).toHaveBeenCalledWith(
      'stats_channel.update_failed',
      'g1',
      expect.objectContaining({ statChannelId: 'sc-fail', error: 'Missing Permissions' }),
    );
    expect(supa.from).toHaveBeenCalledWith('alerts');
  });

  it('does not resolve recovery alerts when the updated value is not durable', async () => {
    const { StatsChannelManager } = await import('../features/stats-channels/stats-manager.js');
    const eventBus = bus();
    const cfg = {
      id: 'sc-write-fail', guild_id: 'g1', channel_id: 'vc1', stat_type: 'custom_counter',
      stat_config: { value: 42 }, name_format: 'Members: {value}', active: true, last_value: null,
    };
    let statsCalls = 0;
    const supa = {
      from: vi.fn((table: string) => {
        if (table === 'stats_channels') {
          statsCalls += 1;
          return chain(statsCalls === 1
            ? { data: [cfg], error: null }
            : { data: null, error: { message: 'write unavailable' } });
        }
        return chain({ data: null, error: null });
      }),
    } as any;
    const channel = { setName: vi.fn(async () => {}) };
    const guild: any = {
      id: 'g1', memberCount: 5, premiumSubscriptionCount: 0,
      channels: { cache: new Map([['vc1', channel]]) },
      roles: { cache: new Map() },
      members: { fetch: vi.fn(async () => {}), cache: { filter: () => ({ size: 0 }) } },
    };
    const mgr = new StatsChannelManager(guild, supa, 10, eventBus);
    const resolveUpdateAlerts = vi.spyOn(mgr as any, 'resolveUpdateAlerts');

    await mgr.reload();

    expect(resolveUpdateAlerts).not.toHaveBeenCalled();
    expect(eventBus.emit).toHaveBeenCalledWith(
      'stats_channel.update_failed',
      'g1',
      expect.objectContaining({ statChannelId: 'sc-write-fail' }),
    );
    expect(eventBus.emit).not.toHaveBeenCalledWith(
      'stats_channel.updated',
      expect.anything(),
      expect.anything(),
    );
  });

  it('emits a persistent stats failure only on the degraded transition', async () => {
    const { StatsChannelManager } = await import('../features/stats-channels/stats-manager.js');
    const eventBus = bus();
    const cfg = {
      id: 'sc-fail', guild_id: 'g1', channel_id: 'vc1', stat_type: 'custom_counter',
      stat_config: { value: 42 }, name_format: 'Members: {value}', active: true, last_value: null,
    };
    const supa = makeSupa({ stats_channels: { data: [cfg], error: null } });
    const channel = { setName: vi.fn(async () => { throw new Error('Missing Permissions'); }) };
    const guild: any = {
      id: 'g1', memberCount: 5, premiumSubscriptionCount: 0,
      channels: { cache: new Map([['vc1', channel]]) },
      roles: { cache: new Map() },
      members: { fetch: vi.fn(async () => {}), cache: { filter: () => ({ size: 0 }) } },
    };
    const mgr = new StatsChannelManager(guild, supa, 10, eventBus);

    await mgr.reload();
    await mgr.reload();

    const failures = eventBus.emit.mock.calls.filter(
      (call: unknown[]) => call[0] === 'stats_channel.update_failed',
    );
    expect(failures).toHaveLength(1);
  });

  it('retries an undelivered stats owner alert without duplicating the transition event', async () => {
    const { StatsChannelManager } = await import('../features/stats-channels/stats-manager.js');
    const eventBus = bus();
    const cfg = {
      id: 'sc-fail', guild_id: 'g1', channel_id: 'vc1', stat_type: 'custom_counter',
      stat_config: { value: 42 }, name_format: 'Members: {value}', active: true, last_value: null,
    };
    const supa = makeSupa({
      stats_channels: { data: [cfg], error: null },
      alerts: { data: null, error: { message: 'alerts unavailable' } },
      guild_config: { data: null, error: null },
    });
    const channel = { setName: vi.fn(async () => { throw new Error('Missing Permissions'); }) };
    const guild: any = {
      id: 'g1', memberCount: 5, premiumSubscriptionCount: 0,
      channels: { cache: new Map([['vc1', channel]]) },
      roles: { cache: new Map() },
      members: { fetch: vi.fn(async () => {}), cache: { filter: () => ({ size: 0 }) } },
    };
    const mgr = new StatsChannelManager(guild, supa, 10, eventBus);

    await mgr.reload();
    await mgr.reload();

    expect(supa.from.mock.calls.filter((call: unknown[]) => call[0] === 'alerts')).toHaveLength(2);
    expect(eventBus.emit.mock.calls.filter(
      (call: unknown[]) => call[0] === 'stats_channel.update_failed',
    )).toHaveLength(1);
  });

  it('does not classify alert-recovery failure as a counter update failure', async () => {
    const { StatsChannelManager } = await import('../features/stats-channels/stats-manager.js');
    const eventBus = bus();
    const cfg = {
      id: 'sc-ok', guild_id: 'g1', channel_id: 'vc1', stat_type: 'custom_counter',
      stat_config: { value: 42 }, name_format: 'Members: {value}', active: true, last_value: null,
    };
    const supa = makeSupa({ stats_channels: { data: [cfg], error: null } });
    const channel = { setName: vi.fn(async () => {}) };
    const guild: any = {
      id: 'g1', memberCount: 5, premiumSubscriptionCount: 0,
      channels: { cache: new Map([['vc1', channel]]) },
      roles: { cache: new Map() },
      members: { fetch: vi.fn(async () => {}), cache: { filter: () => ({ size: 0 }) } },
    };
    const mgr = new StatsChannelManager(guild, supa, 10, eventBus);
    (mgr as any).resolveUpdateAlerts = vi.fn().mockRejectedValue(new Error('alerts unavailable'));

    await mgr.reload();

    expect(eventBus.emit).not.toHaveBeenCalledWith(
      'stats_channel.update_failed',
      expect.anything(),
      expect.anything(),
    );
  });
});

// ── community-temporary-channels ────────────────────────────

describe('community-temporary-channels audit', () => {
  it('emits temp_channel.orphan_reconciled for a stale record on start', async () => {
    const { TempChannelManager } = await import('../features/temp-channels/temp-channel-manager.js');
    const eventBus = bus();
    const supa = makeSupa({
      temp_channel_hubs: { data: [], error: null },
      active_temp_channels: { data: [{ channel_id: 'tc1', owner_id: 'o1', guild_id: 'g1', hub_id: 'h1', text_channel_id: null }], error: null },
    }, vi.fn(async () => ({ data: true, error: null })));
    const guild: any = { id: 'g1', channels: { cache: new Map() } }; // tc1 no longer exists
    const mgr = new TempChannelManager(guild, supa, eventBus);

    await mgr.start();

    expect(eventBus.emit).toHaveBeenCalledWith('temp_channel.orphan_reconciled', 'g1',
      expect.objectContaining({ channelId: 'tc1', ownerId: 'o1' }));
  });
});

// ── community-reaction-roles ────────────────────────────────

describe('community-reaction-roles audit', () => {
  it('emits role.gained when a button role is added', async () => {
    const { handleButtonRoleInteraction } = await import('../features/reaction-roles/button-roles.js');
    const eventBus = bus();
    const supa = makeSupa({
      button_roles: { data: { active: true, exclusive_group: null, require_role: null, require_level: null }, error: null },
    });
    const member = { id: 'u1', roles: { cache: { has: () => false }, add: vi.fn(async () => {}), remove: vi.fn(async () => {}) } };
    const interaction: any = {
      customId: 'btnrole:panel1:role1',
      user: { id: 'u1' },
      reply: vi.fn(async () => {}),
      guild: { id: 'g1', members: { fetch: vi.fn(async () => member) }, roles: { cache: new Map() } },
    };

    await handleButtonRoleInteraction(interaction, supa, eventBus);

    expect(eventBus.emit).toHaveBeenCalledWith('role.gained', 'g1',
      expect.objectContaining({ roleId: 'role1', discordId: 'u1', source: 'bot' }));
  });
});

// ── community-scheduled-messages ────────────────────────────

describe('community-scheduled-messages audit', () => {
  it('emits scheduled_message.sent after a successful delivery', async () => {
    const { ScheduledMessageRunner } = await import('../features/scheduled-messages/runner.js');
    const eventBus = bus();
    const channel = { isTextBased: () => true, name: 'general', send: vi.fn(async () => ({ id: 'm1' })) };
    const guild: any = { id: 'g1', name: 'Test', memberCount: 5, channels: { cache: new Map([['ch1', channel]]) } };
    const supa = makeSupa({
      scheduled_messages: { data: [{ id: 's1' }], error: null },
      discord_operation_occurrences: {
        data: {
          id: 'occ1', guild_id: 'g1', operation_kind: 'scheduled_message',
          occurrence_key: 's1:due', status: 'claimed', resource_id: null, result: {}, last_error: null,
        },
        error: null,
      },
    }, vi.fn(async () => ({ data: 1, error: null })));
    const runner = new ScheduledMessageRunner(guild, supa, eventBus);

    await (runner as any).sendMessage({
      id: 's1', guild_id: 'g1', name: 'Daily', channel_id: 'ch1', message: 'hi',
      embed_config_id: null, current_sends: 0,
    }, new Date('2026-07-30T12:00:00.000Z'));

    expect(eventBus.emit).toHaveBeenCalledWith('scheduled_message.sent', 'g1',
      expect.objectContaining({ scheduleId: 's1', name: 'Daily' }));
  });

  it('emits scheduled_message.delivery_failed and writes an owner alert on failure', async () => {
    const { ScheduledMessageRunner } = await import('../features/scheduled-messages/runner.js');
    const eventBus = bus();
    const guild: any = { id: 'g1', channels: { cache: new Map() } };
    const supa = makeSupa({ scheduled_messages: { data: [{ id: 's1' }], error: null }, alerts: { data: null, error: null } });
    const runner = new ScheduledMessageRunner(guild, supa, eventBus);

    await (runner as any).markFailed(
      { id: 's1', guild_id: 'g1', name: 'Daily', channel_id: 'ch1' },
      'channel_missing:ch1',
    );

    expect(eventBus.emit).toHaveBeenCalledWith('scheduled_message.delivery_failed', 'g1',
      expect.objectContaining({ scheduleId: 's1', reason: 'channel_missing:ch1' }));
    expect(supa.from).toHaveBeenCalledWith('alerts');
  });
});

// ── community-polls-predictions ─────────────────────────────

describe('community-polls-predictions audit', () => {
  it('emits poll.created when a poll is created', async () => {
    const { PollsManager } = await import('../features/polls/polls-manager.js');
    const eventBus = bus();
    const supa = makeSupa({
      guild_config: { data: { polls_enabled: true }, error: null },
      polls: { data: { id: 'p1' }, error: null },
      poll_options: { data: [{ id: 'o1', label: 'A' }, { id: 'o2', label: 'B' }], error: null },
    });
    const mgr = new PollsManager(supa, eventBus);
    const interaction: any = {
      guildId: 'g1', channelId: 'ch1', user: { id: 'u1' },
      reply: vi.fn(async () => {}), fetchReply: vi.fn(async () => ({ id: 'msg1' })),
    };

    await mgr.createPoll(interaction, 'My Poll', ['A', 'B'], false);

    expect(eventBus.emit).toHaveBeenCalledWith('poll.created', 'g1',
      expect.objectContaining({ pollId: 'p1', title: 'My Poll', optionCount: 2, allowMultiple: false }));
  });
});
