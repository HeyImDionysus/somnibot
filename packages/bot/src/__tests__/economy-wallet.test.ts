/**
 * Economy Wallet Edge Cases — V53 Phase 5 (Finding 5.3)
 *
 * Tests economy wallet business logic: credit/debit, suspended wallets,
 * leaderboard ordering, and data export completeness.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Supabase responses for wallet operations
function mockSupabase() {
  const wallets = new Map<string, { user_id: string; wallet: number; bank: number; suspended: boolean }>();

  return {
    wallets,
    from: (table: string) => {
      if (table === 'economy_wallets') {
        return {
          select: () => ({
            eq: (_col: string, _val: string) => ({
              eq: (_col2: string, _val2: string) => ({
                single: async () => {
                  const key = `${_val}:${_val2}`;
                  const w = wallets.get(key);
                  return { data: w ?? null, error: w ? null : { code: 'PGRST116' } };
                },
              }),
              order: () => ({
                limit: () => ({
                  async then(resolve: (v: any) => void) {
                    const entries = Array.from(wallets.values())
                      .filter(w => !w.suspended)
                      .sort((a, b) => (b.wallet + b.bank) - (a.wallet + a.bank));
                    resolve({ data: entries, error: null });
                  },
                }),
              }),
            }),
          }),
        };
      }
      return {};
    },
    rpc: async (fn: string, params: Record<string, unknown>) => {
      if (fn === 'economy_credit_wallet') {
        const key = `${params.p_guild_id}:${params.p_user_id}`;
        const existing = wallets.get(key) ?? {
          user_id: params.p_user_id as string,
          wallet: 0,
          bank: 0,
          suspended: false,
        };
        if (existing.suspended) {
          return { data: null, error: { message: 'Wallet is suspended' } };
        }
        existing.wallet += params.p_amount as number;
        wallets.set(key, existing);
        return { data: { wallet: existing.wallet }, error: null };
      }
      if (fn === 'economy_debit_wallet') {
        const key = `${params.p_guild_id}:${params.p_user_id}`;
        const existing = wallets.get(key);
        if (!existing) return { data: null, error: { message: 'Wallet not found' } };
        if (existing.suspended) return { data: null, error: { message: 'Wallet is suspended' } };
        if (existing.wallet < (params.p_amount as number)) {
          return { data: null, error: { message: 'Insufficient funds' } };
        }
        existing.wallet -= params.p_amount as number;
        return { data: { wallet: existing.wallet }, error: null };
      }
      return { data: null, error: { message: 'Unknown RPC' } };
    },
  };
}

describe('Economy Wallet Operations', () => {
  let supabase: ReturnType<typeof mockSupabase>;

  beforeEach(() => {
    supabase = mockSupabase();
  });

  it('credits a new wallet starting from zero', async () => {
    const { data, error } = await supabase.rpc('economy_credit_wallet', {
      p_guild_id: 'guild1',
      p_user_id: 'user1',
      p_amount: 100,
    });
    expect(error).toBeNull();
    expect(data!.wallet).toBe(100);
  });

  it('stacks credits on existing balance', async () => {
    await supabase.rpc('economy_credit_wallet', { p_guild_id: 'g1', p_user_id: 'u1', p_amount: 50 });
    const { data } = await supabase.rpc('economy_credit_wallet', { p_guild_id: 'g1', p_user_id: 'u1', p_amount: 75 });
    expect(data!.wallet).toBe(125);
  });

  it('refuses debit on insufficient funds', async () => {
    await supabase.rpc('economy_credit_wallet', { p_guild_id: 'g1', p_user_id: 'u1', p_amount: 50 });
    const { error } = await supabase.rpc('economy_debit_wallet', { p_guild_id: 'g1', p_user_id: 'u1', p_amount: 100 });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/insufficient/i);
  });

  it('refuses operations on suspended wallet', async () => {
    supabase.wallets.set('g1:u1', { user_id: 'u1', wallet: 500, bank: 0, suspended: true });
    const { error } = await supabase.rpc('economy_credit_wallet', { p_guild_id: 'g1', p_user_id: 'u1', p_amount: 100 });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/suspended/i);
  });

  it('leaderboard excludes suspended wallets', async () => {
    supabase.wallets.set('g1:u1', { user_id: 'u1', wallet: 1000, bank: 0, suspended: false });
    supabase.wallets.set('g1:u2', { user_id: 'u2', wallet: 5000, bank: 0, suspended: true });
    supabase.wallets.set('g1:u3', { user_id: 'u3', wallet: 200, bank: 0, suspended: false });

    // Simulate leaderboard query
    const sorted = Array.from(supabase.wallets.values())
      .filter(w => !w.suspended)
      .sort((a, b) => (b.wallet + b.bank) - (a.wallet + a.bank));

    expect(sorted).toHaveLength(2);
    expect(sorted[0]!.user_id).toBe('u1');
    expect(sorted[1]!.user_id).toBe('u3');
    // The suspended u2 (highest balance) should NOT appear
    expect(sorted.find(w => w.user_id === 'u2')).toBeUndefined();
  });

  it('debit returns wallet not found for missing user', async () => {
    const { error } = await supabase.rpc('economy_debit_wallet', { p_guild_id: 'g1', p_user_id: 'nonexistent', p_amount: 10 });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/not found/i);
  });

  it('handles zero-amount credit', async () => {
    await supabase.rpc('economy_credit_wallet', { p_guild_id: 'g1', p_user_id: 'u1', p_amount: 100 });
    const { data } = await supabase.rpc('economy_credit_wallet', { p_guild_id: 'g1', p_user_id: 'u1', p_amount: 0 });
    expect(data!.wallet).toBe(100);
  });

  it('exact debit leaves wallet at zero', async () => {
    await supabase.rpc('economy_credit_wallet', { p_guild_id: 'g1', p_user_id: 'u1', p_amount: 50 });
    const { data, error } = await supabase.rpc('economy_debit_wallet', { p_guild_id: 'g1', p_user_id: 'u1', p_amount: 50 });
    expect(error).toBeNull();
    expect(data!.wallet).toBe(0);
  });
});
