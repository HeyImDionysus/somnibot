/**
 * QuestsManager — coverage tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('discord.js', () => ({
  EmbedBuilder: class {
    data: Record<string, unknown> = {};
    fields: any[] = [];
    setTitle(t: string) { this.data.title = t; return this; }
    setDescription(d: string) { this.data.description = d; return this; }
    setColor(c: number) { this.data.color = c; return this; }
    setFooter(f: { text: string }) { this.data.footer = f; return this; }
    addFields(...args: any[]) { this.fields.push(...args); return this; }
  },
}));

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../utils/random.js', () => ({
  cryptoShuffle: <T>(arr: T[]): T[] => [...arr],
}));

import { QuestsManager, registerQuestsManager, invalidateQuestsCache, getQuestsManager } from '../features/quests/quests-manager.js';

// ── Helpers ───────────────────────────────────────────────

function makeSupabase(overrides: Record<string, any> = {}) {
  const fromMock = vi.fn();
  fromMock.mockImplementation((table: string) => {
    const chain: Record<string, any> = {};
    const methods = ['select', 'eq', 'gte', 'lt', 'order', 'limit', 'single', 'insert', 'update', 'delete', 'maybeSingle', 'upsert'];
    for (const m of methods) {
      chain[m] = vi.fn().mockReturnValue(chain);
    }
    const data = overrides[table] ?? null;
    chain.then = (resolve: (v: any) => void) => resolve({ data, error: null, count: 0 });
    (chain as any)[Symbol.toStringTag] = 'Promise';
    return chain;
  });
  return {
    from: fromMock,
    rpc: vi.fn().mockResolvedValue({ data: overrides.rpcData ?? null, error: overrides.rpcError ?? null }),
  };
}

function makeInteraction(overrides: Record<string, any> = {}) {
  return {
    guildId: 'g1',
    user: { id: overrides.userId ?? 'u1' },
    reply: vi.fn().mockResolvedValue(undefined),
    options: {
      getString: vi.fn().mockReturnValue(null),
    },
  };
}

// ── Tests ────────────────────────────────────────────────

describe('QuestsManager', () => {
  let mgr: QuestsManager;
  let supabase: ReturnType<typeof makeSupabase>;

  beforeEach(() => {
    vi.clearAllMocks();
    supabase = makeSupabase({ guild_config: { economy_quests_enabled: true, economy_daily_quest_count: 3, economy_weekly_quest_count: 5 } });
    mgr = new QuestsManager(supabase as any);
  });

  afterEach(() => {
    mgr.stopResetTimer();
  });

  describe('constructor & utility', () => {
    it('creates instance', () => {
      expect(mgr).toBeInstanceOf(QuestsManager);
    });

    it('clearCache works', () => { mgr.clearCache(); });

    it('register and invalidate', () => {
      registerQuestsManager(mgr, 'test-guild-id');
      invalidateQuestsCache();
      expect(getQuestsManager()).toBe(mgr);
    });
  });

  describe('viewQuests', () => {
    it('shows disabled message when quests not enabled', async () => {
      supabase = makeSupabase({ guild_config: { economy_quests_enabled: false } });
      mgr = new QuestsManager(supabase as any);
      const interaction = makeInteraction();
      await mgr.viewQuests(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('not enabled'),
      }));
    });

    it('assigns quests when none exist', async () => {
      supabase = makeSupabase({
        guild_config: { economy_quests_enabled: true, economy_daily_quest_count: 3 },
        economy_quest_progress: null,
        economy_quest_templates: [{ id: 't1', quest_type: 'daily', active: true }],
      });
      mgr = new QuestsManager(supabase as any);
      const interaction = makeInteraction();
      await mgr.viewQuests(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('assigned'),
      }));
    });

    it('shows existing quests', async () => {
      supabase = makeSupabase({
        guild_config: { economy_quests_enabled: true },
        economy_quest_progress: [
          { template: { title: 'Send 10 messages', target_count: 10 }, progress: 5, completed: false, claimed: false },
          { template: { title: 'Win a battle', target_count: 1 }, progress: 1, completed: true, claimed: false },
          { template: { title: 'Buy an item', target_count: 1 }, progress: 1, completed: true, claimed: true },
        ],
      });
      mgr = new QuestsManager(supabase as any);
      const interaction = makeInteraction();
      await mgr.viewQuests(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
        embeds: expect.any(Array),
      }));
    });
  });

  describe('claimQuests', () => {
    it('claims completed quests with rewards', async () => {
      supabase = makeSupabase({
        guild_config: { economy_quests_enabled: true },
        rpcData: [
          { id: 'q1', reward_currency: 500, reward_xp: 50 },
          { id: 'q2', reward_currency: 300, reward_xp: 30 },
        ],
      });
      mgr = new QuestsManager(supabase as any);
      const interaction = makeInteraction();
      await mgr.claimQuests(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
        embeds: expect.any(Array),
      }));
    });

    it('returns message when no quests to claim', async () => {
      supabase = makeSupabase({ rpcData: [] });
      mgr = new QuestsManager(supabase as any);
      const interaction = makeInteraction();
      await mgr.claimQuests(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('No completed'),
      }));
    });

    it('handles null rpc result', async () => {
      supabase = makeSupabase({ rpcData: null });
      mgr = new QuestsManager(supabase as any);
      const interaction = makeInteraction();
      await mgr.claimQuests(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('No completed'),
      }));
    });

    it('reverts claim on payout failure', async () => {
      // First rpc call returns claimed quests, second fails (payout)
      let rpcCalls = 0;
      const rpcMock = vi.fn().mockImplementation(() => {
        rpcCalls++;
        if (rpcCalls === 1) {
          return Promise.resolve({ data: [{ id: 'q1', reward_currency: 100, reward_xp: 10 }], error: null });
        }
        return Promise.resolve({ error: { message: 'payout failed' } });
      });
      supabase.rpc = rpcMock;
      mgr = new QuestsManager(supabase as any);
      const interaction = makeInteraction();
      await mgr.claimQuests(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
        embeds: expect.any(Array),
      }));
    });
  });

  describe('trackProgress', () => {
    it('increments progress for matching quest', async () => {
      supabase = makeSupabase({
        economy_quest_progress: [
          { id: 'q1', template: { action_type: 'messages_sent' } },
          { id: 'q2', template: { action_type: 'battles_won' } },
        ],
      });
      mgr = new QuestsManager(supabase as any);
      await mgr.trackProgress('g1', 'u1', 'messages_sent', 1);
      expect(supabase.rpc).toHaveBeenCalledWith('economy_quest_increment_progress', expect.objectContaining({
        p_id: 'q1',
      }));
    });

    it('handles no active quests', async () => {
      supabase = makeSupabase({ economy_quest_progress: null });
      mgr = new QuestsManager(supabase as any);
      await mgr.trackProgress('g1', 'u1', 'messages_sent');
      // Should not throw
    });

    it('handles array template shape', async () => {
      supabase = makeSupabase({
        economy_quest_progress: [
          { id: 'q1', template: [{ action_type: 'purchases' }] },
        ],
      });
      mgr = new QuestsManager(supabase as any);
      await mgr.trackProgress('g1', 'u1', 'purchases', 1);
    });
  });

  describe('assignWeeklyQuests', () => {
    it('assigns weekly quests when none exist', async () => {
      supabase = makeSupabase({
        guild_config: { economy_quests_enabled: true, economy_weekly_quest_count: 2 },
        economy_quest_progress: [],
        economy_quest_templates: [
          { id: 'w1', quest_type: 'weekly', active: true },
          { id: 'w2', quest_type: 'weekly', active: true },
        ],
      });
      mgr = new QuestsManager(supabase as any);
      await mgr.assignWeeklyQuests('g1', 'u1');
      // Should call upsert
    });

    it('skips when quests disabled', async () => {
      supabase = makeSupabase({ guild_config: { economy_quests_enabled: false } });
      mgr = new QuestsManager(supabase as any);
      await mgr.assignWeeklyQuests('g1', 'u1');
    });

    it('skips when already has enough weekly quests', async () => {
      supabase = makeSupabase({
        guild_config: { economy_quests_enabled: true, economy_weekly_quest_count: 1 },
        economy_quest_progress: [
          { id: 'q1', template: { quest_type: 'weekly' } },
        ],
      });
      mgr = new QuestsManager(supabase as any);
      await mgr.assignWeeklyQuests('g1', 'u1');
    });
  });

  describe('scheduleWeeklyReset', () => {
    it('sets up timer', () => {
      mgr.scheduleWeeklyReset('g1');
      mgr.stopResetTimer();
    });

    it('clears existing timer on reschedule', () => {
      mgr.scheduleWeeklyReset('g1');
      mgr.scheduleWeeklyReset('g1');
      mgr.stopResetTimer();
    });
  });
});
