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
  entitlementStatus: 'active' | 'cancelled',
  linkEntitlementToKey: boolean,
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
      source: 'purchase',
      granted_role_ids: [],
      granted_channel_ids: [],
      ...(entitlementStatus === 'cancelled' ? { cancelled_at: new Date().toISOString() } : {}),
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
    { label: 'terminal', status: 'cancelled' as const, linked: true },
    { label: 'unlinked', status: 'active' as const, linked: false },
  ])(
    'rejects a $label entitlement without changing keys, links, or delivery',
    async ({ status, linked }) => {
      const fixture = await createFixture(status, linked);
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
});
