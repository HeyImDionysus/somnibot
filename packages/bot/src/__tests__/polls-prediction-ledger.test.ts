/**
 * Prediction ledger wiring (#58).
 *
 * Prediction money must move through economy_prediction_settle — the atomic
 * RPC that applies the wallet delta AND writes the economy_transactions row
 * (types prediction_bet / prediction_payout / prediction_refund, request_id
 * = the prediction_bets row id) — never through the raw wallet RPCs that
 * left /mydata and analytics blind to prediction activity.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('discord.js', () => ({
  EmbedBuilder: class {
    setTitle() { return this; } setDescription() { return this; } setColor() { return this; }
    setFooter() { return this; } setTimestamp() { return this; } addFields() { return this; }
  },
  ActionRowBuilder: class { addComponents() { return this; } },
  ButtonBuilder: class {
    setCustomId() { return this; } setLabel() { return this; } setStyle() { return this; }
  },
  ButtonStyle: { Primary: 1, Secondary: 2 },
}));

vi.mock('../features/quests/quests-manager.js', () => ({ getQuestsManager: () => null }));
vi.mock('../features/branding/brand-kit.js', () => ({
  resolveBrandKit: vi.fn(async () => ({ brandName: 'Test' })),
}));

import { PollsManager } from '../features/polls/polls-manager.js';

/**
 * Table-aware supabase double: single()/maybeSingle() pop per-table queues,
 * awaiting a bare chain resolves the table's list result, and every rpc call
 * dispatches on the function name.
 */
function makeSupa(config: {
  singles?: Record<string, any[]>;
  lists?: Record<string, any>;
  rpcs?: Record<string, any>;
}) {
  const singles = config.singles ?? {};
  const lists = config.lists ?? {};
  const rpcCalls: Array<{ fn: string; args: any }> = [];
  const tableCalls: Record<string, Record<string, any[][]>> = {};

  function chainFor(table: string) {
    const c: any = {};
    const record = (m: string) => (...a: any[]) => {
      ((tableCalls[table] ??= {})[m] ??= []).push(a);
      return c;
    };
    for (const m of ['select', 'insert', 'update', 'delete', 'upsert', 'eq', 'neq',
      'order', 'limit', 'in', 'is', 'gte', 'lte', 'range', 'or']) {
      c[m] = vi.fn(record(m));
    }
    const popSingle = () => {
      const queue = singles[table] ?? [];
      return Promise.resolve(queue.length > 0 ? queue.shift() : { data: null, error: null });
    };
    c.single = vi.fn(popSingle);
    c.maybeSingle = vi.fn(popSingle);
    c.then = (resolve: (v: any) => any) =>
      resolve(lists[table] ?? { data: null, error: null });
    return c;
  }

  const supa = {
    from: vi.fn((t: string) => chainFor(t)),
    rpc: vi.fn(async (fn: string, args: any) => {
      rpcCalls.push({ fn, args });
      return config.rpcs?.[fn] ?? { data: null, error: null };
    }),
    _rpcCalls: rpcCalls,
    _tableCalls: tableCalls,
  } as any;
  return supa;
}

const bus = () => ({ emit: vi.fn() }) as any;

const CONFIG = {
  data: {
    predictions_enabled: true, polls_enabled: true, currency_name: 'coins',
    prediction_min_bet: 1, prediction_max_bet: 0,
  },
  error: null,
};

function betInteraction(userId = 'u1') {
  return {
    guildId: 'g1', channelId: 'ch1', user: { id: userId },
    reply: vi.fn(async () => {}),
    deferred: false, replied: false,
  } as any;
}

