/**
 * Integration test: Economy wallets — balance RPCs, deposits, withdrawals.
 *
 * Validates the atomic RPC functions that keep the economy consistent:
 * economy_add_balance, economy_subtract_balance, economy_bank_deposit,
 * economy_bank_withdraw. All against a real Supabase instance.
 *
 * Note: economy_add_balance initializes the wallet canonically and updates
 * total_earned. economy_subtract_balance only debits wallet (not total_spent).
 * economy_bank_deposit returns 0 (not clamp) if wallet < amount.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireSupabase } from './helpers.js';

let supa!: SupabaseClient;
const GUILD_ID = `test-economy-guild-${Date.now()}`;
const USER_A = 'econ-user-aaa';
const USER_B = 'econ-user-bbb';
const USER_C = 'econ-user-ccc';
const USER_REFUND = 'econ-user-refund';

beforeAll(async () => {
  supa = await requireSupabase();

  // economy_wallets has no FK to guild, but we create one to be clean
  await supa.from('guild').insert({
    id: GUILD_ID,
    name: 'Economy Test Guild',
    owner_discord_id: '111222333',
  });
  await supa.from('guild_config').insert({
    guild_id: GUILD_ID,
    economy_max_bank: 0,
  });
  await supa.rpc('economy_add_balance', {
    p_guild_id: GUILD_ID,
    p_user_id: USER_C,
    p_amount: 1000,
  });
});

afterAll(async () => {
  await supa.from('economy_transactions').delete().eq('guild_id', GUILD_ID);
  await supa.from('economy_wallets').delete().eq('guild_id', GUILD_ID);
  await supa.from('guild_config').delete().eq('guild_id', GUILD_ID);
  await supa.from('guild').delete().eq('id', GUILD_ID);
});

describe('economy_leaderboard RPC', () => {
  it('returns a funded wallet when pagination parameters select the current RPC', async () => {
    const { data, error } = await supa.rpc('economy_leaderboard', {
      p_guild_id: GUILD_ID,
      p_limit: 10,
      p_offset: 0,
    });

    expect(error).toBeNull();
    expect(data).toEqual(expect.arrayContaining([
      expect.objectContaining({ user_id: USER_C, net_worth: 1000 }),
    ]));
  });
});

describe('economy_add_balance RPC', () => {
  it('creates a wallet on first credit (upsert)', async () => {
    const { error } = await supa.rpc('economy_add_balance', {
      p_guild_id: GUILD_ID,
      p_user_id: USER_A,
      p_amount: 1000,
    });

    expect(error).toBeNull();

    const { data } = await supa
      .from('economy_wallets')
      .select('wallet, bank, total_earned')
      .eq('guild_id', GUILD_ID)
      .eq('user_id', USER_A)
      .single();

    expect(data!.wallet).toBe(1000);
    expect(data!.bank).toBe(0);
    expect(data!.total_earned).toBe(1000);
  });

  it('adds to existing wallet balance', async () => {
    await supa.rpc('economy_add_balance', {
      p_guild_id: GUILD_ID,
      p_user_id: USER_A,
      p_amount: 500,
    });

    const { data } = await supa
      .from('economy_wallets')
      .select('wallet, total_earned')
      .eq('guild_id', GUILD_ID)
      .eq('user_id', USER_A)
      .single();

    expect(data!.wallet).toBe(1500);
    expect(data!.total_earned).toBe(1500);
  });
});

describe('economy_bank_deposit RPC', () => {
  it('moves funds from wallet to bank', async () => {
    const { data: depositAmt, error } = await supa.rpc('economy_bank_deposit', {
      p_guild_id: GUILD_ID,
      p_user_id: USER_C,
      p_amount: 600,
    });

    expect(error).toBeNull();
    // Returns actual amount deposited
    expect(depositAmt).toBe(600);

    const { data } = await supa
      .from('economy_wallets')
      .select('wallet, bank')
      .eq('guild_id', GUILD_ID)
      .eq('user_id', USER_C)
      .single();

    expect(data!.wallet).toBe(400);   // 1000 - 600
    expect(data!.bank).toBe(600);
  });

  it('enforces the guild-configured cap atomically across concurrent deposits', async () => {
    await supa.from('guild_config')
      .update({ economy_max_bank: 700 })
      .eq('guild_id', GUILD_ID);

    const results = await Promise.all([
      supa.rpc('economy_bank_deposit', {
        p_guild_id: GUILD_ID,
        p_user_id: USER_C,
        p_amount: 100,
      }),
      supa.rpc('economy_bank_deposit', {
        p_guild_id: GUILD_ID,
        p_user_id: USER_C,
        p_amount: 100,
      }),
    ]);

    expect(results.every((result) => result.error === null)).toBe(true);
    expect(results.map((result) => Number(result.data)).sort((a, b) => a - b))
      .toEqual([0, 100]);

    const { data } = await supa.from('economy_wallets')
      .select('wallet, bank')
      .eq('guild_id', GUILD_ID)
      .eq('user_id', USER_C)
      .single();
    expect(data).toMatchObject({ wallet: 300, bank: 700 });
  });

  it('treats a configured zero bank cap as unlimited', async () => {
    await supa.from('guild_config')
      .update({ economy_max_bank: 0 })
      .eq('guild_id', GUILD_ID);

    const { data: depositAmt, error } = await supa.rpc('economy_bank_deposit', {
      p_guild_id: GUILD_ID,
      p_user_id: USER_C,
      p_amount: 100,
    });

    expect(error).toBeNull();
    expect(depositAmt).toBe(100);

    const { data } = await supa.from('economy_wallets')
      .select('wallet, bank')
      .eq('guild_id', GUILD_ID)
      .eq('user_id', USER_C)
      .single();
    expect(data).toMatchObject({ wallet: 200, bank: 800 });
  });

  it('returns 0 when wallet has insufficient funds', async () => {
    // Try to deposit more than wallet has — should return 0 and do nothing
    const { data: depositAmt, error } = await supa.rpc('economy_bank_deposit', {
      p_guild_id: GUILD_ID,
      p_user_id: USER_C,
      p_amount: 99999,
    });

    expect(error).toBeNull();
    expect(depositAmt).toBe(0);

    // Balance should be unchanged
    const { data } = await supa
      .from('economy_wallets')
      .select('wallet, bank')
      .eq('guild_id', GUILD_ID)
      .eq('user_id', USER_C)
      .single();

    expect(data!.wallet).toBe(200);
    expect(data!.bank).toBe(800);
  });
});

describe('economy_bank_withdraw RPC', () => {
  it('moves funds from bank to wallet', async () => {
    const { data: withdrawAmt, error } = await supa.rpc('economy_bank_withdraw', {
      p_guild_id: GUILD_ID,
      p_user_id: USER_C,
      p_amount: 300,
    });

    expect(error).toBeNull();
    expect(withdrawAmt).toBe(300);

    const { data } = await supa
      .from('economy_wallets')
      .select('wallet, bank')
      .eq('guild_id', GUILD_ID)
      .eq('user_id', USER_C)
      .single();

    expect(data!.wallet).toBe(500); // 200 + 300
    expect(data!.bank).toBe(500);   // 800 - 300
  });

  it('returns 0 when bank has insufficient funds', async () => {
    const { data: withdrawAmt, error } = await supa.rpc('economy_bank_withdraw', {
      p_guild_id: GUILD_ID,
      p_user_id: USER_C,
      p_amount: 99999,
    });

    expect(error).toBeNull();
    expect(withdrawAmt).toBe(0);
  });
});

describe('economy_subtract_balance RPC', () => {
  it('debits wallet balance', async () => {
    // User B gets funds first
    await supa.rpc('economy_add_balance', {
      p_guild_id: GUILD_ID,
      p_user_id: USER_B,
      p_amount: 200,
    });

    const { error } = await supa.rpc('economy_subtract_balance', {
      p_guild_id: GUILD_ID,
      p_user_id: USER_B,
      p_amount: 75,
    });

    expect(error).toBeNull();

    const { data } = await supa
      .from('economy_wallets')
      .select('wallet')
      .eq('guild_id', GUILD_ID)
      .eq('user_id', USER_B)
      .single();

    expect(data!.wallet).toBe(125);
  });

  it('raises on insufficient balance', async () => {
    const { error } = await supa.rpc('economy_subtract_balance', {
      p_guild_id: GUILD_ID,
      p_user_id: USER_B,
      p_amount: 9999,
    });

    // The RPC raises EXCEPTION 'Insufficient balance'
    expect(error).not.toBeNull();
    expect(error!.message).toContain('Insufficient balance');
  });
});

describe('economy_refund_balance RPC', () => {
  it('restores a debit exactly once without increasing total_earned', async () => {
    await supa.rpc('economy_add_balance', {
      p_guild_id: GUILD_ID,
      p_user_id: USER_REFUND,
      p_amount: 100,
    });
    await supa.rpc('economy_subtract_balance', {
      p_guild_id: GUILD_ID,
      p_user_id: USER_REFUND,
      p_amount: 40,
    });

    const refundArgs = {
      p_guild_id: GUILD_ID,
      p_user_id: USER_REFUND,
      p_amount: 40,
      p_idempotency_key: 'test:pet:refund:1',
    };
    const first = await supa.rpc('economy_refund_balance', refundArgs);
    const replay = await supa.rpc('economy_refund_balance', refundArgs);

    expect(first.error).toBeNull();
    expect(replay.error).toBeNull();

    const { data } = await supa
      .from('economy_wallets')
      .select('wallet, total_earned')
      .eq('guild_id', GUILD_ID)
      .eq('user_id', USER_REFUND)
      .single();
    expect(data).toMatchObject({ wallet: 100, total_earned: 100 });

    const { count } = await supa
      .from('economy_transactions')
      .select('id', { count: 'exact', head: true })
      .eq('guild_id', GUILD_ID)
      .eq('idempotency_key', refundArgs.p_idempotency_key);
    expect(count).toBe(1);
  });
});

describe('Wallet passive mode', () => {
  it('toggles passive mode on a wallet', async () => {
    const { error } = await supa
      .from('economy_wallets')
      .update({ passive: true })
      .eq('guild_id', GUILD_ID)
      .eq('user_id', USER_A);

    expect(error).toBeNull();

    const { data } = await supa
      .from('economy_wallets')
      .select('passive')
      .eq('guild_id', GUILD_ID)
      .eq('user_id', USER_A)
      .single();

    expect(data!.passive).toBe(true);
  });
});
