/**
 * Integration coverage for economy_pay (player-to-player /pay transfer).
 *
 * These tests use the real local Supabase stack. They prove the properties
 * mocks cannot: the debit, the receiver credit, and both ledger rows commit as
 * one transaction; a redelivered interaction never debits twice; concurrent
 * transfers serialize behind the member advisory locks; a transfer can never
 * oversend a wallet; opposite-direction transfers do not deadlock; and the tax
 * genuinely sinks currency out of circulation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import postgres from 'postgres';
import { getTestDbUrl, requireSupabase } from './helpers.js';

let supa!: SupabaseClient;
let sql!: ReturnType<typeof postgres>;

const GUILD_ID = `test-economy-pay-${Date.now()}`;
const TEST_GUILD_IDS = [GUILD_ID];
const USER = `pay-user-${Date.now()}`;

type PayResult = {
  status: 'sent' | 'insufficient_funds';
  replayed: boolean;
  amount: number;
  tax: number;
  received: number;
  sender_balance: number | null;
  receiver_balance?: number | null;
};

async function pay(
  senderId: string,
  receiverId: string,
  amount: number,
  taxPct: number,
  requestId: string,
): Promise<{ data: PayResult | null; error: { message: string } | null }> {
  return supa.rpc('economy_pay', {
    p_guild_id: GUILD_ID,
    p_sender_id: senderId,
    p_receiver_id: receiverId,
    // Production passes the amount as a string (JSON string → BIGINT); mirror it.
    p_amount: String(amount),
    p_tax_pct: taxPct,
    p_request_id: requestId,
  }) as unknown as Promise<{ data: PayResult | null; error: { message: string } | null }>;
}

async function seedWallet(userId: string, wallet: number): Promise<void> {
  const { error } = await supa.from('economy_wallets').upsert({
    guild_id: GUILD_ID,
    user_id: userId,
    wallet,
    bank: 0,
    total_earned: wallet,
    total_spent: 0,
  });
  if (error) throw new Error(`wallet seed failed: ${error.message}`);
}

async function walletOf(userId: string): Promise<{ wallet: number; total_earned: number }> {
  const { data, error } = await supa
    .from('economy_wallets')
    .select('wallet,total_earned')
    .eq('guild_id', GUILD_ID)
    .eq('user_id', userId)
    .single();
  if (error) throw new Error(error.message);
  return { wallet: Number(data!.wallet), total_earned: Number(data!.total_earned) };
}

async function paySendRowsFor(requestId: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n
      FROM public.economy_transactions
     WHERE guild_id = ${GUILD_ID}
       AND type = 'pay_send'
       AND metadata ->> 'request_id' = ${requestId}
  `;
  return rows[0]!.n;
}

beforeAll(async () => {
  supa = await requireSupabase();
  sql = postgres(getTestDbUrl(), { max: 4 });
  const { error } = await supa.from('guild').insert({
    id: GUILD_ID,
    name: 'Atomic Pay Test Guild',
    owner_discord_id: '100000000000000010',
  });
  if (error) throw new Error(`Guild seed failed: ${error.message}`);
});

afterAll(async () => {
  await supa.from('economy_transactions').delete().in('guild_id', TEST_GUILD_IDS);
  await supa.from('economy_wallets').delete().in('guild_id', TEST_GUILD_IDS);
  // Guild rows are pinned by immutable audit_logs elsewhere; ids are unique per
  // run so a leftover guild row never affects reruns. Remove it best-effort.
  await supa.from('guild').delete().in('id', TEST_GUILD_IDS);
  await sql?.end({ timeout: 5 });
});

describe('economy_pay', () => {
  it('moves currency atomically and writes both ledger rows', async () => {
    const a = `${USER}-happy-a`;
    const b = `${USER}-happy-b`;
    await seedWallet(a, 1000);
    await seedWallet(b, 0);

    const { data, error } = await pay(a, b, 200, 0, 'interaction-happy');
    expect(error).toBeNull();
    expect(data).toMatchObject({ status: 'sent', replayed: false, amount: 200, tax: 0, received: 200 });

    expect(await walletOf(a)).toEqual({ wallet: 800, total_earned: 1000 });
    expect(await walletOf(b)).toEqual({ wallet: 200, total_earned: 200 });

    const { data: rows, error: rowErr } = await supa
      .from('economy_transactions')
      .select('user_id,type,amount,balance_after,metadata')
      .eq('guild_id', GUILD_ID)
      .in('user_id', [a, b])
      .order('type', { ascending: true });
    expect(rowErr).toBeNull();
    expect(rows).toEqual([
      {
        user_id: b,
        type: 'pay_receive',
        amount: 200,
        balance_after: 200,
        metadata: { request_id: 'interaction-happy', counterparty: a },
      },
      {
        user_id: a,
        type: 'pay_send',
        amount: -200,
        balance_after: 800,
        metadata: { request_id: 'interaction-happy', counterparty: b, tax: 0 },
      },
    ]);
  });

  it('replays one interaction without a second debit (double-spend fix)', async () => {
    const a = `${USER}-replay-a`;
    const b = `${USER}-replay-b`;
    await seedWallet(a, 1000);
    await seedWallet(b, 0);

    const first = await pay(a, b, 200, 0, 'interaction-replay');
    const replay = await pay(a, b, 200, 0, 'interaction-replay');

    expect(first.error).toBeNull();
    expect(replay.error).toBeNull();
    expect(first.data).toMatchObject({ status: 'sent', replayed: false, amount: 200 });
    expect(replay.data).toMatchObject({ status: 'sent', replayed: true, amount: 200 });

    // Money moved exactly once despite two calls with the same interaction id.
    expect((await walletOf(a)).wallet).toBe(800);
    expect((await walletOf(b)).wallet).toBe(200);
    expect(await paySendRowsFor('interaction-replay')).toBe(1);
  });

  it('serializes a concurrent same-id double-fire to exactly one debit', async () => {
    const a = `${USER}-concurrent-same-a`;
    const b = `${USER}-concurrent-same-b`;
    await seedWallet(a, 1000);
    await seedWallet(b, 0);

    const [r1, r2] = await Promise.all([
      pay(a, b, 100, 0, 'interaction-concurrent-same'),
      pay(a, b, 100, 0, 'interaction-concurrent-same'),
    ]);
    expect(r1.error).toBeNull();
    expect(r2.error).toBeNull();
    // Both report success; exactly one is the fresh debit, the other a replay.
    expect([r1.data!.replayed, r2.data!.replayed].sort()).toEqual([false, true]);

    expect((await walletOf(a)).wallet).toBe(900);
    expect((await walletOf(b)).wallet).toBe(100);
    expect(await paySendRowsFor('interaction-concurrent-same')).toBe(1);
  });

  it('cannot oversend when two distinct transfers race the same wallet', async () => {
    const a = `${USER}-conserve-a`;
    const b = `${USER}-conserve-b`;
    await seedWallet(a, 1000);
    await seedWallet(b, 0);

    // Two DISTINCT interactions, each spending 600 of a 1000 wallet. The member
    // advisory lock serializes them; the second must see the debited balance and
    // fail rather than overdraw.
    const [r1, r2] = await Promise.all([
      pay(a, b, 600, 0, 'interaction-conserve-1'),
      pay(a, b, 600, 0, 'interaction-conserve-2'),
    ]);
    expect(r1.error).toBeNull();
    expect(r2.error).toBeNull();
    const statuses = [r1.data!.status, r2.data!.status].sort();
    expect(statuses).toEqual(['insufficient_funds', 'sent']);

    // Exactly one 600 transfer landed; total currency is conserved.
    expect((await walletOf(a)).wallet).toBe(400);
    expect((await walletOf(b)).wallet).toBe(600);
  });

  it('does not deadlock on opposite-direction concurrent transfers', async () => {
    const a = `${USER}-reverse-a`;
    const b = `${USER}-reverse-b`;
    await seedWallet(a, 1000);
    await seedWallet(b, 1000);

    // A→B and B→A at once. Locks are taken in sorted id order regardless of
    // direction, so this resolves instead of deadlocking. A short lock_timeout
    // would surface a deadlock as an error rather than a hang.
    await sql`SET lock_timeout = '10s'`;
    const [r1, r2] = await Promise.all([
      pay(a, b, 500, 0, 'interaction-reverse-ab'),
      pay(b, a, 300, 0, 'interaction-reverse-ba'),
    ]);
    expect(r1.error).toBeNull();
    expect(r2.error).toBeNull();
    expect(r1.data!.status).toBe('sent');
    expect(r2.data!.status).toBe('sent');

    // Net: A = 1000 - 500 + 300 = 800, B = 1000 + 500 - 300 = 1200. Total 2000.
    const wa = (await walletOf(a)).wallet;
    const wb = (await walletOf(b)).wallet;
    expect(wa).toBe(800);
    expect(wb).toBe(1200);
    expect(wa + wb).toBe(2000);
  });

  it('moves nothing and writes no ledger row on insufficient funds', async () => {
    const a = `${USER}-insufficient-a`;
    const b = `${USER}-insufficient-b`;
    await seedWallet(a, 50);
    await seedWallet(b, 0);

    const { data, error } = await pay(a, b, 500, 0, 'interaction-insufficient');
    expect(error).toBeNull();
    expect(data).toMatchObject({ status: 'insufficient_funds', replayed: false });

    expect((await walletOf(a)).wallet).toBe(50);
    expect((await walletOf(b)).wallet).toBe(0);
    expect(await paySendRowsFor('interaction-insufficient')).toBe(0);
  });

  it('sinks the tax: sender loses the full amount, receiver gains the remainder', async () => {
    const a = `${USER}-tax-a`;
    const b = `${USER}-tax-b`;
    await seedWallet(a, 1000);
    await seedWallet(b, 0);

    const { data, error } = await pay(a, b, 100, 10, 'interaction-tax');
    expect(error).toBeNull();
    expect(data).toMatchObject({ status: 'sent', amount: 100, tax: 10, received: 90 });

    // 100 leaves the sender, 90 reaches the receiver, 10 is destroyed.
    expect((await walletOf(a)).wallet).toBe(900);
    expect((await walletOf(b)).wallet).toBe(90);
    expect((await walletOf(b)).total_earned).toBe(90);
  });

  it('rejects self-pay and non-positive amounts', async () => {
    const a = `${USER}-guard-a`;
    await seedWallet(a, 1000);

    const self = await pay(a, a, 100, 0, 'interaction-self');
    expect(self.error).not.toBeNull();

    const negative = await pay(a, `${USER}-guard-b`, -5, 0, 'interaction-negative');
    expect(negative.error).not.toBeNull();

    const zero = await pay(a, `${USER}-guard-c`, 0, 0, 'interaction-zero');
    expect(zero.error).not.toBeNull();

    // A rejected call moves nothing.
    expect((await walletOf(a)).wallet).toBe(1000);
  });

  it('erases the sender pay_send ledger row through the member-purge RPC', async () => {
    const a = `${USER}-purge-a`;
    const b = `${USER}-purge-b`;
    await seedWallet(a, 1000);
    await seedWallet(b, 0);
    const sent = await pay(a, b, 100, 0, 'interaction-purge');
    expect(sent.error).toBeNull();
    expect(await paySendRowsFor('interaction-purge')).toBe(1);

    const { error: purgeError } = await supa.rpc('purge_member_data', {
      p_guild_id: GUILD_ID,
      p_user_id: a,
    });
    expect(purgeError).toBeNull();

    // The idempotency anchor lives in economy_transactions, which member-purge
    // already erases — so no new PII table escapes the privacy contract.
    expect(await paySendRowsFor('interaction-purge')).toBe(0);
  });
});
