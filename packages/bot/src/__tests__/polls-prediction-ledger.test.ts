/**
 * Prediction ledger wiring (#58) + money-layer review (2026-07-26).
 *
 * Prediction money must move through economy_prediction_settle — the atomic
 * RPC that applies the wallet delta AND writes the economy_transactions row
 * (types prediction_bet / prediction_payout / prediction_refund, request_id
 * = the prediction_bets row id) — never through the raw wallet RPCs that
 * left /mydata and analytics blind to prediction activity.
 *
 * Review invariants covered here:
 *  - DEBIT-FIRST: the debit settles (keyed on a client-generated bet id)
 *    BEFORE the bet row exists; the row lands via the prediction_place_bet
 *    closed-state fence, and every fence refusal refunds through the key.
 *  - Ambiguous debit errors are probed by re-calling with identical args.
 *  - resolve counts are honest: replayed settles neither count nor rewrite
 *    markers; conflicting settlements are clean skips; RPC errors leave the
 *    marker NULL so an already-resolved /predict resolve re-drives them.
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Table-aware supabase double: single()/maybeSingle() pop per-table queues,
 * awaiting a bare chain resolves the table's list result, and every rpc call
 * dispatches on the function name. An rpc entry may be an ARRAY to script
 * sequential results (probe/retry flows); the last entry repeats.
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
      const scripted = config.rpcs?.[fn];
      if (Array.isArray(scripted)) {
        return scripted.length > 1 ? scripted.shift() : scripted[0] ?? { data: null, error: null };
      }
      return scripted ?? { data: null, error: null };
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

function betSupa(rpcs: Record<string, any>) {
  return makeSupa({
    singles: {
      guild_config: [CONFIG],
      predictions: [{ data: { id: 'pred1', status: 'open', total_pool: 100 }, error: null }],
      prediction_bets: [
        { data: null, error: { code: 'PGRST116' } },       // no existing bet
      ],
      economy_wallets: [{ data: { wallet: 1_000 }, error: null }],
    },
    lists: {
      prediction_options: { data: [{ id: 'opt1' }, { id: 'opt2' }], error: null },
    },
    rpcs,
  });
}

describe('placeBet — debit-first prediction_bet ledger settlement', () => {
  it('settles the debit BEFORE the bet row lands, keyed on one client-generated bet id', async () => {
    const supa = betSupa({
      economy_prediction_settle: { data: { status: 'settled', replayed: false, wallet_balance: 950 }, error: null },
      prediction_place_bet: { data: { status: 'inserted', replayed: false, new_pool: 150 }, error: null },
    });
    const eventBus = bus();
    const mgr = new PollsManager(supa, eventBus);

    await mgr.placeBet(betInteraction(), 'pred1', 0, 50);

    const settleIdx = supa._rpcCalls.findIndex((c: any) => c.fn === 'economy_prediction_settle');
    const placeIdx = supa._rpcCalls.findIndex((c: any) => c.fn === 'prediction_place_bet');
    expect(settleIdx).toBeGreaterThanOrEqual(0);
    expect(placeIdx).toBeGreaterThanOrEqual(0);
    // DEBIT-FIRST ordering: the money moves before the bet row can exist.
    expect(settleIdx).toBeLessThan(placeIdx);

    const settle = supa._rpcCalls[settleIdx];
    const place = supa._rpcCalls[placeIdx];
    expect(settle.args).toMatchObject({
      p_guild_id: 'g1',
      p_user_id: 'u1',
      p_amount: -50,
      p_type: 'prediction_bet',
    });
    // One id keys the debit AND identifies the bet row.
    expect(settle.args.p_request_id).toMatch(UUID_RE);
    expect(place.args).toMatchObject({
      p_bet_id: settle.args.p_request_id,
      p_prediction_id: 'pred1',
      p_option_id: 'opt1',
      p_guild_id: 'g1',
      p_user_id: 'u1',
      p_amount: 50,
    });
    // No direct PostgREST insert — the fenced RPC owns the row + pool.
    expect(supa._tableCalls.prediction_bets?.insert ?? []).toHaveLength(0);
    // The legacy wallet-only RPCs must be gone from this path.
    expect(supa._rpcCalls.some((c: any) => c.fn === 'economy_subtract_balance')).toBe(false);
    expect(supa._rpcCalls.some((c: any) => c.fn === 'economy_increment_prediction_pool')).toBe(false);
    expect(eventBus.emit).toHaveBeenCalledWith('prediction.bet_placed', 'g1',
      expect.objectContaining({ predictionId: 'pred1', userId: 'u1', amount: 50, newPool: 150 }));
  });

  it('stops on insufficient funds without touching the bet row', async () => {
    const supa = betSupa({
      economy_prediction_settle: { data: { status: 'insufficient_funds', replayed: false, wallet_balance: 10 }, error: null },
    });
    const eventBus = bus();
    const mgr = new PollsManager(supa, eventBus);
    const interaction = betInteraction();

    await mgr.placeBet(interaction, 'pred1', 0, 50);

    expect(supa._rpcCalls.some((c: any) => c.fn === 'prediction_place_bet')).toBe(false);
    expect(supa._tableCalls.prediction_bets?.delete ?? []).toHaveLength(0);
    expect(eventBus.emit).not.toHaveBeenCalled();
    expect(String(interaction.reply.mock.calls.at(-1)[0].content)).toMatch(/Payment failed/);
  });

  it('closed-state fence: refunds the settled debit through the key when the prediction closed meanwhile', async () => {
    const supa = betSupa({
      economy_prediction_settle: [
        { data: { status: 'settled', replayed: false }, error: null },  // debit
        { data: { status: 'settled', replayed: false }, error: null },  // refund
      ],
      prediction_place_bet: { data: { status: 'closed', replayed: false }, error: null },
    });
    const eventBus = bus();
    const mgr = new PollsManager(supa, eventBus);
    const interaction = betInteraction();

    await mgr.placeBet(interaction, 'pred1', 0, 50);

    const settles = supa._rpcCalls.filter((c: any) => c.fn === 'economy_prediction_settle');
    expect(settles).toHaveLength(2);
    expect(settles[1].args).toMatchObject({
      p_amount: 50,
      p_type: 'prediction_refund',
      p_request_id: settles[0].args.p_request_id,
    });
    expect(eventBus.emit).not.toHaveBeenCalled();
    expect(String(interaction.reply.mock.calls.at(-1)[0].content)).toMatch(/just closed/);
    expect(String(interaction.reply.mock.calls.at(-1)[0].content)).toMatch(/refunded/);
  });

  it('duplicate fence refusal refunds this attempt and replies already-placed', async () => {
    const supa = betSupa({
      economy_prediction_settle: [
        { data: { status: 'settled', replayed: false }, error: null },
        { data: { status: 'settled', replayed: false }, error: null },
      ],
      prediction_place_bet: { data: { status: 'duplicate', replayed: false }, error: null },
    });
    const mgr = new PollsManager(supa, bus());
    const interaction = betInteraction();

    await mgr.placeBet(interaction, 'pred1', 0, 50);

    const settles = supa._rpcCalls.filter((c: any) => c.fn === 'economy_prediction_settle');
    expect(settles).toHaveLength(2);
    expect(settles[1].args).toMatchObject({ p_type: 'prediction_refund', p_amount: 50 });
    expect(String(interaction.reply.mock.calls.at(-1)[0].content)).toMatch(/already placed/);
  });

  it('probes an ambiguous debit error: replayed=true proves the debit committed and the bet proceeds', async () => {
    const supa = betSupa({
      economy_prediction_settle: [
        { data: null, error: { message: 'socket reset' } },                  // ambiguous first call
        { data: { status: 'settled', replayed: true }, error: null },        // probe: it committed
      ],
      prediction_place_bet: { data: { status: 'inserted', replayed: false, new_pool: 150 }, error: null },
    });
    const eventBus = bus();
    const mgr = new PollsManager(supa, eventBus);

    await mgr.placeBet(betInteraction(), 'pred1', 0, 50);

    const settles = supa._rpcCalls.filter((c: any) => c.fn === 'economy_prediction_settle');
    expect(settles).toHaveLength(2);
    expect(settles[1].args).toEqual(settles[0].args); // identical-args probe
    expect(supa._rpcCalls.some((c: any) => c.fn === 'prediction_place_bet')).toBe(true);
    expect(eventBus.emit).toHaveBeenCalledWith('prediction.bet_placed', 'g1', expect.anything());
  });

  it('probes an ambiguous debit error: a second error confirms not-committed and nothing else runs', async () => {
    const supa = betSupa({
      economy_prediction_settle: [
        { data: null, error: { message: 'socket reset' } },
        { data: null, error: { message: 'still down' } },
      ],
    });
    const eventBus = bus();
    const mgr = new PollsManager(supa, eventBus);
    const interaction = betInteraction();

    await mgr.placeBet(interaction, 'pred1', 0, 50);

    const settles = supa._rpcCalls.filter((c: any) => c.fn === 'economy_prediction_settle');
    expect(settles).toHaveLength(2); // no refund — nothing was debited
    expect(supa._rpcCalls.some((c: any) => c.fn === 'prediction_place_bet')).toBe(false);
    expect(eventBus.emit).not.toHaveBeenCalled();
    expect(String(interaction.reply.mock.calls.at(-1)[0].content)).toMatch(/Nothing was debited/);
  });

  it('compensates an unconfirmed bet insert with the keyed refund AND an error-checked delete', async () => {
    const supa = betSupa({
      economy_prediction_settle: [
        { data: { status: 'settled', replayed: false }, error: null },  // debit
        { data: { status: 'settled', replayed: false }, error: null },  // compensation refund
      ],
      prediction_place_bet: [
        { data: null, error: { message: 'boom' } },
        { data: null, error: { message: 'boom again' } },               // probe also fails
      ],
    });
    const eventBus = bus();
    const mgr = new PollsManager(supa, eventBus);
    const interaction = betInteraction();

    await mgr.placeBet(interaction, 'pred1', 0, 50);

    const settles = supa._rpcCalls.filter((c: any) => c.fn === 'economy_prediction_settle');
    expect(settles).toHaveLength(2);
    expect(settles[1].args).toMatchObject({
      p_type: 'prediction_refund',
      p_request_id: settles[0].args.p_request_id,
    });
    // Delete-by-id compensation is issued (no-ops if the insert never landed).
    expect(supa._tableCalls.prediction_bets?.delete ?? []).toHaveLength(1);
    expect(supa._tableCalls.prediction_bets?.eq ?? []).toContainEqual(['id', settles[0].args.p_request_id]);
    expect(eventBus.emit).not.toHaveBeenCalled();
    expect(String(interaction.reply.mock.calls.at(-1)[0].content)).toMatch(/refunded/);
  });
});

describe('resolvePrediction — payout and refund ledger settlement', () => {
  function resolveSupa(bets: any[], rpcs: Record<string, any> = {}, resolvedPool = 300) {
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
        economy_prediction_settle: { data: { status: 'settled', replayed: false }, error: null },
        ...rpcs,
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

  it('replayed settles are NOT counted and do NOT rewrite the payout marker', async () => {
    const supa = resolveSupa(
      [{ id: 'b1', user_id: 'w1', option_id: 'opt1', amount: 100, payout: null }],
      { economy_prediction_settle: { data: { status: 'settled', replayed: true }, error: null } },
    );
    const eventBus = bus();
    const mgr = new PollsManager(supa, eventBus);

    await mgr.resolvePrediction(resolveInteraction(), 'pred1', 0);

    // No marker rewrite for money that moved in an earlier run.
    expect(supa._tableCalls.prediction_bets?.update ?? []).toHaveLength(0);
    expect(eventBus.emit).toHaveBeenCalledWith('prediction.resolved', 'g1',
      expect.objectContaining({ payoutCount: 0, refundedCount: 0 }));
  });

  it('conflicting_settlement is a clean skip (no count, no marker)', async () => {
    const supa = resolveSupa(
      [{ id: 'b1', user_id: 'u1', option_id: 'opt2', amount: 100, payout: null }],
      { economy_prediction_settle: { data: { status: 'conflicting_settlement', replayed: false }, error: null } },
    );
    const eventBus = bus();
    const mgr = new PollsManager(supa, eventBus);

    await mgr.resolvePrediction(resolveInteraction(), 'pred1', 0);

    expect(supa._tableCalls.prediction_bets?.update ?? []).toHaveLength(0);
    expect(eventBus.emit).toHaveBeenCalledWith('prediction.resolved', 'g1',
      expect.objectContaining({ payoutCount: 0, refundedCount: 0 }));
  });

  it('a per-bettor RPC error leaves the marker NULL for the re-drive to find', async () => {
    const supa = resolveSupa(
      [{ id: 'b1', user_id: 'w1', option_id: 'opt1', amount: 100, payout: null }],
      { economy_prediction_settle: { data: null, error: { message: 'wallet down' } } },
    );
    const eventBus = bus();
    const mgr = new PollsManager(supa, eventBus);

    await mgr.resolvePrediction(resolveInteraction(), 'pred1', 0);

    expect(supa._tableCalls.prediction_bets?.update ?? []).toHaveLength(0);
    expect(eventBus.emit).toHaveBeenCalledWith('prediction.resolved', 'g1',
      expect.objectContaining({ payoutCount: 0 }));
  });
});

describe('resolvePrediction — re-drive on an already-resolved prediction', () => {
  function redriveSupa(bets: any[], settleResult: any) {
    return makeSupa({
      singles: {
        guild_config: [CONFIG],
        predictions: [
          // First read (pre-resolve-attempt).
          { data: { id: 'pred1', title: 'Who wins?', creator_user_id: 'creator', status: 'resolved', total_pool: 300 }, error: null },
          // Re-read inside the re-drive path — the stored outcome.
          { data: { id: 'pred1', title: 'Who wins?', creator_user_id: 'creator', status: 'resolved', winning_option_id: 'opt1', total_pool: 300 }, error: null },
        ],
      },
      lists: {
        prediction_options: { data: [{ id: 'opt1', label: 'A' }, { id: 'opt2', label: 'B' }], error: null },
        prediction_bets: { data: bets, error: null },
      },
      rpcs: {
        predictions_resolve_atomic: { data: [], error: null }, // already resolved
        economy_prediction_settle: settleResult,
      },
    });
  }

  function resolveInteraction() {
    return {
      guildId: 'g1', user: { id: 'creator' },
      reply: vi.fn(async () => {}),
    } as any;
  }

  it('re-runs the payout loop for winners whose marker is NULL (keys make re-pay impossible)', async () => {
    const supa = redriveSupa(
      [
        { id: 'b1', user_id: 'w1', option_id: 'opt1', amount: 100, payout: null },   // stranded
        { id: 'b2', user_id: 'w2', option_id: 'opt1', amount: 100, payout: 150 },    // already paid
      ],
      { data: { status: 'settled', replayed: false }, error: null },
    );
    const eventBus = bus();
    const mgr = new PollsManager(supa, eventBus);
    const interaction = resolveInteraction();

    await mgr.resolvePrediction(interaction, 'pred1', 0);

    const settles = supa._rpcCalls.filter((c: any) => c.fn === 'economy_prediction_settle');
    expect(settles).toHaveLength(1); // only the stranded winner
    expect(settles[0].args).toMatchObject({
      p_user_id: 'w1',
      p_amount: 150, // 100/200 share of the 300 pool
      p_type: 'prediction_payout',
      p_request_id: 'b1',
    });
    expect(supa._tableCalls.prediction_bets?.update ?? []).toHaveLength(1);
    expect(eventBus.emit).toHaveBeenCalledWith('prediction.resolved', 'g1',
      expect.objectContaining({ payoutCount: 1, refundedCount: 0, redrive: true }));
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ embeds: expect.any(Array) }));
  });

  it('replies settled-nothing-to-do (no event) when every marker is present or replayed', async () => {
    const supa = redriveSupa(
      [{ id: 'b1', user_id: 'w1', option_id: 'opt1', amount: 100, payout: null }],
      { data: { status: 'settled', replayed: true }, error: null }, // earlier run already paid it
    );
    const eventBus = bus();
    const mgr = new PollsManager(supa, eventBus);
    const interaction = resolveInteraction();

    await mgr.resolvePrediction(interaction, 'pred1', 0);

    expect(supa._tableCalls.prediction_bets?.update ?? []).toHaveLength(0);
    expect(eventBus.emit).not.toHaveBeenCalledWith('prediction.resolved', expect.anything(), expect.anything());
    expect(String(interaction.reply.mock.calls.at(-1)[0].content)).toMatch(/already resolved/);
  });

  it('keeps the plain already-resolved reply for a CANCELLED prediction', async () => {
    const supa = makeSupa({
      singles: {
        guild_config: [CONFIG],
        predictions: [
          { data: { id: 'pred1', title: 'Who wins?', creator_user_id: 'creator', status: 'cancelled', total_pool: 300 }, error: null },
          { data: { id: 'pred1', title: 'Who wins?', creator_user_id: 'creator', status: 'cancelled', winning_option_id: null, total_pool: 300 }, error: null },
        ],
      },
      lists: {
        prediction_options: { data: [{ id: 'opt1', label: 'A' }], error: null },
        prediction_bets: { data: [], error: null },
      },
      rpcs: {
        predictions_resolve_atomic: { data: [], error: null },
      },
    });
    const mgr = new PollsManager(supa, bus());
    const interaction = resolveInteraction();

    await mgr.resolvePrediction(interaction, 'pred1', 0);

    expect(supa._rpcCalls.filter((c: any) => c.fn === 'economy_prediction_settle')).toHaveLength(0);
    expect(String(interaction.reply.mock.calls.at(-1)[0].content)).toMatch(/already been resolved or cancelled/);
  });
});
