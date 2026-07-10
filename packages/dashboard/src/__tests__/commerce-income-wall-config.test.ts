/**
 * Compliance wall — config-time enforcement of the DECISION MATRIX
 * (see packages/dashboard/src/lib/api/commerce-income-wall.ts).
 *
 * Every enforcement site is exercised against the same fixture database
 * through a small interpreting PostgREST fake, so each matrix row asserts
 * REAL route behaviour (409 blocked / 2xx allowed / 5xx fail-closed), not
 * query shapes:
 *
 *   - MATRIX A  income side  (/api/economy/role-income POST) over every
 *     {product type × active × price/plan state × grant vector × permanence ×
 *     sale history × income amount} combination,
 *   - MATRIX B  product side (/api/store/products POST + PUT), including the
 *     fail-closed stored-row lookup and the V4 history recording,
 *   - MATRIX C  plan side    (/api/store/plans POST + PUT).
 *
 * A real-money purchase must never be able to fund wagerable game currency —
 * and config that moves no real money must never be blocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn() }));
vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/rbac', () => ({
  requirePermission: vi.fn(),
  authErrorResponse: vi.fn(),
}));
vi.mock('@/lib/notify-bot', () => ({ notifyBot: vi.fn() }));
vi.mock('@/lib/paypal', () => ({
  getPayPalRuntimeConfig: vi.fn(),
  getPayPalToken: vi.fn(),
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));

import { POST as productsPOST, PUT as productsPUT } from '@/app/api/store/products/route';
import { POST as plansPOST, PUT as plansPUT } from '@/app/api/store/plans/route';
import { POST as roleIncomePOST } from '@/app/api/economy/role-income/route';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { requirePermission } from '@/lib/rbac';
import { notifyBot } from '@/lib/notify-bot';
import { getPayPalRuntimeConfig, getPayPalToken } from '@/lib/paypal';
import { createAdminSupabase } from '@/lib/supabase/admin';

import { buildRequest, mockAuthSuccess, mockRateLimitPass } from './helpers';

const GUILD = 'guild-1';
const ROLE = '111111111111111111';
const OTHER_ROLE = '222222222222222222';
const PRODUCT_ID = '00000000-0000-0000-0000-00000000000a';
const PLAN_ID = '00000000-0000-0000-0000-00000000000b';

// ── Interpreting PostgREST fake ─────────────────────────────────────────────
// Applies eq/neq/gt/in/is/not/or/overlaps against fixture rows so tests can
// assert route behaviour over a tiny in-memory database. Writes are recorded
// (never applied) and resolve to a configurable result.

type Row = Record<string, unknown>;

interface TableConfig {
  rows?: Row[];
  /** Fail every read on this table (fail-closed tests). */
  readError?: { message: string };
  /** Result for insert/update/upsert/delete terminals. */
  writeResult?: { data?: unknown; error?: { message: string } | null };
}

interface RecordedWrite {
  op: 'insert' | 'update' | 'upsert' | 'delete';
  payload: unknown;
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
    case 'overlaps': {
      const arr = (cell as unknown[] | null) ?? [];
      return Array.isArray(val) && val.some((v) => arr.includes(v));
    }
    default:
      throw new Error(`fake postgrest: unsupported op ${op}`);
  }
}

/** Parse one `or()` disjunct like `price_cents.gt.0` / `paypal_plan_id.not.is.null`. */
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

function createFakeSupabase(tables: Record<string, TableConfig>) {
  const writes: Record<string, RecordedWrite[]> = {};

  function from(table: string) {
    const cfg = tables[table] ?? {};
    const conds: ((row: Row) => boolean)[] = [];
    let mode: 'read' | 'write' = 'read';
    let limitN: number | undefined;

    const readResult = () => {
      if (cfg.readError) return { data: null, error: cfg.readError };
      let rows = (cfg.rows ?? []).filter((r) => conds.every((c) => c(r)));
      if (limitN != null) rows = rows.slice(0, limitN);
      return { data: rows, error: null };
    };
    const writeResult = () => cfg.writeResult ?? { data: { id: 'written-row' }, error: null };
    const result = () => (mode === 'write' ? writeResult() : readResult());

    const record = (op: RecordedWrite['op'], payload: unknown) => {
      (writes[table] ??= []).push({ op, payload });
      mode = 'write';
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
      overlaps: (col: string, val: unknown) => { conds.push((r) => matchesOp(r, col, 'overlaps', val)); return chain; },
      not: (col: string, op: string, val: unknown) => {
        conds.push((r) => !matchesOp(r, col, op, val === 'null' ? null : val));
        return chain;
      },
      or: (expr: string) => {
        conds.push((r) => expr.split(',').some((d) => matchesOrDisjunct(r, d)));
        return chain;
      },
      insert: (payload: unknown) => { record('insert', payload); return chain; },
      update: (payload: unknown) => { record('update', payload); return chain; },
      upsert: (payload: unknown) => { record('upsert', payload); return chain; },
      delete: () => { record('delete', null); return chain; },
      single: () => {
        const r = result();
        if (mode === 'write') return Promise.resolve(r);
        const rows = (r.data as Row[] | null) ?? [];
        return Promise.resolve(
          r.error
            ? { data: null, error: r.error }
            : { data: rows[0] ?? null, error: rows.length === 0 ? { message: '0 rows' } : null },
        );
      },
      maybeSingle: () => {
        const r = result();
        if (mode === 'write') return Promise.resolve(r);
        const rows = (r.data as Row[] | null) ?? [];
        return Promise.resolve(r.error ? { data: null, error: r.error } : { data: rows[0] ?? null, error: null });
      },
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(result()).then(resolve, reject),
    };
    return chain;
  }

  return { from, _writes: writes };
}

