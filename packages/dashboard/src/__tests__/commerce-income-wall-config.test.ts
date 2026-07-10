/**
 * Compliance wall — config-time reject (both dashboard sides).
 *
 * PRODUCT SIDE (/api/store/products): adding a role that already earns
 * role-income to a PAID product is rejected (409) before any PayPal call or DB
 * write.
 *
 * ROLE-INCOME SIDE (/api/economy/role-income): configuring role-income on a
 * role granted by any paid product is rejected (409).
 *
 * A real-money purchase must never be able to fund wagerable game currency.
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

/**
 * A thenable per-table query chain that records the .eq()/.neq()/.or()
 * filters applied and resolves to a caller-supplied result when awaited or
 * terminated with .single()/.maybeSingle().
 */
function makeChain(result: { data?: unknown; error?: unknown }) {
  const state = {
    filters: {} as Record<string, unknown>,
    neqFilters: {} as Record<string, unknown>,
    orFilters: [] as string[],
  };
  const chain: Record<string, unknown> = {
    _state: state,
    select: vi.fn(() => chain),
    eq: vi.fn((c: string, v: unknown) => { state.filters[c] = v; return chain; }),
    neq: vi.fn((c: string, v: unknown) => { state.neqFilters[c] = v; return chain; }),
    in: vi.fn(() => chain),
    or: vi.fn((expr: string) => { state.orFilters.push(expr); return chain; }),
    overlaps: vi.fn(() => chain),
    order: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    insert: vi.fn(() => chain),
    update: vi.fn(() => chain),
    upsert: vi.fn(() => Promise.resolve({ error: result.error ?? null })),
    delete: vi.fn(() => chain),
    single: vi.fn(() => Promise.resolve(result)),
    maybeSingle: vi.fn(() => Promise.resolve(result)),
    then: (resolve: (v: typeof result) => unknown) => Promise.resolve(result).then(resolve),
  };
  return chain;
}

function makeSupabase(tables: Record<string, ReturnType<typeof makeChain>>) {
  return {
    from: vi.fn((t: string) => tables[t] ?? makeChain({ data: [] })),
    _tables: tables,
  };
}

const paypalConfig = {
  apiBase: 'https://api-m.sandbox.paypal.com',
  clientId: 'cid', clientSecret: 'secret', webhookId: 'WH-1',
  webhookUrl: 'https://x/webhook', sandbox: true,
  sources: {},
};

