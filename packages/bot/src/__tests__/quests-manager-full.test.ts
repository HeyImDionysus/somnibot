/**
 * QuestsManager — Full tests
 *
 * Tests viewQuests, claimQuests, trackProgress, module-level helpers.
 * Covers: quest viewing, quest assignment, atomic claiming,
 * payout success/failure, progress tracking, config caching.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../utils/random.js', () => ({
  cryptoShuffle: (arr: any[]) => [...arr], // identity shuffle for determinism
}));

vi.mock('discord.js', async () => {
  const actual = await vi.importActual('discord.js') as any;
  return {
    ...actual,
    EmbedBuilder: class {
      data: any = {};
      setTitle(t: string) { this.data.title = t; return this; }
      setDescription(d: string) { this.data.description = d; return this; }
      setColor(c: number) { this.data.color = c; return this; }
      setFooter(f: any) { this.data.footer = f; return this; }
      addFields(...fields: any[]) { this.data.fields = fields; return this; }
    },
  };
});

import {
  QuestsManager,
  registerQuestsManager,
  getQuestsManager,
  invalidateQuestsCache,
} from '../features/quests/quests-manager.js';

function supaChain(data: any = null, error: any = null) {
  const c: any = {};
  const methods = ['select','insert','update','upsert','delete','eq','neq','gte','lt','lte',
    'limit','order','in','head','filter','single','maybeSingle'];
  for (const m of methods) c[m] = vi.fn((..._: any[]) => c);
  c.single = vi.fn(async () => ({ data, error }));
  c.maybeSingle = vi.fn(async () => ({ data, error }));
  c.then = (resolve: any) => resolve({ data: Array.isArray(data) ? data : (data ? [data] : []), error });
  return c;
}

function makeInteraction(overrides: Record<string, any> = {}): any {
  return {
    guildId: 'g1',
    user: { id: 'u1' },
    reply: vi.fn(async () => {}),
    deferReply: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('module-level helpers', () => {
  it('registerQuestsManager + getQuestsManager roundtrips', () => {
    const supabase = { from: vi.fn(() => supaChain()), rpc: vi.fn(async () => ({ data: null, error: null })) } as any;
    const mgr = new QuestsManager(supabase);
    registerQuestsManager(mgr);
    expect(getQuestsManager()).toBe(mgr);
  });

  it('invalidateQuestsCache calls clearCache', () => {
    const supabase = { from: vi.fn(() => supaChain()), rpc: vi.fn(async () => ({ data: null, error: null })) } as any;
    const mgr = new QuestsManager(supabase);
    const spy = vi.spyOn(mgr, 'clearCache');
    registerQuestsManager(mgr);
    invalidateQuestsCache();
    expect(spy).toHaveBeenCalled();
  });

  it('invalidateQuestsCache does nothing when no manager registered', () => {
    // Reset by registering null through internal path
    registerQuestsManager(null as any);
    expect(() => invalidateQuestsCache()).not.toThrow();
  });
});

describe('QuestsManager.viewQuests', () => {
  it('replies with error when quests not enabled', async () => {
    const supabase = {
      from: vi.fn(() => supaChain({ economy_quests_enabled: false })),
      rpc: vi.fn(async () => ({ data: null, error: null })),
    } as any;
    const mgr = new QuestsManager(supabase);
    const interaction = makeInteraction();

    await mgr.viewQuests(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('not enabled'),
      ephemeral: true,
    }));
  });

  it('assigns new quests when no progress exists', async () => {
    const config = { economy_quests_enabled: true, economy_daily_quest_count: 2 };
    let callCount = 0;
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'guild_config') return supaChain(config);
        if (table === 'economy_quest_progress') {
          callCount++;
          if (callCount <= 1) {
            // First call: viewQuests → no progress
            return supaChain([]); // empty, trigger assign
          }
          // Subsequent calls from assignDailyQuests/assignWeeklyQuests
          const c = supaChain([]);
          c.upsert = vi.fn(async () => ({ data: null, error: null }));
          return c;
        }
        if (table === 'economy_quest_templates') {
          return supaChain([
            { id: 't1', title: 'Send 5 messages', quest_type: 'daily', active: true },
            { id: 't2', title: 'Win a game', quest_type: 'daily', active: true },
          ]);
        }
        return supaChain();
      }),
      rpc: vi.fn(async () => ({ data: null, error: null })),
    } as any;
    const mgr = new QuestsManager(supabase);
    const interaction = makeInteraction();

    await mgr.viewQuests(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('New quests assigned'),
    }));
  });

  it('displays existing quests with status indicators', async () => {
    const config = { economy_quests_enabled: true };
    const progress = [
      { template: { title: 'Send messages', target_count: 10 }, progress: 5, completed: false, claimed: false },
      { template: { title: 'Win game', target_count: 1 }, progress: 1, completed: true, claimed: false },
      { template: { title: 'Daily login', target_count: 1 }, progress: 1, completed: true, claimed: true },
    ];

    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'guild_config') return supaChain(config);
        if (table === 'economy_quest_progress') return supaChain(progress);
        return supaChain([]);
      }),
      rpc: vi.fn(async () => ({ data: null, error: null })),
    } as any;
    const mgr = new QuestsManager(supabase);
    const interaction = makeInteraction();

    await mgr.viewQuests(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      embeds: expect.any(Array),
    }));
  });
});

describe('QuestsManager.claimQuests', () => {
  it('replies with error when no completed quests to claim', async () => {
    const supabase = {
      from: vi.fn(() => supaChain()),
      rpc: vi.fn(async () => ({ data: [], error: null })),
    } as any;
    const mgr = new QuestsManager(supabase);
    const interaction = makeInteraction();

    await mgr.claimQuests(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('No completed quests'),
    }));
  });

  it('claims quests and pays out rewards', async () => {
    const claimed = [
      { id: 'q1', reward_currency: 100, reward_xp: 50 },
      { id: 'q2', reward_currency: 200, reward_xp: 75 },
    ];
    const supabase = {
      from: vi.fn(() => supaChain()),
      rpc: vi.fn(async (fn: string) => {
        if (fn === 'economy_quest_atomic_claim') return { data: claimed, error: null };
        if (fn === 'economy_add_balance') return { data: null, error: null };
        return { data: null, error: null };
      }),
    } as any;
    const mgr = new QuestsManager(supabase);
    const interaction = makeInteraction();

    await mgr.claimQuests(interaction);

    expect(supabase.rpc).toHaveBeenCalledWith('economy_add_balance', expect.objectContaining({
      p_amount: 300,
    }));
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      embeds: expect.arrayContaining([expect.objectContaining({
        data: expect.objectContaining({
          title: expect.stringContaining('Claimed'),
        }),
      })]),
    }));
  });

  it('reverts claims on payout failure', async () => {
    const claimed = [{ id: 'q1', reward_currency: 100, reward_xp: 0 }];
    const supabase = {
      from: vi.fn(() => {
        const c = supaChain();
        c.update = vi.fn(() => c);
        return c;
      }),
      rpc: vi.fn(async (fn: string) => {
        if (fn === 'economy_quest_atomic_claim') return { data: claimed, error: null };
        if (fn === 'economy_add_balance') return { data: null, error: { message: 'payout failed' } };
        return { data: null, error: null };
      }),
    } as any;
    const mgr = new QuestsManager(supabase);
    const interaction = makeInteraction();

    await mgr.claimQuests(interaction);

    // Should revert and show error
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      embeds: expect.arrayContaining([expect.objectContaining({
        data: expect.objectContaining({
          description: expect.stringContaining('Failed'),
        }),
      })]),
    }));
  });

  it('handles null rpc response', async () => {
    const supabase = {
      from: vi.fn(() => supaChain()),
      rpc: vi.fn(async () => ({ data: null, error: null })),
    } as any;
    const mgr = new QuestsManager(supabase);
    const interaction = makeInteraction();

    await mgr.claimQuests(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('No completed quests'),
    }));
  });
});

describe('QuestsManager.trackProgress', () => {
  it('increments progress for matching quest', async () => {
    const active = [
      { id: 'qp1', template: { action_type: 'message_sent' } },
      { id: 'qp2', template: { action_type: 'game_won' } },
    ];
    const supabase = {
      from: vi.fn(() => supaChain(active)),
      rpc: vi.fn(async () => ({ data: null, error: null })),
    } as any;
    const mgr = new QuestsManager(supabase);

    await mgr.trackProgress('g1', 'u1', 'message_sent', 1);

    expect(supabase.rpc).toHaveBeenCalledWith('economy_quest_increment_progress', {
      p_id: 'qp1',
      p_amount: 1,
    });
    // Should not increment game_won
    expect(supabase.rpc).not.toHaveBeenCalledWith('economy_quest_increment_progress', expect.objectContaining({
      p_id: 'qp2',
    }));
  });

  it('handles no active quests gracefully', async () => {
    const supabase = {
      from: vi.fn(() => supaChain([])),
      rpc: vi.fn(async () => ({ data: null, error: null })),
    } as any;
    const mgr = new QuestsManager(supabase);

    await expect(mgr.trackProgress('g1', 'u1', 'message_sent')).resolves.not.toThrow();
  });
});

describe('QuestsManager.clearCache', () => {
  it('clears the config cache', async () => {
    const config = { economy_quests_enabled: true };
    const supabase = {
      from: vi.fn(() => supaChain(config)),
      rpc: vi.fn(async () => ({ data: null, error: null })),
    } as any;
    const mgr = new QuestsManager(supabase);

    // Trigger a cache fill
    const interaction = makeInteraction();
    await mgr.viewQuests(interaction);

    // Clear cache
    mgr.clearCache();

    // Next call should re-fetch from DB
    const call1 = supabase.from.mock.calls.length;
    await mgr.viewQuests(makeInteraction());
    expect(supabase.from.mock.calls.length).toBeGreaterThan(call1);
  });
});

describe('QuestsManager.scheduleWeeklyReset', () => {
  it('sets up interval and can be stopped', () => {
    vi.useFakeTimers();
    const supabase = {
      from: vi.fn(() => supaChain()),
      rpc: vi.fn(async () => ({ data: null, error: null })),
    } as any;
    const mgr = new QuestsManager(supabase);

    mgr.scheduleWeeklyReset('g1');
    mgr.stopResetTimer();

    vi.useRealTimers();
  });
});
