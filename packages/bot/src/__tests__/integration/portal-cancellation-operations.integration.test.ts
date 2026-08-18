import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import postgres, { type Sql } from 'postgres';
import { getTestDbUrl, requireSupabase } from './helpers.js';

const RUN_ID = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const GUILD_ID = `test-portal-cancel-operation-${RUN_ID}`;
const OWNER_ID = '920000000000000001';
const CUSTOMER_DISCORD_ID = '920000000000000002';

let supa!: SupabaseClient;
let sql!: Sql;
let sqlObserver!: Sql;
let customerId!: string;
let productId!: string;
let orderId!: string;
let entitlementId!: string;

type CancellationOperation = {
  id: string;
  request_id: string;
  entitlement_id: string;
  access_until: string;
  status: 'pending' | 'uncertain' | 'provider_confirmed' | 'completed' | 'failed';
};

async function claim(accessUntil: string): Promise<CancellationOperation> {
  const { data, error } = await supa.rpc('claim_portal_cancellation_operation', {
    p_entitlement_id: entitlementId,
    p_order_id: orderId,
    p_guild_id: GUILD_ID,
    p_customer_id: customerId,
    p_paypal_subscription_id: `I-PORTAL-CANCEL-${RUN_ID}`,
    p_cancellation_timing: 'immediate',
    p_access_until: accessUntil,
  });
  expect(error).toBeNull();
  const rows = (data ?? []) as CancellationOperation[];
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function cleanFixtures(): Promise<void> {
  await sql`
    DELETE FROM public.portal_cancellation_operations
     WHERE guild_id = ${GUILD_ID}
  `;
  await sql`DELETE FROM public.entitlements WHERE guild_id = ${GUILD_ID}`;
  await sql`DELETE FROM public.orders WHERE guild_id = ${GUILD_ID}`;
  await sql`DELETE FROM public.products WHERE guild_id = ${GUILD_ID}`;
  await sql`DELETE FROM public.customers WHERE guild_id = ${GUILD_ID}`;
  await sql`DELETE FROM public.guild WHERE id = ${GUILD_ID}`;
}

async function waitForBlockedClaimCount(expected: number): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [activity] = await sqlObserver<{ count: number }[]>`
      SELECT pg_catalog.count(*)::integer AS count
        FROM pg_catalog.pg_stat_activity
       WHERE datname = pg_catalog.current_database()
         AND wait_event_type = 'Lock'
         AND query LIKE '%claim_portal_cancellation_operation%'
    `;
    if ((activity?.count ?? 0) >= expected) return activity!.count;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return 0;
}

beforeAll(async () => {
  supa = await requireSupabase();
  sql = postgres(getTestDbUrl(), { max: 1 });
  sqlObserver = postgres(getTestDbUrl(), { max: 1 });
  await Promise.all([
    sql`SET statement_timeout = '15s'`,
    sqlObserver`SET statement_timeout = '10s'`,
  ]);

  const guild = await supa.from('guild').insert({
    id: GUILD_ID,
    name: 'Portal cancellation operation integration',
    owner_discord_id: OWNER_ID,
  });
  expect(guild.error).toBeNull();

  const customer = await supa.from('customers').insert({
    guild_id: GUILD_ID,
    discord_id: CUSTOMER_DISCORD_ID,
    discord_username: `portal-cancel-${RUN_ID}`,
  }).select('id').single();
  expect(customer.error).toBeNull();
  customerId = customer.data!.id;

  const product = await supa.from('products').insert({
    guild_id: GUILD_ID,
    name: `Portal cancel product ${RUN_ID}`,
    type: 'subscription',
    delivery_type: 'access_pass',
    price_cents: 1_000,
    currency: 'USD',
    active: true,
  }).select('id').single();
  expect(product.error).toBeNull();
  productId = product.data!.id;

  const [order] = await sql<{ id: string }[]>`
    INSERT INTO public.orders (
      order_number,
      customer_id,
      guild_id,
      product_id,
      paypal_subscription_id,
      amount_cents,
      currency,
      status
    ) VALUES (
      ${`ORD-PCO-${RUN_ID}`},
      ${customerId},
      ${GUILD_ID},
      ${productId},
      ${`I-PORTAL-CANCEL-${RUN_ID}`},
      1000,
      'USD',
      'completed'
    )
    RETURNING id
  `;
  orderId = order!.id;

  const entitlement = await supa.from('entitlements').insert({
    customer_id: customerId,
    guild_id: GUILD_ID,
    product_id: productId,
    order_id: orderId,
    type: 'subscription',
    status: 'active',
    source: 'purchase',
  }).select('id').single();
  expect(entitlement.error).toBeNull();
  entitlementId = entitlement.data!.id;
});