// ── Fixture builders ────────────────────────────────────────────────────────

interface ProductFixture {
  id?: string;
  type: string;
  active?: boolean;
  price_cents?: number;
  granted_role_ids?: string[];
  metadata?: Record<string, unknown>;
}

function product(p: ProductFixture): Row {
  return {
    id: p.id ?? PRODUCT_ID,
    guild_id: GUILD,
    type: p.type,
    active: p.active ?? true,
    price_cents: p.price_cents ?? 0,
    granted_role_ids: p.granted_role_ids ?? [],
    metadata: p.metadata ?? {},
  };
}

function plan(p: { product_id?: string; active?: boolean; price_cents?: number; paypal_plan_id?: string | null }): Row {
  return {
    id: PLAN_ID,
    guild_id: GUILD,
    product_id: p.product_id ?? PRODUCT_ID,
    active: p.active ?? true,
    price_cents: p.price_cents ?? 0,
    paypal_plan_id: p.paypal_plan_id ?? null,
  };
}

function order(o: { product_id?: string; amount_cents?: number; status?: string; source?: string | null; paypal_subscription_id?: string | null }): Row {
  return {
    id: `order-${Math.random().toString(36).slice(2, 8)}`,
    guild_id: GUILD,
    product_id: o.product_id ?? PRODUCT_ID,
    amount_cents: o.amount_cents ?? 1500,
    status: o.status ?? 'completed',
    source: o.source === undefined ? 'purchase' : o.source,
    paypal_subscription_id: o.paypal_subscription_id ?? null,
  };
}

function incomeRow(roleId: string, amount = 100): Row {
  return { guild_id: GUILD, role_id: roleId, amount };
}

const paypalConfig = {
  apiBase: 'https://api-m.sandbox.paypal.com',
  clientId: 'cid', clientSecret: 'secret', webhookId: 'WH-1',
  webhookUrl: 'https://x/webhook', sandbox: true,
  sources: {},
};

