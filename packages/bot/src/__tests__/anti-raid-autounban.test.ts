/**
 * V5 Audit §8.2: Tests for anti-raid auto-unban flow.
 * Covers trackRaidBan (via processAntiRaid ban action) and
 * processRaidUnbans (via processAntiRaid when raid mode expires).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  SOMNI_PALETTE: { primary: 0x5865F2, success: 0x57F287, error: 0xED4245, warning: 0xFEE75C },
}));
vi.mock('../services/audit.js', () => ({ writeAuditLog: vi.fn(async () => {}) }));

// Valkey mock with configurable smembers response
const mockSmembers = vi.fn(async () => [] as string[]);
const mockSadd = vi.fn(async () => 1);
const mockDel = vi.fn(async () => 1);
const mockPexpire = vi.fn(async () => 1);
const mockGet = vi.fn(async () => null as string | null);
const mockSet = vi.fn(async () => 'OK');
const mockZremrangebyscore = vi.fn().mockReturnThis();
const mockZadd = vi.fn().mockReturnThis();
const mockZcard = vi.fn().mockReturnThis();
const mockPexpirePipe = vi.fn().mockReturnThis();
const mockExec = vi.fn(async () => [[null, 0], [null, 1], [null, 15], [null, 1]]);
const mockPipeline = vi.fn(() => ({
  zremrangebyscore: mockZremrangebyscore,
  zadd: mockZadd,
  zcard: mockZcard,
  pexpire: mockPexpirePipe,
  exec: mockExec,
}));

vi.mock('../services/valkey.js', () => ({
  getValkey: vi.fn(() => ({
    get: mockGet,
    set: mockSet,
    del: mockDel,
    sadd: mockSadd,
    smembers: mockSmembers,
    pexpire: mockPexpire,
    pipeline: mockPipeline,
  })),
  connectValkey: vi.fn(async () => {}),
}));

vi.mock('discord.js', () => {
  class EmbedBuilder {
    data: any = {};
    setColor(c: any) { this.data.color = c; return this; }
    setTitle(t: any) { this.data.title = t; return this; }
    setDescription(d: any) { this.data.description = d; return this; }
    setTimestamp() { return this; }
    setFooter(f: any) { return this; }
  }
  return { EmbedBuilder };
});

function makeGuild(overrides: any = {}) {
  return {
    id: 'g1',
    name: 'TestGuild',
    systemChannel: null,
    channels: { cache: new Map() },
    members: {
      unban: vi.fn(async () => {}),
      cache: new Map(),
    },
    invites: { fetch: vi.fn(async () => new Map()) },
    verificationLevel: 1,
    setVerificationLevel: vi.fn(async () => {}),
    ...overrides,
  } as any;
}

function makeMember(guildObj: any, id: string, accountAgeDays = 1) {
  return {
    id,
    guild: guildObj,
    user: {
      id,
      username: `User${id}`,
      tag: `User${id}#0001`,
      createdTimestamp: Date.now() - accountAgeDays * 86400000,
      bot: false,
    },
    displayName: `User${id}`,
    roles: { cache: new Map() },
    send: vi.fn(async () => {}).mockImplementation(async () => {}),
    kick: vi.fn(async () => {}),
    ban: vi.fn(async () => {}),
    bannable: true,
    kickable: true,
  } as any;
}

const banConfig: {
  anti_raid_enabled: boolean;
  anti_raid_join_threshold: number;
  anti_raid_join_window_seconds: number;
  anti_raid_account_age_days: number;
  anti_raid_action: string;
  anti_raid_auto_unban: boolean;
  anti_raid_ban_delete_seconds: number;
  anti_raid_log_channel_id: string | null;
  mod_log_channel_id: string | null;
} = {
  anti_raid_enabled: true,
  anti_raid_join_threshold: 5,
  anti_raid_join_window_seconds: 10,
  anti_raid_account_age_days: 7,
  anti_raid_action: 'ban',
  anti_raid_auto_unban: true,
  anti_raid_ban_delete_seconds: 86400,
  anti_raid_log_channel_id: null,
  mod_log_channel_id: null,
};

function makeSupa(cfg = banConfig) {
  const chainResult: any = {};
  for (const m of ['select', 'eq', 'neq', 'gt', 'lt', 'in', 'is', 'or', 'order', 'limit', 'range', 'match', 'ilike', 'like', 'filter', 'contains']) {
    chainResult[m] = vi.fn(() => chainResult);
  }
  chainResult.maybeSingle = vi.fn(async () => ({ data: cfg, error: null }));
  chainResult.single = vi.fn(async () => ({ data: cfg, error: null }));
  chainResult.then = undefined;
  return {
    from: vi.fn(() => chainResult),
  } as any;
}

describe('Anti-Raid auto-unban (§8.2)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Default: raid mode NOT active, no pending bans
    mockGet.mockResolvedValue(null);
    mockSmembers.mockResolvedValue([]);
    // Pipeline returns join count below threshold
    mockExec.mockResolvedValue([[null, 0], [null, 1], [null, 2], [null, 1]]);
    // Clear config cache to ensure each test gets its own config
    const { invalidateAntiRaidCache } = await import('../features/anti-raid/index.js');
    invalidateAntiRaidCache();
  });

  it('processAntiRaid calls processRaidUnbans when raid mode expires with ban action', async () => {
    // Setup: raid mode inactive, but there are previously banned users
    mockSmembers.mockResolvedValue(['user1', 'user2', 'user3']);
    const g = makeGuild();
    const member = makeMember(g, 'newUser', 30); // Old account, passes age check

    const { processAntiRaid } = await import('../features/anti-raid/index.js');
    await processAntiRaid(g, member, makeSupa());

    // V5 Audit §8.1: processRaidUnbans now runs via setImmediate (non-blocking).
    // Flush the setImmediate queue so the background work completes before assertions.
    await new Promise((r) => setImmediate(r));
    // Also flush any pending microtasks from the async unban calls
    await vi.waitFor(() => expect(g.members.unban).toHaveBeenCalledTimes(3), { timeout: 1000 });

    // Should have called smembers to check for banned users
    expect(mockSmembers).toHaveBeenCalled();
    // Should have unbanned the 3 users
    expect(g.members.unban).toHaveBeenCalledWith('user1', expect.stringContaining('auto-unbanning'));
    expect(g.members.unban).toHaveBeenCalledWith('user2', expect.stringContaining('auto-unbanning'));
    expect(g.members.unban).toHaveBeenCalledWith('user3', expect.stringContaining('auto-unbanning'));
    // Should have deleted the banned set
    expect(mockDel).toHaveBeenCalled();
  });

  it('processAntiRaid skips processRaidUnbans when action is kick', async () => {
    mockSmembers.mockResolvedValue(['user1']);
    const g = makeGuild();
    const member = makeMember(g, 'newUser', 30);

    const kickConfig = { ...banConfig, anti_raid_action: 'kick' };
    const { processAntiRaid } = await import('../features/anti-raid/index.js');
    await processAntiRaid(g, member, makeSupa(kickConfig));

    // unban should NOT be called (action is kick, not ban)
    expect(g.members.unban).not.toHaveBeenCalled();
  });

  it('processAntiRaid tracks ban when raid is active and action is ban', async () => {
    // Simulate raid mode active
    mockGet.mockResolvedValue(String(Date.now()));
    // Pipeline: join count above threshold
    mockExec.mockResolvedValue([[null, 0], [null, 1], [null, 15], [null, 1]]);

    const g = makeGuild();
    const member = makeMember(g, 'raider1', 30);

    const { processAntiRaid } = await import('../features/anti-raid/index.js');
    const result = await processAntiRaid(g, member, makeSupa());

    expect(result).toBe(true);
    // Should have banned the member
    expect(member.ban).toHaveBeenCalledWith(
      expect.objectContaining({ reason: expect.stringContaining('Anti-raid') })
    );
    // Should have tracked the ban via sadd
    expect(mockSadd).toHaveBeenCalled();
    expect(mockPexpire).toHaveBeenCalled();
  });

  it('processRaidUnbans handles empty banned set gracefully', async () => {
    mockSmembers.mockResolvedValue([]);
    const g = makeGuild();
    const member = makeMember(g, 'newUser', 30);

    const { processAntiRaid } = await import('../features/anti-raid/index.js');
    await processAntiRaid(g, member, makeSupa());

    // No users to unban
    expect(g.members.unban).not.toHaveBeenCalled();
  });

  it('processRaidUnbans tolerates individual unban failures', async () => {
    mockSmembers.mockResolvedValue(['user1', 'user2', 'user3']);
    const g = makeGuild();
    // user2 unban fails (already unbanned)
    let callCount = 0;
    g.members.unban = vi.fn(async (userId: string) => {
      callCount++;
      if (userId === 'user2') throw new Error('Unknown Ban');
    });
    const member = makeMember(g, 'newUser', 30);

    const { processAntiRaid } = await import('../features/anti-raid/index.js');
    await processAntiRaid(g, member, makeSupa());

    // V5 Audit §8.1: Flush setImmediate + wait for async unban calls
    await new Promise((r) => setImmediate(r));
    await vi.waitFor(() => expect(g.members.unban).toHaveBeenCalledTimes(3), { timeout: 1000 });
  });

  it('processRaidUnbans logs to channel when log channel exists', async () => {
    mockSmembers.mockResolvedValue(['user1']);
    const sendFn = vi.fn(async () => {});
    const logChannel = { send: sendFn };
    const g = makeGuild({
      channels: { cache: new Map([['log-ch', logChannel]]) },
    });
    const member = makeMember(g, 'newUser', 30);

    const configWithLog = { ...banConfig, anti_raid_log_channel_id: 'log-ch' };
    const { processAntiRaid } = await import('../features/anti-raid/index.js');
    await processAntiRaid(g, member, makeSupa(configWithLog));

    // V5 Audit §8.1: Flush setImmediate + wait for async unban calls
    await new Promise((r) => setImmediate(r));
    await vi.waitFor(() => expect(g.members.unban).toHaveBeenCalledTimes(1), { timeout: 1000 });

    // Should have logged the auto-unban event
    await vi.waitFor(() => expect(sendFn).toHaveBeenCalled(), { timeout: 1000 });
    expect(sendFn).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: expect.arrayContaining([
          expect.objectContaining({
            data: expect.objectContaining({
              title: expect.stringContaining('Auto-Unban'),
            }),
          }),
        ]),
      })
    );
  });

  it('trackRaidBan falls back to in-memory when Valkey throws', async () => {
    // Make Valkey sadd throw
    mockSadd.mockRejectedValue(new Error('Connection refused'));
    // Raid mode active
    mockGet.mockResolvedValue(String(Date.now()));
    mockExec.mockResolvedValue([[null, 0], [null, 1], [null, 15], [null, 1]]);

    const g = makeGuild();
    const member = makeMember(g, 'raider1', 30);

    const { processAntiRaid } = await import('../features/anti-raid/index.js');
    const result = await processAntiRaid(g, member, makeSupa());

    // Should still succeed (in-memory fallback)
    expect(result).toBe(true);
    expect(member.ban).toHaveBeenCalled();
  });

  it('processRaidUnbans uses in-memory fallback when Valkey smembers throws', async () => {
    // Make smembers throw to trigger in-memory fallback
    mockSmembers.mockRejectedValue(new Error('Connection refused'));

    const g = makeGuild();
    const member = makeMember(g, 'newUser', 30);

    const { processAntiRaid } = await import('../features/anti-raid/index.js');
    // This should still work - falls back to in-memory (which is empty)
    await processAntiRaid(g, member, makeSupa());

    // No crash, no unbans (in-memory set is empty for this guild)
    expect(g.members.unban).not.toHaveBeenCalled();
  });

  it('lockdown skips when bot lacks ManageGuild permission (V5 §8.P2a)', async () => {
    // Trigger raid by setting join count above threshold
    mockExec.mockResolvedValue([[null, 0], [null, 1], [null, 15], [null, 1]]);
    mockGet.mockResolvedValue(null); // no raid lock yet

    const lockdownConfig = { ...banConfig, anti_raid_action: 'lockdown' };
    const g = makeGuild({
      members: {
        me: { permissions: { has: vi.fn(() => false) } }, // lacks ManageGuild
        unban: vi.fn(async () => {}),
        cache: new Map(),
      },
    });
    const member = makeMember(g, 'raider', 30);

    const { processAntiRaid } = await import('../features/anti-raid/index.js');
    const result = await processAntiRaid(g, member, makeSupa(lockdownConfig));

    // Should return true (handled) but NOT set verification level
    expect(result).toBe(true);
    expect(g.setVerificationLevel).not.toHaveBeenCalled();
  });

  it('lockdown succeeds when bot has ManageGuild permission (V5 §8.P2a)', async () => {
    mockExec.mockResolvedValue([[null, 0], [null, 1], [null, 15], [null, 1]]);
    mockGet.mockResolvedValue(null);

    const lockdownConfig = { ...banConfig, anti_raid_action: 'lockdown' };
    const g = makeGuild({
      members: {
        me: { permissions: { has: vi.fn(() => true) } }, // has ManageGuild
        unban: vi.fn(async () => {}),
        cache: new Map(),
      },
      verificationLevel: 1,
    });
    const member = makeMember(g, 'raider', 30);

    const { processAntiRaid } = await import('../features/anti-raid/index.js');
    await processAntiRaid(g, member, makeSupa(lockdownConfig));

    // Lockdown path raises verification level to VERY_HIGH (4)
    expect(g.setVerificationLevel).toHaveBeenCalledWith(4, expect.any(String));
  });

  it('processAntiRaid skips auto-unban when anti_raid_auto_unban is false', async () => {
    // Setup: raid mode inactive, previously banned users exist
    mockSmembers.mockResolvedValue(['user1', 'user2']);
    const g = makeGuild();
    const member = makeMember(g, 'newUser', 30);

    const noUnbanConfig = { ...banConfig, anti_raid_auto_unban: false };
    const { processAntiRaid } = await import('../features/anti-raid/index.js');
    await processAntiRaid(g, member, makeSupa(noUnbanConfig));

    // Flush setImmediate queue
    await new Promise((r) => setImmediate(r));
    // Wait a tick — unban should NOT have been called
    await new Promise((r) => setTimeout(r, 50));

    expect(g.members.unban).not.toHaveBeenCalled();
  });

  it('lockdown stores invite metadata in Valkey before deleting', async () => {
    mockExec.mockResolvedValue([[null, 0], [null, 1], [null, 15], [null, 1]]);
    mockGet.mockResolvedValue(null);

    const lockdownConfig = { ...banConfig, anti_raid_action: 'lockdown' };
    // Create mock invites with metadata
    const mockInvite1 = {
      channelId: 'ch1',
      maxAge: 86400,
      maxUses: 10,
      temporary: false,
      delete: vi.fn(async () => {}),
    };
    const mockInvite2 = {
      channelId: 'ch2',
      maxAge: 0,
      maxUses: 0,
      temporary: true,
      delete: vi.fn(async () => {}),
    };
    const inviteMap = new Map([['inv1', mockInvite1], ['inv2', mockInvite2]]);
    // Make the Map iterable the way discord.js Collection works
    (inviteMap as any).map = function (fn: any) {
      return [...this.values()].map(fn);
    };

    const g = makeGuild({
      members: {
        me: { permissions: { has: vi.fn(() => true) } },
        unban: vi.fn(async () => {}),
        cache: new Map(),
      },
      verificationLevel: 1,
      invites: { fetch: vi.fn(async () => inviteMap) },
    });
    const member = makeMember(g, 'raider', 30);

    const { processAntiRaid } = await import('../features/anti-raid/index.js');
    await processAntiRaid(g, member, makeSupa(lockdownConfig));

    // Should have stored invite metadata in Valkey
    expect(mockSet).toHaveBeenCalledWith(
      'antiraid:invites:g1',
      expect.any(String),
      'PX',
      expect.any(Number),
    );

    // Verify stored data is valid JSON with the right shape
    const storedCall = mockSet.mock.calls.find(
      (c: any[]) => c[0] === 'antiraid:invites:g1',
    );
    expect(storedCall).toBeDefined();
    const parsed = JSON.parse(storedCall![1]);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ channelId: 'ch1', maxAge: 86400, maxUses: 10, temporary: false });
    expect(parsed[1]).toMatchObject({ channelId: 'ch2', maxAge: 0, maxUses: 0, temporary: true });

    // Both invites should have been deleted
    expect(mockInvite1.delete).toHaveBeenCalled();
    expect(mockInvite2.delete).toHaveBeenCalled();
  });

  it('lockdown restore recreates invites from stored metadata', async () => {
    // Simulate: raid mode has expired (raidModeKey returns null),
    // action is lockdown, prevLevel is stored, invites are stored
    mockGet.mockImplementation(async (key: string) => {
      if (key === 'antiraid:raidmode:g1') return null; // raid expired
      if (key === 'antiraid:prevlevel:g1') return '1'; // previous level
      if (key === 'antiraid:invites:g1') {
        return JSON.stringify([
          { channelId: 'ch1', maxAge: 86400, maxUses: 10, temporary: false },
          { channelId: 'ch2', maxAge: 0, maxUses: 0, temporary: true },
        ]);
      }
      return null;
    });
    // Pipeline: below threshold (no new raid)
    mockExec.mockResolvedValue([[null, 0], [null, 1], [null, 2], [null, 1]]);

    const lockdownConfig = { ...banConfig, anti_raid_action: 'lockdown' };
    const createInviteFn = vi.fn(async () => ({}));
    const g = makeGuild({
      channels: {
        cache: new Map([
          ['ch1', { createInvite: createInviteFn }],
          ['ch2', { createInvite: createInviteFn }],
        ]),
      },
      verificationLevel: 4, // currently at VERY_HIGH from lockdown
    });
    const member = makeMember(g, 'normalUser', 30);

    const { processAntiRaid } = await import('../features/anti-raid/index.js');
    await processAntiRaid(g, member, makeSupa(lockdownConfig));

    // Should restore verification level
    expect(g.setVerificationLevel).toHaveBeenCalledWith(1, expect.stringContaining('restoring'));

    // Should recreate both invites
    expect(createInviteFn).toHaveBeenCalledTimes(2);
    expect(createInviteFn).toHaveBeenCalledWith(
      expect.objectContaining({ maxAge: 86400, maxUses: 10, temporary: false }),
    );
    expect(createInviteFn).toHaveBeenCalledWith(
      expect.objectContaining({ maxAge: 0, maxUses: 0, temporary: true }),
    );

    // Should have cleaned up the stored invites key
    expect(mockDel).toHaveBeenCalledWith('antiraid:invites:g1');
  });
});
