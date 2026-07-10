/**
 * Compliance wall — COLLECTION GUARD matrix (defense-in-depth layer).
 *
 * Covers economy/commerce-role-guard.ts (the collection column of the
 * DECISION MATRIX documented in
 * packages/dashboard/src/lib/api/commerce-income-wall.ts) and its consumer,
 * economy/commands.ts handleCollectIncome. Fixtures run through a small
 * interpreting PostgREST fake so every matrix row asserts real filter
 * behaviour (sources, expiry, permanence, sale evidence), not query shapes.
 *
 * Even if a role slips past the dashboard config-time walls, a role held via
 * a real-money grant must never pay wagerable currency — while giveaway/comp
 * holders, expired temp grants, and roles on never-sold products still pay.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { getCommerceHeldRoleIds } from '../features/economy/commerce-role-guard.js';
import { handleEconomyCommand } from '../features/economy/commands.js';

// ── Interpreting PostgREST fake (mirrors the dashboard test harness) ────────

type Row = Record<string, unknown>;

interface TableConfig {
  rows?: Row[];
  readError?: { message: string };
}

function getCol(row: Row, col: string): unknown {
  if (col.includes('->>')) {
    const [base, key] = col.split('->>');
    const obj = row[base] as Record<string, unknown> | null | undefined;
    const v = obj?.[key];
    return v == null ? null : String(v);
  }
  if (col.includes('->')) {
    const [base, key] = col.split('->');
    const obj = row[base] as Record<string, unknown> | null | undefined;
    return obj?.[key] ?? null;
  }
  return row[col];
}

function matchesOp(row: Row, col: string, op: string, val: unknown): boolean {
  const cell = getCol(row, col);
  switch (op) {
    case 'eq':
      return cell === val || String(cell) === String(val);
    case 'neq':
      return !(cell === val || String(cell) === String(val));
    case 'gt':
      return typeof cell === 'number' ? cell > Number(val) : String(cell ?? '') > String(val);
    case 'is':
      return val === null ? cell == null : cell === val;
    case 'in': {
      const list = Array.isArray(val)
        ? val.map(String)
        : String(val).replace(/^\(|\)$/g, '').split(',').map((s) => s.replace(/^"|"$/g, ''));
      return cell != null && list.includes(String(cell));
    }
    default:
      throw new Error(`fake postgrest: unsupported op ${op}`);
  }
}

function matchesOrDisjunct(row: Row, disjunct: string): boolean {
  const parts = disjunct.split('.');
  const col = parts[0];
  if (parts[1] === 'not') {
    const val = parts[3] === 'null' ? null : parts.slice(3).join('.');
    return !matchesOp(row, col, parts[2], val);
  }
  const val = parts[2] === 'null' ? null : parts.slice(2).join('.');
  return matchesOp(row, col, parts[1], val);
}

function makeSupabase(tables: Record<string, TableConfig>) {
  function from(table: string) {
    const cfg = tables[table] ?? {};
    const conds: ((row: Row) => boolean)[] = [];
    let limitN: number | undefined;

    const result = () => {
      if (cfg.readError) return { data: null, error: cfg.readError };
      let rows = (cfg.rows ?? []).filter((r) => conds.every((c) => c(r)));
      if (limitN != null) rows = rows.slice(0, limitN);
      return { data: rows, error: null };
    };

    const chain: Record<string, unknown> = {
      select: () => chain,
      order: () => chain,
      limit: (n: number) => { limitN = n; return chain; },
      eq: (col: string, val: unknown) => { conds.push((r) => matchesOp(r, col, 'eq', val)); return chain; },
      neq: (col: string, val: unknown) => { conds.push((r) => matchesOp(r, col, 'neq', val)); return chain; },
      gt: (col: string, val: unknown) => { conds.push((r) => matchesOp(r, col, 'gt', val)); return chain; },
      in: (col: string, val: unknown) => { conds.push((r) => matchesOp(r, col, 'in', val)); return chain; },
      is: (col: string, val: unknown) => { conds.push((r) => matchesOp(r, col, 'is', val)); return chain; },
      not: (col: string, op: string, val: unknown) => {
        conds.push((r) => !matchesOp(r, col, op, val === 'null' ? null : val));
        return chain;
      },
      or: (expr: string) => {
        conds.push((r) => expr.split(',').some((d) => matchesOrDisjunct(r, d)));
        return chain;
      },
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(result()).then(resolve, reject),
    };
    return chain;
  }
  return { from: vi.fn(from) };
}

// ── Fixture builders ────────────────────────────────────────────────────────

const GUILD = 'g1';
const USER = 'u1';
const PRODUCT = 'prod-1';

const FUTURE = new Date(Date.now() + 3600_000).toISOString();
const PAST = new Date(Date.now() - 3600_000).toISOString();

function entitlement(roles: string[], source: string | null = 'purchase', status = 'active'): Row {
  return { guild_id: GUILD, customer_id: 'cust-1', granted_role_ids: roles, source, status };
}

function tempGrant(roleId: string, opts: { source?: string; expires_at?: string } = {}): Row {
  return {
    guild_id: GUILD, user_id: USER, role_id: roleId,
    source: opts.source ?? 'commerce_purchase',
    expires_at: opts.expires_at ?? FUTURE,
  };
}

function metaProduct(metadata: Record<string, unknown>, id = PRODUCT): Row {
  return { id, guild_id: GUILD, metadata };
}

function order(o: { amount_cents?: number; status?: string; source?: string | null; paypal_subscription_id?: string | null; product_id?: string } = {}): Row {
  return {
    id: `order-${Math.random().toString(36).slice(2, 8)}`,
    guild_id: GUILD,
    product_id: o.product_id ?? PRODUCT,
    amount_cents: o.amount_cents ?? 1500,
    status: o.status ?? 'completed',
    source: o.source === undefined ? 'purchase' : o.source,
    paypal_subscription_id: o.paypal_subscription_id ?? null,
  };
}

const CUSTOMER = { rows: [{ id: 'cust-1', guild_id: GUILD, discord_id: USER }] };

// ═════════════════════════════════════════════════════════════════════════
// COLLECTION GUARD MATRIX — getCommerceHeldRoleIds
// ═════════════════════════════════════════════════════════════════════════

describe('COLLECTION GUARD MATRIX — getCommerceHeldRoleIds', () => {
  const CASES: {
    name: string;
    tables: Record<string, TableConfig>;
    candidates: string[];
    held: string[];
  }[] = [
    // ── L1: entitlements ──
    { name: 'L1: purchase-source active entitlement excludes the role',
      tables: { customers: CUSTOMER, entitlements: { rows: [entitlement(['role-paid'])] } },
      candidates: ['role-paid', 'role-free'], held: ['role-paid'] },
    { name: 'L1: grace_period entitlement still excludes',
      tables: { customers: CUSTOMER, entitlements: { rows: [entitlement(['role-paid'], 'purchase', 'grace_period')] } },
      candidates: ['role-paid'], held: ['role-paid'] },
    { name: 'L1: revoked/expired entitlements do not exclude',
      tables: { customers: CUSTOMER, entitlements: { rows: [
        entitlement(['role-a'], 'purchase', 'revoked'),
        entitlement(['role-b'], 'purchase', 'expired'),
      ] } },
      candidates: ['role-a', 'role-b'], held: [] },
    { name: 'L1: comped sources (giveaway/manual/automation) do not exclude',
      tables: { customers: CUSTOMER, entitlements: { rows: [
        entitlement(['role-giveaway'], 'giveaway'),
        entitlement(['role-manual'], 'manual'),
        entitlement(['role-auto'], 'automation'),
      ] } },
      candidates: ['role-giveaway', 'role-manual', 'role-auto'], held: [] },
    { name: 'L1: NULL and unknown sources fail CLOSED as purchases',
      tables: { customers: CUSTOMER, entitlements: { rows: [
        entitlement(['role-null'], null),
        entitlement(['role-mystery'], 'mystery_source'),
      ] } },
      candidates: ['role-null', 'role-mystery'], held: ['role-null', 'role-mystery'] },

    // ── L2: temp grants ──
    { name: 'L2: unexpired commerce temp grant excludes',
      tables: { temp_role_grants: { rows: [tempGrant('role-temp')] } },
      candidates: ['role-temp', 'role-free'], held: ['role-temp'] },
    { name: 'L2: EXPIRED commerce temp grant does not exclude',
      tables: { temp_role_grants: { rows: [tempGrant('role-temp', { expires_at: PAST })] } },
      candidates: ['role-temp'], held: [] },
    { name: 'L2: non-commerce temp grant sources do not exclude',
      tables: { temp_role_grants: { rows: [tempGrant('role-temp', { source: 'level_reward' })] } },
      candidates: ['role-temp'], held: [] },

    // ── L3/V3: permanent metadata grants, judged on sale evidence ──
    { name: 'V3: permanent metadata role on a product that SOLD excludes',
      tables: {
        products: { rows: [metaProduct({ grant_role_id: 'role-perma' })] },
        orders: { rows: [order({})] },
      },
      candidates: ['role-perma', 'role-free'], held: ['role-perma'] },
    { name: 'V3: permanent metadata role on a NEVER-SOLD product pays (no commerce holder can exist)',
      tables: { products: { rows: [metaProduct({ grant_role_id: 'role-perma' })] }, orders: { rows: [] } },
      candidates: ['role-perma'], held: [] },
    { name: 'V3: TEMPORARY metadata role is not matched here even if sold (L2 owns it, and it expires)',
      tables: {
        products: { rows: [metaProduct({ grant_role_id: 'role-temp', role_duration_hours: 24 })] },
        orders: { rows: [order({})] },
      },
      candidates: ['role-temp'], held: [] },
    { name: 'V3: only zero-amount orders — pays (no money moved)',
      tables: {
        products: { rows: [metaProduct({ grant_role_id: 'role-perma' })] },
        orders: { rows: [order({ amount_cents: 0 })] },
      },
      candidates: ['role-perma'], held: [] },
    { name: 'V3: only pending/cancelled orders — pays (never fulfilled)',
      tables: {
        products: { rows: [metaProduct({ grant_role_id: 'role-perma' })] },
        orders: { rows: [order({ status: 'pending' }), order({ status: 'cancelled' })] },
      },
      candidates: ['role-perma'], held: [] },
    { name: 'V3: a REFUNDED paid order still excludes (refunds never remove a permanent metadata role)',
      tables: {
        products: { rows: [metaProduct({ grant_role_id: 'role-perma' })] },
        orders: { rows: [order({ status: 'refunded' })] },
      },
      candidates: ['role-perma'], held: ['role-perma'] },
    { name: 'V3: only comped (giveaway/manual) orders — pays',
      tables: {
        products: { rows: [metaProduct({ grant_role_id: 'role-perma' })] },
        orders: { rows: [order({ source: 'giveaway' }), order({ source: 'manual' })] },
      },
      candidates: ['role-perma'], held: [] },
    { name: 'V3: only SUBSCRIPTION orders — pays (subscriptions never consume the metadata vector)',
      tables: {
        products: { rows: [metaProduct({ grant_role_id: 'role-perma' })] },
        orders: { rows: [order({ paypal_subscription_id: 'I-SUB1' })] },
      },
      candidates: ['role-perma'], held: [] },
    { name: 'V3: evidence survives product deactivation/re-typing (no product-state filters)',
      tables: {
        // Row deliberately carries free/inactive state — the guard must not care.
        products: { rows: [{ ...metaProduct({ grant_role_id: 'role-perma' }), type: 'free', active: false }] },
        orders: { rows: [order({})] },
      },
      candidates: ['role-perma'], held: ['role-perma'] },

    // ── L3/V4: recorded historical grants ──
    { name: 'V4: role in historical_grant_role_ids excludes, whatever the live metadata says',
      tables: { products: { rows: [metaProduct({ historical_grant_role_ids: ['role-hist'] })] } },
      candidates: ['role-hist', 'role-free'], held: ['role-hist'] },
    { name: 'V4: history for other roles does not exclude the candidate',
      tables: { products: { rows: [metaProduct({ historical_grant_role_ids: ['role-other'] })] } },
      candidates: ['role-hist'], held: [] },

    // ── nothing commerce-ish ──
    { name: 'no commerce records at all — nothing excluded',
      tables: {},
      candidates: ['role-earned'], held: [] },
  ];

  it.each(CASES)('$name', async ({ tables, candidates, held }) => {
    const supabase = makeSupabase(tables);
    const result = await getCommerceHeldRoleIds(supabase as never, GUILD, USER, candidates);
    expect([...result].sort()).toEqual([...held].sort());
  });

  it('fails CLOSED: any query error excludes every candidate', async () => {
    const supabase = makeSupabase({ customers: { readError: { message: 'db down' } } });
    const held = await getCommerceHeldRoleIds(supabase as never, GUILD, USER, ['a', 'b']);
    expect([...held].sort()).toEqual(['a', 'b']);
  });

  it('fails CLOSED on an orders (V3 evidence) error too', async () => {
    const supabase = makeSupabase({
      products: { rows: [metaProduct({ grant_role_id: 'role-perma' })] },
      orders: { readError: { message: 'db down' } },
    });
    const held = await getCommerceHeldRoleIds(supabase as never, GUILD, USER, ['role-perma', 'role-free']);
    expect([...held].sort()).toEqual(['role-free', 'role-perma']);
  });

  it('short-circuits with no query when there are no candidate roles', async () => {
    const supabase = makeSupabase({});
    const held = await getCommerceHeldRoleIds(supabase as never, GUILD, USER, []);
    expect(held.size).toBe(0);
    expect(supabase.from).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// End-to-end: handleCollectIncome pays earned roles, skips commerce roles
// ═════════════════════════════════════════════════════════════════════════

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

function incomeRule(roleId: string, amount: number): Row {
  return { guild_id: GUILD, role_id: roleId, amount, interval_minutes: 60 };
}

describe('handleCollectIncome — compliance wall at collection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('pays an earned role but NOT a commerce-entitled role with the same income config', async () => {
    const supabase = makeSupabase({
      economy_role_income: { rows: [incomeRule('role-paid', 500), incomeRule('role-earned', 100)] },
      customers: CUSTOMER,
      entitlements: { rows: [entitlement(['role-paid'])] },
    });
    const mgr = makeManager();
    const int = makeInteraction(supabase, ['role-paid', 'role-earned']);

    await handleEconomyCommand(int as never, mgr as never);

    expect(mgr.creditWallet).toHaveBeenCalledWith(USER, 100);
    const reply = int.reply.mock.calls[0][0].content as string;
    expect(reply).toContain('from 1 role');
  });

  it('pays NOTHING and explains when the only income role is commerce-held', async () => {
    const supabase = makeSupabase({
      economy_role_income: { rows: [incomeRule('role-paid', 500)] },
      customers: CUSTOMER,
      entitlements: { rows: [entitlement(['role-paid'])] },
    });
    const mgr = makeManager();
    const int = makeInteraction(supabase, ['role-paid']);

    await handleEconomyCommand(int as never, mgr as never);

    expect(mgr.creditWallet).not.toHaveBeenCalled();
    const reply = int.reply.mock.calls[0][0].content as string;
    expect(reply.toLowerCase()).toContain('store purchase');
  });

  it('pays a GIVEAWAY-granted role in full — comped entitlements are not commerce holds', async () => {
    const supabase = makeSupabase({
      economy_role_income: { rows: [incomeRule('role-comped', 150)] },
      customers: CUSTOMER,
      entitlements: { rows: [entitlement(['role-comped'], 'giveaway')] },
    });
    const mgr = makeManager();
    const int = makeInteraction(supabase, ['role-comped']);

    await handleEconomyCommand(int as never, mgr as never);

    expect(mgr.creditWallet).toHaveBeenCalledWith(USER, 150);
  });

  it('skips a SOLD permanent-metadata role but pays the same role config to nobody else affected', async () => {
    const supabase = makeSupabase({
      economy_role_income: { rows: [incomeRule('role-perma', 500), incomeRule('role-earned', 250)] },
      products: { rows: [metaProduct({ grant_role_id: 'role-perma' })] },
      orders: { rows: [order({})] },
    });
    const mgr = makeManager();
    const int = makeInteraction(supabase, ['role-perma', 'role-earned']);

    await handleEconomyCommand(int as never, mgr as never);

    expect(mgr.creditWallet).toHaveBeenCalledWith(USER, 250);
  });

  it('pays a metadata role whose product NEVER sold (staged products do not starve holders)', async () => {
    const supabase = makeSupabase({
      economy_role_income: { rows: [incomeRule('role-perma', 300)] },
      products: { rows: [metaProduct({ grant_role_id: 'role-perma' })] },
      orders: { rows: [] },
    });
    const mgr = makeManager();
    const int = makeInteraction(supabase, ['role-perma']);

    await handleEconomyCommand(int as never, mgr as never);

    expect(mgr.creditWallet).toHaveBeenCalledWith(USER, 300);
  });

  it('pays a normally-earned role in full when no commerce grant is present', async () => {
    const supabase = makeSupabase({
      economy_role_income: { rows: [incomeRule('role-earned', 250)] },
    });
    const mgr = makeManager();
    const int = makeInteraction(supabase, ['role-earned']);

    await handleEconomyCommand(int as never, mgr as never);

    expect(mgr.creditWallet).toHaveBeenCalledWith(USER, 250);
  });

  it('skips a zero-amount rule WITHOUT burning its cooldown or crediting', async () => {
    const supabase = makeSupabase({
      economy_role_income: { rows: [incomeRule('role-zero', 0)] },
    });
    const mgr = makeManager();
    const int = makeInteraction(supabase, ['role-zero']);

    await handleEconomyCommand(int as never, mgr as never);

    expect(mgr.creditWallet).not.toHaveBeenCalled();
    expect(mgr.valkey.set).not.toHaveBeenCalled();
    const reply = int.reply.mock.calls[0][0].content as string;
    expect(reply.toLowerCase()).toContain('no role income available');
  });

  it('pays only the positive rule when a zero-amount rule is also configured', async () => {
    const supabase = makeSupabase({
      economy_role_income: { rows: [incomeRule('role-zero', 0), incomeRule('role-earned', 300)] },
    });
    const mgr = makeManager();
    const int = makeInteraction(supabase, ['role-zero', 'role-earned']);

    await handleEconomyCommand(int as never, mgr as never);

    expect(mgr.creditWallet).toHaveBeenCalledWith(USER, 300);
    expect(mgr.valkey.set).toHaveBeenCalledTimes(1);
  });
});
