/**
 * polls-manager — coverage tests
 *
 * Tests PollsManager class: createPoll, handlePollVote, closePoll,
 * createPrediction, placeBet, resolvePrediction.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
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
    setEmoji(e: unknown) { this.data.emoji = e; return this; }
    setDisabled(d: boolean) { this.data.disabled = d; return this; }
  },
  ButtonStyle: { Secondary: 2, Primary: 1, Success: 3, Danger: 4 },
}));

const mockGetQuestsManager = vi.fn().mockReturnValue({
  trackProgress: vi.fn().mockResolvedValue(undefined),
});
vi.mock('../features/quests/quests-manager.js', () => ({
  getQuestsManager: () => mockGetQuestsManager(),
}));

import {
  PollsManager,
  registerPollsManager,
  invalidatePollsCache,
} from '../features/polls/polls-manager.js';

// ── Helpers ───────────────────────────────────────────────

function chainBuilder(resolveValue: Record<string, unknown> = { data: null, error: null }) {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'neq', 'update', 'upsert', 'insert', 'delete', 'order', 'limit', 'is', 'in', 'gte', 'lte']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.single = vi.fn().mockResolvedValue(resolveValue);
  chain.maybeSingle = vi.fn().mockResolvedValue(resolveValue);
  chain.then = (res: (v: unknown) => void, rej?: (e: unknown) => void) =>
    Promise.resolve(resolveValue).then(res, rej);
  return chain;
}

function makeSupabase(tableOverrides: Record<string, () => unknown> = {}) {
  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (tableOverrides[table]) return tableOverrides[table]();
      if (table === 'guild_config') {
        return chainBuilder({
          data: {
            polls_enabled: true,
            predictions_enabled: true,
            prediction_min_bet: 10,
            prediction_max_bet: 1000,
          },
          error: null,
        });
      }
      return chainBuilder();
    }),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  };
}

function makeInteraction(overrides: Record<string, unknown> = {}) {
  return {
    guildId: 'g1',
    channelId: 'ch1',
    user: { id: 'u1', tag: 'User#1234' },
    replied: false,
    deferred: false,
    reply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    fetchReply: vi.fn().mockResolvedValue({ id: 'msg1' }),
    ...overrides,
  };
}

function makeBtnInteraction(customId: string, userId = 'u1') {
  return {
    customId,
    guildId: 'g1',
    user: { id: userId },
    reply: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    message: {
      id: 'msg1',
      edit: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe('registerPollsManager & invalidatePollsCache', () => {
  it('registers and invalidates', () => {
    const supabase = makeSupabase();
    const mgr = new PollsManager(supabase as any);
    registerPollsManager(mgr);
    invalidatePollsCache();
    // Should not throw
  });
});

describe('PollsManager', () => {
  let mgr: PollsManager;
  let supabase: ReturnType<typeof makeSupabase>;

  beforeEach(() => {
    vi.clearAllMocks();
    supabase = makeSupabase();
    mgr = new PollsManager(supabase as any);
  });

  describe('createPoll', () => {
    it('replies error when polls are disabled', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'guild_config') {
          return chainBuilder({ data: { polls_enabled: false }, error: null });
        }
        return chainBuilder();
      });
      const interaction = makeInteraction();
      await mgr.createPoll(interaction as any, 'Test Poll', ['A', 'B', 'C'], false);
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('not enabled') }),
      );
    });

    it('creates a poll with multiple options', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'guild_config') {
          return chainBuilder({ data: { polls_enabled: true }, error: null });
        }
        if (table === 'polls') {
          const c = chainBuilder({ data: { id: 'poll1' }, error: null });
          return c;
        }
        return chainBuilder();
      });
      const interaction = makeInteraction();
      await mgr.createPoll(interaction as any, 'Best Color?', ['Red', 'Blue', 'Green'], false);
      expect(interaction.reply).toHaveBeenCalled();
    });

    it('creates a multi-vote poll', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'guild_config') {
          return chainBuilder({ data: { polls_enabled: true }, error: null });
        }
        if (table === 'polls') {
          return chainBuilder({ data: { id: 'poll2' }, error: null });
        }
        return chainBuilder();
      });
      const interaction = makeInteraction();
      await mgr.createPoll(interaction as any, 'Favorites', ['A', 'B'], true);
      expect(interaction.reply).toHaveBeenCalled();
    });

    it('handles DB insert error', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'guild_config') {
          return chainBuilder({ data: { polls_enabled: true }, error: null });
        }
        if (table === 'polls') {
          return chainBuilder({ data: null, error: { message: 'insert fail' } });
        }
        return chainBuilder();
      });
      const interaction = makeInteraction();
      await mgr.createPoll(interaction as any, 'Test', ['A', 'B'], false);
      // Should handle the error
    });
  });

  describe('handlePollVote', () => {
    it('rejects vote when poll is closed/inactive', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'polls') {
          return chainBuilder({ data: { id: 'poll1', status: 'closed' }, error: null });
        }
        return chainBuilder();
      });
      const btn = makeBtnInteraction('poll_vote:poll1:opt1');
      await mgr.handlePollVote(btn as any);
      expect(btn.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('closed') }),
      );
    });

    it('rejects vote when poll not found (null)', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'polls') {
          return chainBuilder({ data: null, error: null });
        }
        return chainBuilder();
      });
      const btn = makeBtnInteraction('poll_vote:poll1:opt1');
      await mgr.handlePollVote(btn as any);
      expect(btn.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('closed') }),
      );
    });

    it('processes valid single vote', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'polls') {
          return chainBuilder({
            data: {
              id: 'poll1', status: 'active', allow_multiple: false,
            },
            error: null,
          });
        }
        return chainBuilder();
      });
      supabase.rpc.mockResolvedValueOnce({ data: [{ id: 'vote1' }], error: null });
      const btn = makeBtnInteraction('poll_vote:poll1:opt1');
      await mgr.handlePollVote(btn as any);
      expect(btn.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Vote recorded') }),
      );
    });

    it('prevents duplicate single vote (empty RPC result)', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'polls') {
          return chainBuilder({
            data: { id: 'poll1', status: 'active', allow_multiple: false },
            error: null,
          });
        }
        return chainBuilder();
      });
      supabase.rpc.mockResolvedValueOnce({ data: [], error: null });
      const btn = makeBtnInteraction('poll_vote:poll1:opt1');
      await mgr.handlePollVote(btn as any);
      expect(btn.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('already voted') }),
      );
    });

    it('handles RPC unique violation (duplicate vote per option)', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'polls') {
          return chainBuilder({
            data: { id: 'poll1', status: 'active', allow_multiple: false },
            error: null,
          });
        }
        return chainBuilder();
      });
      supabase.rpc.mockResolvedValueOnce({ data: null, error: { code: '23505', message: 'unique violation' } });
      const btn = makeBtnInteraction('poll_vote:poll1:opt1');
      await mgr.handlePollVote(btn as any);
      expect(btn.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('already voted') }),
      );
    });

    it('handles RPC generic error', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'polls') {
          return chainBuilder({
            data: { id: 'poll1', status: 'active', allow_multiple: false },
            error: null,
          });
        }
        return chainBuilder();
      });
      supabase.rpc.mockResolvedValueOnce({ data: null, error: { code: 'OTHER', message: 'bad' } });
      const btn = makeBtnInteraction('poll_vote:poll1:opt1');
      await mgr.handlePollVote(btn as any);
      expect(btn.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Failed') }),
      );
    });

    it('multi-vote records vote', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'polls') {
          return chainBuilder({
            data: { id: 'poll1', status: 'active', allow_multiple: true },
            error: null,
          });
        }
        if (table === 'poll_votes') {
          return chainBuilder({ data: null, error: null });
        }
        return chainBuilder();
      });
      const btn = makeBtnInteraction('poll_vote:poll1:opt1');
      await mgr.handlePollVote(btn as any);
      expect(btn.reply).toHaveBeenCalled();
    });

    it('multi-vote detects duplicate (unique violation)', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'polls') {
          return chainBuilder({
            data: { id: 'poll1', status: 'active', allow_multiple: true },
            error: null,
          });
        }
        if (table === 'poll_votes') {
          return chainBuilder({ data: null, error: { code: '23505', message: 'dup' } });
        }
        return chainBuilder();
      });
      const btn = makeBtnInteraction('poll_vote:poll1:opt1');
      await mgr.handlePollVote(btn as any);
      expect(btn.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('already voted') }),
      );
    });

    it('skips short customId', async () => {
      const btn = makeBtnInteraction('poll_vote:bad');
      await mgr.handlePollVote(btn as any);
      expect(btn.reply).not.toHaveBeenCalled();
    });
  });

  describe('closePoll', () => {
    it('closes a poll and shows results', async () => {
      let callCount = 0;
      supabase.from.mockImplementation((table: string) => {
        if (table === 'polls') {
          callCount++;
          if (callCount === 1) {
            // First call: fetch poll
            return chainBuilder({
              data: {
                id: 'poll1', guild_id: 'g1', title: 'Test Poll',
                creator_user_id: 'u1', status: 'open',
              },
              error: null,
            });
          }
          // Second call: update status — return closedRows
          const ch = chainBuilder({ data: [{ id: 'poll1' }], error: null });
          return ch;
        }
        if (table === 'poll_options') {
          return chainBuilder({ data: [{ id: 'opt1', label: 'A', sort_order: 0 }], error: null });
        }
        if (table === 'poll_votes') {
          return { select: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ count: 3 }) }) };
        }
        return chainBuilder();
      });
      const interaction = makeInteraction();
      await mgr.closePoll(interaction as any, 'poll1');
      expect(interaction.reply).toHaveBeenCalled();
    });

    it('rejects when poll not found', async () => {
      supabase.from.mockReturnValue(chainBuilder({ data: null, error: null }));
      const interaction = makeInteraction();
      await mgr.closePoll(interaction as any, 'nonexistent');
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('not found') }),
      );
    });

    it('rejects when not creator', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'polls') {
          return chainBuilder({
            data: { id: 'poll1', creator_user_id: 'other_user', status: 'open' },
            error: null,
          });
        }
        return chainBuilder();
      });
      const interaction = makeInteraction();
      await mgr.closePoll(interaction as any, 'poll1');
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Only the poll creator') }),
      );
    });

    it('rejects closing already-closed poll', async () => {
      let callCount = 0;
      supabase.from.mockImplementation((table: string) => {
        if (table === 'polls') {
          callCount++;
          if (callCount === 1) {
            return chainBuilder({
              data: { id: 'poll1', creator_user_id: 'u1', status: 'open' },
              error: null,
            });
          }
          // Update returns empty (already closed)
          return chainBuilder({ data: [], error: null });
        }
        return chainBuilder();
      });
      const interaction = makeInteraction();
      await mgr.closePoll(interaction as any, 'poll1');
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('already closed') }),
      );
    });
  });

  describe('createPrediction', () => {
    it('creates a prediction market', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'guild_config') {
          return chainBuilder({ data: { predictions_enabled: true }, error: null });
        }
        if (table === 'predictions') {
          return chainBuilder({ data: { id: 'pred1' }, error: null });
        }
        return chainBuilder();
      });
      const interaction = makeInteraction();
      await mgr.createPrediction(interaction as any, 'Will it rain?', ['Yes', 'No'], 60);
      expect(interaction.reply).toHaveBeenCalled();
    });

    it('rejects when predictions are disabled', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'guild_config') {
          return chainBuilder({ data: { predictions_enabled: false }, error: null });
        }
        return chainBuilder();
      });
      const interaction = makeInteraction();
      await mgr.createPrediction(interaction as any, 'Test?', ['Yes', 'No'], 60);
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('not enabled') }),
      );
    });
  });

  describe('placeBet', () => {
    it('rejects bet on non-open prediction', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'predictions') {
          return chainBuilder({ data: { id: 'pred1', status: 'closed' }, error: null });
        }
        return chainBuilder();
      });
      const interaction = makeInteraction();
      await mgr.placeBet(interaction as any, 'pred1', 0, 50);
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('not open') }),
      );
    });

    it('rejects when prediction not found', async () => {
      supabase.from.mockReturnValue(chainBuilder({ data: null, error: null }));
      const interaction = makeInteraction();
      await mgr.placeBet(interaction as any, 'pred1', 0, 50);
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('not open') }),
      );
    });

    it('rejects duplicate bet', async () => {
      let betCallCount = 0;
      supabase.from.mockImplementation((table: string) => {
        if (table === 'predictions') {
          return chainBuilder({ data: { id: 'pred1', status: 'open' }, error: null });
        }
        if (table === 'prediction_bets') {
          betCallCount++;
          if (betCallCount === 1) {
            // existingBet check
            return chainBuilder({ data: { id: 'existing' }, error: null });
          }
          return chainBuilder();
        }
        return chainBuilder();
      });
      const interaction = makeInteraction();
      await mgr.placeBet(interaction as any, 'pred1', 0, 50);
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('already placed') }),
      );
    });

    it('rejects insufficient balance', async () => {
      let betCallCount = 0;
      supabase.from.mockImplementation((table: string) => {
        if (table === 'predictions') {
          return chainBuilder({ data: { id: 'pred1', status: 'open' }, error: null });
        }
        if (table === 'prediction_bets') {
          betCallCount++;
          if (betCallCount === 1) return chainBuilder({ data: null, error: null }); // no existing bet
          return chainBuilder({ data: { id: 'bet1' }, error: null }); // insert
        }
        if (table === 'prediction_options') {
          return chainBuilder({
            data: [{ id: 'opt1', label: 'Yes', sort_order: 0 }, { id: 'opt2', label: 'No', sort_order: 1 }],
            error: null,
          });
        }
        if (table === 'economy_wallets') {
          return chainBuilder({ data: { wallet: 5 }, error: null }); // insufficient
        }
        return chainBuilder();
      });
      const interaction = makeInteraction();
      await mgr.placeBet(interaction as any, 'pred1', 0, 50);
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Insufficient') }),
      );
    });

    it('places a valid bet successfully', async () => {
      let betCallCount = 0;
      supabase.from.mockImplementation((table: string) => {
        if (table === 'predictions') {
          return chainBuilder({ data: { id: 'pred1', status: 'open', total_pool: 100 }, error: null });
        }
        if (table === 'prediction_bets') {
          betCallCount++;
          if (betCallCount === 1) return chainBuilder({ data: null, error: null }); // no existing bet
          return chainBuilder({ data: { id: 'bet1' }, error: null }); // insert
        }
        if (table === 'prediction_options') {
          return chainBuilder({
            data: [{ id: 'opt1', label: 'Yes' }, { id: 'opt2', label: 'No' }],
            error: null,
          });
        }
        if (table === 'economy_wallets') {
          return chainBuilder({ data: { wallet: 500 }, error: null });
        }
        return chainBuilder();
      });
      supabase.rpc.mockResolvedValue({ data: 150, error: null });
      const interaction = makeInteraction();
      await mgr.placeBet(interaction as any, 'pred1', 0, 50);
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ embeds: expect.any(Array) }),
      );
    });
  });

  describe('resolvePrediction', () => {
    it('rejects when prediction not found', async () => {
      supabase.from.mockReturnValue(chainBuilder({ data: null, error: null }));
      const interaction = makeInteraction();
      await mgr.resolvePrediction(interaction as any, 'nonexistent', 0);
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('not found') }),
      );
    });

    it('rejects when not creator', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'predictions') {
          return chainBuilder({
            data: { id: 'pred1', creator_user_id: 'other', title: 'Test' },
            error: null,
          });
        }
        return chainBuilder();
      });
      const interaction = makeInteraction();
      await mgr.resolvePrediction(interaction as any, 'pred1', 0);
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Only the creator') }),
      );
    });

    it('rejects invalid option index', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'predictions') {
          return chainBuilder({
            data: { id: 'pred1', creator_user_id: 'u1', title: 'Test' },
            error: null,
          });
        }
        if (table === 'prediction_options') {
          return chainBuilder({ data: [{ id: 'opt1', label: 'Yes' }], error: null });
        }
        return chainBuilder();
      });
      const interaction = makeInteraction();
      await mgr.resolvePrediction(interaction as any, 'pred1', 5); // out of range
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Invalid winning') }),
      );
    });

    it('handles already-resolved (atomic RPC returns null)', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'predictions') {
          return chainBuilder({
            data: { id: 'pred1', creator_user_id: 'u1', title: 'Test' },
            error: null,
          });
        }
        if (table === 'prediction_options') {
          return chainBuilder({
            data: [{ id: 'opt1', label: 'Yes' }, { id: 'opt2', label: 'No' }],
            error: null,
          });
        }
        return chainBuilder();
      });
      supabase.rpc.mockResolvedValueOnce({ data: null, error: null }); // atomic returns null
      const interaction = makeInteraction();
      await mgr.resolvePrediction(interaction as any, 'pred1', 0);
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('already been resolved') }),
      );
    });

    it('resolves and pays winners', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'predictions') {
          return chainBuilder({
            data: { id: 'pred1', creator_user_id: 'u1', title: 'Will it rain?', total_pool: 300 },
            error: null,
          });
        }
        if (table === 'prediction_options') {
          return chainBuilder({
            data: [
              { id: 'opt1', label: 'Yes', sort_order: 0 },
              { id: 'opt2', label: 'No', sort_order: 1 },
            ],
            error: null,
          });
        }
        if (table === 'prediction_bets') {
          return chainBuilder({
            data: [
              { id: 'b1', user_id: 'u2', option_id: 'opt1', amount: 100, payout: null },
              { id: 'b2', user_id: 'u3', option_id: 'opt2', amount: 50, payout: null },
              { id: 'b3', user_id: 'u4', option_id: 'opt1', amount: 200, payout: null },
            ],
            error: null,
          });
        }
        return chainBuilder();
      });
      supabase.rpc.mockResolvedValueOnce({
        data: [{ total_pool: 350 }],
        error: null,
      });
      // Subsequent rpc calls for economy_add_balance
      supabase.rpc.mockResolvedValue({ data: null, error: null });

      const interaction = makeInteraction();
      await mgr.resolvePrediction(interaction as any, 'pred1', 0);
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ embeds: expect.any(Array) }),
      );
    });

    it('refunds all bets when no one picked the winner', async () => {
      supabase.from.mockImplementation((table: string) => {
        if (table === 'predictions') {
          return chainBuilder({
            data: { id: 'pred1', creator_user_id: 'u1', title: 'Nobody wins' },
            error: null,
          });
        }
        if (table === 'prediction_options') {
          return chainBuilder({
            data: [
              { id: 'opt1', label: 'Yes', sort_order: 0 },
              { id: 'opt2', label: 'No', sort_order: 1 },
            ],
            error: null,
          });
        }
        if (table === 'prediction_bets') {
          // All bets are on opt2, but winner is opt1 → no one wins
          return chainBuilder({
            data: [
              { id: 'b1', user_id: 'u2', option_id: 'opt2', amount: 100, payout: null },
            ],
            error: null,
          });
        }
        return chainBuilder();
      });
      supabase.rpc.mockResolvedValue({ data: [{ total_pool: 100 }], error: null });

      const interaction = makeInteraction();
      await mgr.resolvePrediction(interaction as any, 'pred1', 0); // winner is opt1
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ embeds: expect.any(Array) }),
      );
    });
  });

  describe('clearCache', () => {
    it('clears config cache', () => {
      mgr.clearCache();
      // No error
    });
  });
});
