/**
 * Real-PostgreSQL proof for the PR403 payment rails.
 *
 * These tests intentionally use two independent database sessions. A mocked
 * entitlement precheck cannot prove the required race behavior: the losing
 * provider-paid order must wait on the database claim, then become a durable
 * alert/hold without ever creating a queue row, key, or entitlement.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { getTestDbUrl } from './helpers.js';

const RUN_ID = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const GUILD_ID = `test-commerce-claim-${RUN_ID}`;
const TEST_DB_NAME = (process.env.PR403_CLAIM_TEST_DB ?? `somnibot_pr403_${RUN_ID}`)
  .replace(/[^a-zA-Z0-9_]/g, '_')
  .toLowerCase()
  .slice(0, 60);
const MIGRATION_DIR = new URL('../../../../supabase/migrations/', import.meta.url);
const LICENSE_MIGRATION = migrationBody(
  new URL('20260727040000_license_delivery_requires_config.sql', MIGRATION_DIR),
);
const CLAIM_MIGRATION = migrationBody(
  new URL('20260727041000_checkout_double_charge_rails.sql', MIGRATION_DIR),
);
const BASE_SCHEMA = `
  CREATE TABLE public.guild (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_discord_id TEXT NOT NULL
  );

  CREATE TABLE public.customers (
    id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    guild_id TEXT NOT NULL REFERENCES public.guild(id),
    discord_id TEXT NOT NULL,
    discord_username TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
  );

  CREATE TABLE public.products (
    id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    guild_id TEXT NOT NULL REFERENCES public.guild(id),
    name TEXT NOT NULL,
    description TEXT,
    type TEXT NOT NULL,
    delivery_type TEXT NOT NULL,
    price_cents INTEGER NOT NULL,
    currency TEXT NOT NULL,
    granted_role_ids TEXT[] NOT NULL DEFAULT '{}',
    granted_channel_ids TEXT[] NOT NULL DEFAULT '{}',
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
  );

  CREATE TABLE public.product_license_config (
    product_id UUID PRIMARY KEY
      REFERENCES public.products(id) ON DELETE CASCADE,
    license_mode TEXT NOT NULL DEFAULT 'portal_only',
    max_devices INTEGER NOT NULL DEFAULT 3,
    heartbeat_interval_seconds INTEGER NOT NULL DEFAULT 300,
    offline_grace_hours INTEGER NOT NULL DEFAULT 24
  );

  CREATE TABLE public.plans (
    id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES public.products(id),
    guild_id TEXT NOT NULL REFERENCES public.guild(id),
    name TEXT NOT NULL,
    paypal_plan_id TEXT NOT NULL,
    interval_unit TEXT NOT NULL,
    interval_count INTEGER NOT NULL,
    price_cents INTEGER NOT NULL,
    currency TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
  );

  CREATE TABLE public.orders (
    id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    order_number TEXT NOT NULL UNIQUE,
    customer_id UUID NOT NULL REFERENCES public.customers(id),
    guild_id TEXT NOT NULL REFERENCES public.guild(id),
    product_id UUID NOT NULL REFERENCES public.products(id),
    plan_id UUID REFERENCES public.plans(id),
    paypal_order_id TEXT,
    paypal_subscription_id TEXT,
    amount_cents INTEGER NOT NULL,
    currency TEXT NOT NULL,
    source TEXT,
    status TEXT NOT NULL,
    granted_role_ids_snapshot TEXT[] NOT NULL DEFAULT '{}',
    granted_channel_ids_snapshot TEXT[] NOT NULL DEFAULT '{}',
    temporary_role_grants_snapshot JSONB NOT NULL DEFAULT '[]',
    grant_snapshot_frozen_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
  );

  CREATE TABLE public.payments (
    id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES public.orders(id),
    customer_id UUID NOT NULL REFERENCES public.customers(id),
    guild_id TEXT NOT NULL REFERENCES public.guild(id),
    paypal_payment_id TEXT NOT NULL UNIQUE,
    amount_cents INTEGER NOT NULL,
    currency TEXT NOT NULL,
    status TEXT NOT NULL,
    provider TEXT NOT NULL,
    paypal_resource_type TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
  );

  CREATE TABLE public.license_keys (
    id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    order_id UUID REFERENCES public.orders(id),
    customer_id UUID REFERENCES public.customers(id),
    product_id UUID REFERENCES public.products(id),
    guild_id TEXT REFERENCES public.guild(id),
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL,
    key_suffix TEXT NOT NULL,
    bound_discord_id TEXT NOT NULL,
    status TEXT NOT NULL,
    activated_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    revocation_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
  );

  CREATE TABLE public.entitlements (
    id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES public.customers(id),
    guild_id TEXT NOT NULL REFERENCES public.guild(id),
    product_id UUID NOT NULL REFERENCES public.products(id),
    plan_id UUID REFERENCES public.plans(id),
    license_key_id UUID REFERENCES public.license_keys(id),
    order_id UUID REFERENCES public.orders(id),
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    source TEXT,
    granted_role_ids TEXT[] NOT NULL DEFAULT '{}',
    granted_channel_ids TEXT[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
  );

  CREATE TABLE public.bot_action_queue (
    id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    guild_id TEXT NOT NULL,
    action TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',
    lane TEXT NOT NULL DEFAULT 'commerce',
    idempotency_key TEXT UNIQUE,
    claim_token UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
  );

  CREATE TABLE public.alerts (
    id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    guild_id TEXT NOT NULL,
    alert_type TEXT NOT NULL,
    severity TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT,
    metadata JSONB NOT NULL DEFAULT '{}',
    resolved BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
  );
`;

type Sql = ReturnType<typeof postgres>;
type ClaimResult = {
  order_id: string;
  disposition: 'winner' | 'held';
  winning_order_id: string | null;
  conflicting_entitlement_id: string | null;
  alert_id: string | null;
};
type Fixture = {
  customerId: string;
  productId: string;
  orderA: string;
  orderB: string;
  paypalOrderA: string | null;
  paypalOrderB: string | null;
  providerA: string;
  providerB: string;
  kind: 'capture' | 'subscription';
};

let sqlA!: Sql;
let sqlB!: Sql;
let sqlObserver!: Sql;
let sqlAdmin!: Sql;
let sqlBBackendPid = 0;
let clientsReady = false;
let disposableDatabaseCreated = false;
let sequence = 0;

function migrationBody(url: URL): string {
  return readFileSync(url, 'utf8')
    .replace(/^\uFEFF?\s*BEGIN;\s*/i, '')
    .replace(/\s*COMMIT;\s*$/i, '');
}

