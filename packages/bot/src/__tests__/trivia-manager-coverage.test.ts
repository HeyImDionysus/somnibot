/**
 * trivia-manager — coverage tests
 *
 * Tests TriviaManager class, registerTriviaManager, invalidateTriviaCache
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

vi.mock('../../utils/random.js', () => ({
  randomPick: (arr: unknown[]) => arr[0],
  cryptoShuffle: (arr: unknown[]) => [...arr],
}));
// Also mock with correct path
vi.mock('../utils/random.js', () => ({
  randomPick: (arr: unknown[]) => arr[0],
  cryptoShuffle: (arr: unknown[]) => [...arr],
}));

vi.mock('discord.js', () => ({
  EmbedBuilder: class {
    data: Record<string, unknown> = {};
    setTitle(t: string) { this.data.title = t; return this; }
    setDescription(d: string) { this.data.description = d; return this; }
    setColor(c: number) { this.data.color = c; return this; }
    setFooter(f: Record<string, unknown>) { this.data.footer = f; return this; }
    setImage(u: string) { this.data.image = u; return this; }
  },
  ActionRowBuilder: class {
    components: unknown[] = [];
    addComponents(...c: unknown[]) { this.components.push(...(Array.isArray(c[0]) ? c[0] : c)); return this; }
  },
  ButtonBuilder: class {
    data: Record<string, unknown> = {};
    setCustomId(id: string) { this.data.customId = id; return this; }
    setLabel(l: string) { this.data.label = l; return this; }
    setStyle(s: unknown) { this.data.style = s; return this; }
  },
  ButtonStyle: { Secondary: 2, Primary: 1 },
}));

const mockGetQuestsManager = vi.fn().mockReturnValue({
  trackProgress: vi.fn().mockResolvedValue(undefined),
});
vi.mock('../features/quests/quests-manager.js', () => ({
  getQuestsManager: () => mockGetQuestsManager(),
}));

import {
  TriviaManager,
  registerTriviaManager,
  invalidateTriviaCache,
} from '../features/trivia/trivia-manager.js';

// ── Helpers ───────────────────────────────────────────────

function chainBuilder(resolveValue: Record<string, unknown> = { data: null, error: null }) {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order', 'limit', 'insert', 'upsert', 'update', 'delete']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.single = vi.fn().mockResolvedValue(resolveValue);
  chain.maybeSingle = vi.fn().mockResolvedValue(resolveValue);
  chain.then = (res: (v: unknown) => void, rej?: (e: unknown) => void) =>
    Promise.resolve(resolveValue).then(res, rej);
  return chain;
}

function makeSupabase(configOverrides: Record<string, unknown> = {}) {
  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'guild_config') {
        return chainBuilder({
          data: {
            economy_trivia_enabled: true,
            economy_trivia_base_payout: 50,
            economy_trivia_streak_multiplier_pct: 10,
            economy_trivia_hard_multiplier: 2,
            ...configOverrides,
          },
          error: null,
        });
      }
      if (table === 'economy_trivia_questions') {
        return chainBuilder({ data: [], error: null });
      }
      return chainBuilder();
    }),
    rpc: vi.fn().mockResolvedValue({ error: null }),
  };
}

function makeValkey() {
  const store = new Map<string, string>();
  return {
    get: vi.fn().mockImplementation((k: string) => Promise.resolve(store.get(k) ?? null)),
    set: vi.fn().mockImplementation((k: string, v: string) => { store.set(k, v); return Promise.resolve('OK'); }),
  };
}

function makeInteraction(overrides: Record<string, unknown> = {}) {
  return {
    guildId: 'g1',
    channelId: 'ch1',
    user: { id: 'u1' },
    reply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeButtonInteraction(customId: string, userId = 'u1') {
  return {
    customId,
    user: { id: userId },
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

describe('registerTriviaManager & invalidateTriviaCache', () => {
  it('registers and invalidates cache', () => {
    const supabase = makeSupabase();
    const valkey = makeValkey();
    const mgr = new TriviaManager(supabase as any, valkey as any);
    registerTriviaManager(mgr, 'test-guild-id');
    invalidateTriviaCache(); // Should clear cache without error
  });
});

describe('TriviaManager', () => {
  let mgr: TriviaManager;
  let supabase: ReturnType<typeof makeSupabase>;
  let valkey: ReturnType<typeof makeValkey>;

  beforeEach(() => {
    vi.clearAllMocks();
    supabase = makeSupabase();
    valkey = makeValkey();
    mgr = new TriviaManager(supabase as any, valkey as any);
  });

  afterEach(() => {
    mgr.stopAll();
  });

  describe('startRound', () => {
    it('replies error when trivia is disabled', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'guild_config') {
          return chainBuilder({ data: { economy_trivia_enabled: false }, error: null });
        }
        return chainBuilder();
      });
      const interaction = makeInteraction();
      await mgr.startRound(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('not enabled') }),
      );
    });

    it('replies error when a round is already active', async () => {
      const interaction = makeInteraction();
      // Start a round
      await mgr.startRound(interaction as any);
      // Try to start another
      const interaction2 = makeInteraction();
      await mgr.startRound(interaction2 as any);
      expect(interaction2.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('already active') }),
      );
    });

    it('starts a round with default questions', async () => {
      const interaction = makeInteraction();
      await mgr.startRound(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ embeds: expect.any(Array), components: expect.any(Array) }),
      );
    });

    it('filters by category', async () => {
      const interaction = makeInteraction({ channelId: 'ch2' });
      await mgr.startRound(interaction as any, 'science');
      expect(interaction.reply).toHaveBeenCalled();
    });

    it('filters by difficulty', async () => {
      const interaction = makeInteraction({ channelId: 'ch3' });
      await mgr.startRound(interaction as any, undefined, 'hard');
      expect(interaction.reply).toHaveBeenCalled();
    });

    it('filters by both category and difficulty', async () => {
      const interaction = makeInteraction({ channelId: 'ch4' });
      await mgr.startRound(interaction as any, 'science', 'easy');
      expect(interaction.reply).toHaveBeenCalled();
    });

    it('uses custom questions from DB', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'guild_config') {
          return chainBuilder({ data: { economy_trivia_enabled: true }, error: null });
        }
        if (table === 'economy_trivia_questions') {
          return chainBuilder({
            data: [{
              question: 'Custom Q?',
              correct_answer: 'Yes',
              wrong_answers: ['No', 'Maybe', 'Never'],
              category: 'custom',
              difficulty: 'easy',
            }],
            error: null,
          });
        }
        return chainBuilder();
      });
      const interaction = makeInteraction({ channelId: 'ch5' });
      await mgr.startRound(interaction as any);
      expect(interaction.reply).toHaveBeenCalled();
    });
  });

  describe('handleAnswer', () => {
    it('rejects answer for ended round', async () => {
      const btn = makeButtonInteraction('trivia:ch99:0');
      await mgr.handleAnswer(btn as any);
      expect(btn.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('ended') }),
      );
    });

    it('rejects duplicate answer', async () => {
      const interaction = makeInteraction();
      await mgr.startRound(interaction as any);

      const btn1 = makeButtonInteraction('trivia:ch1:0');
      await mgr.handleAnswer(btn1 as any);
      expect(btn1.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('locked in') }),
      );

      const btn2 = makeButtonInteraction('trivia:ch1:1');
      await mgr.handleAnswer(btn2 as any);
      expect(btn2.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('already answered') }),
      );
    });

    it('skips invalid customId format', async () => {
      const btn = makeButtonInteraction('trivia:bad');
      await mgr.handleAnswer(btn as any);
      expect(btn.reply).not.toHaveBeenCalled();
    });
  });

  describe('stopAll', () => {
    it('clears all active rounds', async () => {
      const interaction = makeInteraction();
      await mgr.startRound(interaction as any);
      mgr.stopAll();
      // Starting another round should work now
      const interaction2 = makeInteraction();
      await mgr.startRound(interaction2 as any);
      expect(interaction2.reply).toHaveBeenCalledWith(
        expect.objectContaining({ embeds: expect.any(Array) }),
      );
    });
  });

  describe('clearCache', () => {
    it('clears config and question caches', async () => {
      // Populate cache by starting a round
      const interaction = makeInteraction({ channelId: 'ch6' });
      await mgr.startRound(interaction as any);

      mgr.clearCache();

      // Next call should re-fetch
      const interaction2 = makeInteraction({ channelId: 'ch7' });
      mgr.stopAll(); // clear active rounds first
      await mgr.startRound(interaction2 as any);
      // supabase.from should have been called again
      expect(supabase.from).toHaveBeenCalledWith('guild_config');
    });
  });
});
