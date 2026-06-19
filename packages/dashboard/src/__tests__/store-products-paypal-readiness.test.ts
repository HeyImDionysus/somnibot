/**
 * Tests for /api/store/products PayPal readiness gates.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn() }));
vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/notify-bot', () => ({ notifyBot: vi.fn() }));
vi.mock('@/lib/paypal', () => ({
  getPayPalRuntimeConfig: vi.fn(),
  getPayPalToken: vi.fn(),
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));

import { POST } from '@/app/api/store/products/route';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { notifyBot } from '@/lib/notify-bot';
import { getPayPalRuntimeConfig, getPayPalToken } from '@/lib/paypal';
import { createAdminSupabase } from '@/lib/supabase/admin';

import {
  buildRequest,
  createMockSupabase,
  mockAuthSuccess,
  mockRateLimitPass,
  registerTable,
} from './helpers';

const paypalConfig = {
  apiBase: 'https://api-m.sandbox.paypal.com',
  clientId: 'paypal-client-id',
  clientSecret: 'paypal-client-secret',
  webhookId: 'WH-123',
  webhookUrl: 'https://somnibot.example.com/api/paypal/webhook',
  sandbox: true,
  sources: {
    apiBase: 'derived',
    clientId: 'saved',
    clientSecret: 'saved',
    webhookId: 'saved',
    webhookUrl: 'saved',
    sandbox: 'saved',
  },
};

const baseProductBody = {
  name: 'Founder Pass',
  description: 'Founding member access',
  delivery_type: 'license_key',
  price_cents: 2500,
  currency: 'USD',
  granted_role_ids: [],
  granted_channel_ids: [],
  active: true,
};

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
}

function ensureChainReturnsSelf(table: ReturnType<typeof registerTable>) {
  table.insert.mockReturnValue(table);
  table.select.mockReturnValue(table);
  table.eq.mockReturnValue(table);
}

describe('POST /api/store/products PayPal readiness', () => {
  let mock: ReturnType<typeof createMockSupabase>;
  let productsTable: ReturnType<typeof registerTable>;
  let plansTable: ReturnType<typeof registerTable>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockSupabase();
    productsTable = registerTable(mock, 'products');
    plansTable = registerTable(mock, 'plans');
    ensureChainReturnsSelf(productsTable);
    ensureChainReturnsSelf(plansTable);
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mock);
    mockAuthSuccess(requireGuildOwner as ReturnType<typeof vi.fn>);
    mockRateLimitPass(checkAdminRateLimit as ReturnType<typeof vi.fn>);
    (getPayPalRuntimeConfig as ReturnType<typeof vi.fn>).mockResolvedValue(paypalConfig);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('blocks paid product creation before database writes when PayPal is not ready', async () => {
    (getPayPalToken as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    vi.stubGlobal('fetch', vi.fn());

    const res = await POST(buildRequest('/api/store/products', {
      method: 'POST',
      body: {
        ...baseProductBody,
        type: 'one_time',
      },
    }));
    const body = await res.json();

    expect(res.status).toBe(424);
    expect(body).toEqual({
      success: false,
      error: 'PayPal token request failed. Check the PayPal Client ID, Client Secret, and sandbox/live mode before creating paid products.',
    });
    expect(productsTable.insert).not.toHaveBeenCalled();
    expect(plansTable.insert).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(notifyBot).not.toHaveBeenCalled();
  });

  it('blocks paid product creation before token requests when PayPal webhooks are not ready', async () => {
    (getPayPalRuntimeConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...paypalConfig,
      webhookId: '',
      webhookUrl: '',
      sources: {
        ...paypalConfig.sources,
        webhookId: 'missing',
        webhookUrl: 'missing',
      },
    });
    (getPayPalToken as ReturnType<typeof vi.fn>).mockResolvedValue('paypal-token');
    vi.stubGlobal('fetch', vi.fn());

    const res = await POST(buildRequest('/api/store/products', {
      method: 'POST',
      body: {
        ...baseProductBody,
        type: 'one_time',
      },
    }));
    const body = await res.json();

    expect(res.status).toBe(424);
    expect(body).toEqual({
      success: false,
      error: 'PayPal is not ready. Configure PayPal Webhook ID, Webhook URL before creating paid products.',
    });
    expect(getPayPalToken).not.toHaveBeenCalled();
    expect(productsTable.insert).not.toHaveBeenCalled();
    expect(plansTable.insert).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(notifyBot).not.toHaveBeenCalled();
  });

  it('blocks paid product creation before database writes when PayPal catalog sync fails', async () => {
    (getPayPalToken as ReturnType<typeof vi.fn>).mockResolvedValue('paypal-token');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('invalid paypal app', { status: 401 }),
    ));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await POST(buildRequest('/api/store/products', {
      method: 'POST',
      body: {
        ...baseProductBody,
        type: 'one_time',
      },
    }));
    const body = await res.json();

    expect(res.status).toBe(424);
    expect(body).toEqual({
      success: false,
      error: 'PayPal catalog product creation failed. Check the PayPal app credentials and try again.',
    });
    expect(productsTable.insert).not.toHaveBeenCalled();
    expect(plansTable.insert).not.toHaveBeenCalled();
    expect(notifyBot).not.toHaveBeenCalled();
  });

  it('blocks subscription creation before database writes when PayPal plan sync fails', async () => {
    (getPayPalToken as ReturnType<typeof vi.fn>).mockResolvedValue('paypal-token');
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'PROD-123' }))
      .mockResolvedValueOnce(new Response('invalid plan', { status: 422 })));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await POST(buildRequest('/api/store/products', {
      method: 'POST',
      body: {
        ...baseProductBody,
        type: 'subscription',
        plans: [{
          name: 'Monthly',
          interval_unit: 'MONTH',
          interval_count: 1,
          price_cents: 2500,
        }],
      },
    }));
    const body = await res.json();

    expect(res.status).toBe(424);
    expect(body).toEqual({
      success: false,
      error: 'PayPal billing plan creation failed. Check the PayPal app credentials and try again.',
    });
    expect(productsTable.insert).not.toHaveBeenCalled();
    expect(plansTable.insert).not.toHaveBeenCalled();
    expect(notifyBot).not.toHaveBeenCalled();
  });

  it('creates paid subscription products only after PayPal product and plan sync succeed', async () => {
    (getPayPalToken as ReturnType<typeof vi.fn>).mockResolvedValue('paypal-token');
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'PROD-123' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'PLAN-123' })));

    const product = {
      id: 'product-123',
      guild_id: 'guild-123',
      name: 'Founder Pass',
      type: 'subscription',
      paypal_product_id: 'PROD-123',
    };
    productsTable.single
      .mockResolvedValueOnce({ data: product, error: null })
      .mockResolvedValueOnce({ data: { ...product, plans: [{ id: 'plan-db-123' }] }, error: null });
    plansTable.single.mockResolvedValueOnce({ data: { id: 'plan-db-123' }, error: null });

    const res = await POST(buildRequest('/api/store/products', {
      method: 'POST',
      body: {
        ...baseProductBody,
        type: 'subscription',
        plans: [{
          name: 'Monthly',
          interval_unit: 'MONTH',
          interval_count: 1,
          price_cents: 2500,
        }],
      },
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.paypal_synced).toBe(true);
    expect(body.plans_created).toBe(1);
    expect(productsTable.insert).toHaveBeenCalledWith(expect.objectContaining({
      paypal_product_id: 'PROD-123',
      type: 'subscription',
    }));
    expect(plansTable.insert).toHaveBeenCalledWith(expect.objectContaining({
      paypal_plan_id: 'PLAN-123',
      product_id: 'product-123',
    }));
    expect(notifyBot).toHaveBeenCalledWith('commerce', { product_created: 'product-123' });
  });
});
