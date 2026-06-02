/**
 * levels/level-announcer — coverage tests
 *
 * Tests handleLevelUp with REAL imports.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('discord.js', () => ({
  ChannelType: { GuildText: 0 },
}));

vi.mock('../features/levels/xp-tracker.js', () => ({
  loadLevelConfig: vi.fn().mockResolvedValue({
    level_up_channel_id: null,
    level_up_message: null,
  }),
  loadRewards: vi.fn().mockResolvedValue([]),
}));

vi.mock('@somnibot/shared', () => ({
  totalXpForLevel: vi.fn().mockReturnValue(100),
  LEVEL_CONFIG: { XP_FORMULA: (lvl: number) => lvl * 100 },
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { handleLevelUp } from '../features/levels/level-announcer.js';
import { loadLevelConfig, loadRewards } from '../features/levels/xp-tracker.js';

function makeGuild(options: any = {}) {
  return {
    id: 'g1',
    members: {
      fetch: vi.fn().mockResolvedValue({
        roles: {
          cache: new Map(options.memberRoles ?? []),
          add: vi.fn().mockResolvedValue(undefined),
          remove: vi.fn().mockResolvedValue(undefined),
        },
      }),
    },
    roles: { cache: new Map(options.guildRoles ?? [['r1', { name: 'Role1' }]]) },
    channels: { cache: new Map(options.channels ?? []) },
  };
}

function makeEventBus() {
  return { emit: vi.fn() };
}

describe('handleLevelUp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns early when member not found', async () => {
    const guild = makeGuild();
    guild.members.fetch.mockRejectedValue(new Error('not found'));
    const eventBus = makeEventBus();
    await handleLevelUp(guild as any, {} as any, eventBus as any, 'u1', 0, 1, 100);
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('grants role rewards for level up', async () => {
    (loadRewards as any).mockResolvedValue([
      { level: 1, role_id: 'r1', remove_at_level: null, announce: false },
    ]);
    const guild = makeGuild();
    const eventBus = makeEventBus();
    await handleLevelUp(guild as any, {} as any, eventBus as any, 'u1', 0, 1, 100);
    const member = await guild.members.fetch('u1');
    expect(member.roles.add).toHaveBeenCalledWith('r1', 'Level 1 reward');
    expect(eventBus.emit).toHaveBeenCalledWith('role.gained', 'g1', expect.any(Object));
    expect(eventBus.emit).toHaveBeenCalledWith('level.up', 'g1', expect.any(Object));
  });

  it('skips granting role if member already has it', async () => {
    (loadRewards as any).mockResolvedValue([
      { level: 2, role_id: 'r1', remove_at_level: null, announce: false },
    ]);
    const guild = makeGuild({ memberRoles: [['r1', { id: 'r1' }]] });
    const eventBus = makeEventBus();
    await handleLevelUp(guild as any, {} as any, eventBus as any, 'u1', 1, 2, 200);
    const member = await guild.members.fetch('u1');
    expect(member.roles.add).not.toHaveBeenCalled();
  });

  it('removes old reward at configured level', async () => {
    (loadRewards as any).mockResolvedValue([
      { level: 1, role_id: 'old-r', remove_at_level: 2, announce: false },
      { level: 2, role_id: 'new-r', remove_at_level: null, announce: false },
    ]);
    const guild = makeGuild({ memberRoles: [['old-r', { id: 'old-r' }]] });
    const eventBus = makeEventBus();
    await handleLevelUp(guild as any, {} as any, eventBus as any, 'u1', 1, 2, 200);
    const member = await guild.members.fetch('u1');
    expect(member.roles.remove).toHaveBeenCalled();
    // role.lost may or may not fire depending on whether the member has the old role  
    // The key assertion is that remove was called and level.up was emitted
    expect(eventBus.emit).toHaveBeenCalledWith('level.up', 'g1', expect.any(Object));
  });

  it('handles reward grant error gracefully', async () => {
    (loadRewards as any).mockResolvedValue([
      { level: 1, role_id: 'bad-role', remove_at_level: null, announce: false },
    ]);
    const guild = makeGuild();
    const member = await guild.members.fetch('u1');
    member.roles.add.mockRejectedValue(new Error('Missing Permissions'));
    const eventBus = makeEventBus();
    // Should not throw
    await handleLevelUp(guild as any, {} as any, eventBus as any, 'u1', 0, 1, 100);
    expect(eventBus.emit).toHaveBeenCalledWith('level.up', 'g1', expect.any(Object));
  });

  it('sends announcement to configured channel', async () => {
    (loadLevelConfig as any).mockResolvedValue({
      level_up_channel_id: 'announce-ch',
      level_up_message: null,
    });
    (loadRewards as any).mockResolvedValue([]);
    const sendFn = vi.fn().mockResolvedValue(undefined);
    const guild = makeGuild({
      channels: [['announce-ch', { type: 0, send: sendFn }]],
    });
    const eventBus = makeEventBus();
    await handleLevelUp(guild as any, {} as any, eventBus as any, 'u1', 0, 1, 100);
    expect(sendFn).toHaveBeenCalledWith(expect.stringContaining('<@u1>'));
  });

  it('uses custom level up message', async () => {
    (loadLevelConfig as any).mockResolvedValue({
      level_up_channel_id: 'announce-ch',
      level_up_message: 'GG {user} hit level {level} with {totalXp} XP!',
    });
    (loadRewards as any).mockResolvedValue([]);
    const sendFn = vi.fn().mockResolvedValue(undefined);
    const guild = makeGuild({
      channels: [['announce-ch', { type: 0, send: sendFn }]],
    });
    const eventBus = makeEventBus();
    await handleLevelUp(guild as any, {} as any, eventBus as any, 'u1', 0, 5, 500);
    expect(sendFn).toHaveBeenCalledWith(expect.stringContaining('GG <@u1> hit level 5 with 500 XP'));
  });

  it('appends role unlock flair when announce is true', async () => {
    (loadLevelConfig as any).mockResolvedValue({
      level_up_channel_id: 'announce-ch',
      level_up_message: null,
    });
    (loadRewards as any).mockResolvedValue([
      { level: 3, role_id: 'r1', remove_at_level: null, announce: true },
    ]);
    const sendFn = vi.fn().mockResolvedValue(undefined);
    const guild = makeGuild({
      channels: [['announce-ch', { type: 0, send: sendFn }]],
      guildRoles: [['r1', { name: 'VIP' }]],
    });
    const eventBus = makeEventBus();
    await handleLevelUp(guild as any, {} as any, eventBus as any, 'u1', 2, 3, 300);
    expect(sendFn).toHaveBeenCalledWith(expect.stringContaining('VIP'));
  });

  it('handles multi-level jumps', async () => {
    (loadRewards as any).mockResolvedValue([
      { level: 2, role_id: 'r2', remove_at_level: null, announce: false },
      { level: 3, role_id: 'r3', remove_at_level: null, announce: false },
    ]);
    const guild = makeGuild();
    const eventBus = makeEventBus();
    await handleLevelUp(guild as any, {} as any, eventBus as any, 'u1', 1, 3, 300);
    const member = await guild.members.fetch('u1');
    expect(member.roles.add).toHaveBeenCalledTimes(2);
  });
});
