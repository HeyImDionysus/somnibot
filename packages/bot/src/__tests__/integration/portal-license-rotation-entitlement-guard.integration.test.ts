import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import postgres, { type Sql } from 'postgres';
import { getTestDbUrl, requireSupabase } from './helpers.js';

const RUN_ID = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const GUILD_ID = `test-portal-license-rotation-${RUN_ID}`;
const OWNER_ID = '920000000000000001';
const CUSTOMER_DISCORD_ID = '920000000000000002';

type RotationFixture = {
  customerId: string;
  entitlementId: string;
  keyId: string;
  orderId: string;
  productId: string;
};

type RotationSnapshot = {
  predecessor: {
    status: string;
    revoked_at: string | null;
    revocation_reason: string | null;
    rotated_to_key_id: string | null;
  };
  key_count: number;
  entitlement: {
    status: string;
    license_key_id: string | null;
  };
  delivery_count: number;
};

let supa!: SupabaseClient;
let sql!: Sql;
let sequence = 0;

function nextValue(prefix: string): string {
  sequence += 1;
  return `${prefix}-${RUN_ID}-${sequence}`;
}

async function cleanFixtures(): Promise<void> {
  await sql`DELETE FROM public.bot_action_queue WHERE guild_id = ${GUILD_ID}`;
  await sql`DELETE FROM public.entitlements WHERE guild_id = ${GUILD_ID}`;
  await sql`DELETE FROM public.license_keys WHERE guild_id = ${GUILD_ID}`;
  await sql`DELETE FROM public.payment_refunds WHERE guild_id = ${GUILD_ID}`;
  await sql`DELETE FROM public.payments WHERE guild_id = ${GUILD_ID}`;
  await sql`DELETE FROM public.orders WHERE guild_id = ${GUILD_ID}`;
  await sql`DELETE FROM public.products WHERE guild_id = ${GUILD_ID}`;
  await sql`DELETE FROM public.customers WHERE guild_id = ${GUILD_ID}`;
}

async function createFixture(
  entitlementStatus: 'active' | 'cancelled' | 'grace_period',
  linkEntitlementToKey: boolean,
  expiresAt: string | null = null,
): Promise<RotationFixture> {
  const { data: customer, error: customerError } = await supa
    .from('customers')
    .insert({
      guild_id: GUILD_ID,
      discord_id: CUSTOMER_DISCORD_ID,
      discord_username: nextValue('rotation-customer'),
    })
    .select('id')
    .single();
  expect(customerError).toBeNull();
  if (!customer?.id) throw new Error('rotation customer fixture returned no id');

  const { data: product, error: productError } = await supa
    .from('products')
    .insert({
      guild_id: GUILD_ID,
      name: nextValue('rotation-product'),
      type: 'one_time',
      delivery_type: 'license_key',
      price_cents: 1_499,
      currency: 'USD',
      active: true,
      granted_role_ids: [],
      granted_channel_ids: [],
    })
    .select('id')
    .single();
  expect(productError).toBeNull();
  if (!product?.id) throw new Error('rotation product fixture returned no id');

  const paypalOrderId = nextValue('PAYPAL-ORDER');
  const checkout = await supa.rpc('commerce_create_active_paid_checkout', {
    p_order_number: nextValue('ORD-ROTATION'),
    p_guild_id: GUILD_ID,
    p_customer_id: customer.id,
    p_product_id: product.id,
    p_plan_id: null,
    p_provider_kind: 'capture',
    p_provider_id: paypalOrderId,
    p_approval_url: `https://paypal.test/approve/${paypalOrderId}`,
    p_amount_cents: 1_499,
    p_currency: 'USD',
  });
  expect(checkout.error).toBeNull();
  const orderId = (checkout.data as { id?: unknown } | null)?.id;
  if (typeof orderId !== 'string') throw new Error('rotation checkout fixture returned no id');

  const capture = await supa.rpc('commerce_finalize_paypal_capture', {
    p_order_id: orderId,
    p_guild_id: GUILD_ID,
    p_customer_id: customer.id,
    p_product_id: product.id,
    p_paypal_order_id: paypalOrderId,
    p_paypal_capture_id: nextValue('PAYPAL-CAPTURE'),
    p_amount_cents: 1_499,
    p_currency: 'USD',
  });
  expect(capture.error).toBeNull();

  const { data: key, error: keyError } = await supa
    .from('license_keys')
    .insert({
      order_id: orderId,
      customer_id: customer.id,
      product_id: product.id,
      guild_id: GUILD_ID,
      key_hash: nextValue('predecessor-hash'),
      key_prefix: 'SMNI',
      key_suffix: 'ACDE',
      bound_discord_id: CUSTOMER_DISCORD_ID,
      status: 'active',
    })
    .select('id')
    .single();
  expect(keyError).toBeNull();
  if (!key?.id) throw new Error('rotation key fixture returned no id');

  const { data: entitlement, error: entitlementError } = await supa
    .from('entitlements')
    .insert({
      order_id: orderId,
      customer_id: customer.id,
      product_id: product.id,
      guild_id: GUILD_ID,
      license_key_id: linkEntitlementToKey ? key.id : null,
      type: 'one_time',
      status: entitlementStatus,
      expires_at: expiresAt,
      source: 'purchase',
      granted_role_ids: [],
      granted_channel_ids: [],
      ...(entitlementStatus === 'cancelled' ? { cancelled_at: new Date().toISOString() } : {}),
      ...(entitlementStatus === 'grace_period'
        ? { grace_period_ends_at: '2020-01-01T00:00:00.000Z' }
        : {}),
    })
    .select('id')
    .single();
  expect(entitlementError).toBeNull();
  if (!entitlement?.id) throw new Error('rotation entitlement fixture returned no id');

  return {
    customerId: customer.id,
    entitlementId: entitlement.id,
    keyId: key.id,
    orderId,
    productId: product.id,
  };
}

