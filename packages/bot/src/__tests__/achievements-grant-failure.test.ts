/**
 * AchievementsManager — failed unlocks and rewards are reported, not swallowed.
 *
 * THE DEFECT THIS PINS: the unlock insert, the currency grant and the XP grant
 * each failed with nothing but a `log.error`. A member could meet an
 * achievement's criteria and receive no badge, no coins and no XP, with the
 * only trace in bot logs the owner never reads.
 *
 * The badge itself is not lost — `checkAndUnlock` re-evaluates the same
 * criteria on the next qualifying action, so a transient database failure
 * self-heals. A PERSISTENT one now has to surface.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
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

vi.mock('../services/alert-service.js', () => ({
  raiseOwnerAlert: vi.fn().mockResolvedValue({ inserted: true }),
}));

import { eventBus } from '../services/event-bus.js';
import { AchievementsManager } from '../features/achievements/achievements-manager.js';
import { raiseOwnerAlert } from '../services/alert-service.js';

function supaChain(data: unknown = null, error: unknown = null): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'gt',
    'gte', 'lt', 'lte', 'in', 'is', 'not', 'ilike', 'contains', 'order', 'limit',
    'range', 'head']) c[m] = () => c;
  c.single = async () => ({ data, error });
  c.maybeSingle = async () => ({ data, error });
  c.then = (resolve: (v: unknown) => unknown) =>
    resolve({ data: Array.isArray(data) ? data : (data ? [data] : []), error });
  return c;
}

function makeSupabase(
  tableMap: Record<string, () => unknown> = {},
  rpcMap: Record<string, (a?: unknown) => unknown> = {},
) {
  return {
    from: vi.fn((t: string) => (tableMap[t] ? tableMap[t]() : supaChain())),
    rpc: vi.fn(async (fn: string, args?: unknown) =>
      (rpcMap[fn] ? rpcMap[fn](args) : { data: null, error: null })),
  };
}

const DEF = { id: 'a1', condition_value: 5, reward_currency: 250, reward_xp: 100, name: 'Chatterbox' };

/** `unlockResult` controls the economy_user_achievements upsert outcome. */
function tables(unlockResult: { data?: unknown; error?: unknown } = {}) {
  return {
    guild_config: () => supaChain({ economy_achievements_enabled: true }),
    economy_achievement_defs: () => supaChain([{ ...DEF }]),
    economy_user_achievements: () =>
      supaChain(unlockResult.data ?? [{ id: 'x' }], unlockResult.error ?? null),
  };
}

beforeEach(() => {
  // NOT restoreAllMocks: that would strip the module mock's implementation and
  // leave raiseOwnerAlert returning undefined for every case after the first.
  vi.clearAllMocks();
  vi.mocked(raiseOwnerAlert).mockResolvedValue({ inserted: true } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('achievement unlock failures', () => {
  it('reports a failed unlock instead of silently skipping it', async () => {
    const emit = vi.spyOn(eventBus, 'emit').mockImplementation(() => {});
    const supabase = makeSupabase(tables({ error: { message: 'deadlock detected' } }));
    const mgr = new AchievementsManager(supabase as never, { id: 'g1' } as never);

    const unlocked = await mgr.checkAndUnlock('g1', 'u1', 'messages_sent', 10);

    // Nothing was unlocked, and that fact is now visible.
    expect(unlocked).toBeNull();
    expect(emit).toHaveBeenCalledWith('achievement.unlock_failed', 'g1', expect.objectContaining({
      userId: 'u1', achievementId: 'a1', stage: 'unlock',
    }));
    expect(raiseOwnerAlert).toHaveBeenCalledWith(supabase, 'g1',
      expect.objectContaining({ alertType: 'achievement_grant_failing', severity: 'warning' }));
    // It must NOT be reported as an unlock.
    expect(emit).not.toHaveBeenCalledWith('achievement.unlocked', 'g1', expect.anything());
  });

  it('reports a failed currency reward on an otherwise successful unlock', async () => {
    const emit = vi.spyOn(eventBus, 'emit').mockImplementation(() => {});
    const supabase = makeSupabase(tables(), {
      economy_add_balance: () => ({ data: null, error: { message: 'wallet locked' } }),
      increment_member_xp: () => ({
        data: { new_xp: 400, old_level: 2, new_level: 2, total_messages: 10 }, error: null,
      }),
    });
    const mgr = new AchievementsManager(supabase as never, { id: 'g1' } as never);

    const unlocked = await mgr.checkAndUnlock('g1', 'u1', 'messages_sent', 10);

    // The badge WAS granted, so the unlock still stands…
    expect(unlocked).toBe('Chatterbox');
    // …but the unpaid reward is on the record.
    expect(emit).toHaveBeenCalledWith('achievement.unlock_failed', 'g1', expect.objectContaining({
      stage: 'currency',
    }));
    expect(raiseOwnerAlert).toHaveBeenCalled();
  });

  it('reports a failed XP reward', async () => {
    const emit = vi.spyOn(eventBus, 'emit').mockImplementation(() => {});
    const supabase = makeSupabase(tables(), {
      increment_member_xp: () => ({ data: null, error: { message: 'rpc timeout' } }),
    });
    const mgr = new AchievementsManager(supabase as never, { id: 'g1' } as never);

    await mgr.checkAndUnlock('g1', 'u1', 'messages_sent', 10);

    expect(emit).toHaveBeenCalledWith('achievement.unlock_failed', 'g1', expect.objectContaining({
      stage: 'xp',
    }));
  });

  it('stays quiet when everything succeeds', async () => {
    const emit = vi.spyOn(eventBus, 'emit').mockImplementation(() => {});
    const supabase = makeSupabase(tables(), {
      increment_member_xp: () => ({
        data: { new_xp: 400, old_level: 2, new_level: 2, total_messages: 10 }, error: null,
      }),
    });
    const mgr = new AchievementsManager(supabase as never, { id: 'g1' } as never);

    await mgr.checkAndUnlock('g1', 'u1', 'messages_sent', 10);

    const failures = emit.mock.calls.filter((c) => c[0] === 'achievement.unlock_failed');
    expect(failures).toHaveLength(0);
    expect(raiseOwnerAlert).not.toHaveBeenCalled();
  });
});
