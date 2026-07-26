/**
 * observability-gap [moderation-anti-raid]:
 *  - Anti-raid must emit an audit event per detection / containment / restoration.
 *  - Failure branches must persist an owner alert to the `alerts` table.
 *
 * These tests spy the eventBus + the alerts insert and assert the emit/insert fires
 * at each state change / failure branch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockSmembers = vi.fn(async () => [] as string[]);
const mockSadd = vi.fn(async () => 1);
const mockDel = vi.fn(async () => 1);
const mockPexpire = vi.fn(async () => 1);
const mockGet = vi.fn(async () => null as string | null);
const mockSet = vi.fn(async () => 'OK');
const mockExec = vi.fn(async () => [[null, 0], [null, 1], [null, 2], [null, 1]]);
const mockPipeline = vi.fn(() => ({
  zremrangebyscore: vi.fn().mockReturnThis(),
  zadd: vi.fn().mockReturnThis(),
  zcard: vi.fn().mockReturnThis(),
  pexpire: vi.fn().mockReturnThis(),
  exec: mockExec,
}));

vi.mock('../services/valkey.js', () => ({
  getValkey: vi.fn(() => ({
    get: mockGet, set: mockSet, del: mockDel, sadd: mockSadd,
    smembers: mockSmembers, pexpire: mockPexpire, pipeline: mockPipeline,
  })),
  connectValkey: vi.fn(async () => {}),
}));

vi.mock('discord.js', () => {
  class EmbedBuilder {
    data: any = {};
    setColor() { return this; }
    setTitle() { return this; }
    setDescription() { return this; }
    setTimestamp() { return this; }
    setFooter() { return this; }
  }
  return { EmbedBuilder };
});

function makeGuild(overrides: any = {}) {
  return {
    id: 'g1',
    name: 'TestGuild',
    channels: { cache: new Map() },
    members: { unban: vi.fn(async () => {}), cache: new Map() },
    invites: { fetch: vi.fn(async () => new Map()) },
    verificationLevel: 1,
    setVerificationLevel: vi.fn(async () => {}),
    ...overrides,
  } as any;
}

function makeMember(guildObj: any, id: string, accountAgeDays = 30) {
  return {
    id,
    guild: guildObj,
    user: {
      id, username: `User${id}`, tag: `User${id}#0001`,
      createdTimestamp: Date.now() - accountAgeDays * 86400000, bot: false,
    },
    displayName: `User${id}`,
    roles: { cache: new Map() },
    send: vi.fn(async () => {}),
    kick: vi.fn(async () => {}),
    ban: vi.fn(async () => {}),
    bannable: true,
    kickable: true,
  } as any;
}

const baseConfig = {
  anti_raid_enabled: true,
  anti_raid_join_threshold: 5,
  anti_raid_join_window_seconds: 10,
  anti_raid_account_age_days: 7,
  anti_raid_action: 'kick' as string,
  anti_raid_auto_unban: true,
  anti_raid_ban_delete_seconds: 86400,
  anti_raid_log_channel_id: null as string | null,
  mod_log_channel_id: null as string | null,
};

function makeSupa(cfg: any = baseConfig) {
  const alertsInsert = vi.fn(async () => ({ error: null }));
  const chain: any = {};
  for (const m of ['select', 'eq', 'neq', 'gt', 'lt', 'in', 'is', 'or', 'order', 'limit', 'range', 'match']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.maybeSingle = vi.fn(async () => ({ data: cfg, error: null }));
  chain.single = vi.fn(async () => ({ data: cfg, error: null }));
  const supa: any = {
    from: vi.fn((t: string) => (t === 'alerts' ? { insert: alertsInsert } : chain)),
    _alertsInsert: alertsInsert,
  };
  return supa;
}

function makeBus() {
  return { emit: vi.fn() } as any;
}

describe('anti-raid audit observability', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue(null);
    mockSmembers.mockResolvedValue([]);
    mockExec.mockResolvedValue([[null, 0], [null, 1], [null, 2], [null, 1]]);
    const { invalidateAntiRaidCache } = await import('../features/anti-raid/index.js');
    invalidateAntiRaidCache();
  });

  it('emits anti_raid.detected when the join threshold is crossed', async () => {
    // join count above threshold, raid not yet active
    mockExec.mockResolvedValue([[null, 0], [null, 1], [null, 15], [null, 1]]);
    const bus = makeBus();
    const g = makeGuild();
    const member = makeMember(g, 'raider', 30);

    const { processAntiRaid } = await import('../features/anti-raid/index.js');
    await processAntiRaid(g, member, makeSupa(), bus);

    expect(bus.emit).toHaveBeenCalledWith(
      'anti_raid.detected',
      'g1',
      expect.objectContaining({ joinCount: 15, threshold: 5, action: 'kick' }),
    );
  });

  it('emits anti_raid.contained (account_age) when a too-new account is kicked', async () => {
    const bus = makeBus();
    const g = makeGuild();
    const member = makeMember(g, 'newbie', 1); // 1-day-old account < 7-day minimum

    const { processAntiRaid } = await import('../features/anti-raid/index.js');
    await processAntiRaid(g, member, makeSupa(), bus);

    expect(member.kick).toHaveBeenCalled();
    expect(bus.emit).toHaveBeenCalledWith(
      'anti_raid.contained',
      'g1',
      expect.objectContaining({ action: 'account_age', userId: 'newbie' }),
    );
  });

  it('emits anti_raid.contained (ban) during an active raid', async () => {
    mockGet.mockResolvedValue(String(Date.now())); // raid mode active
    mockExec.mockResolvedValue([[null, 0], [null, 1], [null, 15], [null, 1]]);
    const bus = makeBus();
    const g = makeGuild();
    const member = makeMember(g, 'raider', 30);

    const { processAntiRaid } = await import('../features/anti-raid/index.js');
    await processAntiRaid(g, member, makeSupa({ ...baseConfig, anti_raid_action: 'ban' }), bus);

    expect(member.ban).toHaveBeenCalled();
    expect(bus.emit).toHaveBeenCalledWith(
      'anti_raid.contained',
      'g1',
      expect.objectContaining({ action: 'ban', userId: 'raider' }),
    );
  });

  it('emits anti_raid.restored when raid-banned users are auto-unbanned', async () => {
    mockSmembers.mockResolvedValue(['u1', 'u2']);
    const bus = makeBus();
    const g = makeGuild();
    const member = makeMember(g, 'oldUser', 30);

    const { processAntiRaid } = await import('../features/anti-raid/index.js');
    await processAntiRaid(g, member, makeSupa({ ...baseConfig, anti_raid_action: 'ban' }), bus);

    // processRaidUnbans runs via setImmediate — flush it
    await new Promise((r) => setImmediate(r));
    await vi.waitFor(() => expect(g.members.unban).toHaveBeenCalledTimes(2), { timeout: 1000 });

    expect(bus.emit).toHaveBeenCalledWith(
      'anti_raid.restored',
      'g1',
      expect.objectContaining({ restorationType: 'unban', count: 2 }),
    );
  });

  it('persists an owner alert when a containment kick fails', async () => {
    const bus = makeBus();
    const g = makeGuild();
    const member = makeMember(g, 'newbie', 1);
    member.kick.mockRejectedValue(new Error('Missing Permissions'));
    const supa = makeSupa();

    const { processAntiRaid } = await import('../features/anti-raid/index.js');
    await processAntiRaid(g, member, supa, bus);

    expect(supa._alertsInsert).toHaveBeenCalledWith(
      expect.objectContaining({ guild_id: 'g1', alert_type: 'anti_raid_action_failed' }),
    );
    expect(bus.emit).toHaveBeenCalledWith(
      'anti_raid.action_failed',
      'g1',
      expect.objectContaining({ action: 'account_age' }),
    );
  });
});