afterAll(async () => {
  if (!sql) return;
  try {
    await cleanFixtures();
  } finally {
    await Promise.allSettled([
      sql.end({ timeout: 5 }),
      sqlObserver.end({ timeout: 5 }),
    ]);
  }
});

describe('claim_portal_cancellation_operation', () => {
  it('serializes concurrent claims into one current operation and request ID', async () => {
    const accessUntil = new Date(Date.now() + 60_000).toISOString();
    let blockedClaims!: Promise<[CancellationOperation, CancellationOperation]>;

    await sql.begin(async (transaction) => {
      await transaction`
        SELECT pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended(${entitlementId}::text, 0)
        )
      `;

      blockedClaims = Promise.all([claim(accessUntil), claim(accessUntil)]);
      expect(await waitForBlockedClaimCount(2)).toBeGreaterThanOrEqual(2);
    });

    const [first, second] = await blockedClaims;
    expect(second.id).toBe(first.id);
    expect(second.request_id).toBe(first.request_id);

    const rows = await sql<CancellationOperation[]>`
      SELECT id, request_id, entitlement_id, access_until, status
        FROM public.portal_cancellation_operations
       WHERE entitlement_id = ${entitlementId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.request_id).toBe(first.request_id);
  });

  it('preserves a failed attempt and creates a fresh current request identity', async () => {
    const [original] = await sql<CancellationOperation[]>`
      SELECT id, request_id, entitlement_id, access_until, status
        FROM public.portal_cancellation_operations
       WHERE entitlement_id = ${entitlementId}
       ORDER BY created_at
       LIMIT 1
    `;
    expect(original).toBeDefined();

    await sql`
      UPDATE public.portal_cancellation_operations
         SET status = 'failed',
             failure_code = 'provider_rejected'
       WHERE id = ${original!.id}
    `;

    const freshAccessUntil = new Date(Date.now() + 120_000).toISOString();
    const fresh = await claim(freshAccessUntil);
    expect(fresh.id).not.toBe(original!.id);
    expect(fresh.request_id).not.toBe(original!.request_id);

    const history = await sql<CancellationOperation[]>`
      SELECT id, request_id, entitlement_id, access_until, status
        FROM public.portal_cancellation_operations
       WHERE entitlement_id = ${entitlementId}
       ORDER BY created_at, id
    `;
    expect(history).toHaveLength(2);
    expect(history.map((row) => row.status).sort()).toEqual(['failed', 'pending']);
    expect(new Set(history.map((row) => row.request_id)).size).toBe(2);
  });

  it('rejects immutable identity mutation and invalid state transitions', async () => {
    const [current] = await sql<CancellationOperation[]>`
      SELECT id, request_id, entitlement_id, access_until, status
        FROM public.portal_cancellation_operations
       WHERE entitlement_id = ${entitlementId}
         AND status = 'pending'
       LIMIT 1
    `;
    expect(current).toBeDefined();

    await expect(sql`
      UPDATE public.portal_cancellation_operations
         SET request_id = ${randomUUID()}
       WHERE id = ${current!.id}
    `).rejects.toMatchObject({ code: '23514' });

    await expect(sql`
      UPDATE public.portal_cancellation_operations
         SET status = 'completed',
             provider_confirmed_at = pg_catalog.clock_timestamp(),
             completed_at = pg_catalog.clock_timestamp()
       WHERE id = ${current!.id}
    `).rejects.toMatchObject({ code: '23514' });

    const [unchanged] = await sql<CancellationOperation[]>`
      SELECT id, request_id, entitlement_id, access_until, status
        FROM public.portal_cancellation_operations
       WHERE id = ${current!.id}
    `;
    expect(unchanged).toMatchObject({
      request_id: current!.request_id,
      status: 'pending',
    });
  });
});
