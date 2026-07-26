/**
 * trivia-manager — coverage tests
 *
 * Tests TriviaManager class, registerTriviaManager, invalidateTriviaCache
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
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
  const expiry = new Map<string, number>();
  return {
    get: vi.fn().mockImplementation((k: string) => Promise.resolve(store.get(k) ?? null)),
    set: vi.fn().mockImplementation((k: string, v: string, _mode?: string, ttl?: number) => {
      store.set(k, v);
      if (ttl) expiry.set(k, ttl);
      return Promise.resolve('OK');
    }),
    // ioredis/iovalkey ttl: seconds remaining, -1 no-expire, -2 absent.
    ttl: vi.fn().mockImplementation((k: string) =>
      Promise.resolve(store.has(k) ? (expiry.get(k) ?? -1) : -2)),
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

function makeGuild(id = 'g1') {
  return { id };
}

function makeChannel(id = 'sch-ch') {
  const message = { edit: vi.fn().mockResolvedValue(undefined) };
  return {
    id,
    name: 'trivia-time',
    isTextBased: () => true,
    send: vi.fn().mockResolvedValue(message),
    _message: message,
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

    // [game-economy-trivia] Per-channel cooldown ("breather") enforcement.
    it('refuses a new round while the per-channel cooldown is active', async () => {
      // Simulate a prior round having opened the cooldown breather.
      await valkey.set('trivia:cooldown:g1:cdch', '1', 'EX', 30);
      const interaction = makeInteraction({ channelId: 'cdch' });
      await mgr.startRound(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('start again') }),
      );
      // No round should have been opened (no embed reply).
      const openedRound = interaction.reply.mock.calls.some(
        (c: unknown[]) => c[0] && Array.isArray((c[0] as { embeds?: unknown[] }).embeds),
      );
      expect(openedRound).toBe(false);
    });

    it('opens the per-channel cooldown when a round ends', async () => {
      vi.useFakeTimers();
      try {
        const interaction = makeInteraction({ channelId: 'cdend' });
        await mgr.startRound(interaction as any);
        // Fire the 20s round timeout → endRound runs and opens the cooldown.
        await vi.advanceTimersByTimeAsync(20_000);
      } finally {
        vi.useRealTimers();
      }
      expect(valkey.set).toHaveBeenCalledWith('trivia:cooldown:g1:cdend', '1', 'EX', 30);
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

  // ── Hosted / scheduled rounds (no interaction) ──────────────
  describe('startScheduledRound', () => {
    it('posts a hosted round to the channel and registers it', async () => {
      const channel = makeChannel('sch1');
      const res = await mgr.startScheduledRound(makeGuild() as any, channel as any);
      expect(res.started).toBe(true);
      expect(channel.send).toHaveBeenCalledWith(
        expect.objectContaining({ embeds: expect.any(Array), components: expect.any(Array) }),
      );
    });

    it('refuses when trivia is disabled', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'guild_config') {
          return chainBuilder({ data: { economy_trivia_enabled: false }, error: null });
        }
        return chainBuilder();
      });
      const channel = makeChannel('sch-off');
      const res = await mgr.startScheduledRound(makeGuild() as any, channel as any);
      expect(res.started).toBe(false);
      expect(res.reason).toBe('trivia_disabled');
      expect(channel.send).not.toHaveBeenCalled();
    });

    it('refuses when a round is already active in the channel', async () => {
      const channel = makeChannel('busy');
      await mgr.startScheduledRound(makeGuild() as any, channel as any); // opens the round
      const res = await mgr.startScheduledRound(makeGuild() as any, channel as any);
      expect(res.started).toBe(false);
      expect(res.reason).toBe('round_active');
    });

    it('refuses while the per-channel cooldown breather is active', async () => {
      await valkey.set('trivia:cooldown:g1:cdsch', '1', 'EX', 30);
      const res = await mgr.startScheduledRound(makeGuild('g1') as any, makeChannel('cdsch') as any);
      expect(res.started).toBe(false);
      expect(res.reason).toBe('cooldown');
    });

    it('honors a pinned category + difficulty without emptying the pool', async () => {
      const channel = makeChannel('sch-pin');
      const res = await mgr.startScheduledRound(makeGuild() as any, channel as any, 'science', 'easy');
      expect(res.started).toBe(true);
      expect(channel.send).toHaveBeenCalled();
    });

    it('resolves the hosted round via message.edit when it ends', async () => {
      vi.useFakeTimers();
      const channel = makeChannel('edch');
      try {
        await mgr.startScheduledRound(makeGuild() as any, channel as any);
        // Fire the 20s round timeout → endRound edits the posted message.
        await vi.advanceTimersByTimeAsync(20_000);
      } finally {
        vi.useRealTimers();
      }
      expect(channel._message.edit).toHaveBeenCalledWith(
        expect.objectContaining({ components: [] }),
      );
    });

    it('returns send_failed when the channel send throws', async () => {
      const channel = {
        id: 'boom',
        name: 'boom',
        isTextBased: () => true,
        send: vi.fn().mockRejectedValue(new Error('missing perms')),
      };
      const res = await mgr.startScheduledRound(makeGuild() as any, channel as any);
      expect(res.started).toBe(false);
      expect(res.reason).toBe('send_failed');
    });
  });
});