async function observe(fixture: RotationFixture): Promise<RotationSnapshot> {
  const [predecessor] = await sql<RotationSnapshot['predecessor'][] >`
    SELECT
      status,
      revoked_at::TEXT,
      revocation_reason,
      rotated_to_key_id::TEXT
    FROM public.license_keys
    WHERE id = ${fixture.keyId}::UUID
  `;
  const [keyCount] = await sql<{ key_count: number }[]>`
    SELECT pg_catalog.count(*)::INTEGER AS key_count
    FROM public.license_keys
    WHERE order_id = ${fixture.orderId}::UUID
  `;
  const [entitlement] = await sql<RotationSnapshot['entitlement'][] >`
    SELECT status, license_key_id::TEXT
    FROM public.entitlements
    WHERE id = ${fixture.entitlementId}::UUID
  `;
  const [deliveryCount] = await sql<{ delivery_count: number }[]>`
    SELECT pg_catalog.count(*)::INTEGER AS delivery_count
    FROM public.bot_action_queue
    WHERE guild_id = ${GUILD_ID}
      AND action = 'deliver_receipt'
  `;
  if (!predecessor || !keyCount || !entitlement || !deliveryCount) {
    throw new Error('rotation state observation was incomplete');
  }
  return {
    predecessor,
    key_count: keyCount.key_count,
    entitlement,
    delivery_count: deliveryCount.delivery_count,
  };
}

async function attemptRotation(fixture: RotationFixture): Promise<void> {
  const { error } = await supa.rpc('commerce_rotate_license_and_stage_receipt', {
    p_license_key_id: fixture.keyId,
    p_guild_id: GUILD_ID,
    p_customer_id: fixture.customerId,
    p_product_id: fixture.productId,
    p_order_id: fixture.orderId,
    p_discord_id: CUSTOMER_DISCORD_ID,
    p_new_key_plaintext: 'SMNI-ACDE-FGHJ-KMNP-QRTV',
    p_new_key_prefix: 'SMNI',
    p_new_key_suffix: 'QRTV',
    p_actor_discord_id: CUSTOMER_DISCORD_ID,
  });
  expect(error?.message).toContain(
    'license_rotate_key_without_receipt_stage: entitlement is not usable',
  );
}

beforeAll(async () => {
  supa = await requireSupabase();
  sql = postgres(getTestDbUrl(), { max: 1 });
  const { error } = await supa.from('guild').insert({
    id: GUILD_ID,
    name: 'Portal license rotation entitlement guard integration',
    owner_discord_id: OWNER_ID,
  });
  expect(error).toBeNull();
});

beforeEach(async () => {
  await cleanFixtures();
});

afterAll(async () => {
  try {
    await cleanFixtures();
  } finally {
    await sql.end({ timeout: 5 });
  }
});