describe('placeBet — prediction_bet ledger settlement', () => {
  function betSupa(settleResult: any) {
    return makeSupa({
      singles: {
        guild_config: [CONFIG],
        predictions: [{ data: { id: 'pred1', status: 'open', total_pool: 100 }, error: null }],
        prediction_bets: [
          { data: null, error: { code: 'PGRST116' } },       // no existing bet
          { data: { id: 'bet-1' }, error: null },            // inserted bet row
        ],
        economy_wallets: [{ data: { wallet: 1_000 }, error: null }],
      },
      lists: {
        prediction_options: { data: [{ id: 'opt1' }, { id: 'opt2' }], error: null },
      },
      rpcs: {
        economy_prediction_settle: settleResult,
        economy_increment_prediction_pool: { data: 150, error: null },
      },
    });
  }

  it('debits via economy_prediction_settle keyed on the bet row id', async () => {
    const supa = betSupa({ data: { status: 'settled', wallet_balance: 950 }, error: null });
    const eventBus = bus();
    const mgr = new PollsManager(supa, eventBus);

    await mgr.placeBet(betInteraction(), 'pred1', 0, 50);

    const settle = supa._rpcCalls.find((c: any) => c.fn === 'economy_prediction_settle');
    expect(settle).toBeDefined();
    expect(settle.args).toMatchObject({
      p_guild_id: 'g1',
      p_user_id: 'u1',
      p_amount: -50,
      p_type: 'prediction_bet',
      p_request_id: 'bet-1',
    });
    // The legacy wallet-only RPC must be gone from this path.
    expect(supa._rpcCalls.some((c: any) => c.fn === 'economy_subtract_balance')).toBe(false);
    expect(eventBus.emit).toHaveBeenCalledWith('prediction.bet_placed', 'g1',
      expect.objectContaining({ predictionId: 'pred1', userId: 'u1', amount: 50 }));
  });

  it('rolls the bet row back when the settlement reports insufficient funds', async () => {
    const supa = betSupa({ data: { status: 'insufficient_funds', wallet_balance: 10 }, error: null });
    const eventBus = bus();
    const mgr = new PollsManager(supa, eventBus);
    const interaction = betInteraction();

    await mgr.placeBet(interaction, 'pred1', 0, 50);

    expect(supa._tableCalls.prediction_bets?.delete?.length ?? 0).toBe(1);
    expect(supa._rpcCalls.some((c: any) => c.fn === 'economy_increment_prediction_pool')).toBe(false);
    expect(eventBus.emit).not.toHaveBeenCalled();
    expect(String(interaction.reply.mock.calls.at(-1)[0].content)).toMatch(/Payment failed/);
  });

  it('refunds through the ledger RPC when the pool update fails', async () => {
    const supa = makeSupa({
      singles: {
        guild_config: [CONFIG],
        predictions: [{ data: { id: 'pred1', status: 'open', total_pool: 100 }, error: null }],
        prediction_bets: [
          { data: null, error: { code: 'PGRST116' } },
          { data: { id: 'bet-1' }, error: null },
        ],
        economy_wallets: [{ data: { wallet: 1_000 }, error: null }],
      },
      lists: {
        prediction_options: { data: [{ id: 'opt1' }], error: null },
      },
      rpcs: {
        economy_prediction_settle: { data: { status: 'settled' }, error: null },
        economy_increment_prediction_pool: { data: null, error: { message: 'pool down' } },
      },
    });
    const mgr = new PollsManager(supa, bus());

    await mgr.placeBet(betInteraction(), 'pred1', 0, 50);

    const settles = supa._rpcCalls.filter((c: any) => c.fn === 'economy_prediction_settle');
    expect(settles).toHaveLength(2);
    expect(settles[1].args).toMatchObject({
      p_amount: 50,
      p_type: 'prediction_refund',
      p_request_id: 'bet-1',
    });
    expect(supa._rpcCalls.some((c: any) => c.fn === 'economy_add_balance')).toBe(false);
  });
});

describe('resolvePrediction — payout and refund ledger settlement', () => {
  function resolveSupa(bets: any[], resolvedPool = 300) {
    return makeSupa({
      singles: {
        guild_config: [CONFIG],
        predictions: [{
          data: { id: 'pred1', title: 'Who wins?', creator_user_id: 'creator', status: 'open', total_pool: resolvedPool },
          error: null,
        }],
      },
      lists: {
        prediction_options: { data: [{ id: 'opt1', label: 'A' }, { id: 'opt2', label: 'B' }], error: null },
        prediction_bets: { data: bets, error: null },
      },
      rpcs: {
        predictions_resolve_atomic: { data: [{ total_pool: resolvedPool }], error: null },
        economy_prediction_settle: { data: { status: 'settled' }, error: null },
      },
    });
  }

  function resolveInteraction() {
    return {
      guildId: 'g1', user: { id: 'creator' },
      reply: vi.fn(async () => {}),
    } as any;
  }

  it('pays winners via economy_prediction_settle (type prediction_payout)', async () => {
    const supa = resolveSupa([
      { id: 'b1', user_id: 'w1', option_id: 'opt1', amount: 100, payout: null },
      { id: 'b2', user_id: 'l1', option_id: 'opt2', amount: 200, payout: null },
    ]);
    const eventBus = bus();
    const mgr = new PollsManager(supa, eventBus);

    await mgr.resolvePrediction(resolveInteraction(), 'pred1', 0);

    const settles = supa._rpcCalls.filter((c: any) => c.fn === 'economy_prediction_settle');
    expect(settles).toHaveLength(1);
    expect(settles[0].args).toMatchObject({
      p_guild_id: 'g1',
      p_user_id: 'w1',
      p_amount: 300, // sole winner takes the whole pool
      p_type: 'prediction_payout',
      p_request_id: 'b1',
    });
    expect(supa._rpcCalls.some((c: any) => c.fn === 'economy_add_balance')).toBe(false);
    expect(eventBus.emit).toHaveBeenCalledWith('prediction.resolved', 'g1',
      expect.objectContaining({ predictionId: 'pred1', payoutCount: 1, refundedCount: 0 }));
  });

  it('refunds all bettors via prediction_refund when nobody picked the winner', async () => {
    const supa = resolveSupa([
      { id: 'b1', user_id: 'u1', option_id: 'opt2', amount: 100, payout: null },
      { id: 'b2', user_id: 'u2', option_id: 'opt2', amount: 200, payout: null },
    ]);
    const eventBus = bus();
    const mgr = new PollsManager(supa, eventBus);

    await mgr.resolvePrediction(resolveInteraction(), 'pred1', 0);

    const settles = supa._rpcCalls.filter((c: any) => c.fn === 'economy_prediction_settle');
    expect(settles).toHaveLength(2);
    expect(settles[0].args).toMatchObject({
      p_user_id: 'u1', p_amount: 100, p_type: 'prediction_refund', p_request_id: 'b1',
    });
    expect(settles[1].args).toMatchObject({
      p_user_id: 'u2', p_amount: 200, p_type: 'prediction_refund', p_request_id: 'b2',
    });
    expect(eventBus.emit).toHaveBeenCalledWith('prediction.resolved', 'g1',
      expect.objectContaining({ payoutCount: 0, refundedCount: 2 }));
  });
});