function nextValue(prefix: string): string {
  sequence += 1;
  return `${prefix}-${RUN_ID}-${sequence}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDatabaseLock(description: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [activity] = await sqlObserver<{
      state: string | null;
      wait_event_type: string | null;
    }[]>`
      SELECT state, wait_event_type
      FROM pg_catalog.pg_stat_activity
      WHERE pid = ${sqlBBackendPid}
    `;
    if (activity?.state === 'active' && activity.wait_event_type === 'Lock') return;
    await delay(10);
  }
  throw new Error(`${description} did not reach a PostgreSQL lock wait`);
}

async function cleanFixtures(): Promise<void> {
  await sqlObserver.begin(async (tx) => {
    await tx`
      DELETE FROM public.alerts
      WHERE guild_id = ${GUILD_ID}
    `;
    await tx`
      DELETE FROM public.commerce_fulfillment_holds
      WHERE guild_id = ${GUILD_ID}
    `;
    await tx`
      DELETE FROM public.commerce_fulfillment_claims
      WHERE guild_id = ${GUILD_ID}
    `;
    await tx`
      DELETE FROM public.bot_action_queue
      WHERE guild_id = ${GUILD_ID}
    `;
    await tx`
      DELETE FROM public.entitlements
      WHERE guild_id = ${GUILD_ID}
    `;
    await tx`
      DELETE FROM public.license_keys
      WHERE guild_id = ${GUILD_ID}
    `;
    await tx`
      DELETE FROM public.payments
      WHERE guild_id = ${GUILD_ID}
    `;
    await tx`
      DELETE FROM public.orders
      WHERE guild_id = ${GUILD_ID}
    `;
    await tx`
      DELETE FROM public.plans
      WHERE guild_id = ${GUILD_ID}
    `;
    await tx`
      DELETE FROM public.products
      WHERE guild_id = ${GUILD_ID}
    `;
    await tx`
      DELETE FROM public.customers
      WHERE guild_id = ${GUILD_ID}
    `;
  });
}

async function closeDisposableClients(): Promise<void> {
  await Promise.allSettled([
    sqlA?.end({ timeout: 5 }),
    sqlB?.end({ timeout: 5 }),
    sqlObserver?.end({ timeout: 5 }),
  ]);
  clientsReady = false;
}

async function dropDisposableDatabase(): Promise<void> {
  if (!disposableDatabaseCreated) return;
  await sqlAdmin.unsafe(`DROP DATABASE "${TEST_DB_NAME}" WITH (FORCE)`);
  disposableDatabaseCreated = false;
  const [remaining] = await sqlAdmin<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_database
      WHERE datname = ${TEST_DB_NAME}
    ) AS exists
  `;
  if (remaining?.exists) {
    throw new Error('Disposable commerce-claim database cleanup failed');
  }
}

