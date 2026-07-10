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
 * A thenable per-table query chain that records the .eq()/.in()/.neq()/
 * .overlaps() filters applied and resolves to a caller-supplied result when
 * awaited or terminated with .single()/.maybeSingle().
 */
function makeChain(result: { data?: unknown; error?: unknown }) {
  const state = { filters: {} as Record<string, unknown> };
  const chain: Record<string, unknown> = {
    _state: state,
    select: vi.fn(() => chain),
    eq: vi.fn((c: string, v: unknown) => { state.filters[c] = v; return chain; }),
    neq: vi.fn(() => chain),
    in: vi.fn(() => chain),
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

  it('PUT: 409 when adding an income-earning role to an existing paid product', async () => {
    const incomeTable = makeChain({ data: [{ role_id: '222222222222222222' }] });
    // Existing product is paid (one_time).
    const productsTable = makeChain({ data: { type: 'one_time', granted_role_ids: [] } });
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
});
