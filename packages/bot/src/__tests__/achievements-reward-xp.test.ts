/**
 * AchievementsManager — reward_xp payment (P2 batch C6).
 *
 * Achievement XP rewards were advertised (column, dashboard, seeder) but
 * never paid. They now flow through the levels system's own award path
 * (increment_member_xp — the same RPC message XP uses) so a resulting
 * level-up runs handleLevelUp (role rewards + announcement). A re-entrancy
 * fence stops the level-up side effects from nesting another achievement
 * check inside the same call chain.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('discord.js', () => {
  class EmbedBuilder {
    data: Record<string, unknown> = {};
    setTitle() { return this; } setDescription() { return this; } setColor() { return this; }
    setFooter() { return this; } addFields() { return this; } setTimestamp() { return this; }
  }
  return { EmbedBuilder };
});

vi.mock('../features/levels/level-announcer.js', () => ({
  handleLevelUp: vi.fn(async () => {}),
}));

import { eventBus } from '../services/event-bus.js';
import { AchievementsManager } from '../features/achievements/achievements-manager.js';
import { handleLevelUp } from '../features/levels/level-announcer.js';

// Permissive Supabase query-builder stub (same shape as game-econ-audit-emit).
function supaChain(data: any = null, error: any = null, count?: number): any {
  const c: any = {};
  const methods = ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq',
    'gt', 'gte', 'lt', 'lte', 'in', 'is', 'not', 'ilike', 'contains', 'order',
    'limit', 'range', 'head'];
  for (const m of methods) c[m] = (..._a: any[]) => c;
  c.single = async () => ({ data, error });
  c.maybeSingle = async () => ({ data, error });
  c.then = (resolve: any) =>
    resolve({ data: Array.isArray(data) ? data : (data ? [data] : []), error, count });
  return c;
}

function makeSupabase(tableMap: Record<string, () => any> = {}, rpcMap: Record<string, (a?: any) => any> = {}): any {
  return {
    from: vi.fn((t: string) => (tableMap[t] ? tableMap[t]() : supaChain())),
    rpc: vi.fn(async (fn: string, args?: any) => (rpcMap[fn] ? rpcMap[fn](args) : { data: null, error: null })),
  };
}

function spyEmit() {
  return vi.spyOn(eventBus, 'emit').mockImplementation(() => {});
}

const XP_DEF = { id: 'a1', condition_value: 5, reward_currency: 0, reward_xp: 100, name: 'Chatterbox' };

function tableMap() {
  return {
    guild_config: () => supaChain({ economy_achievements_enabled: true }),
    economy_achievement_defs: () => supaChain([{ ...XP_DEF }]),
    economy_user_achievements: () => supaChain([{ id: 'x' }]), // fresh unlock
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(handleLevelUp).mockClear();
});

describe('checkAndUnlock — reward_xp payment', () => {
  it('pays reward_xp via increment_member_xp and reports it in the unlock payload', async () => {
    const emit = spyEmit();
    let rpcArgs: any = null;
    const supabase = makeSupabase(tableMap(), {
      increment_member_xp: (args) => {
        rpcArgs = args;
        return { data: { new_xp: 400, old_level: 2, new_level: 2, total_messages: 10 }, error: null };
      },
    });
    const mgr = new AchievementsManager(supabase, { id: 'g1' } as any);

    const unlocked = await mgr.checkAndUnlock('g1', 'u1', 'messages_sent', 10);

    expect(unlocked).toBe('Chatterbox');
    expect(rpcArgs).toMatchObject({
      p_guild_id: 'g1',
      p_member_id: 'u1',
      p_xp_amount: 100,
      p_increment_messages: false,
      p_voice_minutes: 0,
    });
    expect(emit).toHaveBeenCalledWith('achievement.unlocked', 'g1', expect.objectContaining({
      userId: 'u1', achievementId: 'a1', rewardXp: 100,
    }));
    // No level-up — the announcer path must stay untouched.
    expect(handleLevelUp).not.toHaveBeenCalled();
  });

  it('runs the level-up path (role rewards + announcement) when the reward levels the member up', async () => {
    spyEmit();
    const guild = { id: 'g1' } as any;
    const supabase = makeSupabase(tableMap(), {
      increment_member_xp: () => ({ data: { new_xp: 900, old_level: 2, new_level: 3, total_messages: 10 }, error: null }),
    });
    const mgr = new AchievementsManager(supabase, guild);

    await mgr.checkAndUnlock('g1', 'u1', 'messages_sent', 10);

    expect(handleLevelUp).toHaveBeenCalledTimes(1);
    expect(handleLevelUp).toHaveBeenCalledWith(guild, supabase, expect.anything(), 'u1', 2, 3, 900);
  });

  it('still pays the XP but skips the announcer without a guild handle', async () => {
    const emit = spyEmit();
    const supabase = makeSupabase(tableMap(), {
      increment_member_xp: () => ({ data: { new_xp: 900, old_level: 2, new_level: 3, total_messages: 10 }, error: null }),
    });
    const mgr = new AchievementsManager(supabase); // no guild (e.g. tests)

    const unlocked = await mgr.checkAndUnlock('g1', 'u1', 'messages_sent', 10);

    expect(unlocked).toBe('Chatterbox');
    expect(handleLevelUp).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('achievement.unlocked', 'g1', expect.objectContaining({ rewardXp: 100 }));
  });

  it('fences off a re-entrant checkAndUnlock while the XP grant is in flight', async () => {
    const emit = spyEmit();
    const holder: { mgr: AchievementsManager | null } = { mgr: null };
    let nestedResult: string | null = 'sentinel';
    const supabase = makeSupabase(tableMap(), {
      increment_member_xp: async () => {
        // Simulate a level-up side effect re-entering the achievement check
        // in the SAME call chain — the fence must short-circuit it to null.
        nestedResult = await holder.mgr!.checkAndUnlock('g1', 'u1', 'level', 3);
        return { data: { new_xp: 900, old_level: 2, new_level: 3, total_messages: 10 }, error: null };
      },
    });
    holder.mgr = new AchievementsManager(supabase, { id: 'g1' } as any);

    const unlocked = await holder.mgr.checkAndUnlock('g1', 'u1', 'messages_sent', 10);

    expect(unlocked).toBe('Chatterbox');
    expect(nestedResult).toBeNull();
    // Exactly ONE unlock landed — the nested call never processed defs.
    const unlockEmits = emit.mock.calls.filter((c) => c[0] === 'achievement.unlocked');
    expect(unlockEmits).toHaveLength(1);
  });

  it('reports rewardXp 0 when the XP grant RPC fails (unlock still returned)', async () => {
    const emit = spyEmit();
    const supabase = makeSupabase(tableMap(), {
      increment_member_xp: () => ({ data: null, error: { message: 'boom' } }),
    });
    const mgr = new AchievementsManager(supabase, { id: 'g1' } as any);

    const unlocked = await mgr.checkAndUnlock('g1', 'u1', 'messages_sent', 10);

    expect(unlocked).toBe('Chatterbox');
    expect(handleLevelUp).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('achievement.unlocked', 'g1', expect.objectContaining({ rewardXp: 0 }));
  });
});