async function createFixture(kind: 'capture' | 'subscription'): Promise<Fixture> {
  const [customer] = await sqlObserver<{ id: string }[]>`
    INSERT INTO public.customers (
      guild_id,
      discord_id,
      discord_username
    ) VALUES (
      ${GUILD_ID},
      ${nextValue('discord')},
      'Claim Race Customer'
    )
    RETURNING id
  `;
  const [product] = await sqlObserver<{ id: string }[]>`
    INSERT INTO public.products (
      guild_id,
      name,
      description,
      type,
      delivery_type,
      price_cents,
      currency,
      granted_role_ids,
      granted_channel_ids,
      active
    ) VALUES (
      ${GUILD_ID},
      ${nextValue('claim-product')},
      'atomic fulfillment claim fixture',
      ${kind === 'capture' ? 'one_time' : 'subscription'},
      'access_pass',
      999,
      'USD',
      ARRAY[]::TEXT[],
      ARRAY[]::TEXT[],
      true
    )
    RETURNING id
  `;

  let planId: string | null = null;
  if (kind === 'subscription') {
    const [plan] = await sqlObserver<{ id: string }[]>`
      INSERT INTO public.plans (
        product_id,
        guild_id,
        name,
        paypal_plan_id,
        interval_unit,
        interval_count,
        price_cents,
        currency,
        active
      ) VALUES (
        ${product.id}::UUID,
        ${GUILD_ID},
        ${nextValue('claim-plan')},
        ${nextValue('P-CLAIM')},
        'MONTH',
        1,
        999,
        'USD',
        true
      )
      RETURNING id
    `;
    planId = plan.id;
  }

  const paypalOrderA = kind === 'capture' ? nextValue('PAYPAL-ORDER-A') : null;
  const paypalOrderB = kind === 'capture' ? nextValue('PAYPAL-ORDER-B') : null;
  const providerA = kind === 'capture'
    ? nextValue('CAPTURE-A')
    : nextValue('SUBSCRIPTION-A');
  const providerB = kind === 'capture'
    ? nextValue('CAPTURE-B')
    : nextValue('SUBSCRIPTION-B');

  const orders = await sqlObserver<{ id: string; order_number: string }[]>`
    INSERT INTO public.orders (
      order_number,
      customer_id,
      guild_id,
      product_id,
      plan_id,
      paypal_order_id,
      paypal_subscription_id,
      amount_cents,
      currency,
      status,
      source,
      checkout_active
    ) VALUES
      (
        ${nextValue('ORD-CLAIM-A')},
        ${customer.id}::UUID,
        ${GUILD_ID},
        ${product.id}::UUID,
        ${planId}::UUID,
        ${paypalOrderA},
        ${kind === 'subscription' ? providerA : null},
        999,
        'USD',
        ${kind === 'capture' ? 'completed' : 'pending'},
        'purchase',
        false
      ),
      (
        ${nextValue('ORD-CLAIM-B')},
        ${customer.id}::UUID,
        ${GUILD_ID},
        ${product.id}::UUID,
        ${planId}::UUID,
        ${paypalOrderB},
        ${kind === 'subscription' ? providerB : null},
        999,
        'USD',
        ${kind === 'capture' ? 'completed' : 'pending'},
        'purchase',
        false
      )
    RETURNING id, order_number
  `;

  if (kind === 'capture') {
    await sqlObserver`
      INSERT INTO public.payments (
        order_id,
        customer_id,
        guild_id,
        paypal_payment_id,
        amount_cents,
        currency,
        status,
        provider,
        paypal_resource_type
      ) VALUES
        (
          ${orders[0].id}::UUID,
          ${customer.id}::UUID,
          ${GUILD_ID},
          ${providerA},
          999,
          'USD',
          'completed',
          'paypal',
          'capture'
        ),
        (
          ${orders[1].id}::UUID,
          ${customer.id}::UUID,
          ${GUILD_ID},
          ${providerB},
          999,
          'USD',
          'completed',
          'paypal',
          'capture'
        )
    `;
  }

  return {
    customerId: customer.id,
    productId: product.id,
    orderA: orders[0].id,
    orderB: orders[1].id,
    paypalOrderA,
    paypalOrderB,
    providerA,
    providerB,
    kind,
  };
}

async function claim(
  sql: any,
  fixture: Fixture,
  side: 'A' | 'B',
): Promise<ClaimResult> {
  const orderId = side === 'A' ? fixture.orderA : fixture.orderB;
  const providerId = side === 'A' ? fixture.providerA : fixture.providerB;
  const [row] = await sql<{ result: ClaimResult }[]>`
    SELECT public.commerce_claim_paid_fulfillment(
      ${orderId}::UUID,
      ${GUILD_ID},
      ${fixture.customerId}::UUID,
      ${fixture.productId}::UUID,
      ${fixture.kind},
      ${providerId},
      999,
      'USD'
    ) AS result
  `;
  if (!row?.result) throw new Error('claim RPC returned no result');
  return row.result;
}

async function runConcurrentClaim(fixture: Fixture): Promise<{
  winner: ClaimResult;
  loser: ClaimResult;
}> {
  let releaseWinner!: () => void;
  let winnerClaimed!: () => void;
  const releaseGate = new Promise<void>((resolve) => {
    releaseWinner = resolve;
  });
  const winnerGate = new Promise<void>((resolve) => {
    winnerClaimed = resolve;
  });

  const winnerPromise = sqlA.begin(async (tx) => {
    const result = await claim(tx, fixture, 'A');
    winnerClaimed();
    await releaseGate;
    return result;
  });
  await winnerGate;

  const loserPromise = sqlB.begin(async (tx) => claim(tx, fixture, 'B'));
  await waitForDatabaseLock(`${fixture.kind} competing fulfillment claim`);
  releaseWinner();

  const [winner, loser] = await Promise.all([winnerPromise, loserPromise]);
  return { winner, loser };
}

