/**
 * Integration test: Economy wallets — balance RPCs, deposits, withdrawals.
 *
 * Validates the atomic RPC functions that keep the economy consistent:
 * economy_add_balance, economy_subtract_balance, economy_bank_deposit,
 * economy_bank_withdraw. All against a real Supabase instance.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

let supa: SupabaseClient;
const GUILD_ID = `test-economy-guild-${Date.now()}`;
const USER_A = 'econ-user-aaa';
const USER_B = 'econ-user-bbb';

beforeAll(async () => {
  supa = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Create prerequisite guild + config (economy tables reference guild via guild_id)
  await supa.from('guild').insert({
    id: GUILD_ID,
    name: 'Economy Test Guild',
    owner_discord_id: '111222333',
  });
  await supa.from('guild_config').insert({ guild_id: GUILD_ID });
});

afterAll(async () => {
  await supa.from('economy_transactions').delete().eq('guild_id', GUILD_ID);
  await supa.from('economy_wallets').delete().eq('guild_id', GUILD_ID);
  await supa.from('guild_config').delete().eq('guild_id', GUILD_ID);
  await supa.from('guild').delete().eq('id', GUILD_ID);
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
      p_user_id: USER_A,
      p_amount: 600,
    });

    expect(error).toBeNull();

    const { data } = await supa
      .from('economy_wallets')
      .select('wallet, bank')
      .eq('guild_id', GUILD_ID)
      .eq('user_id', USER_A)
      .single();

    expect(data!.wallet).toBe(900); // 1500 - 600
    expect(data!.bank).toBe(600);
  });

  it('clamps deposit to available wallet balance', async () => {
    // Try to deposit more than wallet has
    await supa.rpc('economy_bank_deposit', {
      p_guild_id: GUILD_ID,
      p_user_id: USER_A,
      p_amount: 99999,
    });

    const { data } = await supa
      .from('economy_wallets')
      .select('wallet, bank')
      .eq('guild_id', GUILD_ID)
      .eq('user_id', USER_A)
      .single();

    // All remaining wallet should have moved to bank
    expect(data!.wallet).toBe(0);
    expect(data!.bank).toBe(1500); // 600 + 900
  });
});

describe('economy_bank_withdraw RPC', () => {
  it('moves funds from bank to wallet', async () => {
    await supa.rpc('economy_bank_withdraw', {
      p_guild_id: GUILD_ID,
      p_user_id: USER_A,
      p_amount: 300,
    });

    const { data } = await supa
      .from('economy_wallets')
      .select('wallet, bank')
      .eq('guild_id', GUILD_ID)
      .eq('user_id', USER_A)
      .single();

    expect(data!.wallet).toBe(300);
    expect(data!.bank).toBe(1200); // 1500 - 300
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
      .select('wallet, total_spent')
      .eq('guild_id', GUILD_ID)
      .eq('user_id', USER_B)
      .single();

    expect(data!.wallet).toBe(125); // 200 - 75
    expect(data!.total_spent).toBe(75);
  });

  it('rejects debit that would overdraw (wallet cannot go negative)', async () => {
    const { error } = await supa.rpc('economy_subtract_balance', {
      p_guild_id: GUILD_ID,
      p_user_id: USER_B,
      p_amount: 9999,
    });

    // The RPC raises an exception for insufficient funds
    expect(error).not.toBeNull();
  });
});

describe('Wallet passive mode', () => {
  it('toggles passive mode on a wallet', async () => {
    // Toggle passive on
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
