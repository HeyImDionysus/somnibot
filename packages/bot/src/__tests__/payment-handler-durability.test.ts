import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { handleBuyButton } from '../features/commerce/payment-handler.js';

const product = {
  id: 'prod-1', guild_id: 'guild-1', active: true, type: 'subscription',
  price_cents: 500, name: 'VIP', delivery_type: 'access_pass',
  granted_role_ids: [], granted_channel_ids: [], currency: 'USD',
};
const plan = {
  id: 'plan-1', guild_id: 'guild-1', product_id: 'prod-1', active: true,
  name: 'Monthly', price_cents: 500, currency: 'USD', interval_unit: 'MONTH',
  paypal_plan_id: 'P-LEGIT',
};

function interaction() {
  return {
    customId: 'store:buy:prod-1', user: { id: 'user-1', username: 'Tester' },
    deferReply: vi.fn().mockResolvedValue({}), editReply: vi.fn().mockResolvedValue({}),
  } as any;
}

function makeSupabase(opts: {
  planBind?: { data: unknown; error: unknown };
  orderBind?: { data: unknown; error: unknown };
  productType?: 'subscription' | 'one_time';
} = {}) {
  const checkoutProduct = opts.productType === 'one_time'
    ? { ...product, type: 'one_time' as const, currency: 'USD' }
    : product;
  const updates: Array<{ table: string; values: Record<string, unknown> }> = [];
  const rpc = vi.fn(async (name: string, args?: Record<string, unknown>) => {
    if (name === 'commerce_claim_checkout_intent') {
      return {
        data: {
          disposition: 'claimed',
          checkout_token: args?.p_checkout_token,
        },
        error: null,
      };
    }
    if (name === 'commerce_reserve_checkout_pricing') {
      return {
        data: { amount_cents: checkoutProduct.price_cents, discount_cents: 0, promotion_id: null, coupon_code: null },
        error: null,
      };
    }
    if (name === 'commerce_select_checkout_plan') return { data: [plan], error: null };
    if (name === 'generate_order_number') return { data: 'ORD-1', error: null };
    if (name === 'commerce_create_and_bind_active_paid_checkout') {
      // The atomic reservation is the current persistence boundary.  Allow
      // each regression to force either a bind error or a zero-row response
      // without reviving the removed multi-step plan/order update sequence.
      if (opts.planBind?.error) {
        return { data: null, error: opts.planBind.error };
      }
      if (opts.orderBind && opts.orderBind.data === null && !opts.orderBind.error) {
        return { data: null, error: null };
      }
      return {
        data: {
          disposition: 'created', id: '12000000-0000-4000-8000-000000000001', order_number: args?.p_order_number,
          customer_id: args?.p_customer_id, guild_id: args?.p_guild_id, product_id: args?.p_product_id,
          plan_id: args?.p_plan_id, paypal_order_id: null, paypal_subscription_id: args?.p_provider_id,
          amount_cents: args?.p_amount_cents, currency: args?.p_currency, status: 'pending', checkout_active: true,
          checkout_approval_url: args?.p_approval_url, delivery_type_snapshot: 'access_pass',
          promotion_id: null, discount_cents: 0,
          granted_role_ids_snapshot: [], granted_channel_ids_snapshot: [], temporary_role_grants_snapshot: [],
          grant_snapshot_frozen_at: '2026-07-11T00:00:00.000Z',
        }, error: null,
      };
    }
    return { data: null, error: null };
  });
  let customerReads = 0;
  const from = vi.fn((table: string) => {
    let operation = 'read';
    const chain: any = {
      select: vi.fn(() => chain),
      eq: vi.fn(() => chain), in: vi.fn(() => chain), gt: vi.fn(() => chain),
      order: vi.fn(() => chain), limit: vi.fn(() => chain),
      insert: vi.fn((values: Record<string, unknown>) => { operation = 'insert'; updates.push({ table, values }); return chain; }),
      update: vi.fn((values: Record<string, unknown>) => { operation = 'update'; updates.push({ table, values }); return chain; }),
      maybeSingle: vi.fn(async () => {
        if (table === 'products') return { data: checkoutProduct, error: null };
        if (table === 'guild_config') return { data: null, error: null };
        if (table === 'customers' && customerReads++ === 0) return { data: null, error: null };
        if (table === 'commerce_checkout_intents' && operation === 'update') {
          const values = updates.at(-1)?.values ?? {};
          if (values.plan_id) return opts.planBind ?? { data: { token: 't' }, error: null };
          if (values.order_id) return opts.orderBind ?? { data: { token: 't' }, error: null };
          return { data: { token: 't' }, error: null };
        }
        return { data: null, error: null };
      }),
      single: vi.fn(async () => ({ data: { id: 'cust-1' }, error: null })),
      then: (resolve: Function) => resolve(
        table === 'products' ? { data: checkoutProduct, error: null }
          : table === 'commerce_product_temp_role_config' ? { data: [], error: null }
            : { data: null, error: null },
      ),
    };
    return chain;
  });
  return { supabase: { from, rpc } as any, updates, rpc };
}

