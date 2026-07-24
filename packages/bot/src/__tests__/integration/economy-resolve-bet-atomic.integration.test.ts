/**
 * Integration coverage for economy_resolve_bet
 * (migration 20260724110100_economy_resolve_bet_atomic).
 *
 * The casino bet settlement is now ONE serializable, member-locked, idempotent
 * RPC that applies the net wallet delta, records the daily loss, and writes the
 * casino_bet ledger row together. These tests prove — against the real local
 * Supabase stack — the properties mocks cannot: atomic co-mutation, durable
 * interaction-id replay, and concurrent-replay collapse to a single settlement.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { getTestDbUrl, requireSupabase } from './helpers.js';

let supa!: SupabaseClient;
let sql!: ReturnType<typeof postgres>;

const GUILD_ID = `resolve-bet-${Date.now()}`;

async function seedWallet(userId: string, wallet: number): Promise<void> {
  await sql`
    INSERT INTO public.economy_wallets (guild_id, user_id, wallet, total_earned, total_spent)
    VALUES (${GUILD_ID}, ${userId}, ${wallet}, 0, 0)
    ON CONFLICT (guild_id, user_id)
    DO UPDATE SET wallet = ${wallet}, total_earned = 0, total_spent = 0
  `;
}

async function walletOf(userId: string): Promise<{ wallet: number; total_earned: number }> {
  const [row] = await sql<{ wallet: number; total_earned: number }[]>`
    SELECT wallet, total_earned
      FROM public.economy_wallets
     WHERE guild_id = ${GUILD_ID} AND user_id = ${userId}
  `;
  return { wallet: Number(row!.wallet), total_earned: Number(row!.total_earned) };
}

async function casinoTxCount(userId: string, requestId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n
      FROM public.economy_transactions
     WHERE guild_id = ${GUILD_ID}
       AND user_id = ${userId}
       AND type = 'casino_bet'
       AND metadata ->> 'request_id' = ${requestId}
  `;
  return Number(row!.n);
}

async function dailyLossOf(userId: string): Promise<number> {
  const [row] = await sql<{ amount: number | null }[]>`
    SELECT amount
      FROM public.economy_daily_losses
     WHERE guild_id = ${GUILD_ID}
       AND user_id = ${userId}
       AND loss_date = (pg_catalog.now() AT TIME ZONE 'UTC')::date
  `;
  return Number(row?.amount ?? 0);
}

beforeAll(async () => {
  supa = await requireSupabase();
  sql = postgres(getTestDbUrl(), { max: 4 });
});

afterAll(async () => {
  await sql`DELETE FROM public.economy_transactions WHERE guild_id = ${GUILD_ID}`;
  await sql`DELETE FROM public.economy_daily_losses WHERE guild_id = ${GUILD_ID}`;
  await sql`DELETE FROM public.economy_wallets WHERE guild_id = ${GUILD_ID}`;
  await sql.end({ timeout: 5 });
});

describe('economy_resolve_bet', () => {
  it('debits the wallet, records the daily loss, and writes one ledger row atomically', async () => {
    const user = 'loser-1';
    const idem = randomUUID();
    await seedWallet(user, 1000);

    const { data, error } = await supa.rpc('economy_resolve_bet', {
      p_guild_id: GUILD_ID,
      p_user_id: user,
      p_net: -100,
      p_loss: 100,
      p_game: 'coinflip',
      p_idempotency_key: idem,
    });

    expect(error).toBeNull();
    expect(data).toMatchObject({ status: 'settled', replayed: false, net: -100 });
    expect((data as { wallet_balance: number }).wallet_balance).toBe(900);
    expect((data as { daily_loss: number }).daily_loss).toBe(100);

    expect((await walletOf(user)).wallet).toBe(900);
    expect(await dailyLossOf(user)).toBe(100);
    expect(await casinoTxCount(user, idem)).toBe(1);
  });

  it('is idempotent — re-delivering the same interaction id moves no more money', async () => {
    const user = 'loser-2';
    const idem = randomUUID();
    await seedWallet(user, 1000);

    const first = await supa.rpc('economy_resolve_bet', {
      p_guild_id: GUILD_ID, p_user_id: user, p_net: -250, p_loss: 250,
      p_game: 'slots', p_idempotency_key: idem,
    });
    expect(first.error).toBeNull();
    expect(first.data).toMatchObject({ replayed: false });

    const replay = await supa.rpc('economy_resolve_bet', {
      p_guild_id: GUILD_ID, p_user_id: user, p_net: -250, p_loss: 250,
      p_game: 'slots', p_idempotency_key: idem,
    });
    expect(replay.error).toBeNull();
    expect(replay.data).toMatchObject({ status: 'settled', replayed: true, net: -250 });

    // Exactly one debit, one loss, one ledger row despite two calls.
    expect((await walletOf(user)).wallet).toBe(750);
    expect(await dailyLossOf(user)).toBe(250);
    expect(await casinoTxCount(user, idem)).toBe(1);
  });

  it('credits a win to the wallet and total_earned, recording no daily loss', async () => {
    const user = 'winner-1';
    const idem = randomUUID();
    await seedWallet(user, 500);

    const { data, error } = await supa.rpc('economy_resolve_bet', {
      p_guild_id: GUILD_ID, p_user_id: user, p_net: 300, p_loss: 0,
      p_game: 'blackjack', p_idempotency_key: idem,
    });
    expect(error).toBeNull();
    expect(data).toMatchObject({ status: 'settled', replayed: false, net: 300, daily_loss: 0 });

    const w = await walletOf(user);
    expect(w.wallet).toBe(800);
    expect(w.total_earned).toBe(300);
    expect(await dailyLossOf(user)).toBe(0);
    expect(await casinoTxCount(user, idem)).toBe(1);
  });

  it('refuses a debit larger than the wallet without mutating anything', async () => {
    const user = 'broke-1';
    const idem = randomUUID();
    await seedWallet(user, 50);

    const { data, error } = await supa.rpc('economy_resolve_bet', {
      p_guild_id: GUILD_ID, p_user_id: user, p_net: -100, p_loss: 100,
      p_game: 'dice', p_idempotency_key: idem,
    });
    expect(error).toBeNull();
    expect(data).toMatchObject({ status: 'insufficient_funds', replayed: false });

    expect((await walletOf(user)).wallet).toBe(50);
    expect(await dailyLossOf(user)).toBe(0);
    expect(await casinoTxCount(user, idem)).toBe(0);
  });

  it('collapses concurrent replays of one interaction to a single settlement', async () => {
    const user = 'race-1';
    const idem = randomUUID();
    await seedWallet(user, 1000);

    const args = {
      p_guild_id: GUILD_ID, p_user_id: user, p_net: -400, p_loss: 400,
      p_game: 'scratch', p_idempotency_key: idem,
    };
    const results = await Promise.all([
      supa.rpc('economy_resolve_bet', args),
      supa.rpc('economy_resolve_bet', args),
      supa.rpc('economy_resolve_bet', args),
    ]);

    for (const r of results) expect(r.error).toBeNull();
    const replayedFlags = results.map((r) => (r.data as { replayed: boolean }).replayed);
    // Exactly one caller performed the settlement; the rest saw the replay.
    expect(replayedFlags.filter((f) => f === false)).toHaveLength(1);

    expect((await walletOf(user)).wallet).toBe(600);
    expect(await dailyLossOf(user)).toBe(400);
    expect(await casinoTxCount(user, idem)).toBe(1);
  });
});