describe('portal license rotation entitlement guard', () => {
  it.each([
    { label: 'terminal', status: 'cancelled' as const, linked: true, expiresAt: null },
    { label: 'unlinked', status: 'active' as const, linked: false, expiresAt: null },
    { label: 'expired grace-period', status: 'grace_period' as const, linked: true, expiresAt: null },
    {
      label: 'expired active',
      status: 'active' as const,
      linked: true,
      expiresAt: '2020-01-01T00:00:00.000Z',
    },
  ])(
    'rejects a $label entitlement without changing keys, links, or delivery',
    async ({ status, linked, expiresAt }) => {
      const fixture = await createFixture(status, linked, expiresAt);
      const before = await observe(fixture);

      await attemptRotation(fixture);

      expect(await observe(fixture)).toEqual(before);
      expect(before).toMatchObject({
        predecessor: {
          status: 'active',
          revoked_at: null,
          revocation_reason: null,
          rotated_to_key_id: null,
        },
        key_count: 1,
        entitlement: {
          status,
          license_key_id: linked ? fixture.keyId : null,
        },
        delivery_count: 0,
      });
    },
  );

  it('resolves the portal license entitlement embeds through explicit relationships', async () => {
    const fixture = await createFixture('active', true);
    const { data, error } = await supa
      .from('license_keys')
      .select('id, entitlements!entitlements_license_key_id_fkey(id), orders!license_keys_order_id_fkey(id, entitlements!entitlements_order_id_fkey(id))')
      .eq('id', fixture.keyId)
      .single();

    expect(error).toBeNull();
    expect(data?.id).toBe(fixture.keyId);
    expect(data?.entitlements).toMatchObject([{ id: fixture.entitlementId }]);
    const order = Array.isArray(data?.orders) ? data.orders[0] : data?.orders;
    expect(order?.entitlements).toMatchObject([{ id: fixture.entitlementId }]);
  });

  it('keeps cancellation fulfillment behind a later local grace deadline', async () => {
    const [customer] = await sql<{ id: string }[]>`
      INSERT INTO public.customers (
        guild_id, discord_id, discord_username
      ) VALUES (
        ${GUILD_ID}, ${CUSTOMER_DISCORD_ID}, ${nextValue('grace-customer')}
      )
      RETURNING id
    `;
    if (!customer) throw new Error('grace customer fixture returned no id');

    const [product] = await sql<{ id: string }[]>`
      INSERT INTO public.products (
        guild_id, name, type, delivery_type, price_cents, currency,
        active, granted_role_ids, granted_channel_ids
      ) VALUES (
        ${GUILD_ID}, ${nextValue('grace-product')}, 'subscription',
        'access_pass', 1499, 'USD', true, ARRAY[]::TEXT[], ARRAY[]::TEXT[]
      )
      RETURNING id
    `;
    if (!product) throw new Error('grace product fixture returned no id');

    const paypalPlanId = nextValue('PAYPAL-PLAN');
    const [plan] = await sql<{ id: string }[]>`
      INSERT INTO public.plans (
        product_id, guild_id, name, paypal_plan_id, interval_unit,
        interval_count, price_cents, currency, active
      ) VALUES (
        ${product.id}::UUID, ${GUILD_ID}, ${nextValue('grace-plan')},
        ${paypalPlanId}, 'MONTH', 1, 1499, 'USD', true
      )
      RETURNING id
    `;
    if (!plan) throw new Error('grace plan fixture returned no id');

    const paypalSubscriptionId = nextValue('PAYPAL-SUBSCRIPTION');
    const orderNumber = nextValue('ORD-GRACE-CANCEL');
    const [order] = await sql<{ id: string }[]>`
      INSERT INTO public.orders (
        order_number, customer_id, guild_id, product_id, plan_id,
        paypal_subscription_id, amount_cents, currency, source, status,
        checkout_active
      ) VALUES (
        ${orderNumber}, ${customer.id}::UUID, ${GUILD_ID}, ${product.id}::UUID,
        ${plan.id}::UUID, ${paypalSubscriptionId}, 1499, 'USD', 'purchase',
        'completed', false
      )
      RETURNING id
    `;
    if (!order) throw new Error('grace order fixture returned no id');

    const graceUntil = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    const [entitlement] = await sql<{ id: string }[]>`
      INSERT INTO public.entitlements (
        customer_id, guild_id, product_id, plan_id, order_id, type, status,
        source, granted_role_ids, granted_channel_ids, grace_period_ends_at
      ) VALUES (
        ${customer.id}::UUID, ${GUILD_ID}, ${product.id}::UUID, ${plan.id}::UUID,
        ${order.id}::UUID, 'subscription', 'grace_period', 'purchase',
        ARRAY[]::TEXT[], ARRAY[]::TEXT[], ${graceUntil}::TIMESTAMPTZ
      )
      RETURNING id
    `;
    if (!entitlement) throw new Error('grace entitlement fixture returned no id');

    const webhookEventId = nextValue('WH-GRACE-CANCEL');
    const providerOccurredAt = new Date().toISOString();
    const providerPaidThroughAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const [providerAction] = await sql<{ id: string; next_retry_at: string }[]>`
      INSERT INTO public.bot_action_queue (
        guild_id, action, payload, status, idempotency_key, next_retry_at
      ) VALUES (
        ${GUILD_ID},
        'fulfill_cancellation',
        pg_catalog.jsonb_build_object(
          'fulfillment_type', 'subscription_cancelled',
          'guild_id', ${GUILD_ID}::TEXT,
          'customer_id', ${customer.id}::TEXT,
          'discord_id', ${CUSTOMER_DISCORD_ID}::TEXT,
          'product_id', ${product.id}::TEXT,
          'product_name', 'Grace product',
          'order_id', ${order.id}::TEXT,
          'order_number', ${orderNumber}::TEXT,
          'plan_id', ${plan.id}::TEXT,
          'paypal_subscription_id', ${paypalSubscriptionId}::TEXT,
          'amount_cents', 1499,
          'currency', 'USD',
          'granted_role_ids', pg_catalog.jsonb_build_array(),
          'granted_channel_ids', pg_catalog.jsonb_build_array(),
          'entitlement_type', 'subscription',
          'webhook_event_id', ${webhookEventId}::TEXT,
          'provider_event_type', 'BILLING.SUBSCRIPTION.CANCELLED',
          'provider_occurred_at', ${providerOccurredAt}::TEXT,
          'provider_paid_through_at', ${providerPaidThroughAt}::TEXT,
          'lifecycle_generation', 1
        ),
        'pending',
        ${`paypal:lifecycle:${webhookEventId}:provider-cancelled`},
        ${providerPaidThroughAt}::TIMESTAMPTZ
      )
      RETURNING id, next_retry_at::TEXT
    `;
    if (!providerAction) throw new Error('provider cancellation action fixture returned no id');
    expect(Date.parse(providerAction.next_retry_at)).toBeLessThan(Date.parse(graceUntil));

    const portalCancelledAt = new Date().toISOString();
    const [marked] = await sql<{ id: string }[]>`
      UPDATE public.entitlements
      SET
        cancelled_at = ${portalCancelledAt}::TIMESTAMPTZ,
        portal_cancellation_timing = 'end-of-term',
        portal_cancellation_access_until = ${graceUntil}::TIMESTAMPTZ
      WHERE id = ${entitlement.id}::UUID
      RETURNING id
    `;
    if (!marked) throw new Error('portal cancellation marker update returned no row');

    const [action] = await sql<{ id: string; next_retry_at: string }[]>`
      INSERT INTO public.bot_action_queue (
        guild_id, action, payload, status, idempotency_key, next_retry_at
      )
      SELECT
        guild_id,
        action,
        payload,
        status,
        ${`paypal:lifecycle:${webhookEventId}:portal-cancelled`},
        ${providerPaidThroughAt}::TIMESTAMPTZ
      FROM public.bot_action_queue
      WHERE id = ${providerAction.id}::UUID
      RETURNING id, next_retry_at::TEXT
    `;
    if (!action) throw new Error('portal cancellation action fixture returned no id');
    expect(Date.parse(action.next_retry_at)).toBeGreaterThanOrEqual(Date.parse(graceUntil));

    const [reset] = await sql<{ next_retry_at: string }[]>`
      UPDATE public.bot_action_queue
      SET next_retry_at = NULL
      WHERE id = ${action.id}::UUID
      RETURNING next_retry_at::TEXT
    `;
    if (!reset) throw new Error('grace cancellation action reset returned no row');
    expect(Date.parse(reset.next_retry_at)).toBeGreaterThanOrEqual(Date.parse(graceUntil));
  });
});