function useFake(tables: Record<string, TableConfig>) {
  const fake = createFakeSupabase(tables);
  (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(fake);
  return fake;
}

// ═════════════════════════════════════════════════════════════════════════
// MATRIX A — income side: /api/economy/role-income POST for role R, given a
// product in every relevant state. One fixture DB per row; expectation is
// the CONFIG WALL column of the matrix.
// ═════════════════════════════════════════════════════════════════════════

describe('MATRIX A — role-income POST vs product state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (requirePermission as ReturnType<typeof vi.fn>).mockResolvedValue({
      guildId: GUILD, userId: 'u', discordId: 'd', permissions: ['dashboard.full_access'],
    });
    mockRateLimitPass(checkAdminRateLimit as ReturnType<typeof vi.fn>);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  const paidOrder = order({});
  const zeroOrder = order({ amount_cents: 0 });
  const pendingOrder = order({ status: 'pending' });
  const cancelledOrder = order({ status: 'cancelled' });
  const pendingReviewOrder = order({ status: 'pending_review' });
  const refundedOrder = order({ status: 'refunded' });
  const giveawayOrder = order({ source: 'giveaway' });
  const subscriptionOrder = order({ paypal_subscription_id: 'I-SUB1' });

  const CASES: {
    name: string;
    products: Row[];
    plans?: Row[];
    orders?: Row[];
    blocked: boolean;
  }[] = [
    // ── V1: granted_role_ids array vector ──
    { name: 'V1: buyable one_time (active, priced) granting R blocks',
      products: [product({ type: 'one_time', price_cents: 2500, granted_role_ids: [ROLE] })], blocked: true },
    { name: 'V1: zero-price one_time granting R does not block (charges nothing)',
      products: [product({ type: 'one_time', price_cents: 0, granted_role_ids: [ROLE] })], blocked: false },
    { name: 'V1: INACTIVE priced one_time granting R does not block (not buyable)',
      products: [product({ type: 'one_time', price_cents: 2500, active: false, granted_role_ids: [ROLE] })], blocked: false },
    { name: 'V1: free product granting R does not block (never buyable)',
      products: [product({ type: 'free', granted_role_ids: [ROLE] })], blocked: false },
    { name: 'V1: active subscription with an ACTIVE chargeable plan (priced + paypal_plan_id) blocks',
      products: [product({ type: 'subscription', granted_role_ids: [ROLE] })],
      plans: [plan({ price_cents: 999, paypal_plan_id: 'P-1' })], blocked: true },
    { name: 'V1: active subscription with a zero-price plan that HAS a paypal_plan_id blocks (PayPal price is authoritative)',
      products: [product({ type: 'subscription', granted_role_ids: [ROLE] })],
      plans: [plan({ price_cents: 0, paypal_plan_id: 'P-123' })], blocked: true },
    { name: 'V1: active subscription with only a zero-price, no-PayPal-id plan does not block (checkout cannot start it)',
      products: [product({ type: 'subscription', granted_role_ids: [ROLE] })],
      plans: [plan({ price_cents: 0 })], blocked: false },
    { name: 'V1: active subscription with an active PRICED plan but NO paypal_plan_id does not block (finding #1: checkout rejects it, price_cents cannot charge a subscription)',
      products: [product({ type: 'subscription', granted_role_ids: [ROLE] })],
      plans: [plan({ price_cents: 999, paypal_plan_id: null })], blocked: false },
    { name: 'V1: active subscription with only an INACTIVE paid plan does not block',
      products: [product({ type: 'subscription', granted_role_ids: [ROLE] })],
      plans: [plan({ price_cents: 999, active: false })], blocked: false },
    { name: 'V1: active subscription with NO plans does not block (finding: not chargeable by type alone)',
      products: [product({ type: 'subscription', granted_role_ids: [ROLE] })], blocked: false },
    { name: 'V1: INACTIVE subscription with an active paid plan does not block',
      products: [product({ type: 'subscription', active: false, granted_role_ids: [ROLE] })],
      plans: [plan({ price_cents: 999 })], blocked: false },

    // ── V2: live metadata vector (one-time only) ──
    { name: 'V2: buyable one_time with PERMANENT metadata role blocks',
      products: [product({ type: 'one_time', price_cents: 2500, metadata: { grant_role_id: ROLE } })], blocked: true },
    { name: 'V2: buyable one_time with TEMPORARY metadata role blocks too (a temp grant still moves real money)',
      products: [product({ type: 'one_time', price_cents: 2500, metadata: { grant_role_id: ROLE, role_duration_hours: 24 } })], blocked: true },
    { name: 'V2: chargeable subscription carrying metadata.grant_role_id does NOT block (subscriptions never consume it)',
      products: [product({ type: 'subscription', metadata: { grant_role_id: ROLE } })],
      plans: [plan({ price_cents: 999, paypal_plan_id: 'P-1' })], blocked: false },

    // ── V3: sold permanent metadata (evidence outlives config) ──
    { name: 'V3: deactivated one_time with permanent metadata role that SOLD still blocks',
      products: [product({ type: 'one_time', active: false, price_cents: 2500, metadata: { grant_role_id: ROLE } })],
      orders: [paidOrder], blocked: true },
    { name: 'V3: deactivated one_time with permanent metadata role, NEVER sold, does not block',
      products: [product({ type: 'one_time', active: false, price_cents: 2500, metadata: { grant_role_id: ROLE } })], blocked: false },
    { name: 'V3: only a ZERO-amount completed order — does not block (no money moved)',
      products: [product({ type: 'one_time', active: false, metadata: { grant_role_id: ROLE } })],
      orders: [zeroOrder], blocked: false },
    { name: 'V3: only pending/cancelled orders — does not block (never fulfilled)',
      products: [product({ type: 'one_time', active: false, metadata: { grant_role_id: ROLE } })],
      orders: [pendingOrder, cancelledOrder], blocked: false },
    { name: 'V3: only a PENDING_REVIEW order — does not block (finding #4: amount mismatch parked it, fulfillment never ran, role never granted)',
      products: [product({ type: 'one_time', active: false, metadata: { grant_role_id: ROLE } })],
      orders: [pendingReviewOrder], blocked: false },
    { name: 'V3: a REFUNDED paid order still blocks (refunds never remove a permanent metadata role)',
      products: [product({ type: 'one_time', active: false, metadata: { grant_role_id: ROLE } })],
      orders: [refundedOrder], blocked: true },
    { name: 'V3: only a comped (giveaway-source) order — does not block',
      products: [product({ type: 'one_time', active: false, metadata: { grant_role_id: ROLE } })],
      orders: [giveawayOrder], blocked: false },
    { name: 'V3: only SUBSCRIPTION orders — does not block (metadata never fires on subscription checkout)',
      products: [product({ type: 'subscription', metadata: { grant_role_id: ROLE } })],
      orders: [subscriptionOrder], blocked: false },
    { name: 'V3: product re-typed to subscription AFTER selling one-time still blocks (orders are the truth)',
      products: [product({ type: 'subscription', metadata: { grant_role_id: ROLE } })],
      orders: [paidOrder], blocked: true },
    { name: 'V3: product re-typed to free AFTER selling one-time still blocks',
      products: [product({ type: 'free', active: false, metadata: { grant_role_id: ROLE } })],
      orders: [paidOrder], blocked: true },
    { name: 'V3: TEMPORARY metadata role on a sold, now-inactive product does not block (temp grants expire; per-user rows guard collection)',
      products: [product({ type: 'one_time', active: false, metadata: { grant_role_id: ROLE, role_duration_hours: 24 } })],
      orders: [paidOrder], blocked: false },

    // ── V4: recorded historical grants ──
    { name: 'V4: R in historical_grant_role_ids blocks whatever the product state',
      products: [product({ type: 'free', active: false, metadata: { historical_grant_role_ids: [ROLE] } })], blocked: true },
    { name: 'V4: history for a DIFFERENT role does not block R',
      products: [product({ type: 'free', active: false, metadata: { historical_grant_role_ids: [OTHER_ROLE] } })], blocked: false },

    // ── no grant at all ──
    { name: 'no product grants R — income config allowed',
      products: [product({ type: 'one_time', price_cents: 2500, granted_role_ids: [OTHER_ROLE] })], blocked: false },
  ];

  it.each(CASES)('$name', async ({ products, plans, orders, blocked }) => {
    const fake = useFake({
      products: { rows: products },
      plans: { rows: plans ?? [] },
      orders: { rows: orders ?? [] },
      economy_role_income: {},
    });

    const res = await roleIncomePOST(buildRequest('/api/economy/role-income', {
      method: 'POST',
      body: { role_id: ROLE, amount: 100, interval_minutes: 60 },
    }));
    const body = await res.json();

    if (blocked) {
      expect(res.status).toBe(409);
      expect(String(body.error).toLowerCase()).toContain('compliance');
      expect(fake._writes.economy_role_income ?? []).toHaveLength(0);
      expect(notifyBot).not.toHaveBeenCalled();
    } else {
      expect(res.status).toBe(200);
      expect(fake._writes.economy_role_income?.[0]?.op).toBe('upsert');
      expect(notifyBot).toHaveBeenCalledWith('economy');
    }
  });

  it('fails CLOSED (500, no write) when the products lookup errors', async () => {
    const fake = useFake({
      products: { readError: { message: 'db down' } },
      economy_role_income: {},
    });
    const res = await roleIncomePOST(buildRequest('/api/economy/role-income', {
      method: 'POST',
      body: { role_id: ROLE, amount: 100, interval_minutes: 60 },
    }));
    expect(res.status).toBe(500);
    expect(fake._writes.economy_role_income ?? []).toHaveLength(0);
  });

  it('fails CLOSED (500, no write) when the V3 orders lookup errors', async () => {
    const fake = useFake({
      products: { rows: [product({ type: 'one_time', active: false, metadata: { grant_role_id: ROLE } })] },
      orders: { readError: { message: 'db down' } },
      economy_role_income: {},
    });
    const res = await roleIncomePOST(buildRequest('/api/economy/role-income', {
      method: 'POST',
      body: { role_id: ROLE, amount: 100, interval_minutes: 60 },
    }));
    expect(res.status).toBe(500);
    expect(fake._writes.economy_role_income ?? []).toHaveLength(0);
  });

  it('400-rejects a zero-amount rule at the schema boundary', async () => {
    const fake = useFake({ products: {}, economy_role_income: {} });
    const res = await roleIncomePOST(buildRequest('/api/economy/role-income', {
      method: 'POST',
      body: { role_id: ROLE, amount: 0, interval_minutes: 60 },
    }));
    expect(res.status).toBe(400);
    expect(fake._writes.economy_role_income ?? []).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// MATRIX B — product side: /api/store/products POST + PUT.
// ═════════════════════════════════════════════════════════════════════════

describe('MATRIX B — products POST', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthSuccess(requireGuildOwner as ReturnType<typeof vi.fn>, { guildId: GUILD });
    mockRateLimitPass(checkAdminRateLimit as ReturnType<typeof vi.fn>);
    (getPayPalRuntimeConfig as ReturnType<typeof vi.fn>).mockResolvedValue(paypalConfig);
    (getPayPalToken as ReturnType<typeof vi.fn>).mockResolvedValue('token');
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ id: 'PAYPAL-1' }),
    })));
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  const baseBody = {
    name: 'Founder Pass', delivery_type: 'access_pass', currency: 'USD',
    granted_channel_ids: [],
  };

  const CASES: {
    name: string;
    body: Record<string, unknown>;
    income?: Row[];
    blocked: boolean;
  }[] = [
    { name: 'priced one_time granting an income role → 409',
      body: { ...baseBody, type: 'one_time', price_cents: 2500, granted_role_ids: [ROLE] },
      income: [incomeRow(ROLE)], blocked: true },
    { name: 'income row with amount 0 does not block (zero cannot pay currency)',
      body: { ...baseBody, type: 'one_time', price_cents: 2500, granted_role_ids: [ROLE] },
      income: [incomeRow(ROLE, 0)], blocked: false },
    { name: 'STAGED (inactive) priced one_time with income role allowed — not yet buyable',
      body: { ...baseBody, type: 'one_time', price_cents: 2500, active: false, granted_role_ids: [ROLE] },
      income: [incomeRow(ROLE)], blocked: false },
    { name: 'zero-price one_time with income role allowed — charges nothing',
      body: { ...baseBody, type: 'one_time', price_cents: 0, granted_role_ids: [ROLE] },
      income: [incomeRow(ROLE)], blocked: false },
    { name: 'free product with income role allowed',
      body: { ...baseBody, type: 'free', price_cents: 0, granted_role_ids: [ROLE] },
      income: [incomeRow(ROLE)], blocked: false },
    { name: 'subscription with a PAID plan definition granting income role → 409',
      body: { ...baseBody, type: 'subscription', price_cents: 0, granted_role_ids: [ROLE],
        plans: [{ name: 'Monthly', interval_unit: 'MONTH', interval_count: 1, price_cents: 999 }] },
      income: [incomeRow(ROLE)], blocked: true },
    { name: 'subscription with NO plans and price 0 granting income role allowed (nothing chargeable is created)',
      body: { ...baseBody, type: 'subscription', price_cents: 0, granted_role_ids: [ROLE] },
      income: [incomeRow(ROLE)], blocked: false },
    { name: 'subscription with NO plan defs but priced product → 409 (a default paid plan is auto-created)',
      body: { ...baseBody, type: 'subscription', price_cents: 999, granted_role_ids: [ROLE] },
      income: [incomeRow(ROLE)], blocked: true },
    { name: 'subscription with only ZERO-price plan defs and price 0 allowed',
      body: { ...baseBody, type: 'subscription', price_cents: 0, granted_role_ids: [ROLE],
        plans: [{ name: 'Free', interval_unit: 'MONTH', interval_count: 1, price_cents: 0 }] },
      income: [incomeRow(ROLE)], blocked: false },
    { name: 'priced one_time whose metadata.grant_role_id earns income → 409 (V2)',
      body: { ...baseBody, type: 'one_time', price_cents: 2500, granted_role_ids: [],
        metadata: { grant_role_id: ROLE } },
      income: [incomeRow(ROLE)], blocked: true },
    { name: 'paid subscription whose METADATA role earns income allowed (metadata never fires for subscriptions)',
      body: { ...baseBody, type: 'subscription', price_cents: 999, granted_role_ids: [],
        metadata: { grant_role_id: ROLE } },
      income: [incomeRow(ROLE)], blocked: false },
  ];

  it.each(CASES)('$name', async ({ body, income, blocked }) => {
    const fake = useFake({
      economy_role_income: { rows: income ?? [] },
      products: { rows: [] },
      plans: { rows: [] },
    });

    const res = await productsPOST(buildRequest('/api/store/products', { method: 'POST', body }));
    const resBody = await res.json();

    if (blocked) {
      expect(res.status).toBe(409);
      expect(String(resBody.error).toLowerCase()).toContain('compliance');
      expect(fake._writes.products ?? []).toHaveLength(0);
      expect(notifyBot).not.toHaveBeenCalled();
    } else {
      expect(res.status).toBe(200);
      expect(fake._writes.products?.[0]?.op).toBe('insert');
    }
  });

  it('409s before any PayPal call or DB write', async () => {
    useFake({
      economy_role_income: { rows: [incomeRow(ROLE)] },
      products: { rows: [] },
    });
    const res = await productsPOST(buildRequest('/api/store/products', {
      method: 'POST',
      body: { ...baseBody, type: 'one_time', price_cents: 2500, granted_role_ids: [ROLE] },
    }));
    expect(res.status).toBe(409);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails CLOSED (500) when the income lookup errors', async () => {
    const fake = useFake({
      economy_role_income: { readError: { message: 'db down' } },
      products: { rows: [] },
    });
    const res = await productsPOST(buildRequest('/api/store/products', {
      method: 'POST',
      body: { ...baseBody, type: 'one_time', price_cents: 2500, granted_role_ids: [ROLE] },
    }));
    expect(res.status).toBe(500);
    expect(fake._writes.products ?? []).toHaveLength(0);
  });
});