describe('PRODUCT SIDE — /api/store/products rejects income-earning roles on paid products', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthSuccess(requireGuildOwner as ReturnType<typeof vi.fn>, { guildId: GUILD });
    mockRateLimitPass(checkAdminRateLimit as ReturnType<typeof vi.fn>);
    (getPayPalRuntimeConfig as ReturnType<typeof vi.fn>).mockResolvedValue(paypalConfig);
    (getPayPalToken as ReturnType<typeof vi.fn>).mockResolvedValue('token');
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('POST: 409 when a granted role already earns role-income (before any DB write / PayPal call)', async () => {
    // economy_role_income lookup returns the role → conflict.
    const incomeTable = makeChain({ data: [{ role_id: '111111111111111111' }] });
    const productsTable = makeChain({ data: null });
    const supabase = makeSupabase({ economy_role_income: incomeTable, products: productsTable });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(supabase);
    vi.stubGlobal('fetch', vi.fn());

    const res = await productsPOST(buildRequest('/api/store/products', {
      method: 'POST',
      body: {
        name: 'Founder Pass', type: 'one_time', delivery_type: 'access_pass',
        price_cents: 2500, currency: 'USD',
        granted_role_ids: ['111111111111111111'], granted_channel_ids: [],
      },
    }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.success).toBe(false);
    expect(String(body.error).toLowerCase()).toContain('compliance');
    // No product row created, no PayPal call, no bot notify.
    expect(productsTable.insert).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(notifyBot).not.toHaveBeenCalled();
  });

  it('POST: a FREE product with the same role is allowed (free product moves no real money)', async () => {
    const incomeTable = makeChain({ data: [{ role_id: '111111111111111111' }] });
    // products insert then select-single returns a created row.
    const productsInsertChain = makeChain({ data: { id: 'prod-1' } });
    const supabase = makeSupabase({ economy_role_income: incomeTable, products: productsInsertChain });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(supabase);

    const res = await productsPOST(buildRequest('/api/store/products', {
      method: 'POST',
      body: {
        name: 'Free Role', type: 'free', delivery_type: 'access_pass',
        price_cents: 0, currency: 'USD',
        granted_role_ids: ['111111111111111111'], granted_channel_ids: [],
      },
    }));

    // Free product is not blocked by the wall — income lookup is skipped.
    expect(res.status).toBe(200);
    expect(incomeTable.select).not.toHaveBeenCalled();
  });

  it('POST: a STAGED (inactive) paid product with an income role is allowed — not yet buyable', async () => {
    // Calibration: active=false means no one can buy it, so the wall must not
    // block staging it. Reactivating later re-runs the wall via the PUT path.
    const incomeTable = makeChain({ data: [{ role_id: '111111111111111111' }] });
    const productsTable = makeChain({ data: { id: 'prod-1' } });
    const supabase = makeSupabase({ economy_role_income: incomeTable, products: productsTable });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(supabase);
    // The staged product still provisions its PayPal catalog entry (priced
    // one-time products always do) — only the WALL must not fire.
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ id: 'PAYPAL-CATALOG-1' }),
    })));

    const res = await productsPOST(buildRequest('/api/store/products', {
      method: 'POST',
      body: {
        name: 'Staged Pass', type: 'one_time', delivery_type: 'access_pass',
        price_cents: 2500, currency: 'USD', active: false,
        granted_role_ids: ['111111111111111111'], granted_channel_ids: [],
      },
    }));

    expect(res.status).toBe(200);
    // Wall short-circuits before the income lookup (product not buyable).
    expect(incomeTable.select).not.toHaveBeenCalled();
    expect(productsTable.insert).toHaveBeenCalled();
  });

  it('POST: a zero-price one-time product with an income role is allowed — charges no money', async () => {
    const incomeTable = makeChain({ data: [{ role_id: '111111111111111111' }] });
    const productsTable = makeChain({ data: { id: 'prod-1' } });
    const supabase = makeSupabase({ economy_role_income: incomeTable, products: productsTable });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(supabase);

    const res = await productsPOST(buildRequest('/api/store/products', {
      method: 'POST',
      body: {
        name: 'Free-In-Effect', type: 'one_time', delivery_type: 'access_pass',
        price_cents: 0, currency: 'USD',
        granted_role_ids: ['111111111111111111'], granted_channel_ids: [],
      },
    }));

    expect(res.status).toBe(200);
    expect(incomeTable.select).not.toHaveBeenCalled();
  });

  it('POST: an ACTIVE subscription with an income role is still 409 even at product price 0 (plans can charge)', async () => {
    // Blocked direction preserved: a non-free active subscription is treated
    // as chargeable — its plans (existing or future) charge real money.
    const incomeTable = makeChain({ data: [{ role_id: '111111111111111111' }] });
    const productsTable = makeChain({ data: null });
    const supabase = makeSupabase({ economy_role_income: incomeTable, products: productsTable });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(supabase);
    vi.stubGlobal('fetch', vi.fn());

    const res = await productsPOST(buildRequest('/api/store/products', {
      method: 'POST',
      body: {
        name: 'Sub', type: 'subscription', delivery_type: 'access_pass',
        price_cents: 0, currency: 'USD',
        granted_role_ids: ['111111111111111111'], granted_channel_ids: [],
      },
    }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(String(body.error).toLowerCase()).toContain('compliance');
    expect(productsTable.insert).not.toHaveBeenCalled();
  });

  it('PUT: 409 when adding an income-earning role to an existing paid product', async () => {
    const incomeTable = makeChain({ data: [{ role_id: '222222222222222222' }] });
    // Existing product is paid, active, priced (a real-money purchase path).
    const productsTable = makeChain({
      data: { type: 'one_time', granted_role_ids: [], active: true, price_cents: 500, metadata: {} },
    });
    const supabase = makeSupabase({ economy_role_income: incomeTable, products: productsTable });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(supabase);

    const res = await productsPUT(buildRequest('/api/store/products', {
      method: 'PUT',
      body: { id: '00000000-0000-0000-0000-000000000001', granted_role_ids: ['222222222222222222'] },
    }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(String(body.error).toLowerCase()).toContain('compliance');
    expect(productsTable.update).not.toHaveBeenCalled();
  });

  it('POST: 409 when a metadata.grant_role_id role earns role-income (permanent grant vector)', async () => {
    // The product grants a role only through metadata.grant_role_id (no
    // granted_role_ids), and that role already earns income → must be rejected.
    const incomeTable = makeChain({ data: [{ role_id: '111111111111111111' }] });
    const productsTable = makeChain({ data: null });
    const supabase = makeSupabase({ economy_role_income: incomeTable, products: productsTable });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(supabase);
    vi.stubGlobal('fetch', vi.fn());

    const res = await productsPOST(buildRequest('/api/store/products', {
      method: 'POST',
      body: {
        name: 'Perma Role', type: 'one_time', delivery_type: 'access_pass',
        price_cents: 2500, currency: 'USD',
        granted_role_ids: [], granted_channel_ids: [],
        metadata: { grant_role_id: '111111111111111111' },
      },
    }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(String(body.error).toLowerCase()).toContain('compliance');
    expect(productsTable.insert).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('PUT: 409 when flipping an existing product to BUYABLE (active false→true) reopens an income-role overlap', async () => {
    // The stored product already grants an income-earning role but was inactive
    // (not buyable). Setting active=true alone — without touching roles or type —
    // makes it a real-money path and must re-trigger the wall.
    const incomeTable = makeChain({ data: [{ role_id: '222222222222222222' }] });
    const productsTable = makeChain({
      data: {
        type: 'one_time',
        granted_role_ids: ['222222222222222222'],
        active: false,
        price_cents: 2500,
        metadata: {},
      },
    });
    const supabase = makeSupabase({ economy_role_income: incomeTable, products: productsTable });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(supabase);

    const res = await productsPUT(buildRequest('/api/store/products', {
      method: 'PUT',
      body: { id: '00000000-0000-0000-0000-000000000001', active: true },
    }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(String(body.error).toLowerCase()).toContain('compliance');
    expect(productsTable.update).not.toHaveBeenCalled();
  });

  it('PUT: 409 when flipping price_cents 0→paid on a product with an overlapping income role', async () => {
    const incomeTable = makeChain({ data: [{ role_id: '222222222222222222' }] });
    const productsTable = makeChain({
      data: {
        type: 'one_time',
        granted_role_ids: ['222222222222222222'],
        active: true,
        price_cents: 0, // was free-in-effect
        metadata: {},
      },
    });
    const supabase = makeSupabase({ economy_role_income: incomeTable, products: productsTable });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(supabase);

    const res = await productsPUT(buildRequest('/api/store/products', {
      method: 'PUT',
      body: { id: '00000000-0000-0000-0000-000000000001', price_cents: 1500 },
    }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(String(body.error).toLowerCase()).toContain('compliance');
    expect(productsTable.update).not.toHaveBeenCalled();
  });

  it('PUT: 409 when adding a metadata.grant_role_id role to an existing buyable product', async () => {
    const incomeTable = makeChain({ data: [{ role_id: '555555555555555555' }] });
    const productsTable = makeChain({
      data: { type: 'one_time', granted_role_ids: [], active: true, price_cents: 2500, metadata: {} },
    });
    const supabase = makeSupabase({ economy_role_income: incomeTable, products: productsTable });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(supabase);

    const res = await productsPUT(buildRequest('/api/store/products', {
      method: 'PUT',
      body: {
        id: '00000000-0000-0000-0000-000000000001',
        metadata: { grant_role_id: '555555555555555555' },
      },
    }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(String(body.error).toLowerCase()).toContain('compliance');
    expect(productsTable.update).not.toHaveBeenCalled();
  });

  it('PUT: allowed when the update leaves the product NOT buyable (still inactive)', async () => {
    // Updating price on a product that stays inactive is not a real-money path,
    // so the wall does not block even though a role overlaps income.
    const incomeTable = makeChain({ data: [{ role_id: '222222222222222222' }] });
    const productsTable = makeChain({
      data: {
        type: 'one_time',
        granted_role_ids: ['222222222222222222'],
        active: false,
        price_cents: 0,
        metadata: {},
      },
    });
    const supabase = makeSupabase({ economy_role_income: incomeTable, products: productsTable });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(supabase);

    const res = await productsPUT(buildRequest('/api/store/products', {
      method: 'PUT',
      body: { id: '00000000-0000-0000-0000-000000000001', price_cents: 1500 },
    }));

    // active stays false → not buyable → wall passes → update proceeds.
    expect(res.status).toBe(200);
    // income lookup skipped (isPaid=false short-circuits before the query).
    expect(incomeTable.select).not.toHaveBeenCalled();
  });
});

describe('ROLE-INCOME SIDE — /api/economy/role-income rejects paid-product roles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (requirePermission as ReturnType<typeof vi.fn>).mockResolvedValue({
      guildId: GUILD, userId: 'u', discordId: 'd', permissions: ['dashboard.full_access'],
    });
    mockRateLimitPass(checkAdminRateLimit as ReturnType<typeof vi.fn>);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('POST: 409 when the role is granted by a paid product', async () => {
    // products overlaps lookup returns a paid product granting this role.
    const productsTable = makeChain({ data: [{ id: 'prod-1', granted_role_ids: ['333333333333333333'] }] });
    const incomeTable = makeChain({ error: null });
    const supabase = makeSupabase({ products: productsTable, economy_role_income: incomeTable });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(supabase);

    const res = await roleIncomePOST(buildRequest('/api/economy/role-income', {
      method: 'POST',
      body: { role_id: '333333333333333333', amount: 100, interval_minutes: 60 },
    }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.success).toBe(false);
    expect(String(body.error).toLowerCase()).toContain('compliance');
    // No income row written.
    expect(incomeTable.upsert).not.toHaveBeenCalled();
    expect(notifyBot).not.toHaveBeenCalled();
  });

  it('POST: succeeds when the role is NOT granted by any paid product', async () => {
    const productsTable = makeChain({ data: [] }); // no paid product grants it
    const incomeTable = makeChain({ error: null });
    const supabase = makeSupabase({ products: productsTable, economy_role_income: incomeTable });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(supabase);

    const res = await roleIncomePOST(buildRequest('/api/economy/role-income', {
      method: 'POST',
      body: { role_id: '444444444444444444', amount: 100, interval_minutes: 60 },
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(incomeTable.upsert).toHaveBeenCalled();
    expect(notifyBot).toHaveBeenCalledWith('economy');
  });

  it('POST: 409 when the role is granted by a paid product via metadata.grant_role_id', async () => {
    // The paid product grants the role only through metadata.grant_role_id
    // (empty granted_role_ids), so the metadata grant vector must catch it.
    const productsTable = makeChain({
      data: [{ id: 'prod-1', granted_role_ids: [], metadata: { grant_role_id: '666666666666666666' } }],
    });
    const incomeTable = makeChain({ error: null });
    const supabase = makeSupabase({ products: productsTable, economy_role_income: incomeTable });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(supabase);

    const res = await roleIncomePOST(buildRequest('/api/economy/role-income', {
      method: 'POST',
      body: { role_id: '666666666666666666', amount: 100, interval_minutes: 60 },
    }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(String(body.error).toLowerCase()).toContain('compliance');
    expect(incomeTable.upsert).not.toHaveBeenCalled();
  });

  it('POST: queries only BUYABLE products — inactive and zero-price-one-time products cannot block', async () => {
    // Calibration proof at the query level: both grant-vector lookups must
    // constrain to active=true, type!=free, and chargeable (subscription OR
    // price>0), so a deactivated or free-in-effect product never conflicts.
    const productsTable = makeChain({ data: [] });
    const incomeTable = makeChain({ error: null });
    const supabase = makeSupabase({ products: productsTable, economy_role_income: incomeTable });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(supabase);

    const res = await roleIncomePOST(buildRequest('/api/economy/role-income', {
      method: 'POST',
      body: { role_id: '888888888888888888', amount: 100, interval_minutes: 60 },
    }));

    expect(res.status).toBe(200);
    const state = (productsTable as { _state: { filters: Record<string, unknown>; neqFilters: Record<string, unknown>; orFilters: string[] } })._state;
    expect(state.filters.active).toBe(true);
    expect(state.neqFilters.type).toBe('free');
    expect(state.orFilters).toContain('type.eq.subscription,price_cents.gt.0');
    // Both vector queries (array overlap + metadata) carry the filters.
    expect(productsTable.eq).toHaveBeenCalledWith('active', true);
    expect(productsTable.or).toHaveBeenCalledTimes(2);
    expect(incomeTable.upsert).toHaveBeenCalled();
  });

  it('POST: 400 rejects a zero-amount role-income rule at the schema boundary', async () => {
    // A zero-amount rule would burn the collection cooldown and then fail
    // creditWallet — reject it before any DB work.
    const productsTable = makeChain({ data: [] });
    const incomeTable = makeChain({ error: null });
    const supabase = makeSupabase({ products: productsTable, economy_role_income: incomeTable });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(supabase);

    const res = await roleIncomePOST(buildRequest('/api/economy/role-income', {
      method: 'POST',
      body: { role_id: '777777777777777777', amount: 0, interval_minutes: 60 },
    }));

    expect(res.status).toBe(400);
    expect(incomeTable.upsert).not.toHaveBeenCalled();
  });
});

describe('PLANS SIDE — /api/store/plans re-runs the wall when a plan makes a product chargeable', () => {
  const PRODUCT_ID = '00000000-0000-0000-0000-00000000000a';
  const PLAN_ID = '00000000-0000-0000-0000-00000000000b';
  const ROLE = '999999999999999999';

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthSuccess(requireGuildOwner as ReturnType<typeof vi.fn>, { guildId: GUILD });
    mockRateLimitPass(checkAdminRateLimit as ReturnType<typeof vi.fn>);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('POST: 409 when a PAID active plan lands on an active product granting an income role', async () => {
    // A plan price change is the one path that makes a subscription chargeable
    // without touching the product row — the wall must fire here.
    const productsTable = makeChain({
      data: { type: 'subscription', active: true, granted_role_ids: [ROLE], metadata: {} },
    });
    const incomeTable = makeChain({ data: [{ role_id: ROLE }] });
    const plansTable = makeChain({ data: { id: PLAN_ID } });
    const supabase = makeSupabase({ products: productsTable, economy_role_income: incomeTable, plans: plansTable });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(supabase);

    const res = await plansPOST(buildRequest('/api/store/plans', {
      method: 'POST',
      body: { product_id: PRODUCT_ID, name: 'Monthly', interval_unit: 'MONTH', price_cents: 999 },
    }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(String(body.error).toLowerCase()).toContain('compliance');
    expect(plansTable.insert).not.toHaveBeenCalled();
  });

  it('POST: a ZERO-price plan is allowed without consulting the wall (charges no money)', async () => {
    const productsTable = makeChain({
      data: { type: 'subscription', active: true, granted_role_ids: [ROLE], metadata: {} },
    });
    const incomeTable = makeChain({ data: [{ role_id: ROLE }] });
    const plansTable = makeChain({ data: { id: PLAN_ID } });
    const supabase = makeSupabase({ products: productsTable, economy_role_income: incomeTable, plans: plansTable });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(supabase);

    const res = await plansPOST(buildRequest('/api/store/plans', {
      method: 'POST',
      body: { product_id: PRODUCT_ID, name: 'Free Tier', interval_unit: 'MONTH', price_cents: 0 },
    }));

    expect(res.status).toBe(200);
    expect(productsTable.select).not.toHaveBeenCalled();
    expect(plansTable.insert).toHaveBeenCalled();
  });

  it('POST: a paid plan on an INACTIVE parent product is allowed — reactivation re-runs the product wall', async () => {
    // Staged product: cannot be bought while inactive. Flipping it active goes
    // through /api/store/products PUT, which treats a non-free subscription as
    // chargeable and blocks the collision there.
    const productsTable = makeChain({
      data: { type: 'subscription', active: false, granted_role_ids: [ROLE], metadata: {} },
    });
    const incomeTable = makeChain({ data: [{ role_id: ROLE }] });
    const plansTable = makeChain({ data: { id: PLAN_ID } });
    const supabase = makeSupabase({ products: productsTable, economy_role_income: incomeTable, plans: plansTable });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(supabase);

    const res = await plansPOST(buildRequest('/api/store/plans', {
      method: 'POST',
      body: { product_id: PRODUCT_ID, name: 'Monthly', interval_unit: 'MONTH', price_cents: 999 },
    }));

    expect(res.status).toBe(200);
    // Parent fetched, but income lookup skipped (parent not buyable).
    expect(incomeTable.select).not.toHaveBeenCalled();
    expect(plansTable.insert).toHaveBeenCalled();
  });

  it('POST: 404 when the parent product does not belong to this guild (wall cannot be evaluated)', async () => {
    const productsTable = makeChain({ data: null }); // guild-scoped lookup misses
    const plansTable = makeChain({ data: { id: PLAN_ID } });
    const supabase = makeSupabase({ products: productsTable, plans: plansTable });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(supabase);

    const res = await plansPOST(buildRequest('/api/store/plans', {
      method: 'POST',
      body: { product_id: PRODUCT_ID, name: 'Monthly', interval_unit: 'MONTH', price_cents: 999 },
    }));

    expect(res.status).toBe(404);
    expect(plansTable.insert).not.toHaveBeenCalled();
  });

  it('PUT: 409 when re-pricing a plan 0→paid while the parent grants an income role', async () => {
    const productsTable = makeChain({
      data: { type: 'subscription', active: true, granted_role_ids: [ROLE], metadata: {} },
    });
    const incomeTable = makeChain({ data: [{ role_id: ROLE }] });
    // Stored plan row: currently free, active.
    const plansTable = makeChain({ data: { product_id: PRODUCT_ID, price_cents: 0, active: true } });
    const supabase = makeSupabase({ products: productsTable, economy_role_income: incomeTable, plans: plansTable });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(supabase);

    const res = await plansPUT(buildRequest('/api/store/plans', {
      method: 'PUT',
      body: { id: PLAN_ID, price_cents: 1500 },
    }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(String(body.error).toLowerCase()).toContain('compliance');
    expect(plansTable.update).not.toHaveBeenCalled();
  });

  it('PUT: DEACTIVATING a paid plan is allowed — the effective state opens no purchase path', async () => {
    const productsTable = makeChain({
      data: { type: 'subscription', active: true, granted_role_ids: [ROLE], metadata: {} },
    });
    const incomeTable = makeChain({ data: [{ role_id: ROLE }] });
    const plansTable = makeChain({ data: { product_id: PRODUCT_ID, price_cents: 1500, active: true } });
    const supabase = makeSupabase({ products: productsTable, economy_role_income: incomeTable, plans: plansTable });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(supabase);

    const res = await plansPUT(buildRequest('/api/store/plans', {
      method: 'PUT',
      body: { id: PLAN_ID, active: false },
    }));

    expect(res.status).toBe(200);
    // Effective active=false → wall never consults the parent product.
    expect(productsTable.select).not.toHaveBeenCalled();
    expect(plansTable.update).toHaveBeenCalled();
  });

  it('PUT: a name-only change never consults the wall', async () => {
    const productsTable = makeChain({
      data: { type: 'subscription', active: true, granted_role_ids: [ROLE], metadata: {} },
    });
    const plansTable = makeChain({ data: { product_id: PRODUCT_ID, price_cents: 1500, active: true } });
    const supabase = makeSupabase({ products: productsTable, plans: plansTable });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(supabase);

    const res = await plansPUT(buildRequest('/api/store/plans', {
      method: 'PUT',
      body: { id: PLAN_ID, name: 'Renamed' },
    }));

    expect(res.status).toBe(200);
    expect(productsTable.select).not.toHaveBeenCalled();
    // No trigger field touched → not even the stored plan row is fetched.
    // (The update path calls .select() for RETURNING, so assert on the
    // stored-row terminator instead.)
    expect(plansTable.maybeSingle).not.toHaveBeenCalled();
    expect(plansTable.update).toHaveBeenCalled();
  });
});
