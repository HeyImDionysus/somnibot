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

vi.mock('../quests/quests-manager.js', () => ({
  getQuestsManager: () => ({
    trackProgress: vi.fn().mockResolvedValue(undefined),
  }),
}));

import { LotteryManager, registerLotteryManager, invalidateLotteryCache } from '../features/lottery/lottery-manager.js';

// ── Helpers ───────────────────────────────────────────────

function makeSupabase(tableData: Record<string, any> = {}, rpcResults: Record<string, any> = {}, tableErrors: Record<string, any> = {}) {
  const fromMock = vi.fn();
  fromMock.mockImplementation((table: string) => {
    const chain: Record<string, any> = {};
    const methods = ['select', 'eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'in', 'order', 'limit', 'single', 'insert', 'update', 'delete', 'maybeSingle'];
    for (const m of methods) {
      chain[m] = vi.fn().mockReturnValue(chain);
    }
    const error = tableErrors[table] ?? null;
    const data = error ? null : (tableData[table] ?? null);
    chain.then = (resolve: (v: any) => void) => resolve({ data, error });
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
      registerLotteryManager(mgr, 'test-guild-id');
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

    it('refunds and explains when the drawing closed while the buy was in flight', async () => {
      supabase = makeSupabase(
        {
          guild_config: { economy_lottery_enabled: true, economy_lottery_max_tickets: 10, economy_lottery_ticket_price: 100 },
          economy_wallets: { wallet: 1000 },
          economy_lottery_drawings: { id: 'd1', jackpot: 500, status: 'active', created_at: new Date().toISOString() },
        },
        {
          economy_subtract_balance: { data: true, error: null },
          // Typed guard from 20260709190000: the scheduler claimed the
          // drawing while this purchase waited on the row lock.
          lottery_buy_tickets: { error: { message: 'lottery_buy_tickets: drawing d1 is not active (status=drawing)' } },
          economy_add_balance: { data: true, error: null },
        },
      );
      mgr = new LotteryManager(supabase as any);
      const interaction = makeInteraction();
      await mgr.buyTickets(interaction as any, 1);
      // The debit must be refunded — the user cannot silently lose coins.
      expect(supabase.rpc).toHaveBeenCalledWith('economy_add_balance', expect.objectContaining({
        p_guild_id: 'g1', p_user_id: 'u1', p_amount: 100,
      }));
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('just closed'),
        ephemeral: true,
      }));
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('refunded'),
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
    /** Collect update() payloads sent to a given table across all from() calls. */
    function updatePayloads(supa: ReturnType<typeof makeSupabase>, table: string): any[] {
      return supa.from.mock.calls
        .map((args: any[], i: number) => ({ table: args[0], chain: supa.from.mock.results[i].value }))
        .filter((e: any) => e.table === table)
        .flatMap((e: any) => e.chain.update.mock.calls.map((c: any[]) => c[0]));
    }

    function rpcNames(supa: ReturnType<typeof makeSupabase>): string[] {
      return supa.rpc.mock.calls.map((c: any[]) => c[0]);
    }

    it('returns null when no pending drawing', async () => {
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
      // Never attempts a payout for a drawing it did not claim.
      expect(rpcNames(supabase)).not.toContain('lottery_award_jackpot');
    });

    it('returns null when claim returns no row for an empty drawing (left active for reset)', async () => {
      supabase = makeSupabase(
        { economy_lottery_drawings: { id: 'd1', jackpot: 1000, status: 'active' } },
        { lottery_claim_drawing: { data: [], error: null } },
      );
      mgr = new LotteryManager(supabase as any);
      const result = await mgr.drawWinner('g1');
      expect(result).toBeNull();
      // The RPC leaves ticketless drawings 'active'; the manager must not
      // flip status itself (the scheduler's reset path handles cancellation).
      expect(updatePayloads(supabase, 'economy_lottery_drawings')).toEqual([]);
    });

    it('draws winner and pays out via lottery_award_jackpot', async () => {
      const row = { id: 'd1', guild_id: 'g1', jackpot: 1000, winner_user_id: 'u1', winning_number: 42 };
      supabase = makeSupabase(
        { economy_lottery_drawings: { id: 'd1', jackpot: 1000, status: 'active' } },
        {
          lottery_claim_drawing: { data: [row], error: null },
          lottery_award_jackpot: { data: [row], error: null },
        },
      );
      mgr = new LotteryManager(supabase as any);
      const result = await mgr.drawWinner('g1');
      expect(result).toEqual({ winnerId: 'u1', jackpot: 1000, winningNumber: 42 });
      // Payout and finalisation happen inside lottery_award_jackpot — the
      // manager must not credit the wallet or flip status itself.
      expect(rpcNames(supabase)).not.toContain('economy_add_balance');
      expect(updatePayloads(supabase, 'economy_lottery_drawings')).toEqual([]);
    });

    it('payout failure keeps the claim and stored winner (no revert to active)', async () => {
      const row = { id: 'd1', guild_id: 'g1', jackpot: 1000, winner_user_id: 'u1', winning_number: 42 };
      supabase = makeSupabase(
        { economy_lottery_drawings: { id: 'd1', jackpot: 1000, status: 'active' } },
        {
          lottery_claim_drawing: { data: [row], error: null },
          lottery_award_jackpot: { data: null, error: { message: 'payout failed' } },
        },
      );
      mgr = new LotteryManager(supabase as any);
      const result = await mgr.drawWinner('g1');
      expect(result).toBeNull();
      // The drawing must stay in 'drawing' with its stored winner so the next
      // tick retries the SAME winner — reverting to 'active' re-rolled it.
      expect(updatePayloads(supabase, 'economy_lottery_drawings')).toEqual([]);
    });

    it('retry tick pays the SAME stored winner without re-picking', async () => {
      const stored = { id: 'd1', guild_id: 'g1', jackpot: 1000, winner_user_id: 'u2', winning_number: 77 };
      supabase = makeSupabase(
        {
          economy_lottery_drawings: { id: 'd1', jackpot: 1000, status: 'drawing', winner_user_id: 'u2', winning_number: 77 },
          economy_lottery_tickets: [{ user_id: 'u9', ticket_number: 1 }],
        },
        { lottery_award_jackpot: { data: [stored], error: null } },
      );
      mgr = new LotteryManager(supabase as any);
      const result = await mgr.drawWinner('g1');
      expect(result).toEqual({ winnerId: 'u2', jackpot: 1000, winningNumber: 77 });
      // Already claimed with a stored winner: no re-claim, no re-pick.
      expect(rpcNames(supabase)).not.toContain('lottery_claim_drawing');
      expect(supabase.from).not.toHaveBeenCalledWith('economy_lottery_tickets');
    });

    it('does not repeat a payout that already succeeded on a second tick', async () => {
      supabase = makeSupabase(
        { economy_lottery_drawings: { id: 'd1', jackpot: 1000, status: 'drawing', winner_user_id: 'u2', winning_number: 77 } },
        { lottery_award_jackpot: { data: [], error: null } },
      );
      mgr = new LotteryManager(supabase as any);
      const result = await mgr.drawWinner('g1');
      expect(result).toBeNull();
      // The award RPC is the idempotency gate: it was consulted exactly once
      // and returned no row, so no wallet credit may happen.
      expect(rpcNames(supabase).filter((n: string) => n === 'lottery_award_jackpot')).toHaveLength(1);
      expect(rpcNames(supabase)).not.toContain('economy_add_balance');
    });

    it('does not cancel or announce a reset while a payout retry is pending', async () => {
      supabase = makeSupabase(
        {
          guild_config: { economy_lottery_enabled: true, economy_lottery_schedule: 'daily', economy_log_channel_id: 'ch1' },
          economy_lottery_drawings: { id: 'd1', jackpot: 1000, status: 'drawing', winner_user_id: 'u2', winning_number: 77 },
        },
        { lottery_award_jackpot: { data: null, error: { message: 'payout failed' } } },
      );
      const send = vi.fn().mockResolvedValue(undefined);
      const client = { channels: { cache: new Map([['ch1', { send }]]) } };
      mgr = new LotteryManager(supabase as any, client as any);

      const config = { economy_lottery_enabled: true, economy_log_channel_id: 'ch1' };
      await (mgr as any).executeDrawAndAnnounce('g1', config);

      // The claimed drawing (stored winner, payout pending) must not be
      // cancelled as "no entries", and no reset may be announced.
      expect(updatePayloads(supabase, 'economy_lottery_drawings')).toEqual([]);
      expect(send).not.toHaveBeenCalled();
    });

    it('cancels and announces the reset for a ticketless active drawing', async () => {
      supabase = makeSupabase(
        {
          economy_lottery_drawings: { id: 'd1', jackpot: 0, status: 'active' },
          // A successful zero-row select resolves to [] (never null) — the
          // reset requires this genuine "succeeded with zero rows" shape.
          economy_lottery_tickets: [],
        },
        { lottery_claim_drawing: { data: [], error: null } },
      );
      const send = vi.fn().mockResolvedValue(undefined);
      const client = { channels: { cache: new Map([['ch1', { send }]]) } };
      mgr = new LotteryManager(supabase as any, client as any);

      const config = { economy_lottery_enabled: true, economy_log_channel_id: 'ch1' };
      await (mgr as any).executeDrawAndAnnounce('g1', config);

      expect(updatePayloads(supabase, 'economy_lottery_drawings')).toEqual([
        expect.objectContaining({ status: 'cancelled' }),
      ]);
      expect(send).toHaveBeenCalled();
    });

    it('does not cancel a ticketed active drawing it did not evaluate', async () => {
      supabase = makeSupabase(
        {
          economy_lottery_drawings: { id: 'd2', jackpot: 300, status: 'active' },
          economy_lottery_tickets: [{ id: 't1', user_id: 'u1', ticket_number: 5 }],
        },
        // Another worker won the claim race — this tick gets no row back.
        { lottery_claim_drawing: { data: [], error: null } },
      );
      const send = vi.fn().mockResolvedValue(undefined);
      const client = { channels: { cache: new Map([['ch1', { send }]]) } };
      mgr = new LotteryManager(supabase as any, client as any);

      const config = { economy_lottery_enabled: true, economy_log_channel_id: 'ch1' };
      await (mgr as any).executeDrawAndAnnounce('g1', config);

      // A drawing with tickets is never a "no entries" reset.
      expect(updatePayloads(supabase, 'economy_lottery_drawings')).toEqual([]);
      expect(send).not.toHaveBeenCalled();
    });

    it('does not cancel the drawing when the ticket lookup errors', async () => {
      supabase = makeSupabase(
        { economy_lottery_drawings: { id: 'd1', jackpot: 0, status: 'active' } },
        { lottery_claim_drawing: { data: [], error: null } },
        // Transient DB failure on the entries check: data comes back null,
        // which must NOT be mistaken for "zero entries" — that destroyed a
        // live lottery.
        { economy_lottery_tickets: { message: 'connection reset by peer' } },
      );
      const send = vi.fn().mockResolvedValue(undefined);
      const client = { channels: { cache: new Map([['ch1', { send }]]) } };
      mgr = new LotteryManager(supabase as any, client as any);

      const config = { economy_lottery_enabled: true, economy_log_channel_id: 'ch1' };
      await (mgr as any).executeDrawAndAnnounce('g1', config);

      expect(updatePayloads(supabase, 'economy_lottery_drawings')).toEqual([]);
      expect(send).not.toHaveBeenCalled();
    });

    it('does not cancel when the ticket lookup yields no result set at all', async () => {
      supabase = makeSupabase(
        {
          economy_lottery_drawings: { id: 'd1', jackpot: 0, status: 'active' },
          economy_lottery_tickets: null, // no rowset — NOT a confirmed zero-row result
        },
        { lottery_claim_drawing: { data: [], error: null } },
      );
      const send = vi.fn().mockResolvedValue(undefined);
      const client = { channels: { cache: new Map([['ch1', { send }]]) } };
      mgr = new LotteryManager(supabase as any, client as any);

      const config = { economy_lottery_enabled: true, economy_log_channel_id: 'ch1' };
      await (mgr as any).executeDrawAndAnnounce('g1', config);

      expect(updatePayloads(supabase, 'economy_lottery_drawings')).toEqual([]);
      expect(send).not.toHaveBeenCalled();
    });

    it('resets exactly the drawing that was selected for drawing', async () => {
      // The scheduler selected this (oldest, empty) drawing; a NEWER active
      // drawing with tickets also exists. The reset must target the selected
      // row by id — re-fetching "the newest active drawing" here inspected
      // the other row, skipped the cancel, and the scheduler re-selected the
      // same empty row forever while the ticketed drawing was never drawn.
      const selected = { id: 'old-1', jackpot: 0, status: 'active', created_at: '2026-01-01T00:00:00Z' };
      supabase = makeSupabase(
        {
          economy_lottery_drawings: { id: 'old-1', status: 'active' },
          economy_lottery_tickets: [],
        },
        { lottery_claim_drawing: { data: [], error: null } },
      );
      const send = vi.fn().mockResolvedValue(undefined);
      const client = { channels: { cache: new Map([['ch1', { send }]]) } };
      mgr = new LotteryManager(supabase as any, client as any);

      const config = { economy_lottery_enabled: true, economy_log_channel_id: 'ch1' };
      await (mgr as any).executeDrawAndAnnounce('g1', config, selected);

      const chainsFor = (table: string) => supabase.from.mock.calls
        .map((args: any[], i: number) => ({ table: args[0], chain: supabase.from.mock.results[i].value }))
        .filter((e: any) => e.table === table)
        .map((e: any) => e.chain);

      // The entries check ran against the SELECTED drawing…
      const ticketChains = chainsFor('economy_lottery_tickets');
      expect(ticketChains).toHaveLength(1);
      expect(ticketChains[0].eq.mock.calls).toContainEqual(['drawing_id', 'old-1']);

      // …and the cancel targeted the SELECTED drawing, guarded on status.
      const cancelChains = chainsFor('economy_lottery_drawings')
        .filter((c: any) => c.update.mock.calls.length > 0);
      expect(cancelChains).toHaveLength(1);
      expect(cancelChains[0].update.mock.calls[0][0]).toEqual(expect.objectContaining({ status: 'cancelled' }));
      expect(cancelChains[0].eq.mock.calls).toContainEqual(['id', 'old-1']);
      expect(cancelChains[0].eq.mock.calls).toContainEqual(['status', 'active']);
      expect(send).toHaveBeenCalled();
    });

    it('checkAndDraw hands the drawing it selected to drawWinner', async () => {
      const selected = {
        id: 'old-1', jackpot: 0, status: 'active',
        created_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
      };
      supabase = makeSupabase(
        {
          guild_config: { economy_lottery_enabled: true, economy_lottery_schedule: 'daily' },
          economy_lottery_drawings: selected,
          economy_lottery_tickets: [],
        },
        { lottery_claim_drawing: { data: [], error: null } },
      );
      mgr = new LotteryManager(supabase as any);
      const spy = vi.spyOn(mgr, 'drawWinner');

      await (mgr as any).checkAndDraw('g1');

      // Selection happens once, up front — the whole tick acts on that row.
      expect(spy).toHaveBeenCalledWith('g1', expect.objectContaining({ id: 'old-1' }));
    });

    it('pays out to exactly one of two racing workers', async () => {
      const row = { id: 'd1', guild_id: 'g1', jackpot: 1000, winner_user_id: 'u1', winning_number: 42 };
      let claims = 0;
      let awards = 0;
      const fromFactory = makeSupabase({ economy_lottery_drawings: { id: 'd1', jackpot: 1000, status: 'active' } });
      const racingSupabase = {
        from: fromFactory.from,
        rpc: vi.fn().mockImplementation((name: string) => {
          // First caller wins the claim and the award; the loser gets no rows.
          if (name === 'lottery_claim_drawing') {
            return Promise.resolve({ data: ++claims === 1 ? [row] : [], error: null });
          }
          if (name === 'lottery_award_jackpot') {
            return Promise.resolve({ data: ++awards === 1 ? [row] : [], error: null });
          }
          return Promise.resolve({ data: null, error: null });
        }),
      };
      mgr = new LotteryManager(racingSupabase as any);
      const [first, second] = await Promise.all([mgr.drawWinner('g1'), mgr.drawWinner('g1')]);
      const winners = [first, second].filter((r) => r !== null);
      expect(winners).toHaveLength(1);
      expect(winners[0]).toEqual({ winnerId: 'u1', jackpot: 1000, winningNumber: 42 });
    });
  });
});