function paypalFetch(mode: 'subscription' | 'one-time', fail?: 'timeout') {
  return vi.fn(async (url: unknown, init?: RequestInit) => {
    const target = String(url);
    if (target.includes('/v1/oauth2/token')) return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
    if (fail === 'timeout' && target.includes(mode === 'subscription' ? '/v1/billing/subscriptions' : '/v2/checkout/orders')) {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      throw new DOMException('timed out', 'AbortError');
    }
    if (target.includes('/v1/billing/subscriptions')) return new Response(JSON.stringify({ id: 'SUB-1', links: [{ rel: 'approve', href: 'https://www.sandbox.paypal.com/approve' }] }), { status: 200 });
    if (target.includes('/v2/checkout/orders')) return new Response(JSON.stringify({ id: 'ORDER-1', links: [{ rel: 'approve', href: 'https://www.sandbox.paypal.com/approve' }] }), { status: 200 });
    return new Response('unexpected', { status: 500 });
  });
}

beforeEach(() => { process.env['PAYPAL_CLIENT_SECRET'] = 'test-signing-secret'; });
afterEach(() => { delete process.env.PAYPAL_CLIENT_SECRET; vi.restoreAllMocks(); });

describe('payment checkout durability regressions', () => {
  it('ships an atomic gift-checkout expiry cleanup RPC that never reopens captured rows', () => {
    const migration = readFileSync(new URL('../../../supabase/migrations/20260804141000_gift_checkout_expiry_cleanup.sql', import.meta.url), 'utf8');
    expect(migration).toContain('commerce_prepare_gift_checkout');
    expect(migration).toContain("status IN ('pending', 'bound')");
    expect(migration).toContain("status = 'cancelled'");
    expect(migration).toContain('FOR UPDATE');
  });

  it('reaps the unexposed provider checkout when atomic plan persistence fails', async () => {
    const { supabase, updates, rpc } = makeSupabase({ planBind: { data: null, error: { message: 'db write failed' } } });
    const fetchMock = paypalFetch('subscription');
    vi.stubGlobal('fetch', fetchMock);
    await handleBuyButton(interaction(), supabase, 'guild-1', 'https://api.paypal.example', 'id', 'secret', 'https://dashboard.example');
    // PayPal is created before the atomic bind; a failed bind must never mark
    // the approval as exposed and must invoke the unexposed-checkout reaper.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/v1/billing/subscriptions'))).toBe(true);
    expect(updates.some((entry) => entry.table === 'commerce_checkout_intents' && entry.values.status === 'cancelled')).toBe(false);
    expect(rpc.mock.calls.some(([name]) => name === 'commerce_reap_unexposed_paid_checkout')).toBe(true);
    expect(rpc.mock.calls.some(([name]) => name === 'commerce_mark_paid_checkout_exposed')).toBe(false);
  });

  it('cancels the intent when PayPal order creation times out', async () => {
    const { supabase, updates } = makeSupabase({ productType: 'one_time' });
    const fetchMock = paypalFetch('one-time', 'timeout');
    vi.stubGlobal('fetch', fetchMock);
    await handleBuyButton(interaction(), supabase, 'guild-1', 'https://api.paypal.example', 'id', 'secret', 'https://dashboard.example');
    expect(updates.some((entry) => entry.table === 'commerce_checkout_intents' && entry.values.status === 'cancelled')).toBe(true);
  });

  it('cancels the intent when PayPal subscription creation times out', async () => {
    const { supabase, updates } = makeSupabase();
    const fetchMock = paypalFetch('subscription', 'timeout');
    vi.stubGlobal('fetch', fetchMock);
    await handleBuyButton(interaction(), supabase, 'guild-1', 'https://api.paypal.example', 'id', 'secret', 'https://dashboard.example');
    expect(updates.some((entry) => entry.table === 'commerce_checkout_intents' && entry.values.status === 'cancelled')).toBe(true);
  });

  it('reaps a provider checkout when the atomic order bind returns zero rows', async () => {
    const { supabase, rpc } = makeSupabase({ orderBind: { data: null, error: null } });
    vi.stubGlobal('fetch', paypalFetch('subscription'));
    await handleBuyButton(interaction(), supabase, 'guild-1', 'https://api.paypal.example', 'id', 'secret', 'https://dashboard.example');
    const reaping = rpc.mock.calls.find(([name]) => name === 'commerce_reap_unexposed_paid_checkout');
    expect(reaping?.[1]).toMatchObject({
      p_checkout_token: expect.any(String), p_guild_id: 'guild-1',
      p_customer_id: 'cust-1', p_product_id: 'prod-1', p_plan_id: 'plan-1',
      p_provider_kind: 'subscription', p_provider_id: 'SUB-1', p_order_id: null,
      p_reason: 'atomic subscription response uncertain',
    });
  });
});