beforeAll(async () => {
  if (!/^[a-z0-9_]+$/.test(TEST_DB_NAME)) {
    throw new Error('Disposable test database name is not a safe SQL identifier');
  }
  const adminDbUrl = getTestDbUrl();
  sqlAdmin = postgres(adminDbUrl, { max: 1 });
  try {
    await sqlAdmin.unsafe(
      `CREATE DATABASE "${TEST_DB_NAME}" TEMPLATE template0 ENCODING 'UTF8'`,
    );
    disposableDatabaseCreated = true;

    const disposableUrl = new URL(adminDbUrl);
    disposableUrl.pathname = `/${TEST_DB_NAME}`;
    const testDbUrl = disposableUrl.toString();
    sqlA = postgres(testDbUrl, { max: 1 });
    sqlB = postgres(testDbUrl, { max: 1 });
    sqlObserver = postgres(testDbUrl, { max: 1 });
    clientsReady = true;
    await sqlObserver.begin(async (tx) => {
      await tx.unsafe(BASE_SCHEMA);
      await tx.unsafe(LICENSE_MIGRATION);
      await tx.unsafe(CLAIM_MIGRATION);
    });
    await Promise.all([
      sqlA`SET idle_in_transaction_session_timeout = '15s'`,
      sqlB`SET lock_timeout = '10s'`,
      sqlB`SET statement_timeout = '15s'`,
      sqlObserver`SET statement_timeout = '30s'`,
    ]);
    const [backend] = await sqlB<{ pid: number }[]>`
      SELECT pg_catalog.pg_backend_pid() AS pid
    `;
    sqlBBackendPid = backend.pid;
    await sqlObserver`
      INSERT INTO public.guild (id, name, owner_discord_id)
      VALUES (${GUILD_ID}, 'Commerce claim integration', ${nextValue('owner')})
      ON CONFLICT (id) DO NOTHING
    `;
  } catch (error) {
    await closeDisposableClients();
    await dropDisposableDatabase();
    await sqlAdmin.end({ timeout: 5 });
    throw error;
  }
});

beforeEach(async () => {
  await cleanFixtures();
});

afterAll(async () => {
  try {
    if (clientsReady) {
      await cleanFixtures().catch(() => undefined);
    }
  } finally {
    await closeDisposableClients();
    await dropDisposableDatabase();
    await sqlAdmin?.end({ timeout: 5 });
  }
});

