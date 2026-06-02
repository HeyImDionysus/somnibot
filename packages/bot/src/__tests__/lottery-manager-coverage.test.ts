/**
 * LotteryManager — coverage tests.
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
  randomPick: (arr: any[]) => arr[0],
}));

vi.mock('../quests/quests-manager.js', () => ({
  getQuestsManager: () => ({
    trackProgress: vi.fn().mockResolvedValue(undefined),
  }),
}));

import { LotteryManager, registerLotteryManager, invalidateLotteryCache } from '../features/lottery/lottery-manager.js';

// ── Helpers ───────────────────────────────────────────────

function makeSupabase(tableData: Record<string, any> = {}, rpcResults: Record<string, any> = {}) {
  const fromMock = vi.fn();
  fromMock.mockImplementation((table: string) => {
    const chain: Record<string, any> = {};
    const methods = ['select', 'eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'order', 'limit', 'single', 'insert', 'update', 'delete', 'maybeSingle'];
    for (const m of methods) {
      chain[m] = vi.fn().mockReturnValue(chain);
    }
    const data = tableData[table] ?? null;
    chain.then = (resolve: (v: any) => void) => resolve({ data, error: null });
    (chain as any)[Symbol.toStringTag] = 'Promise';
    return chain;
  });
  return {
    from: fromMock,
    rpc: vi.fn().mockImplementation((name: string) => {
      if (rpcResults[name]) return Promise.resolve(rpcResults[name]);
      return Promise.resolve({ data: null, error: null });
    }),
  };
}

function makeInteraction(overrides: Record<string, any> = {}) {
  return {
    guildId: 'g1',
    user: { id: overrides.userId ?? 'u1' },
    reply: vi.fn().mockResolvedValue(undefined),
    options: {
      getInteger: vi.fn().mockReturnValue(overrides.count ?? 1),
    },
  };
}

// ── Tests ────────────────────────────────────────────────

describe('LotteryManager', () => {
  let mgr: LotteryManager;
  let supabase: ReturnType<typeof makeSupabase>;

  beforeEach(() => {
    vi.clearAllMocks();
    supabase = makeSupabase(
      {
        guild_config: { economy_lottery_enabled: true, economy_lottery_max_tickets: 10, economy_lottery_ticket_price: 100, economy_lottery_schedule: 'daily', economy_log_channel_id: 'ch1' },
      },
    );
    mgr = new LotteryManager(supabase as any);
  });

  describe('constructor & utility', () => {
    it('creates instance', () => {
      expect(mgr).toBeInstanceOf(LotteryManager);
    });

    it('clearCache works', () => {
      mgr.clearCache();
    });

    it('register and invalidate', () => {
      registerLotteryManager(mgr);
      invalidateLotteryCache();
    });
  });

  describe('buyTickets', () => {
    it('rejects when lottery not enabled', async () => {
      supabase = makeSupabase({ guild_config: { economy_lottery_enabled: false } });
      mgr = new LotteryManager(supabase as any);
      const interaction = makeInteraction();
      await mgr.buyTickets(interaction as any, 1);
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('not enabled'),
      }));
    });

    it('rejects invalid ticket count', async () => {
      const interaction = makeInteraction();
      await mgr.buyTickets(interaction as any, 0);
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('1-10'),
      }));
    });

    it('rejects when count exceeds max', async () => {
      const interaction = makeInteraction();
      await mgr.buyTickets(interaction as any, 11);
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('1-10'),
      }));
    });

    it('rejects when insufficient balance', async () => {
      supabase = makeSupabase(
        {
          guild_config: { economy_lottery_enabled: true, economy_lottery_max_tickets: 10, economy_lottery_ticket_price: 100 },
          economy_wallets: { wallet: 50 },
        },
      );
      mgr = new LotteryManager(supabase as any);
      const interaction = makeInteraction();
      await mgr.buyTickets(interaction as any, 1);
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('need'),
      }));
    });

    it('rejects when no wallet found', async () => {
      supabase = makeSupabase(
        {
          guild_config: { economy_lottery_enabled: true, economy_lottery_max_tickets: 10, economy_lottery_ticket_price: 100 },
          economy_wallets: null,
        },
      );
      mgr = new LotteryManager(supabase as any);
      const interaction = makeInteraction();
      await mgr.buyTickets(interaction as any, 1);
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('need'),
      }));
    });

    it('purchases tickets successfully', async () => {
      supabase = makeSupabase(
        {
          guild_config: { economy_lottery_enabled: true, economy_lottery_max_tickets: 10, economy_lottery_ticket_price: 100 },
          economy_wallets: { wallet: 1000 },
          economy_lottery_drawings: { id: 'd1', jackpot: 500, status: 'active', created_at: new Date().toISOString() },
        },
        {
          economy_subtract_balance: { data: true, error: null },
          lottery_buy_tickets: { data: 600, error: null },
        },
      );
      mgr = new LotteryManager(supabase as any);
      const interaction = makeInteraction();
      await mgr.buyTickets(interaction as any, 1);
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
        embeds: expect.any(Array),
      }));
    });

    it('handles debit failure', async () => {
      supabase = makeSupabase(
        {
          guild_config: { economy_lottery_enabled: true, economy_lottery_max_tickets: 10, economy_lottery_ticket_price: 100 },
          economy_wallets: { wallet: 1000 },
          economy_lottery_drawings: { id: 'd1', jackpot: 500, status: 'active', created_at: new Date().toISOString() },
        },
        {
          economy_subtract_balance: { error: { message: 'insufficient funds' } },
        },
      );
      mgr = new LotteryManager(supabase as any);
      const interaction = makeInteraction();
      await mgr.buyTickets(interaction as any, 1);
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining("don't have enough"),
      }));
    });

    it('handles buy RPC failure with refund', async () => {
      supabase = makeSupabase(
        {
          guild_config: { economy_lottery_enabled: true, economy_lottery_max_tickets: 10, economy_lottery_ticket_price: 100 },
          economy_wallets: { wallet: 1000 },
          economy_lottery_drawings: { id: 'd1', jackpot: 500, status: 'active', created_at: new Date().toISOString() },
        },
        {
          economy_subtract_balance: { data: true, error: null },
          lottery_buy_tickets: { error: { message: 'DB error' } },
          economy_add_balance: { data: true, error: null },
        },
      );
      mgr = new LotteryManager(supabase as any);
      const interaction = makeInteraction();
      await mgr.buyTickets(interaction as any, 1);
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('refunded'),
      }));
    });

    it('handles buy RPC failure with max tickets exceeded', async () => {
      supabase = makeSupabase(
        {
          guild_config: { economy_lottery_enabled: true, economy_lottery_max_tickets: 10, economy_lottery_ticket_price: 100 },
          economy_wallets: { wallet: 1000 },
          economy_lottery_drawings: { id: 'd1', jackpot: 500, status: 'active', created_at: new Date().toISOString() },
        },
        {
          economy_subtract_balance: { data: true, error: null },
          lottery_buy_tickets: { error: { message: 'would exceed max tickets' } },
          economy_add_balance: { data: true, error: null },
        },
      );
      mgr = new LotteryManager(supabase as any);
      const interaction = makeInteraction();
      await mgr.buyTickets(interaction as any, 1);
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('maximum'),
      }));
    });

    it('handles no drawing created', async () => {
      supabase = makeSupabase(
        {
          guild_config: { economy_lottery_enabled: true, economy_lottery_max_tickets: 10, economy_lottery_ticket_price: 100 },
          economy_wallets: { wallet: 1000 },
          economy_lottery_drawings: null,
        },
      );
      mgr = new LotteryManager(supabase as any);
      const interaction = makeInteraction();
      await mgr.buyTickets(interaction as any, 1);
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('Could not create'),
      }));
    });
  });

  describe('viewLottery', () => {
    it('rejects when not enabled', async () => {
      supabase = makeSupabase({ guild_config: { economy_lottery_enabled: false } });
      mgr = new LotteryManager(supabase as any);
      const interaction = makeInteraction();
      await mgr.viewLottery(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('not enabled'),
      }));
    });

    it('shows no active drawing', async () => {
      supabase = makeSupabase({
        guild_config: { economy_lottery_enabled: true, economy_lottery_schedule: 'weekly', economy_lottery_ticket_price: 100 },
        economy_lottery_drawings: null,
      });
      mgr = new LotteryManager(supabase as any);
      const interaction = makeInteraction();
      await mgr.viewLottery(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
        embeds: expect.any(Array),
      }));
    });

    it('shows active drawing with tickets', async () => {
      supabase = makeSupabase({
        guild_config: { economy_lottery_enabled: true, economy_lottery_schedule: 'daily', economy_lottery_ticket_price: 50 },
        economy_lottery_drawings: { id: 'd1', jackpot: 5000, status: 'active' },
        economy_lottery_tickets: [{ user_id: 'u1' }, { user_id: 'u1' }, { user_id: 'u2' }],
      });
      mgr = new LotteryManager(supabase as any);
      const interaction = makeInteraction();
      await mgr.viewLottery(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
        embeds: expect.any(Array),
      }));
    });
  });

  describe('drawWinner', () => {
    it('returns null when no active drawing', async () => {
      supabase = makeSupabase({ economy_lottery_drawings: null });
      mgr = new LotteryManager(supabase as any);
      const result = await mgr.drawWinner('g1');
      expect(result).toBeNull();
    });

    it('returns null when claim fails', async () => {
      supabase = makeSupabase(
        { economy_lottery_drawings: { id: 'd1', jackpot: 1000, status: 'active' } },
        { lottery_claim_drawing: { data: null, error: { message: 'claim failed' } } },
      );
      mgr = new LotteryManager(supabase as any);
      const result = await mgr.drawWinner('g1');
      expect(result).toBeNull();
    });

    it('returns null when already claimed by another worker', async () => {
      supabase = makeSupabase(
        { economy_lottery_drawings: { id: 'd1', jackpot: 1000, status: 'active' } },
        { lottery_claim_drawing: { data: null, error: null } },
      );
      mgr = new LotteryManager(supabase as any);
      const result = await mgr.drawWinner('g1');
      expect(result).toBeNull();
    });

    it('returns null when no tickets and reverts to active', async () => {
      supabase = makeSupabase(
        {
          economy_lottery_drawings: { id: 'd1', jackpot: 1000, status: 'active' },
          economy_lottery_tickets: null,
        },
        {
          lottery_claim_drawing: { data: [{ id: 'd1', jackpot: 1000 }], error: null },
        },
      );
      mgr = new LotteryManager(supabase as any);
      const result = await mgr.drawWinner('g1');
      expect(result).toBeNull();
    });

    it('draws winner and pays out successfully', async () => {
      supabase = makeSupabase(
        {
          economy_lottery_drawings: { id: 'd1', jackpot: 1000, status: 'active' },
          economy_lottery_tickets: [{ user_id: 'u1', ticket_number: 42 }],
        },
        {
          lottery_claim_drawing: { data: [{ id: 'd1', jackpot: 1000 }], error: null },
          economy_add_balance: { data: true, error: null },
        },
      );
      mgr = new LotteryManager(supabase as any);
      const result = await mgr.drawWinner('g1');
      expect(result).toEqual({ winnerId: 'u1', jackpot: 1000, winningNumber: 42 });
    });

    it('reverts on jackpot payout failure', async () => {
      supabase = makeSupabase(
        {
          economy_lottery_drawings: { id: 'd1', jackpot: 1000, status: 'active' },
          economy_lottery_tickets: [{ user_id: 'u1', ticket_number: 42 }],
        },
        {
          lottery_claim_drawing: { data: [{ id: 'd1', jackpot: 1000 }], error: null },
          economy_add_balance: { error: { message: 'payout failed' } },
        },
      );
      mgr = new LotteryManager(supabase as any);
      const result = await mgr.drawWinner('g1');
      expect(result).toBeNull();
    });
  });
});
