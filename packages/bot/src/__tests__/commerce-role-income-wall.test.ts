/**
 * Compliance wall — commerce-granted roles earn NO game currency (collection-time).
 *
 * Covers the defense-in-depth layer in economy/commands.ts handleCollectIncome
 * and its helper economy/commerce-role-guard.ts. Even if a role slips past the
 * dashboard config-time reject, a role the user holds via a commerce grant must
 * never pay wagerable currency, while a normally-earned role still pays.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { getCommerceHeldRoleIds, COMMERCE_TEMP_ROLE_SOURCES } from '../features/economy/commerce-role-guard.js';
import { handleEconomyCommand } from '../features/economy/commands.js';

// ── Supabase mock: a chainable per-table query builder that resolves to a
//    caller-provided result, so we can assert exact table access. ───────────

interface TableResult {
  data?: unknown;
  error?: { message: string } | null;
}

function makeSupabase(results: Record<string, TableResult | ((state: QueryState) => TableResult)>) {
  const calls: Record<string, QueryState[]> = {};

  function tableBuilder(table: string) {
    const state: QueryState = { table, filters: {}, inFilters: {}, gt: {} };
    const chain: Record<string, unknown> = {
      select: vi.fn(() => chain),
      eq: vi.fn((col: string, val: unknown) => { state.filters[col] = val; return chain; }),
      in: vi.fn((col: string, vals: unknown) => { state.inFilters[col] = vals; return chain; }),
      gt: vi.fn((col: string, val: unknown) => { state.gt[col] = val; return chain; }),
      neq: vi.fn(() => chain),
      order: vi.fn(() => chain),
      limit: vi.fn(() => {
        (calls[table] ??= []).push(state);
        const r = results[table];
        const resolved = typeof r === 'function' ? r(state) : (r ?? { data: [] });
        return Promise.resolve(resolved);
      }),
    };
    return chain;
  }

  return {
    from: vi.fn((table: string) => tableBuilder(table)),
    _calls: calls,
  };
}

interface QueryState {
  table: string;
  filters: Record<string, unknown>;
  inFilters: Record<string, unknown>;
  gt: Record<string, unknown>;
}

const GUILD = 'g1';
const USER = 'u1';

describe('getCommerceHeldRoleIds', () => {
  it('flags a role held via an active entitlement (customers → entitlements)', async () => {
    const supabase = makeSupabase({
      customers: { data: [{ id: 'cust-1' }] },
      entitlements: { data: [{ granted_role_ids: ['role-paid'] }] },
      temp_role_grants: { data: [] },
    });
    const held = await getCommerceHeldRoleIds(supabase as any, GUILD, USER, ['role-paid', 'role-free']);
    expect([...held]).toEqual(['role-paid']);
  });

  it('flags a role held via an unexpired commerce temp_role_grant', async () => {
    const supabase = makeSupabase({
      customers: { data: [] }, // no entitlements path
      temp_role_grants: { data: [{ role_id: 'role-temp' }] },
    });
    const held = await getCommerceHeldRoleIds(supabase as any, GUILD, USER, ['role-temp', 'role-free']);
    expect([...held]).toEqual(['role-temp']);
  });

  it('filters temp grants by commerce sources and unexpired only', async () => {
    const supabase = makeSupabase({
      customers: { data: [] },
      temp_role_grants: (state) => {
        // Assert the query constrains source to commerce sources and expiry > now.
        expect(state.inFilters.source).toEqual(COMMERCE_TEMP_ROLE_SOURCES);
        expect(typeof state.gt.expires_at).toBe('string');
        expect(state.filters.user_id).toBe(USER);
        return { data: [{ role_id: 'role-temp' }] };
      },
    });
    const held = await getCommerceHeldRoleIds(supabase as any, GUILD, USER, ['role-temp']);
    expect(held.has('role-temp')).toBe(true);
  });

  it('returns empty when the user holds none of the candidate roles via commerce', async () => {
    const supabase = makeSupabase({
      customers: { data: [{ id: 'cust-1' }] },
      entitlements: { data: [{ granted_role_ids: ['some-other-role'] }] },
      temp_role_grants: { data: [] },
    });
    const held = await getCommerceHeldRoleIds(supabase as any, GUILD, USER, ['role-earned']);
    expect(held.size).toBe(0);
  });

  it('fails CLOSED: on a query error, treats every candidate as commerce-held', async () => {
    const supabase = makeSupabase({
      customers: { error: { message: 'db down' }, data: null },
    });
    const held = await getCommerceHeldRoleIds(supabase as any, GUILD, USER, ['a', 'b']);
    expect([...held].sort()).toEqual(['a', 'b']);
  });

  it('short-circuits with no query when there are no candidate roles', async () => {
    const supabase = makeSupabase({});
    const held = await getCommerceHeldRoleIds(supabase as any, GUILD, USER, []);
    expect(held.size).toBe(0);
    expect(supabase.from).not.toHaveBeenCalled();
  });
});

// ── End-to-end: handleCollectIncome pays earned roles, skips commerce roles ──

function makeManager() {
  const store = new Map<string, string>();
  return {
    loadConfig: vi.fn().mockResolvedValue({ economy_enabled: true, currency_emoji: '💰', currency_name: 'coins' }),
    creditWallet: vi.fn().mockResolvedValue({ wallet: 1000 }),
    valkey: {
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      set: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
    },
  };
}

function makeInteraction(supabase: unknown, heldRoleIds: string[]) {
  const cache = new Map(heldRoleIds.map((id) => [id, {}]));
  return {
    client: { supabase },
    guildId: GUILD,
    user: { id: USER },
    member: { roles: { cache } },
    reply: vi.fn().mockResolvedValue(undefined),
    options: { getSubcommand: vi.fn().mockReturnValue('collect-income') },
    commandName: 'collect-income',
  };
}

describe('handleCollectIncome — compliance wall at collection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('pays an earned role but NOT a commerce-held role with the same income config', async () => {
    // Both roles are configured for income and both are held. role-paid is held
    // via a commerce entitlement; role-earned is a normal role.
    const supabase = makeSupabase({
      economy_role_income: { data: [
        { role_id: 'role-paid', amount: 500, interval_minutes: 60 },
        { role_id: 'role-earned', amount: 100, interval_minutes: 60 },
      ] },
      customers: { data: [{ id: 'cust-1' }] },
      entitlements: { data: [{ granted_role_ids: ['role-paid'] }] },
      temp_role_grants: { data: [] },
    });
    const mgr = makeManager();
    const int = makeInteraction(supabase, ['role-paid', 'role-earned']);

    await handleEconomyCommand(int as any, mgr as any);

    // Only the earned role (100) is credited — the commerce role (500) is excluded.
    expect(mgr.creditWallet).toHaveBeenCalledWith(USER, 100);
    const reply = int.reply.mock.calls[0][0].content as string;
    expect(reply).toContain('from 1 role');
  });

  it('pays NOTHING and explains when the only income role is commerce-held', async () => {
    const supabase = makeSupabase({
      economy_role_income: { data: [{ role_id: 'role-paid', amount: 500, interval_minutes: 60 }] },
      customers: { data: [{ id: 'cust-1' }] },
      entitlements: { data: [{ granted_role_ids: ['role-paid'] }] },
      temp_role_grants: { data: [] },
    });
    const mgr = makeManager();
    const int = makeInteraction(supabase, ['role-paid']);

    await handleEconomyCommand(int as any, mgr as any);

    expect(mgr.creditWallet).not.toHaveBeenCalled();
    const reply = int.reply.mock.calls[0][0].content as string;
    expect(reply.toLowerCase()).toContain('store purchase');
  });

  it('pays a normally-earned role in full when no commerce grant is present', async () => {
    const supabase = makeSupabase({
      economy_role_income: { data: [{ role_id: 'role-earned', amount: 250, interval_minutes: 60 }] },
      customers: { data: [] },
      temp_role_grants: { data: [] },
    });
    const mgr = makeManager();
    const int = makeInteraction(supabase, ['role-earned']);

    await handleEconomyCommand(int as any, mgr as any);

    expect(mgr.creditWallet).toHaveBeenCalledWith(USER, 250);
  });
});
