/**
 * levels/level-announcer — coverage tests
 *
 * Tests handleLevelUp with REAL imports.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createClient } from '@supabase/supabase-js';

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

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
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
import { totalXpForLevel } from '@somnibot/shared';

type LoadedReward = Awaited<ReturnType<typeof loadRewards>>[number];
type LoadedConfig = Awaited<ReturnType<typeof loadLevelConfig>>;

function levelConfig(overrides: Partial<LoadedConfig> = {}): LoadedConfig {
  return {
    levels_enabled: true,
    xp_min: 15,
    xp_max: 25,
    xp_cooldown_seconds: 60,
    voice_xp_enabled: true,
    voice_xp_per_interval: 10,
    voice_xp_interval_minutes: 5,
    xp_multiplier_mode: 'highest',
    xp_channel_mode: 'blacklist',
    xp_channel_list: [],
    level_up_channel_id: null,
    level_up_message: null,
    no_xp_role_id: null,
    currency_name: 'Coins',
    currency_emoji: '🪙',
    level_curve: { base: 100, exponent: 1.9 },
    ...overrides,
  };
}

function roleReward(overrides: Partial<LoadedReward> = {}): LoadedReward {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    level: 1,
    reward_type: 'role',
    role_id: '100000000000000001',
    remove_role_id: null,
    remove_at_level: null,
    currency_amount: null,
    item_id: null,
    item_quantity: null,
    economy_items: null,
    announce: false,
    ...overrides,
  };
}

function makeSupabase(outcome: 'applied' | 'replayed' = 'applied') {
  const supabase = createClient('http://localhost:54321', 'test-anon-key');
  const rpc = vi.spyOn(supabase, 'rpc').mockResolvedValue({
    success: true,
    data: { outcome },
    error: null,
    count: null,
    status: 200,
    statusText: 'OK',
  });
  return { supabase, rpc };
}

type MockRole = { id?: string; name?: string };
type MockChannel = { type: number; send?: ReturnType<typeof vi.fn> };

function makeGuild(options: {
  memberRoles?: Array<[string, MockRole]>;
  guildRoles?: Array<[string, MockRole]>;
  channels?: Array<[string, MockChannel]>;
} = {}) {
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

function runLevelUp(
  guild: ReturnType<typeof makeGuild>,
  supabase: Parameters<typeof handleLevelUp>[1],
  eventBus: ReturnType<typeof makeEventBus>,
  userId: string,
  oldLevel: number,
  newLevel: number,
  totalXp: number,
) {
  return handleLevelUp(
    guild as unknown as Parameters<typeof handleLevelUp>[0],
    supabase,
    eventBus as unknown as Parameters<typeof handleLevelUp>[2],
    userId,
    oldLevel,
    newLevel,
    totalXp,
  );
}

describe('handleLevelUp', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(loadLevelConfig).mockResolvedValue(levelConfig());
    vi.mocked(loadRewards).mockResolvedValue([]);
    vi.mocked(totalXpForLevel).mockReturnValue(100);
  });

  it('returns early when member not found', async () => {
    const guild = makeGuild();
    guild.members.fetch.mockRejectedValue(new Error('not found'));
    const eventBus = makeEventBus();
    const { supabase } = makeSupabase();
    await runLevelUp(guild, supabase, eventBus, 'u1', 0, 1, 100);
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('grants role rewards for level up', async () => {
    vi.mocked(loadRewards).mockResolvedValue([roleReward()]);
    const guild = makeGuild();
    const eventBus = makeEventBus();
    const { supabase, rpc } = makeSupabase();
    await runLevelUp(guild, supabase, eventBus, 'u1', 0, 1, 100);
    expect(rpc).toHaveBeenCalledWith('apply_level_reward_delivery', {
      p_guild_id: 'g1',
      p_member_id: 'u1',
      p_reward_id: '00000000-0000-4000-8000-000000000001',
      p_delivery_kind: 'award',
      p_reached_level: 1,
    });
    expect(eventBus.emit).toHaveBeenCalledWith('level.up', 'g1', expect.any(Object));
  });

  it('announces a transactionally staged reward on the actual level-up event', async () => {
    vi.mocked(loadLevelConfig).mockResolvedValue(levelConfig({
      level_up_channel_id: 'announce-ch',
    }));
    vi.mocked(loadRewards).mockResolvedValue([roleReward({ level: 2, announce: true })]);
    const sendFn = vi.fn().mockResolvedValue(undefined);
    const guild = makeGuild({ channels: [['announce-ch', { type: 0, send: sendFn }]] });
    const eventBus = makeEventBus();
    const { supabase } = makeSupabase('replayed');
    await runLevelUp(guild, supabase, eventBus, 'u1', 1, 2, 200);
    expect(sendFn).toHaveBeenCalledWith(expect.stringContaining('Unlocked'));
  });

  it('removes old reward at configured level', async () => {
    vi.mocked(loadRewards).mockResolvedValue([
      roleReward({ id: '00000000-0000-4000-8000-000000000002', level: 1, remove_at_level: 2 }),
      roleReward({ id: '00000000-0000-4000-8000-000000000003', level: 2, role_id: '100000000000000003' }),
    ]);
    const guild = makeGuild();
    const eventBus = makeEventBus();
    const { supabase, rpc } = makeSupabase();
    await runLevelUp(guild, supabase, eventBus, 'u1', 1, 2, 200);
    expect(rpc).toHaveBeenCalledWith('apply_level_reward_delivery', expect.objectContaining({
      p_reward_id: '00000000-0000-4000-8000-000000000002',
      p_delivery_kind: 'expiry',
    }));
  });

  it('handles malformed reward delivery readback gracefully', async () => {
    vi.mocked(loadRewards).mockResolvedValue([roleReward()]);
    const guild = makeGuild();
    const eventBus = makeEventBus();
    const { supabase, rpc } = makeSupabase();
    rpc.mockResolvedValueOnce({
      success: true,
      data: null,
      error: null,
      count: null,
      status: 200,
      statusText: 'OK',
    });
    await runLevelUp(guild, supabase, eventBus, 'u1', 0, 1, 100);
    expect(eventBus.emit).toHaveBeenCalledWith('level.up', 'g1', expect.any(Object));
  });

  it('sends announcement to configured channel', async () => {
    vi.mocked(loadLevelConfig).mockResolvedValue(levelConfig({
      level_up_channel_id: 'announce-ch',
      level_up_message: null,
    }));
    vi.mocked(loadRewards).mockResolvedValue([]);
    const sendFn = vi.fn().mockResolvedValue(undefined);
    const guild = makeGuild({
      channels: [['announce-ch', { type: 0, send: sendFn }]],
    });
    const eventBus = makeEventBus();
    const { supabase } = makeSupabase();
    await runLevelUp(guild, supabase, eventBus, 'u1', 0, 1, 100);
    expect(sendFn).toHaveBeenCalledWith(expect.stringContaining('<@u1>'));
  });

  it('uses custom level up message', async () => {
    vi.mocked(loadLevelConfig).mockResolvedValue(levelConfig({
      level_up_channel_id: 'announce-ch',
      level_up_message: 'GG {user} hit level {level} with {totalXp} XP!',
    }));
    vi.mocked(loadRewards).mockResolvedValue([]);
    const sendFn = vi.fn().mockResolvedValue(undefined);
    const guild = makeGuild({
      channels: [['announce-ch', { type: 0, send: sendFn }]],
    });
    const eventBus = makeEventBus();
    const { supabase } = makeSupabase();
    await runLevelUp(guild, supabase, eventBus, 'u1', 0, 5, 500);
    expect(sendFn).toHaveBeenCalledWith(expect.stringContaining('GG <@u1> hit level 5 with 500 XP'));
  });

  it('appends role unlock flair when announce is true', async () => {
    vi.mocked(loadLevelConfig).mockResolvedValue(levelConfig({
      level_up_channel_id: 'announce-ch',
      level_up_message: null,
    }));
    vi.mocked(loadRewards).mockResolvedValue([
      roleReward({ level: 3, role_id: 'r1', announce: true }),
    ]);
    const sendFn = vi.fn().mockResolvedValue(undefined);
    const guild = makeGuild({
      channels: [['announce-ch', { type: 0, send: sendFn }]],
      guildRoles: [['r1', { name: 'VIP' }]],
    });
    const eventBus = makeEventBus();
    const { supabase } = makeSupabase();
    await runLevelUp(guild, supabase, eventBus, 'u1', 2, 3, 300);
    expect(sendFn).toHaveBeenCalledWith(expect.stringContaining('VIP'));
  });

  it('handles multi-level jumps', async () => {
    vi.mocked(loadRewards).mockResolvedValue([
      roleReward({ id: '00000000-0000-4000-8000-000000000002', level: 2, role_id: 'r2' }),
      roleReward({ id: '00000000-0000-4000-8000-000000000003', level: 3, role_id: 'r3' }),
    ]);
    const guild = makeGuild();
    const eventBus = makeEventBus();
    const { supabase, rpc } = makeSupabase();
    await runLevelUp(guild, supabase, eventBus, 'u1', 1, 3, 300);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('does not queue an award that also expires inside the same level jump', async () => {
    vi.mocked(loadRewards).mockResolvedValue([
      roleReward({ level: 2, remove_at_level: 3 }),
    ]);
    const guild = makeGuild();
    const eventBus = makeEventBus();
    const { supabase, rpc } = makeSupabase();
    await runLevelUp(guild, supabase, eventBus, 'u1', 1, 3, 300);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('apply_level_reward_delivery', expect.objectContaining({
      p_delivery_kind: 'expiry',
    }));
  });
});
