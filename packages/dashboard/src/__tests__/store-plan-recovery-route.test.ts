import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn() }));
vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/notify-bot', () => ({ notifyBot: vi.fn() }));
vi.mock('@/lib/paypal', () => ({ getPayPalRuntimeConfig: vi.fn() }));
vi.mock('@/lib/paypal-policy', () => ({
  loadPayPalPolicy: vi.fn(),
  applyPayPalPolicyEnvironment: vi.fn((config) => config),
}));
vi.mock('@/lib/store/paypal-plan-state', () => ({ ensurePayPalPlanState: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));

import { POST } from '@/app/api/store/products/recover-plan/route';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { notifyBot } from '@/lib/notify-bot';
import { getPayPalRuntimeConfig } from '@/lib/paypal';
import { loadPayPalPolicy } from '@/lib/paypal-policy';
import { ensurePayPalPlanState } from '@/lib/store/paypal-plan-state';
import { createAdminSupabase } from '@/lib/supabase/admin';
import {
  buildRequest,
  createMockSupabase,
  mockAuthSuccess,
  mockRateLimitPass,
  registerTable,
} from './helpers';

const PRODUCT_ID = '00000000-0000-4000-8000-000000000123';
const PLAN_ID = '00000000-0000-4000-8000-000000000456';

const recovery = {
  id: PLAN_ID,
  product_id: PRODUCT_ID,
  product_active: true,
  name: 'Monthly recovery',
  paypal_plan_id: 'PLAN-RECOVERY',
  interval_unit: 'MONTH',
  interval_count: 1,
  price_cents: 2500,
  currency: 'USD',
  trial_days: 7,
  active: true,
};

const savedPlan = { ...recovery, product_active: undefined };

function product(metadata: Record<string, unknown>, active = false) {
  return {
    id: PRODUCT_ID,
    name: 'Founder Pass',
    active,
    metadata,
    plans: active ? [{ paypal_plan_id: 'PLAN-RECOVERY' }] : [],
  };
}

describe('POST /api/store/products/recover-plan', () => {
  let mock: ReturnType<typeof createMockSupabase>;
  let products: ReturnType<typeof registerTable>;
  let plans: ReturnType<typeof registerTable>;

  beforeEach(() => {
    vi.resetAllMocks();
    mock = createMockSupabase();
    products = registerTable(mock, 'products');
    plans = registerTable(mock, 'plans');
    for (const table of [products, plans]) {
      table.select.mockReturnValue(table);
      table.eq.mockReturnValue(table);
      table.insert.mockReturnValue(table);
      table.update.mockReturnValue(table);
    }
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mock);
    mockAuthSuccess(requireGuildOwner as ReturnType<typeof vi.fn>, { guildId: 'guild-1' });
    mockRateLimitPass(checkAdminRateLimit as ReturnType<typeof vi.fn>);
    (getPayPalRuntimeConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ sandbox: true });
    (loadPayPalPolicy as ReturnType<typeof vi.fn>).mockResolvedValue({ environment: 'sandbox' });
    (ensurePayPalPlanState as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
  });

  it('persists the fixed plan identity, verifies provider state, and authoritatively reactivates', async () => {
    products.maybeSingle.mockResolvedValueOnce({
      data: product({ commerce_plan_recovery: recovery }),
      error: null,
    });
    plans.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    plans.single.mockResolvedValueOnce({ data: savedPlan, error: null });
    products.single.mockResolvedValueOnce({ data: product({}, true), error: null });

    const response = await POST(buildRequest('/api/store/products/recover-plan', {
      method: 'POST',
      body: { product_id: PRODUCT_ID },
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.active).toBe(true);
    expect(plans.insert).toHaveBeenCalledWith(expect.objectContaining({ id: PLAN_ID }));
    expect(ensurePayPalPlanState).toHaveBeenCalledWith(expect.anything(), 'PLAN-RECOVERY', true);
    expect(products.update).toHaveBeenCalledWith(expect.objectContaining({ active: true, metadata: {} }));
    expect(notifyBot).toHaveBeenCalledWith('guild-1', 'commerce', { product_updated: PRODUCT_ID });

    products.maybeSingle.mockResolvedValueOnce({ data: product({}, true), error: null });
    const repeated = await POST(buildRequest('/api/store/products/recover-plan', {
      method: 'POST',
      body: { product_id: PRODUCT_ID },
    }));
    expect(await repeated.json()).toMatchObject({ success: true, already_recovered: true });
  });

  it('deactivates the provider again when local parent reactivation fails', async () => {
    products.maybeSingle.mockResolvedValueOnce({
      data: product({ commerce_plan_recovery: recovery }),
      error: null,
    });
    plans.maybeSingle.mockResolvedValueOnce({ data: savedPlan, error: null });
    products.single.mockResolvedValueOnce({ data: null, error: { message: 'reactivation failed' } });

    const response = await POST(buildRequest('/api/store/products/recover-plan', {
      method: 'POST',
      body: { product_id: PRODUCT_ID },
    }));

    expect(response.status).toBe(500);
    expect(ensurePayPalPlanState).toHaveBeenNthCalledWith(1, expect.anything(), 'PLAN-RECOVERY', true);
    expect(ensurePayPalPlanState).toHaveBeenNthCalledWith(2, expect.anything(), 'PLAN-RECOVERY', false);
  });
});