describe('MATRIX B — products PUT', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthSuccess(requireGuildOwner as ReturnType<typeof vi.fn>, { guildId: GUILD });
    mockRateLimitPass(checkAdminRateLimit as ReturnType<typeof vi.fn>);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  const put = (body: Record<string, unknown>) =>
    productsPUT(buildRequest('/api/store/products', { method: 'PUT', body: { id: PRODUCT_ID, ...body } }));

  it('409 when adding an income-earning role to a buyable one_time product', async () => {
    const fake = useFake({
      products: { rows: [product({ type: 'one_time', price_cents: 500 })] },
      economy_role_income: { rows: [incomeRow(OTHER_ROLE)] },
    });
    const res = await put({ granted_role_ids: [OTHER_ROLE] });
    expect(res.status).toBe(409);
    expect(fake._writes.products ?? []).toHaveLength(0);
  });

  it('409 when flipping active false→true reopens an income-role overlap', async () => {
    const fake = useFake({
      products: { rows: [product({ type: 'one_time', price_cents: 2500, active: false, granted_role_ids: [ROLE] })] },
      economy_role_income: { rows: [incomeRow(ROLE)] },
    });
    const res = await put({ active: true });
    expect(res.status).toBe(409);
    expect(fake._writes.products ?? []).toHaveLength(0);
  });

  it('409 when re-pricing 0→paid on a product with an overlapping income role', async () => {
    const fake = useFake({
      products: { rows: [product({ type: 'one_time', price_cents: 0, granted_role_ids: [ROLE] })] },
      economy_role_income: { rows: [incomeRow(ROLE)] },
    });
    const res = await put({ price_cents: 1500 });
    expect(res.status).toBe(409);
    expect(fake._writes.products ?? []).toHaveLength(0);
  });

  it('allowed when the update leaves the product NOT buyable (still inactive)', async () => {
    const fake = useFake({
      products: { rows: [product({ type: 'one_time', price_cents: 0, active: false, granted_role_ids: [ROLE] })] },
      economy_role_income: { rows: [incomeRow(ROLE)] },
    });
    const res = await put({ price_cents: 1500 });
    expect(res.status).toBe(200);
    expect(fake._writes.products?.[0]?.op).toBe('update');
  });

  it('subscription flip to active WITHOUT a chargeable plan is allowed (finding: plan decides chargeability)', async () => {
    const fake = useFake({
      products: { rows: [product({ type: 'subscription', active: false, granted_role_ids: [ROLE] })] },
      plans: { rows: [plan({ price_cents: 0 })] },
      economy_role_income: { rows: [incomeRow(ROLE)] },
    });
    const res = await put({ active: true });
    expect(res.status).toBe(200);
    expect(fake._writes.products?.[0]?.op).toBe('update');
  });

  it('finding #1: subscription flip to active with a stored PRICED-but-no-paypal plan is ALLOWED (checkout cannot start it)', async () => {
    const fake = useFake({
      products: { rows: [product({ type: 'subscription', active: false, granted_role_ids: [ROLE] })] },
      plans: { rows: [plan({ price_cents: 999 })] },
      economy_role_income: { rows: [incomeRow(ROLE)] },
    });
    const res = await put({ active: true });
    expect(res.status).toBe(200);
    expect(fake._writes.products?.[0]?.op).toBe('update');
  });

  it('409 when flipping a subscription active WITH a stored chargeable plan (paypal_plan_id) and an income role', async () => {
    const fake = useFake({
      products: { rows: [product({ type: 'subscription', active: false, granted_role_ids: [ROLE] })] },
      plans: { rows: [plan({ price_cents: 999, paypal_plan_id: 'P-1' })] },
      economy_role_income: { rows: [incomeRow(ROLE)] },
    });
    const res = await put({ active: true });
    expect(res.status).toBe(409);
    expect(fake._writes.products ?? []).toHaveLength(0);
  });

  it('409 when adding a metadata.grant_role_id income role to a buyable one_time product', async () => {
    const fake = useFake({
      products: { rows: [product({ type: 'one_time', price_cents: 2500 })] },
      orders: { rows: [] },
      economy_role_income: { rows: [incomeRow(ROLE)] },
    });
    const res = await put({ metadata: { grant_role_id: ROLE } });
    expect(res.status).toBe(409);
    expect(fake._writes.products ?? []).toHaveLength(0);
  });

  it('metadata income role on a SUBSCRIPTION product is not folded into the wall (metadata never fires there)', async () => {
    const fake = useFake({
      products: { rows: [product({ type: 'subscription' })] },
      plans: { rows: [plan({ price_cents: 999 })] },
      orders: { rows: [] },
      economy_role_income: { rows: [incomeRow(ROLE)] },
    });
    const res = await put({ metadata: { grant_role_id: ROLE } });
    expect(res.status).toBe(200);
    expect(fake._writes.products?.[0]?.op).toBe('update');
  });

  it('FAILS CLOSED: 500 and no update when the stored-product lookup errors', async () => {
    const fake = useFake({
      products: { readError: { message: 'db down' } },
      economy_role_income: { rows: [] },
    });
    const res = await put({ active: true });
    expect(res.status).toBe(500);
    expect(fake._writes.products ?? []).toHaveLength(0);
  });

  it('404 when the product does not belong to this guild', async () => {
    const fake = useFake({ products: { rows: [] }, economy_role_income: { rows: [] } });
    const res = await put({ active: true });
    expect(res.status).toBe(404);
    expect(fake._writes.products ?? []).toHaveLength(0);
  });

  it('a name-only change never consults the wall or the stored row', async () => {
    const fake = useFake({
      products: { readError: { message: 'would fail if read' } },
      economy_role_income: { readError: { message: 'would fail if read' } },
    });
    const res = await put({ name: 'Renamed' });
    expect(res.status).toBe(200);
    expect(fake._writes.products?.[0]?.op).toBe('update');
  });

  // ── V4 history recording ──

  it('RECORDS a stripped, SOLD permanent metadata role into historical_grant_role_ids', async () => {
    const fake = useFake({
      products: { rows: [product({ type: 'one_time', active: false, metadata: { grant_role_id: ROLE } })] },
      orders: { rows: [order({})] },
      economy_role_income: { rows: [] },
    });
    const res = await put({ metadata: {} });
    expect(res.status).toBe(200);
    const written = fake._writes.products?.[0]?.payload as { metadata?: Record<string, unknown> };
    expect(written.metadata?.historical_grant_role_ids).toEqual([ROLE]);
  });

  it('records history when a sold PERMANENT grant is made TEMPORARY (permanence stripped)', async () => {
    const fake = useFake({
      products: { rows: [product({ type: 'one_time', active: false, metadata: { grant_role_id: ROLE } })] },
      orders: { rows: [order({})] },
      economy_role_income: { rows: [] },
    });
    const res = await put({ metadata: { grant_role_id: ROLE, role_duration_hours: 24 } });
    expect(res.status).toBe(200);
    const written = fake._writes.products?.[0]?.payload as { metadata?: Record<string, unknown> };
    expect(written.metadata?.historical_grant_role_ids).toEqual([ROLE]);
  });

  it('does NOT record history for a never-sold permanent metadata role', async () => {
    const fake = useFake({
      products: { rows: [product({ type: 'one_time', active: false, metadata: { grant_role_id: ROLE } })] },
      orders: { rows: [] },
      economy_role_income: { rows: [] },
    });
    const res = await put({ metadata: {} });
    expect(res.status).toBe(200);
    const written = fake._writes.products?.[0]?.payload as { metadata?: Record<string, unknown> };
    expect(written.metadata?.historical_grant_role_ids).toBeUndefined();
  });

  it('PRESERVES stored history when the client metadata omits it (append-only through the API)', async () => {
    const fake = useFake({
      products: { rows: [product({ type: 'one_time', active: false, metadata: { historical_grant_role_ids: [ROLE] } })] },
      orders: { rows: [] },
      economy_role_income: { rows: [] },
    });
    const res = await put({ metadata: { some_other_key: 'x' } });
    expect(res.status).toBe(200);
    const written = fake._writes.products?.[0]?.payload as { metadata?: Record<string, unknown> };
    expect(written.metadata?.historical_grant_role_ids).toEqual([ROLE]);
    expect(written.metadata?.some_other_key).toBe('x');
  });

  it('finding #3: STRIPS a client-forged historical_grant_role_ids (never-sold role) on PUT — owner cannot fabricate sold-history', async () => {
    const fake = useFake({
      // Product has no stored history and has sold nothing.
      products: { rows: [product({ type: 'one_time', active: false, metadata: {} })] },
      orders: { rows: [] },
      economy_role_income: { rows: [] },
    });
    const res = await put({ metadata: { historical_grant_role_ids: [OTHER_ROLE], keep_me: 'y' } });
    expect(res.status).toBe(200);
    const written = fake._writes.products?.[0]?.payload as { metadata?: Record<string, unknown> };
    // The forged entry is discarded; the real (empty) server history wins.
    expect(written.metadata?.historical_grant_role_ids).toBeUndefined();
    expect(written.metadata?.keep_me).toBe('y');
  });

  it('finding #3: a client cannot EXTEND real server history with forged entries on PUT', async () => {
    const fake = useFake({
      // Server truly recorded ROLE; client tries to also smuggle OTHER_ROLE.
      products: { rows: [product({ type: 'one_time', active: false, metadata: { historical_grant_role_ids: [ROLE] } })] },
      orders: { rows: [] },
      economy_role_income: { rows: [] },
    });
    const res = await put({ metadata: { historical_grant_role_ids: [ROLE, OTHER_ROLE] } });
    expect(res.status).toBe(200);
    const written = fake._writes.products?.[0]?.payload as { metadata?: Record<string, unknown> };
    // Only the server-derived ROLE survives; the smuggled OTHER_ROLE is dropped.
    expect(written.metadata?.historical_grant_role_ids).toEqual([ROLE]);
  });

  it('finding #3: STRIPS client-forged historical_grant_role_ids on product CREATE (POST)', async () => {
    // Uses the MATRIX B POST harness inline: a fresh product has sold nothing,
    // so any history in its metadata is necessarily forged.
    mockAuthSuccess(requireGuildOwner as ReturnType<typeof vi.fn>, { guildId: GUILD });
    mockRateLimitPass(checkAdminRateLimit as ReturnType<typeof vi.fn>);
    (getPayPalRuntimeConfig as ReturnType<typeof vi.fn>).mockResolvedValue(paypalConfig);
    (getPayPalToken as ReturnType<typeof vi.fn>).mockResolvedValue('token');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ id: 'PAYPAL-1' }) })));
    const fake = useFake({
      economy_role_income: { rows: [] },
      products: { rows: [] },
      plans: { rows: [] },
    });
    const res = await productsPOST(buildRequest('/api/store/products', {
      method: 'POST',
      body: {
        name: 'Forged', delivery_type: 'access_pass', currency: 'USD', granted_channel_ids: [],
        type: 'one_time', price_cents: 2500, granted_role_ids: [],
        metadata: { historical_grant_role_ids: [OTHER_ROLE], other: 'z' },
      },
    }));
    expect(res.status).toBe(200);
    const written = fake._writes.products?.[0]?.payload as { metadata?: Record<string, unknown> };
    expect(written.metadata?.historical_grant_role_ids).toBeUndefined();
    expect(written.metadata?.other).toBe('z');
    vi.unstubAllGlobals();
  });

  it('FAILS CLOSED: 500 and no update when the sold-history orders lookup errors', async () => {
    const fake = useFake({
      products: { rows: [product({ type: 'one_time', active: false, metadata: { grant_role_id: ROLE } })] },
      orders: { readError: { message: 'db down' } },
      economy_role_income: { rows: [] },
    });
    const res = await put({ metadata: {} });
    expect(res.status).toBe(500);
    expect(fake._writes.products ?? []).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// MATRIX C — plan side: /api/store/plans POST + PUT.
// ═════════════════════════════════════════════════════════════════════════

describe('MATRIX C — plans POST/PUT', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthSuccess(requireGuildOwner as ReturnType<typeof vi.fn>, { guildId: GUILD });
    mockRateLimitPass(checkAdminRateLimit as ReturnType<typeof vi.fn>);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  const postPlan = (body: Record<string, unknown>) =>
    plansPOST(buildRequest('/api/store/plans', {
      method: 'POST',
      body: { product_id: PRODUCT_ID, name: 'Monthly', interval_unit: 'MONTH', ...body },
    }));
  const putPlan = (body: Record<string, unknown>) =>
    plansPUT(buildRequest('/api/store/plans', { method: 'PUT', body: { id: PLAN_ID, ...body } }));

  const POST_CASES: {
    name: string;
    parent: Row | null;
    body: Record<string, unknown>;
    income?: Row[];
    expect: number;
  }[] = [
    { name: 'chargeable plan (paid + paypal_plan_id) on an active subscription granting an income role → 409',
      parent: product({ type: 'subscription', granted_role_ids: [ROLE] }),
      body: { price_cents: 999, paypal_plan_id: 'P-1' }, income: [incomeRow(ROLE)], expect: 409 },
    { name: 'finding #1: PRICED plan with NO paypal_plan_id on a conflicted subscription is ALLOWED (checkout cannot start it — price_cents cannot charge a subscription)',
      parent: product({ type: 'subscription', granted_role_ids: [ROLE] }),
      body: { price_cents: 999 }, income: [incomeRow(ROLE)], expect: 200 },
    { name: 'zero-price plan WITH a paypal_plan_id → 409 (chargeable: PayPal price is authoritative)',
      parent: product({ type: 'subscription', granted_role_ids: [ROLE] }),
      body: { price_cents: 0, paypal_plan_id: 'P-1' }, income: [incomeRow(ROLE)], expect: 409 },
    { name: 'zero-price plan with no PayPal id is allowed without consulting the wall',
      parent: product({ type: 'subscription', granted_role_ids: [ROLE] }),
      body: { price_cents: 0 }, income: [incomeRow(ROLE)], expect: 200 },
    { name: 'INACTIVE chargeable plan is allowed (opens no purchase path)',
      parent: product({ type: 'subscription', granted_role_ids: [ROLE] }),
      body: { price_cents: 999, paypal_plan_id: 'P-1', active: false }, income: [incomeRow(ROLE)], expect: 200 },
    { name: 'chargeable plan on an INACTIVE subscription parent is allowed (reactivation re-runs the product wall)',
      parent: product({ type: 'subscription', active: false, granted_role_ids: [ROLE] }),
      body: { price_cents: 999, paypal_plan_id: 'P-1' }, income: [incomeRow(ROLE)], expect: 200 },
    { name: 'chargeable plan on a ONE_TIME parent is allowed (checkout ignores plans for one-time products)',
      parent: product({ type: 'one_time', price_cents: 0, granted_role_ids: [ROLE] }),
      body: { price_cents: 999, paypal_plan_id: 'P-1' }, income: [incomeRow(ROLE)], expect: 200 },
    { name: 'chargeable plan on a FREE parent is allowed (checkout refuses free products)',
      parent: product({ type: 'free', granted_role_ids: [ROLE] }),
      body: { price_cents: 999, paypal_plan_id: 'P-1' }, income: [incomeRow(ROLE)], expect: 200 },
    { name: 'chargeable plan when the parent grants the income role only via METADATA is allowed (subscriptions never consume it)',
      parent: product({ type: 'subscription', metadata: { grant_role_id: ROLE } }),
      body: { price_cents: 999, paypal_plan_id: 'P-1' }, income: [incomeRow(ROLE)], expect: 200 },
    { name: 'income row with amount 0 does not block a chargeable plan',
      parent: product({ type: 'subscription', granted_role_ids: [ROLE] }),
      body: { price_cents: 999, paypal_plan_id: 'P-1' }, income: [incomeRow(ROLE, 0)], expect: 200 },
    { name: '404 when the parent product is not in this guild',
      parent: null, body: { price_cents: 999, paypal_plan_id: 'P-1' }, expect: 404 },
  ];

  it.each(POST_CASES)('POST: $name', async ({ parent, body, income, expect: expected }) => {
    const fake = useFake({
      products: { rows: parent ? [parent] : [] },
      plans: { rows: [] },
      economy_role_income: { rows: income ?? [] },
    });
    const res = await postPlan(body);
    expect(res.status).toBe(expected);
    if (expected === 409 || expected === 404) {
      expect(fake._writes.plans ?? []).toHaveLength(0);
    } else {
      expect(fake._writes.plans?.[0]?.op).toBe('insert');
    }
  });

  it('POST fails CLOSED (500) when the parent lookup errors', async () => {
    const fake = useFake({
      products: { readError: { message: 'db down' } },
      plans: { rows: [] },
    });
    const res = await postPlan({ price_cents: 999 });
    expect(res.status).toBe(500);
    expect(fake._writes.plans ?? []).toHaveLength(0);
  });

  it('PUT: 409 when re-pricing an ALREADY-chargeable plan (has paypal_plan_id) under a conflicted parent', async () => {
    const fake = useFake({
      products: { rows: [product({ type: 'subscription', granted_role_ids: [ROLE] })] },
      plans: { rows: [plan({ price_cents: 999, paypal_plan_id: 'P-1' })] },
      economy_role_income: { rows: [incomeRow(ROLE)] },
    });
    const res = await putPlan({ price_cents: 1500 });
    expect(res.status).toBe(409);
    expect(fake._writes.plans ?? []).toHaveLength(0);
  });

  it('finding #1: PUT re-pricing 0→paid on a plan with NO paypal_plan_id is ALLOWED (still not chargeable — checkout cannot start it)', async () => {
    const fake = useFake({
      products: { rows: [product({ type: 'subscription', granted_role_ids: [ROLE] })] },
      plans: { rows: [plan({ price_cents: 0 })] },
      economy_role_income: { rows: [incomeRow(ROLE)] },
    });
    const res = await putPlan({ price_cents: 1500 });
    expect(res.status).toBe(200);
    expect(fake._writes.plans?.[0]?.op).toBe('update');
  });

  it('PUT: 409 when adding a paypal_plan_id to a zero-price active plan (becomes chargeable)', async () => {
    const fake = useFake({
      products: { rows: [product({ type: 'subscription', granted_role_ids: [ROLE] })] },
      plans: { rows: [plan({ price_cents: 0 })] },
      economy_role_income: { rows: [incomeRow(ROLE)] },
    });
    const res = await putPlan({ paypal_plan_id: 'P-9' });
    expect(res.status).toBe(409);
    expect(fake._writes.plans ?? []).toHaveLength(0);
  });

  it('PUT: 409 when re-activating a chargeable (paypal_plan_id) plan under a conflicted parent', async () => {
    const fake = useFake({
      products: { rows: [product({ type: 'subscription', granted_role_ids: [ROLE] })] },
      plans: { rows: [plan({ price_cents: 999, paypal_plan_id: 'P-1', active: false })] },
      economy_role_income: { rows: [incomeRow(ROLE)] },
    });
    const res = await putPlan({ active: true });
    expect(res.status).toBe(409);
  });

  it('PUT: DEACTIVATING a chargeable plan is allowed (effective state opens no purchase path)', async () => {
    const fake = useFake({
      products: { rows: [product({ type: 'subscription', granted_role_ids: [ROLE] })] },
      plans: { rows: [plan({ price_cents: 999, paypal_plan_id: 'P-1' })] },
      economy_role_income: { rows: [incomeRow(ROLE)] },
    });
    const res = await putPlan({ active: false });
    expect(res.status).toBe(200);
    expect(fake._writes.plans?.[0]?.op).toBe('update');
  });

  it('PUT: moving a chargeable plan to another parent re-runs the wall against the NEW parent', async () => {
    const OTHER_PRODUCT = '00000000-0000-0000-0000-00000000000c';
    const fake = useFake({
      products: { rows: [
        product({ type: 'subscription', granted_role_ids: [] }),
        product({ id: OTHER_PRODUCT, type: 'subscription', granted_role_ids: [ROLE] }),
      ] },
      plans: { rows: [plan({ price_cents: 999, paypal_plan_id: 'P-1' })] },
      economy_role_income: { rows: [incomeRow(ROLE)] },
    });
    const res = await putPlan({ product_id: OTHER_PRODUCT });
    expect(res.status).toBe(409);
    expect(fake._writes.plans ?? []).toHaveLength(0);
  });

  it('PUT: a name-only change never consults the wall', async () => {
    const fake = useFake({
      products: { readError: { message: 'would fail if read' } },
      plans: { rows: [plan({ price_cents: 999 })] },
      economy_role_income: { readError: { message: 'would fail if read' } },
    });
    const res = await putPlan({ name: 'Renamed' });
    expect(res.status).toBe(200);
    expect(fake._writes.plans?.[0]?.op).toBe('update');
  });

  it('PUT fails CLOSED (500) when the stored plan lookup errors', async () => {
    const fake = useFake({
      products: { rows: [product({ type: 'subscription', granted_role_ids: [ROLE] })] },
      plans: { readError: { message: 'db down' } },
      economy_role_income: { rows: [incomeRow(ROLE)] },
    });
    const res = await putPlan({ price_cents: 999 });
    expect(res.status).toBe(500);
    expect(fake._writes.plans ?? []).toHaveLength(0);
  });
});