describe('checkout migration and atomic fulfillment winner', () => {
  it('replays migrations without cancelling provider-payable rows and surfaces historical missing keys', async () => {
    const rollbackMarker = new Error('expected migration replay rollback');

    await expect(sqlObserver.begin(async (tx) => {
      const [customer] = await tx<{ id: string; discord_id: string }[]>`
        INSERT INTO public.customers (guild_id, discord_id, discord_username)
        VALUES (${GUILD_ID}, ${nextValue('migration-discord')}, 'Migration Customer')
        RETURNING id, discord_id
      `;
      const [product] = await tx<{ id: string }[]>`
        INSERT INTO public.products (
          guild_id, name, type, delivery_type, price_cents, currency, active
        ) VALUES (
          ${GUILD_ID}, ${nextValue('migration-product')}, 'one_time',
          'access_pass', 999, 'USD', true
        )
        RETURNING id
      `;
      const pendingOrders = await tx<{ id: string }[]>`
        INSERT INTO public.orders (
          order_number, customer_id, guild_id, product_id, paypal_order_id,
          amount_cents, currency, status, source, checkout_active
        ) VALUES
          (
            ${nextValue('ORD-MIGRATION-OLD')}, ${customer.id}::UUID, ${GUILD_ID},
            ${product.id}::UUID, ${nextValue('PAYPAL-MIGRATION-OLD')},
            999, 'USD', 'pending', 'purchase', false
          ),
          (
            ${nextValue('ORD-MIGRATION-NEW')}, ${customer.id}::UUID, ${GUILD_ID},
            ${product.id}::UUID, ${nextValue('PAYPAL-MIGRATION-NEW')},
            999, 'USD', 'pending', 'purchase', false
          )
        RETURNING id
      `;

      const [queuedProduct] = await tx<{ id: string }[]>`
        INSERT INTO public.products (
          guild_id, name, type, delivery_type, price_cents, currency, active
        ) VALUES (
          ${GUILD_ID}, ${nextValue('queued-duplicate-product')}, 'one_time',
          'access_pass', 999, 'USD', true
        )
        RETURNING id
      `;
      const queuedOrders = await tx<{ id: string; order_number: string }[]>`
        INSERT INTO public.orders (
          order_number, customer_id, guild_id, product_id, paypal_order_id,
          amount_cents, currency, status, source, checkout_active
        ) VALUES
          (
            ${nextValue('ORD-QUEUED-WINNER')}, ${customer.id}::UUID, ${GUILD_ID},
            ${queuedProduct.id}::UUID, ${nextValue('PAYPAL-QUEUED-WINNER')},
            999, 'USD', 'completed', 'purchase', false
          ),
          (
            ${nextValue('ORD-QUEUED-LOSER')}, ${customer.id}::UUID, ${GUILD_ID},
            ${queuedProduct.id}::UUID, ${nextValue('PAYPAL-QUEUED-LOSER')},
            999, 'USD', 'completed', 'purchase', false
          ),
          (
            ${nextValue('ORD-QUEUED-MALFORMED')}, ${customer.id}::UUID, ${GUILD_ID},
            ${queuedProduct.id}::UUID, ${nextValue('PAYPAL-QUEUED-MALFORMED')},
            999, 'USD', 'completed', 'purchase', false
          )
        RETURNING id, order_number
      `;
      const queuedCaptureA = nextValue('CAPTURE-QUEUED-WINNER');
      const queuedCaptureB = nextValue('CAPTURE-QUEUED-LOSER');
      const malformedCapture = nextValue('CAPTURE-WITHOUT-PAYMENT');
      await tx`
        INSERT INTO public.payments (
          order_id,
          customer_id,
          guild_id,
          paypal_payment_id,
          amount_cents,
          currency,
          status,
          provider,
          paypal_resource_type
        ) VALUES
          (
            ${queuedOrders[0].id}::UUID,
            ${customer.id}::UUID,
            ${GUILD_ID},
            ${queuedCaptureA},
            999,
            'USD',
            'completed',
            'paypal',
            'capture'
          ),
          (
            ${queuedOrders[1].id}::UUID,
            ${customer.id}::UUID,
            ${GUILD_ID},
            ${queuedCaptureB},
            999,
            'USD',
            'completed',
            'paypal',
            'capture'
          )
      `;
      await tx`
        INSERT INTO public.bot_action_queue (
          guild_id,
          action,
          payload,
          status,
          lane,
          idempotency_key,
          created_at
        ) VALUES
          (
            ${GUILD_ID},
            'fulfill_purchase',
            pg_catalog.jsonb_build_object(
              'fulfillment_type', 'one_time_purchase',
              'guild_id', ${GUILD_ID}::TEXT,
              'customer_id', ${customer.id}::TEXT,
              'discord_id', ${customer.discord_id}::TEXT,
              'product_id', ${queuedProduct.id}::TEXT,
              'product_name', 'Queued duplicate product',
              'order_id', ${queuedOrders[0].id}::TEXT,
              'order_number', ${queuedOrders[0].order_number}::TEXT,
              'paypal_capture_id', ${queuedCaptureA}::TEXT,
              'amount_cents', 999,
              'currency', 'USD',
              'granted_role_ids', '[]'::JSONB,
              'granted_channel_ids', '[]'::JSONB,
              'entitlement_type', 'one_time'
            ),
            'pending',
            'commerce',
            ${nextValue('queued-fulfillment-a')},
            '2026-07-27T01:00:00Z'::TIMESTAMPTZ
          ),
          (
            ${GUILD_ID},
            'fulfill_purchase',
            pg_catalog.jsonb_build_object(
              'fulfillment_type', 'one_time_purchase',
              'guild_id', ${GUILD_ID}::TEXT,
              'customer_id', ${customer.id}::TEXT,
              'discord_id', ${customer.discord_id}::TEXT,
              'product_id', ${queuedProduct.id}::TEXT,
              'product_name', 'Queued duplicate product',
              'order_id', ${queuedOrders[1].id}::TEXT,
              'order_number', ${queuedOrders[1].order_number}::TEXT,
              'paypal_capture_id', ${queuedCaptureB}::TEXT,
              'amount_cents', 999,
              'currency', 'USD',
              'granted_role_ids', '[]'::JSONB,
              'granted_channel_ids', '[]'::JSONB,
              'entitlement_type', 'one_time'
            ),
            'pending',
            'commerce',
            ${nextValue('queued-fulfillment-b')},
            '2026-07-27T02:00:00Z'::TIMESTAMPTZ
          ),
          (
            ${GUILD_ID},
            'fulfill_purchase',
            pg_catalog.jsonb_build_object(
              'fulfillment_type', 'one_time_purchase',
              'guild_id', ${GUILD_ID}::TEXT,
              'customer_id', ${customer.id}::TEXT,
              'discord_id', ${customer.discord_id}::TEXT,
              'product_id', ${queuedProduct.id}::TEXT,
              'product_name', 'Queued duplicate product',
              'order_id', ${queuedOrders[2].id}::TEXT,
              'order_number', ${queuedOrders[2].order_number}::TEXT,
              'paypal_capture_id', ${malformedCapture}::TEXT,
              'amount_cents', 999,
              'currency', 'USD',
              'granted_role_ids', '[]'::JSONB,
              'granted_channel_ids', '[]'::JSONB,
              'entitlement_type', 'one_time'
            ),
            'pending',
            'commerce',
            ${nextValue('queued-fulfillment-malformed')},
            '2026-07-27T00:00:00Z'::TIMESTAMPTZ
          )
      `;

      const [licenseProduct] = await tx<{ id: string }[]>`
        INSERT INTO public.products (
          guild_id, name, type, delivery_type, price_cents, currency, active
        ) VALUES (
          ${GUILD_ID}, ${nextValue('historical-license-product')}, 'one_time',
          'license_key', 1499, 'USD', true
        )
        RETURNING id
      `;
      const [paidOrder] = await tx<{ id: string; order_number: string }[]>`
        INSERT INTO public.orders (
          order_number, customer_id, guild_id, product_id, paypal_order_id,
          amount_cents, currency, status, source, checkout_active
        ) VALUES (
          ${nextValue('ORD-MISSING-KEY')}, ${customer.id}::UUID, ${GUILD_ID},
          ${licenseProduct.id}::UUID, ${nextValue('PAYPAL-MISSING-KEY')},
          1499, 'USD', 'completed', 'purchase', false
        )
        RETURNING id, order_number
      `;
      await tx`
        INSERT INTO public.entitlements (
          customer_id, guild_id, product_id, order_id, type, status, source
        ) VALUES (
          ${customer.id}::UUID, ${GUILD_ID}, ${licenseProduct.id}::UUID,
          ${paidOrder.id}::UUID, 'one_time', 'active', 'purchase'
        )
      `;

      await tx.unsafe(LICENSE_MIGRATION);
      await tx.unsafe(CLAIM_MIGRATION);

      const preserved = await tx<{
        id: string;
        status: string;
        checkout_active: boolean;
      }[]>`
        SELECT id, status, checkout_active
        FROM public.orders
        WHERE id IN (${pendingOrders[0].id}::UUID, ${pendingOrders[1].id}::UUID)
        ORDER BY created_at, id
      `;
      expect(preserved).toHaveLength(2);
      expect(preserved.every((order) => order.status === 'pending')).toBe(true);
      expect(preserved.filter((order) => order.checkout_active)).toHaveLength(1);

      const [legacyActiveFreeze] = await tx<{
        id: string;
        delivery_type_snapshot: string | null;
        grant_snapshot_frozen_at: string;
      }[]>`
        UPDATE public.orders
        SET grant_snapshot_frozen_at = pg_catalog.clock_timestamp()
        WHERE id IN (
          ${pendingOrders[0].id}::UUID,
          ${pendingOrders[1].id}::UUID
        )
          AND checkout_active = true
        RETURNING id, delivery_type_snapshot, grant_snapshot_frozen_at
      `;
      expect(legacyActiveFreeze).toMatchObject({
        id: preserved.find((order) => order.checkout_active)?.id,
        delivery_type_snapshot: null,
      });
      expect(Number.isFinite(Date.parse(String(
        legacyActiveFreeze.grant_snapshot_frozen_at,
      )))).toBe(true);

      const queuedClaims = await tx<{ order_id: string }[]>`
        SELECT order_id
        FROM public.commerce_fulfillment_claims
        WHERE guild_id = ${GUILD_ID}
          AND customer_id = ${customer.id}::UUID
          AND product_id = ${queuedProduct.id}::UUID
      `;
      expect(queuedClaims).toEqual([{ order_id: queuedOrders[0].id }]);

      const queuedHolds = await tx<{
        order_id: string;
        winning_order_id: string | null;
        provider_kind: string;
        provider_id: string;
      }[]>`
        SELECT order_id, winning_order_id, provider_kind, provider_id
        FROM public.commerce_fulfillment_holds
        WHERE order_id = ${queuedOrders[1].id}::UUID
      `;
      expect(queuedHolds).toEqual([{
        order_id: queuedOrders[1].id,
        winning_order_id: queuedOrders[0].id,
        provider_kind: 'capture',
        provider_id: queuedCaptureB,
      }]);
      const malformedHolds = await tx<{ order_id: string }[]>`
        SELECT order_id
        FROM public.commerce_fulfillment_holds
        WHERE order_id = ${queuedOrders[2].id}::UUID
      `;
      expect(malformedHolds).toEqual([]);

      const queuedAlerts = await tx<{
        id: string;
        severity: string;
        metadata: Record<string, unknown>;
      }[]>`
        SELECT id, severity, metadata
        FROM public.alerts
        WHERE guild_id = ${GUILD_ID}
          AND alert_type = 'commerce_duplicate_purchase_capture'
          AND metadata ->> 'order_id' = ${queuedOrders[1].id}
          AND resolved = false
      `;
      expect(queuedAlerts).toHaveLength(1);
      expect(queuedAlerts[0]).toMatchObject({
        severity: 'critical',
        metadata: {
          source: 'migration_backfill',
          winning_order_id: queuedOrders[0].id,
          required_action: 'refund_or_cancel_duplicate',
        },
      });

      const [queuedLoserReplay] = await tx<{ result: ClaimResult }[]>`
        SELECT public.commerce_claim_paid_fulfillment(
          ${queuedOrders[1].id}::UUID,
          ${GUILD_ID},
          ${customer.id}::UUID,
          ${queuedProduct.id}::UUID,
          'capture',
          ${queuedCaptureB},
          999,
          'USD'
        ) AS result
      `;
      expect(queuedLoserReplay.result).toMatchObject({
        order_id: queuedOrders[1].id,
        disposition: 'held',
        winning_order_id: queuedOrders[0].id,
        alert_id: queuedAlerts[0].id,
      });

      const alerts = await tx<{
        severity: string;
        metadata: Record<string, unknown>;
      }[]>`
        SELECT severity, metadata
        FROM public.alerts
        WHERE guild_id = ${GUILD_ID}
          AND alert_type = 'commerce_missing_license_delivery'
          AND metadata ->> 'order_id' = ${paidOrder.id}
          AND resolved = false
      `;
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({
        severity: 'critical',
        metadata: {
          order_id: paidOrder.id,
          customer_id: customer.id,
          product_id: licenseProduct.id,
          required_action: 'manual_fulfillment_or_refund',
        },
      });

      throw rollbackMarker;
    })).rejects.toBe(rollbackMarker);
  }, 45_000);

  it.each(['capture', 'subscription'] as const)(
    'serializes two historical %s orders, holds the loser, and preserves replay',
    async (kind) => {
      const fixture = await createFixture(kind);
      const { winner, loser } = await runConcurrentClaim(fixture);

      expect(winner).toEqual({
        order_id: fixture.orderA,
        disposition: 'winner',
        winning_order_id: fixture.orderA,
        conflicting_entitlement_id: null,
        alert_id: null,
      });
      expect(loser).toMatchObject({
        order_id: fixture.orderB,
        disposition: 'held',
        winning_order_id: fixture.orderA,
        conflicting_entitlement_id: null,
        alert_id: expect.any(String),
      });

      const claims = await sqlObserver<{
        order_id: string;
      }[]>`
        SELECT order_id
        FROM public.commerce_fulfillment_claims
        WHERE guild_id = ${GUILD_ID}
          AND customer_id = ${fixture.customerId}::UUID
          AND product_id = ${fixture.productId}::UUID
      `;
      expect(claims).toEqual([{ order_id: fixture.orderA }]);

      const holds = await sqlObserver<{
        order_id: string;
        winning_order_id: string | null;
        provider_kind: string;
        provider_id: string;
      }[]>`
        SELECT order_id, winning_order_id, provider_kind, provider_id
        FROM public.commerce_fulfillment_holds
        WHERE order_id = ${fixture.orderB}::UUID
      `;
      expect(holds).toEqual([{
        order_id: fixture.orderB,
        winning_order_id: fixture.orderA,
        provider_kind: kind,
        provider_id: fixture.providerB,
      }]);

      if (kind === 'capture') {
        const payments = await sqlObserver<{
          paypal_payment_id: string;
          status: string;
        }[]>`
          SELECT paypal_payment_id, status
          FROM public.payments
          WHERE order_id = ${fixture.orderB}::UUID
        `;
        expect(payments).toEqual([{
          paypal_payment_id: fixture.providerB,
          status: 'completed',
        }]);
      }

      const [loserOrder] = await sqlObserver<{ status: string }[]>`
        SELECT status
        FROM public.orders
        WHERE id = ${fixture.orderB}::UUID
      `;
      expect(loserOrder.status).toBe(kind === 'capture' ? 'completed' : 'pending_review');

      const alerts = await sqlObserver<{
        id: string;
        severity: string;
        metadata: Record<string, unknown>;
      }[]>`
        SELECT id, severity, metadata
        FROM public.alerts
        WHERE guild_id = ${GUILD_ID}
          AND metadata ->> 'order_id' = ${fixture.orderB}
          AND resolved = false
      `;
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({
        id: loser.alert_id,
        severity: 'critical',
        metadata: {
          winning_order_id: fixture.orderA,
          required_action: 'refund_or_cancel_duplicate',
        },
      });

      const replay = await claim(sqlObserver, fixture, 'B');
      expect(replay).toEqual(loser);
      const winnerReplay = await claim(sqlObserver, fixture, 'A');
      expect(winnerReplay).toEqual(winner);

      const [effects] = await sqlObserver<{
        queue_count: number;
        key_count: number;
        entitlement_count: number;
      }[]>`
        SELECT
          (
            SELECT count(*)::INTEGER
            FROM public.bot_action_queue AS queue
            WHERE queue.payload ->> 'order_id' IN (
              ${fixture.orderA},
              ${fixture.orderB}
            )
          ) AS queue_count,
          (
            SELECT count(*)::INTEGER
            FROM public.license_keys AS license_key
            WHERE license_key.order_id IN (
              ${fixture.orderA}::UUID,
              ${fixture.orderB}::UUID
            )
          ) AS key_count,
          (
            SELECT count(*)::INTEGER
            FROM public.entitlements AS entitlement
            WHERE entitlement.order_id IN (
              ${fixture.orderA}::UUID,
              ${fixture.orderB}::UUID
            )
          ) AS entitlement_count
      `;
      expect(effects).toEqual({
        queue_count: 0,
        key_count: 0,
        entitlement_count: 0,
      });
    },
    45_000,
  );

  it('does not replace a paid subscription claim that remains in manual review', async () => {
    const fixture = await createFixture('subscription');
    const winner = await claim(sqlObserver, fixture, 'A');
    expect(winner).toEqual({
      order_id: fixture.orderA,
      disposition: 'winner',
      winning_order_id: fixture.orderA,
      conflicting_entitlement_id: null,
      alert_id: null,
    });

    const [reviewOrder] = await sqlObserver<{ id: string; status: string }[]>`
      UPDATE public.orders
      SET status = 'pending_review',
          updated_at = pg_catalog.clock_timestamp()
      WHERE id = ${fixture.orderA}::UUID
        AND status = 'pending'
      RETURNING id, status
    `;
    expect(reviewOrder).toEqual({
      id: fixture.orderA,
      status: 'pending_review',
    });

    const loser = await claim(sqlObserver, fixture, 'B');
    expect(loser).toMatchObject({
      order_id: fixture.orderB,
      disposition: 'held',
      winning_order_id: fixture.orderA,
      conflicting_entitlement_id: null,
      alert_id: expect.any(String),
    });

    const claims = await sqlObserver<{ order_id: string }[]>`
      SELECT order_id
      FROM public.commerce_fulfillment_claims
      WHERE guild_id = ${GUILD_ID}
        AND customer_id = ${fixture.customerId}::UUID
        AND product_id = ${fixture.productId}::UUID
    `;
    expect(claims).toEqual([{ order_id: fixture.orderA }]);

    const holds = await sqlObserver<{
      order_id: string;
      winning_order_id: string | null;
    }[]>`
      SELECT order_id, winning_order_id
      FROM public.commerce_fulfillment_holds
      WHERE order_id = ${fixture.orderB}::UUID
    `;
    expect(holds).toEqual([{
      order_id: fixture.orderB,
      winning_order_id: fixture.orderA,
    }]);

    const alerts = await sqlObserver<{
      id: string;
      severity: string;
      metadata: Record<string, unknown>;
    }[]>`
      SELECT id, severity, metadata
      FROM public.alerts
      WHERE guild_id = ${GUILD_ID}
        AND alert_type = 'commerce_duplicate_subscription_activation'
        AND metadata ->> 'order_id' = ${fixture.orderB}
        AND resolved = false
    `;
    expect(alerts).toEqual([expect.objectContaining({
      id: loser.alert_id,
      severity: 'critical',
      metadata: expect.objectContaining({
        winning_order_id: fixture.orderA,
        required_action: 'refund_or_cancel_duplicate',
      }),
    })]);
  }, 45_000);

  it('rejects a syntactically valid capture ID belonging to a different paid order', async () => {
    const fixture = await createFixture('capture');

    await expect(sqlObserver`
      SELECT public.commerce_claim_paid_fulfillment(
        ${fixture.orderA}::UUID,
        ${GUILD_ID},
        ${fixture.customerId}::UUID,
        ${fixture.productId}::UUID,
        'capture',
        ${fixture.providerB},
        999,
        'USD'
      )
    `).rejects.toMatchObject({
      code: '23514',
      message: expect.stringContaining('completed capture payment identity mismatch'),
    });

    const claimsAfterMismatch = await sqlObserver<{ order_id: string }[]>`
      SELECT order_id
      FROM public.commerce_fulfillment_claims
      WHERE guild_id = ${GUILD_ID}
        AND customer_id = ${fixture.customerId}::UUID
        AND product_id = ${fixture.productId}::UUID
    `;
    expect(claimsAfterMismatch).toEqual([]);

    const valid = await claim(sqlObserver, fixture, 'A');
    expect(valid).toEqual({
      order_id: fixture.orderA,
      disposition: 'winner',
      winning_order_id: fixture.orderA,
      conflicting_entitlement_id: null,
      alert_id: null,
    });
  }, 45_000);

  it('does not lock the prior winner order after the losing order and claim row', async () => {
    const fixture = await createFixture('capture');
    const winner = await claim(sqlObserver, fixture, 'A');
    expect(winner.disposition).toBe('winner');

    let releaseWinnerOrder!: () => void;
    let winnerOrderLocked!: () => void;
    const releaseGate = new Promise<void>((resolve) => {
      releaseWinnerOrder = resolve;
    });
    const lockedGate = new Promise<void>((resolve) => {
      winnerOrderLocked = resolve;
    });
    const blocker = sqlA.begin(async (tx) => {
      await tx`
        SELECT id
        FROM public.orders
        WHERE id = ${fixture.orderA}::UUID
        FOR NO KEY UPDATE
      `;
      winnerOrderLocked();
      await releaseGate;
    });
    await lockedGate;

    try {
      const loser = await sqlB.begin(async (tx) => {
        await tx`SET LOCAL lock_timeout = '750ms'`;
        return claim(tx, fixture, 'B');
      });
      expect(loser).toMatchObject({
        order_id: fixture.orderB,
        disposition: 'held',
        winning_order_id: fixture.orderA,
        alert_id: expect.any(String),
      });
    } finally {
      releaseWinnerOrder();
      await blocker;
    }
  }, 45_000);

  it('keeps claim/hold tables private while exposing only the exact service RPC', async () => {
    const [privileges] = await sqlObserver<{
      service_claim_select: boolean;
      service_hold_select: boolean;
      service_execute: boolean;
      anon_execute: boolean;
      authenticated_execute: boolean;
    }[]>`
      SELECT
        pg_catalog.has_table_privilege(
          'service_role',
          'public.commerce_fulfillment_claims',
          'SELECT'
        ) AS service_claim_select,
        pg_catalog.has_table_privilege(
          'service_role',
          'public.commerce_fulfillment_holds',
          'SELECT'
        ) AS service_hold_select,
        pg_catalog.has_function_privilege(
          'service_role',
          'public.commerce_claim_paid_fulfillment(uuid,text,uuid,uuid,text,text,integer,text)',
          'EXECUTE'
        ) AS service_execute,
        pg_catalog.has_function_privilege(
          'anon',
          'public.commerce_claim_paid_fulfillment(uuid,text,uuid,uuid,text,text,integer,text)',
          'EXECUTE'
        ) AS anon_execute,
        pg_catalog.has_function_privilege(
          'authenticated',
          'public.commerce_claim_paid_fulfillment(uuid,text,uuid,uuid,text,text,integer,text)',
          'EXECUTE'
        ) AS authenticated_execute
    `;
    expect(privileges).toEqual({
      service_claim_select: false,
      service_hold_select: false,
      service_execute: true,
      anon_execute: false,
      authenticated_execute: false,
    });
  });
});
