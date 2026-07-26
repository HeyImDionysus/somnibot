/**
 * /voice owner-control surface — audit emit tests (#60).
 *
 * Every successful /voice control (lock/unlock/limit/name/permit/deny/ban/
 * claim — all eight) emits ONE temp_channel.settings_changed platform event
 * carrying the op, the optional target/value, and a cheap before/after diff
 * where the prior value is at hand. AuditService maps the event to an
 * audit_logs row (category temp_channels, actorType user). Member-targeted
 * ops (permit/deny/ban/claim) land with the AFFECTED MEMBER as the row's
 * target so purge_member_data's actor/target scrub reaches them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('discord.js', () => {
  class Chainable { [k: string]: any; constructor() { return new Proxy(this, { get: () => () => this }); } }
  return {
    SlashCommandBuilder: Chainable,
    ChannelType: { GuildText: 0, GuildVoice: 2, GuildCategory: 4 },
    PermissionFlagsBits: { ManageChannels: 4n, ViewChannel: 1n, Connect: 256n },
  };
});

import { handleTempChannelCommand } from '../features/temp-channels/commands.js';
import { eventBus } from '../services/event-bus.js';

const HUB = {
  id: 'hub1', guild_id: 'g1', hub_channel_id: 'hubvc', category_id: 'cat1',
  naming_format: '{owner-name}\'s room',
  default_user_limit: 0, default_bitrate: 64000,
  keep_alive_minutes: 1, empty_grace_seconds: 15,
  allow_text_channel: false, allow_claim: true,
  moderator_roles: [] as string[], active: true,
};

function makeVc() {
  return {
    id: 'vc1',
    name: 'Old Room',
    userLimit: 3,
    members: new Map<string, any>(),
    permissionOverwrites: {
      edit: vi.fn(async () => {}),
      create: vi.fn(async () => {}),
    },
    setUserLimit: vi.fn(async () => {}),
    setName: vi.fn(async () => {}),
  };
}

function makeInteraction(sub: string, vc: ReturnType<typeof makeVc>, opts: { count?: number; name?: string } = {}) {
  const channels = new Map<string, any>([['vc1', vc]]);
  const members = new Map<string, any>([
    ['u1', { voice: { channelId: 'vc1' }, roles: { cache: { has: () => false } }, displayName: 'Alice' }],
  ]);
  return {
    reply: vi.fn(async () => {}),
    member: { id: 'u1' },
    user: { id: 'u1', username: 'alice' },
    guild: { id: 'g1', name: 'Guild', members: { cache: members }, channels: { cache: channels } },
    options: {
      getSubcommand: () => sub,
      getInteger: () => opts.count ?? 5,
      getString: () => opts.name ?? 'New Room',
      getUser: () => ({ id: 'target1' }),
    },
    replied: false,
    deferred: false,
  } as any;
}

function ownerManager() {
  return {
    isTempChannel: () => true,
    getChannelOwner: () => 'u1',
    getHubForChannel: () => HUB,
    transferOwnership: vi.fn(async () => {}),
  } as any;
}

describe('/voice controls emit temp_channel.settings_changed', () => {
  let emitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    emitSpy = vi.spyOn(eventBus, 'emit').mockImplementation(() => {});
  });

  afterEach(() => {
    emitSpy.mockRestore();
  });

  function settingsEmits() {
    return emitSpy.mock.calls.filter((c) => c[0] === 'temp_channel.settings_changed');
  }

  it('lock emits op=lock with after.locked=true', async () => {
    const vc = makeVc();
    await handleTempChannelCommand(makeInteraction('lock', vc), ownerManager());
    expect(settingsEmits()).toHaveLength(1);
    expect(settingsEmits()[0][1]).toBe('g1');
    expect(settingsEmits()[0][2]).toMatchObject({
      channelId: 'vc1', actorId: 'u1', op: 'lock', after: { locked: true },
    });
  });

  it('unlock emits op=unlock with after.locked=false', async () => {
    const vc = makeVc();
    await handleTempChannelCommand(makeInteraction('unlock', vc), ownerManager());
    expect(settingsEmits()[0][2]).toMatchObject({ op: 'unlock', after: { locked: false } });
  });

  it('limit emits op=limit with the previous limit as before-state', async () => {
    const vc = makeVc();
    await handleTempChannelCommand(makeInteraction('limit', vc, { count: 7 }), ownerManager());
    expect(settingsEmits()[0][2]).toMatchObject({
      op: 'limit', value: 7, before: { userLimit: 3 }, after: { userLimit: 7 },
    });
  });

  it('name emits op=name with the previous name as before-state', async () => {
    const vc = makeVc();
    await handleTempChannelCommand(makeInteraction('name', vc, { name: 'War Room' }), ownerManager());
    expect(settingsEmits()[0][2]).toMatchObject({
      op: 'name', value: 'War Room', before: { name: 'Old Room' }, after: { name: 'War Room' },
    });
  });

  it('permit emits op=permit with the target user', async () => {
    const vc = makeVc();
    await handleTempChannelCommand(makeInteraction('permit', vc), ownerManager());
    expect(settingsEmits()[0][2]).toMatchObject({
      op: 'permit', targetUserId: 'target1', after: { connect: true },
    });
  });

  it('deny emits op=deny with the target user', async () => {
    const vc = makeVc();
    await handleTempChannelCommand(makeInteraction('deny', vc), ownerManager());
    expect(settingsEmits()[0][2]).toMatchObject({
      op: 'deny', targetUserId: 'target1', after: { connect: false },
    });
  });

  it('ban emits op=ban with the target user', async () => {
    const vc = makeVc();
    await handleTempChannelCommand(makeInteraction('ban', vc), ownerManager());
    expect(settingsEmits()[0][2]).toMatchObject({
      op: 'ban', targetUserId: 'target1', after: { connect: false, viewChannel: false },
    });
  });

  it('claim emits op=claim with the previous owner as target and the ownership diff', async () => {
    const vc = makeVc();
    // Previous owner has left the channel; a different member claims it.
    const mgr = { ...ownerManager(), getChannelOwner: () => 'prev-owner' };
    await handleTempChannelCommand(makeInteraction('claim', vc), mgr);
    expect(mgr.transferOwnership).toHaveBeenCalledWith('vc1', 'u1');
    expect(settingsEmits()).toHaveLength(1);
    expect(settingsEmits()[0][2]).toMatchObject({
      channelId: 'vc1', actorId: 'u1', op: 'claim', targetUserId: 'prev-owner',
      before: { ownerId: 'prev-owner' }, after: { ownerId: 'u1' },
    });
  });

  it('does NOT emit claim when claiming is disabled for the hub', async () => {
    const vc = makeVc();
    const mgr = {
      ...ownerManager(),
      getChannelOwner: () => 'prev-owner',
      getHubForChannel: () => ({ ...HUB, allow_claim: false }),
    };
    await handleTempChannelCommand(makeInteraction('claim', vc), mgr);
    expect(mgr.transferOwnership).not.toHaveBeenCalled();
    expect(settingsEmits()).toHaveLength(0);
  });

  it('does NOT emit claim when the transfer throws', async () => {
    const vc = makeVc();
    const mgr = {
      ...ownerManager(),
      getChannelOwner: () => 'prev-owner',
      transferOwnership: vi.fn(async () => { throw new Error('DB down'); }),
    };
    await handleTempChannelCommand(makeInteraction('claim', vc), mgr);
    expect(settingsEmits()).toHaveLength(0);
  });

  it('does NOT emit when the control is refused (non-owner)', async () => {
    const vc = makeVc();
    const mgr = { ...ownerManager(), getChannelOwner: () => 'someone-else' };
    await handleTempChannelCommand(makeInteraction('lock', vc), mgr);
    expect(settingsEmits()).toHaveLength(0);
  });

  it('does NOT emit when the Discord mutation throws', async () => {
    const vc = makeVc();
    vc.permissionOverwrites.edit = vi.fn(async () => { throw new Error('Missing Permissions'); });
    await handleTempChannelCommand(makeInteraction('lock', vc), ownerManager());
    expect(settingsEmits()).toHaveLength(0);
  });
});

// ── AuditService mapping ────────────────────────────────────

describe('AuditService maps temp_channel.settings_changed', () => {
  function makeSupabase() {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    return { from: vi.fn().mockReturnValue({ upsert }), _upsert: upsert };
  }

  function makeBus() {
    const handlers: Array<(event: any) => void> = [];
    return {
      onAny: (h: (event: any) => void) => handlers.push(h),
      _emit: (event: any) => handlers.forEach((h) => h(event)),
    };
  }

  it('writes a channel-targeted temp_channels row for channel-shaped ops', async () => {
    const { AuditService } = await import('../features/audit/audit-service.js');
    const supabase = makeSupabase();
    const bus = makeBus();
    const service = new AuditService('g1', supabase as any, bus as any);
    service.start();

    bus._emit({
      type: 'temp_channel.settings_changed',
      guildId: 'g1',
      timestamp: Date.now(),
      data: {
        channelId: 'vc1', actorId: 'u1', op: 'name', value: 'War Room',
        before: { name: 'Old' }, after: { name: 'War Room' },
      },
    });
    await (service as any).flush();
    service.stop();

    const batch = supabase._upsert.mock.calls[0][0];
    expect(batch[0]).toMatchObject({
      guild_id: 'g1',
      action: 'temp_channel.settings_changed',
      category: 'temp_channels',
      actor_type: 'user',
      actor_id: 'u1',
      target_type: 'channel',
      target_id: 'vc1',
      details: { op: 'name', value: 'War Room', channelId: 'vc1' },
      before_state: { name: 'Old' },
      after_state: { name: 'War Room' },
      success: true,
    });
  });

  it('member-targeted ops put the AFFECTED MEMBER in target_id (M1 purge shaping)', async () => {
    const { AuditService } = await import('../features/audit/audit-service.js');
    const supabase = makeSupabase();
    const bus = makeBus();
    const service = new AuditService('g1', supabase as any, bus as any);
    service.start();

    bus._emit({
      type: 'temp_channel.settings_changed',
      guildId: 'g1',
      timestamp: Date.now(),
      data: {
        channelId: 'vc1', actorId: 'u1', op: 'ban', targetUserId: 'victim1',
        after: { connect: false, viewChannel: false },
      },
    });
    await (service as any).flush();
    service.stop();

    const batch = supabase._upsert.mock.calls[0][0];
    // purge_member_data scrubs rows WHERE actor_id = member OR target_id =
    // member — the banned member's id must live in target_id, and the channel
    // id moves into details so no member snowflake hides outside the scrub.
    expect(batch[0]).toMatchObject({
      action: 'temp_channel.settings_changed',
      actor_id: 'u1',
      target_type: 'member',
      target_id: 'victim1',
      details: { op: 'ban', channelId: 'vc1' },
    });
    expect(batch[0].details).not.toHaveProperty('targetUserId');
  });

  it('maps op=claim with the previous owner as the member target', async () => {
    const { AuditService } = await import('../features/audit/audit-service.js');
    const supabase = makeSupabase();
    const bus = makeBus();
    const service = new AuditService('g1', supabase as any, bus as any);
    service.start();

    bus._emit({
      type: 'temp_channel.settings_changed',
      guildId: 'g1',
      timestamp: Date.now(),
      data: {
        channelId: 'vc1', actorId: 'claimer1', op: 'claim', targetUserId: 'prev-owner',
        before: { ownerId: 'prev-owner' }, after: { ownerId: 'claimer1' },
      },
    });
    await (service as any).flush();
    service.stop();

    const batch = supabase._upsert.mock.calls[0][0];
    expect(batch[0]).toMatchObject({
      category: 'temp_channels',
      actor_id: 'claimer1',
      target_type: 'member',
      target_id: 'prev-owner',
      before_state: { ownerId: 'prev-owner' },
      after_state: { ownerId: 'claimer1' },
    });
  });
});
