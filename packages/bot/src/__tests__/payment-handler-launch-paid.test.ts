import { createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { handleBuyButton } from '../features/commerce/payment-handler.js';
import { mockButtonInteraction, mockGuild } from './helpers/discord-mocks.js';

const GUILD_ID = '345678901234567890';
const OWNER_ID = '456789012345678901';
const RUN_ID = '00000000-0000-4000-8000-000000000401';
const PRODUCT_ID = '00000000-0000-4000-8000-000000000402';
const CUSTOMER_ID = '00000000-0000-4000-8000-000000000403';
const PLAN_ID = '00000000-0000-4000-8000-000000000404';
const STARTED_AT = '2026-08-31T07:00:00.000Z';

function paidLaunchFixture(type: 'one_time' | 'subscription', failure?: 'binding' | 'persistence') {
  const requests: { readonly path: string; readonly body: Record<string, unknown> }[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const path = url.pathname.replace('/rest/v1/', '');
    const body = typeof init?.body === 'string' && init.body.startsWith('{')
      ? z.record(z.unknown()).parse(JSON.parse(init.body)) : {};
    requests.push({ path, body });
    if (path === '/v1/oauth2/token') return Response.json({ access_token: 'fixture-token' });
    if (path === '/v2/checkout/orders' || path === '/v1/billing/subscriptions') {
      return Response.json({
        id: type === 'one_time' ? 'ORDER-LAUNCH' : 'SUB-LAUNCH',
        links: [{ rel: 'approve', href: 'https://www.sandbox.paypal.com/checkoutnow?token=fixture' }],
      });
    }
    if (path === 'commerce_product_launch_runs') return Response.json({ id: RUN_ID, verification_started_at: STARTED_AT });
    if (path === 'products') return Response.json({
      id: PRODUCT_ID, guild_id: GUILD_ID, name: 'Sandbox launch', active: false, type,
      price_cents: 500, currency: 'USD', delivery_type: 'access_pass',
      granted_role_ids: [], granted_channel_ids: [],
    });
    if (path === 'guild_config') return Response.json({ repeat_purchase_policy: 'unique' });
    if (path === 'customers') return Response.json(init?.method === 'POST' ? { id: CUSTOMER_ID } : null);
    if (path === 'commerce_product_temp_role_config' || path === 'commerce_checkout_intents' || path === 'audit_logs') {
      return Response.json([]);
    }
    if (path === 'rpc/commerce_claim_checkout_intent') return Response.json({ disposition: 'claimed', checkout_token: body.p_checkout_token });
    if (path === 'rpc/commerce_bind_checkout_launch') return Response.json(failure !== 'binding');
    if (path === 'rpc/commerce_reserve_checkout_pricing' || path === 'rpc/commerce_reserve_launch_checkout_pricing') {
      return Response.json({ amount_cents: 500, discount_cents: 0, promotion_id: null, coupon_code: null });
    }
    if (path === 'rpc/commerce_select_checkout_plan' || path === 'rpc/commerce_select_launch_checkout_plan') {
      return Response.json([{
        id: PLAN_ID, paypal_plan_id: 'P-SANDBOX', price_cents: 500, currency: 'USD',
        interval_unit: 'MONTH', interval_count: 1,
      }]);
    }
    if (path === 'rpc/next_order_number') return Response.json('ORD-LAUNCH-1');
    if (path === 'rpc/commerce_create_and_bind_active_paid_checkout' || path === 'rpc/commerce_create_and_bind_launch_paid_checkout') {
      if (failure === 'persistence') return Response.json({ code: '23514', message: 'launch persistence rejected' }, { status: 400 });
      return Response.json({
        disposition: 'created', id: '00000000-0000-4000-8000-000000000405',
        order_number: body.p_order_number, customer_id: body.p_customer_id, guild_id: body.p_guild_id,
        product_id: body.p_product_id, plan_id: body.p_plan_id,
        paypal_order_id: type === 'one_time' ? body.p_provider_id : null,
        paypal_subscription_id: type === 'subscription' ? body.p_provider_id : null,
        amount_cents: body.p_amount_cents, discount_cents: 0, promotion_id: null,
        currency: body.p_currency, status: 'pending', checkout_active: true,
        checkout_approval_url: body.p_approval_url, delivery_type_snapshot: 'access_pass',
        granted_role_ids_snapshot: [], granted_channel_ids_snapshot: [], temporary_role_grants_snapshot: [],
        grant_snapshot_frozen_at: STARTED_AT,
      });
    }
    if (path === 'rpc/commerce_mark_paid_checkout_exposed' || path === 'rpc/commerce_reap_unexposed_paid_checkout') {
      return Response.json(true);
    }
    return Response.json({ message: `Unexpected fixture request: ${path}` }, { status: 500 });
  });
  vi.stubGlobal('fetch', fetch);
  vi.stubEnv('PAYPAL_RECONCILE_SECRET', 'fixture-launch-signing');
  const supabase = createClient('https://somnibot-fixture.invalid', 'fixture-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch },
  });
  const interaction = mockButtonInteraction({
    customId: `store:launch-buy:${RUN_ID}:${PRODUCT_ID}`, userId: OWNER_ID,
    guild: Object.assign(mockGuild(), { id: GUILD_ID, ownerId: OWNER_ID }),
  });
  return { requests, interaction, supabase };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('paid launch persistence boundary', () => {
  it.each(['one_time', 'subscription'] as const)('carries the authorized attempt through the %s checkout', async (type) => {
    // Given an owner-authorized inactive Sandbox product.
    const fixture = paidLaunchFixture(type);

    // When its supported launch checkout completes.
    await handleBuyButton(fixture.interaction, fixture.supabase, GUILD_ID,
      'https://api-m.sandbox.paypal.com', 'fixture-client', 'fixture-secret', 'https://dashboard.invalid');

    // Then binding, price or plan selection, and order creation use the launch attempt.
    expect(fixture.requests.find((request) => request.path === 'rpc/commerce_bind_checkout_launch')?.body).toMatchObject({
      p_launch_run_id: RUN_ID, p_verification_started_at: STARTED_AT,
      p_guild_id: GUILD_ID, p_customer_id: CUSTOMER_ID, p_product_id: PRODUCT_ID,
    });
    const selection = type === 'one_time' ? 'commerce_reserve_launch_checkout_pricing' : 'commerce_select_launch_checkout_plan';
    expect(fixture.requests.find((request) => request.path === `rpc/${selection}`)?.body.p_verification_started_at).toBe(STARTED_AT);
    expect(fixture.requests.find((request) => request.path === 'rpc/commerce_create_and_bind_launch_paid_checkout')?.body).toMatchObject({
      p_verification_started_at: STARTED_AT, p_provider_kind: type === 'one_time' ? 'capture' : 'subscription',
    });
    expect(fixture.interaction.editReply).toHaveBeenLastCalledWith(expect.objectContaining({ components: expect.any(Array) }));
  });

  it('does not create a provider checkout when atomic launch binding returns false', async () => {
    // Given a binding race that did not persist the intended launch row.
    const fixture = paidLaunchFixture('one_time', 'binding');

    // When the owner requests checkout.
    await handleBuyButton(fixture.interaction, fixture.supabase, GUILD_ID,
      'https://api-m.sandbox.paypal.com', 'fixture-client', 'fixture-secret', 'https://dashboard.invalid');

    // Then no provider order is created or approval link exposed.
    expect(fixture.requests.some((request) => request.path === '/v2/checkout/orders')).toBe(false);
    expect(fixture.interaction.editReply).toHaveBeenLastCalledWith({
      content: '❌ Sandbox checkout proof could not be bound to this launch run. No PayPal checkout was created.',
    });
  });

  it('reaps an unexposed provider checkout when launch order persistence fails', async () => {
    // Given a provider response followed by rejected database persistence.
    const fixture = paidLaunchFixture('one_time', 'persistence');

    // When checkout cannot freeze a durable launch order.
    await handleBuyButton(fixture.interaction, fixture.supabase, GUILD_ID,
      'https://api-m.sandbox.paypal.com', 'fixture-client', 'fixture-secret', 'https://dashboard.invalid');

    // Then recovery is requested and no approval control is returned.
    expect(fixture.requests.some((request) => request.path === 'rpc/commerce_reap_unexposed_paid_checkout')).toBe(true);
    expect(fixture.interaction.editReply).not.toHaveBeenCalledWith(expect.objectContaining({ components: expect.any(Array) }));
  });
});
