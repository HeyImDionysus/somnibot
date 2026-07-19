/**
 * Real-database coverage for the commerce / wagerable-income wall.
 *
 * These tests intentionally bypass dashboard preflight checks. The migration
 * must protect direct writes and races at the database boundary.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import postgres from 'postgres';
import { getTestDbUrl, requireSupabase } from './helpers.js';

const CONFLICT_MARKER = 'COMMERCE_INCOME_WALL_CONFLICT';
const RUN_ID = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const GUILD_A = `test-commerce-wall-a-${RUN_ID}`;
const GUILD_B = `test-commerce-wall-b-${RUN_ID}`;
const TEST_GUILDS = [GUILD_A, GUILD_B];

let supa!: SupabaseClient;
let sqlA!: ReturnType<typeof postgres>;
let sqlB!: ReturnType<typeof postgres>;
let sqlObserver!: ReturnType<typeof postgres>;
let sqlBBackendPid!: number;
let sequence = 0;
const SNOWFLAKE_BASE = 900_000_000_000_000_000n
  + BigInt(Date.now() % 1_000_000) * 10_000n;

type DbError = { code?: string; message?: string; details?: string };

function expectWallConflict(error: DbError | null | undefined): void {
  expect(error?.code).toBe('P0001');
  expect(error?.message).toMatch(new RegExp(`^${CONFLICT_MARKER}`));
}

function expectPgWallConflict(error: unknown): void {
  const dbError = error as DbError;
  expect(dbError.code).toBe('P0001');
  expect(dbError.message).toMatch(new RegExp(`^${CONFLICT_MARKER}`));
}

function nextName(prefix: string): string {
  sequence += 1;
  // Globally-unique columns (orders.order_number, payments.paypal_payment_id,
  // ...) must not collide with rows a previous run left behind: audit rows
  // are append-only, so cleanup can never reclaim prior-run identifiers.
  return `${prefix}-${RUN_ID}-${sequence}`;
}

function nextSnowflake(): string {
  sequence += 1;
  return (SNOWFLAKE_BASE + BigInt(sequence)).toString();
}

function productRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    guild_id: GUILD_A,
    name: nextName('wall-product'),
    description: 'commerce income wall integration fixture',
    type: 'one_time',
    delivery_type: 'access_pass',
    price_cents: 1_000,
    currency: 'USD',
    granted_role_ids: [],
    granted_channel_ids: [],
    active: true,
    ...overrides,
  };
}

function planRow(
  productId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    product_id: productId,
    guild_id: GUILD_A,
    name: nextName('wall-plan'),
    paypal_plan_id: `P-${nextName('paypal')}`,
    interval_unit: 'MONTH',
    interval_count: 1,
    price_cents: 500,
    currency: 'USD',
    trial_days: 0,
    active: true,
    ...overrides,
  };
}

async function createProduct(overrides: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await supa
    .from('products')
    .insert(productRow(overrides))
    .select('id')
    .single();
  expect(error).toBeNull();
  if (error || !data?.id) throw new Error(error?.message ?? 'product insert returned no id');
  return data.id as string;
}

async function createPlan(
  productId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const { data, error } = await supa
    .from('plans')
    .insert(planRow(productId, overrides))
    .select('id')
    .single();
  expect(error).toBeNull();
  if (error || !data?.id) throw new Error(error?.message ?? 'plan insert returned no id');
  return data.id as string;
}

async function createIncome(
  roleId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const { data, error } = await supa
    .from('economy_role_income')
    .insert({
      guild_id: GUILD_A,
      role_id: roleId,
      amount: 100,
      interval_minutes: 60,
      ...overrides,
    })
    .select('id')
    .single();
  expect(error).toBeNull();
  if (error || !data?.id) throw new Error(error?.message ?? 'income insert returned no id');
  return data.id as string;
}

async function selectedPlan(
  guildId: string,
  productId: string,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await supa.rpc('commerce_select_checkout_plan', {
    p_guild_id: guildId,
    p_product_id: productId,
  });
  expect(error).toBeNull();
  const rows = (data ?? []) as Record<string, unknown>[];
  expect(rows.length).toBeLessThanOrEqual(1);
  return rows[0] ?? null;
}

type PaidRefundFixture = {
  productId: string;
  customerId: string;
  discordId: string;
  orderId: string;
  paymentId: string;
  paypalOrderId: string;
  captureId: string;
  roleId: string | null;
  entitlementId: string | null;
  licenseKeyId: string | null;
  sessionId: string | null;
};

type SaleRefundFixture = {
  productId: string;
  planId: string;
  customerId: string;
  orderId: string;
  paymentId: string;
  subscriptionId: string;
  saleId: string;
  entitlementId: string | null;
  licenseKeyId: string | null;
  sessionId: string | null;
};

async function createPaidRefundFixture(options: {
  priorRefundCents?: number;
  withAccess?: boolean;
} = {}): Promise<PaidRefundFixture> {
  const priorRefundCents = options.priorRefundCents ?? 0;
  const roleId = options.withAccess ? nextSnowflake() : null;
  const discordId = nextSnowflake();
  const productId = await createProduct({
    granted_role_ids: roleId === null ? [] : [roleId],
  });
  const { data: customer, error: customerError } = await supa
    .from('customers')
    .insert({
      guild_id: GUILD_A,
      discord_id: discordId,
      discord_username: nextName('refund-customer'),
    })
    .select('id')
    .single();
  expect(customerError).toBeNull();

  const paypalOrderId = nextName('refund-paypal-order');
  const { data: order, error: orderError } = await supa
    .from('orders')
    .insert({
      order_number: nextName('refund-order'),
      customer_id: customer!.id,
      guild_id: GUILD_A,
      product_id: productId,
      paypal_order_id: paypalOrderId,
      amount_cents: 1_000,
      currency: 'USD',
      source: 'purchase',
      status: 'pending',
    })
    .select('id')
    .single();
  expect(orderError).toBeNull();

  const freeze = await supa.rpc('commerce_freeze_order_grant_snapshot', {
    p_order_id: order!.id,
    p_guild_id: GUILD_A,
    p_customer_id: customer!.id,
    p_product_id: productId,
  });
  expect(freeze.error).toBeNull();

  const captureId = nextName('refund-capture');
  const capture = await supa.rpc('commerce_finalize_paypal_capture', {
    p_order_id: order!.id,
    p_guild_id: GUILD_A,
    p_customer_id: customer!.id,
    p_product_id: productId,
    p_paypal_order_id: paypalOrderId,
    p_paypal_capture_id: captureId,
    p_amount_cents: 1_000,
    p_currency: 'USD',
  });
  expect(capture.error).toBeNull();
  const { data: payment, error: paymentError } = await supa
    .from('payments')
    .select('id')
    .eq('paypal_payment_id', captureId)
    .single();
  expect(paymentError).toBeNull();

  if (priorRefundCents > 0) {
    const priorRefund = await supa.rpc('commerce_record_paypal_refund_event', {
      p_payment_id: payment!.id,
      p_order_id: order!.id,
      p_guild_id: GUILD_A,
      p_customer_id: customer!.id,
      p_paypal_payment_id: captureId,
      p_resource_type: 'capture',
      p_paypal_refund_id: nextName('prior-capture-refund'),
      p_event_type: 'PAYMENT.CAPTURE.REFUNDED',
      p_refund_amount_cents: priorRefundCents,
      p_currency: 'USD',
      p_audit_details: { fixture: 'prior refund' },
    });
    expect(priorRefund.error).toBeNull();
  }

  let entitlementId: string | null = null;
  let licenseKeyId: string | null = null;
  let sessionId: string | null = null;
  if (options.withAccess) {
    const { data: licenseKey, error: licenseKeyError } = await supa
      .from('license_keys')
      .insert({
        order_id: order!.id,
        customer_id: customer!.id,
        product_id: productId,
        guild_id: GUILD_A,
        key_hash: nextName('refund-key-hash'),
        key_prefix: 'TEST',
        key_suffix: nextName('refund-key-suffix'),
        bound_discord_id: discordId,
        status: 'active',
      })
      .select('id')
      .single();
    expect(licenseKeyError).toBeNull();
    licenseKeyId = licenseKey!.id as string;

    const { data: entitlement, error: entitlementError } = await supa
      .from('entitlements')
      .insert({
        customer_id: customer!.id,
        guild_id: GUILD_A,
        product_id: productId,
        license_key_id: licenseKeyId,
        order_id: order!.id,
        type: 'one_time',
        status: 'active',
        source: 'purchase',
        granted_role_ids: roleId === null ? [] : [roleId],
        granted_channel_ids: [],
      })
      .select('id')
      .single();
    expect(entitlementError).toBeNull();
    entitlementId = entitlement!.id as string;

    const { data: session, error: sessionError } = await supa
      .from('license_sessions')
      .insert({
        license_key_id: licenseKeyId,
        device_fingerprint: nextName('refund-device'),
        active: true,
      })
      .select('id')
      .single();
    expect(sessionError).toBeNull();
    sessionId = session!.id as string;
  }

  return {
    productId,
    customerId: customer!.id as string,
    discordId,
    orderId: order!.id as string,
    paymentId: payment!.id as string,
    paypalOrderId,
    captureId,
    roleId,
    entitlementId,
    licenseKeyId,
    sessionId,
  };
}

async function createSaleRefundFixture(options: {
  withAccess?: boolean;
} = {}): Promise<SaleRefundFixture> {
  const productId = await createProduct({
    type: 'subscription',
    price_cents: 500,
  });
  const planId = await createPlan(productId, { price_cents: 500 });
  const saleDiscordId = nextSnowflake();
  const { data: customer, error: customerError } = await supa
    .from('customers')
    .insert({
      guild_id: GUILD_A,
      discord_id: saleDiscordId,
      discord_username: nextName('sale-refund-customer'),
    })
    .select('id')
    .single();
  expect(customerError).toBeNull();
  const subscriptionId = nextName('sale-refund-subscription');
  const { data: order, error: orderError } = await supa
    .from('orders')
    .insert({
      order_number: nextName('sale-refund-order'),
      customer_id: customer!.id,
      guild_id: GUILD_A,
      product_id: productId,
      plan_id: planId,
      paypal_subscription_id: subscriptionId,
      amount_cents: 500,
      currency: 'USD',
      source: 'purchase',
      status: 'pending',
    })
    .select('id')
    .single();
  expect(orderError).toBeNull();
  const freeze = await supa.rpc('commerce_freeze_order_grant_snapshot', {
    p_order_id: order!.id,
    p_guild_id: GUILD_A,
    p_customer_id: customer!.id,
    p_product_id: productId,
  });
  expect(freeze.error).toBeNull();
  const completed = await supa
    .from('orders')
    .update({ status: 'completed' })
    .eq('id', order!.id);
  expect(completed.error).toBeNull();
  const saleId = nextName('sale-refund-payment');
  const { data: payment, error: paymentError } = await supa
    .from('payments')
    .insert({
      order_id: order!.id,
      customer_id: customer!.id,
      guild_id: GUILD_A,
      paypal_payment_id: saleId,
      paypal_resource_type: 'sale',
      amount_cents: 500,
      currency: 'USD',
      provider: 'paypal',
      status: 'completed',
    })
    .select('id')
    .single();
  expect(paymentError).toBeNull();

  let entitlementId: string | null = null;
  let licenseKeyId: string | null = null;
  let sessionId: string | null = null;
  if (options.withAccess) {
    const { data: licenseKey, error: licenseKeyError } = await supa
      .from('license_keys')
      .insert({
        order_id: order!.id,
        customer_id: customer!.id,
        product_id: productId,
        guild_id: GUILD_A,
        key_hash: nextName('sale-refund-key-hash'),
        key_prefix: 'SALE',
        key_suffix: nextName('sale-refund-key-suffix'),
        bound_discord_id: saleDiscordId,
        status: 'active',
      })
      .select('id')
      .single();
    expect(licenseKeyError).toBeNull();
    licenseKeyId = licenseKey!.id as string;
    const { data: entitlement, error: entitlementError } = await supa
      .from('entitlements')
      .insert({
        customer_id: customer!.id,
        guild_id: GUILD_A,
        product_id: productId,
        plan_id: planId,
        license_key_id: licenseKeyId,
        order_id: order!.id,
        type: 'subscription',
        status: 'active',
        source: 'purchase',
        granted_role_ids: [],
        granted_channel_ids: [],
      })
      .select('id')
      .single();
    expect(entitlementError).toBeNull();
    entitlementId = entitlement!.id as string;
    const { data: session, error: sessionError } = await supa
      .from('license_sessions')
      .insert({
        license_key_id: licenseKeyId,
        device_fingerprint: nextName('sale-refund-device'),
        active: true,
      })
      .select('id')
      .single();
    expect(sessionError).toBeNull();
    sessionId = session!.id as string;
  }

  return {
    productId,
    planId,
    customerId: customer!.id as string,
    orderId: order!.id as string,
    paymentId: payment!.id as string,
    subscriptionId,
    saleId,
    entitlementId,
    licenseKeyId,
    sessionId,
  };
}

async function cleanFixtures(): Promise<void> {
  const { data: fixtureLicenseKeys, error: fixtureLicenseKeyError } = await supa
    .from('license_keys')
    .select('id')
    .in('guild_id', TEST_GUILDS);
  expect(fixtureLicenseKeyError).toBeNull();
  const fixtureLicenseKeyIds = (fixtureLicenseKeys ?? []).map((row) => row.id as string);

  if (fixtureLicenseKeyIds.length > 0) {
    const licenseSessionDelete = await supa
      .from('license_sessions')
      .delete()
      .in('license_key_id', fixtureLicenseKeyIds);
    expect(licenseSessionDelete.error).toBeNull();
  }

  const alertDelete = await supa
    .from('alerts')
    .delete()
    .in('guild_id', TEST_GUILDS);
  expect(alertDelete.error).toBeNull();

  // audit_logs is append-only by design (trg_prevent_audit_log_delete raises
  // for every deleted row, with no sanctioned purge RPC). Audit rows written
  // by earlier tests are retained; every audit assertion in this suite scopes
  // to a per-test unique target/order id, so retained rows cannot leak
  // between tests, and the per-run guild ids keep reruns isolated.

  // Noncommerce cleanup carriers are deliberately undeletable through
  // production clients before resolution (commerce_queue_guard_noncommerce_
  // cleanup_delete raises 23503), and their activation-head fences pin the
  // carrier rows with an ON DELETE RESTRICT FK. Fixture teardown removes
  // them as replica-mode surgery on the integration owner connection,
  // exactly like the other legacy-state fixtures in this file.
  await sqlA.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`
      DELETE FROM public.commerce_noncommerce_activation_heads
       WHERE guild_id = ${GUILD_A} OR guild_id = ${GUILD_B}
    `;
    await tx`
      DELETE FROM public.commerce_noncommerce_action_outcomes AS outcome
       USING public.bot_action_queue AS queue
       WHERE outcome.action_id = queue.id
         AND (queue.guild_id = ${GUILD_A} OR queue.guild_id = ${GUILD_B})
    `;
    await tx`
      DELETE FROM public.bot_action_queue
       WHERE guild_id = ${GUILD_A} OR guild_id = ${GUILD_B}
    `;
  });

  const deadLetterDelete = await supa
    .from('action_queue_dlq')
    .delete()
    .in('guild_id', TEST_GUILDS);
  expect(deadLetterDelete.error).toBeNull();

  const tempGrantDelete = await supa
    .from('temp_role_grants')
    .delete()
    .in('guild_id', TEST_GUILDS);
  expect(tempGrantDelete.error).toBeNull();

  const entitlementDelete = await supa
    .from('entitlements')
    .delete()
    .in('guild_id', TEST_GUILDS);
  expect(entitlementDelete.error).toBeNull();

  const licenseKeyDelete = await supa
    .from('license_keys')
    .delete()
    .in('guild_id', TEST_GUILDS);
  expect(licenseKeyDelete.error).toBeNull();

  await sqlA`
    DELETE FROM public.commerce_admin_refund_operations
     WHERE guild_id = ${GUILD_A} OR guild_id = ${GUILD_B}
  `;

  // Production service clients cannot erase the append-only provider ledger.
  // The integration owner connection performs explicit fixture retention
  // cleanup, mirroring an authorized SECURITY DEFINER purge path.
  await sqlA`
    DELETE FROM public.payment_refunds
     WHERE guild_id = ${GUILD_A} OR guild_id = ${GUILD_B}
  `;

  const paymentDelete = await supa
    .from('payments')
    .delete()
    .in('guild_id', TEST_GUILDS);
  expect(paymentDelete.error).toBeNull();

  const orderDelete = await supa
    .from('orders')
    .delete()
    .in('guild_id', TEST_GUILDS);
  expect(orderDelete.error).toBeNull();

  const incomeDelete = await supa
    .from('economy_role_income')
    .delete()
    .in('guild_id', TEST_GUILDS);
  expect(incomeDelete.error).toBeNull();

  const productDelete = await supa
    .from('products')
    .delete()
    .in('guild_id', TEST_GUILDS);
  expect(productDelete.error).toBeNull();

  const customerDelete = await supa
    .from('customers')
    .delete()
    .in('guild_id', TEST_GUILDS);
  expect(customerDelete.error).toBeNull();
}

/**
 * Fabricate a stored capture payment/order status pair in one transaction.
 *
 * The deferred commerce_capture_payment_order_fk deliberately forbids new
 * writes from committing half-applied or legacy pairs (e.g. payment
 * 'completed' under an order that is not 'completed'), so raw sequential
 * single-statement updates can never install them. Tests that need such
 * stored states (legacy rows predating the FK, or corrupt crash artifacts)
 * install them as replica-mode fixture surgery, exactly like the other
 * legacy-state fixtures in this file.
 */
async function setCaptureSuccessorPair(
  orderId: string,
  paypalCaptureId: string,
  paymentStatus: string,
  orderStatus: string,
): Promise<void> {
  await sqlA.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`
      UPDATE public.payments
         SET status = ${paymentStatus}
       WHERE paypal_payment_id = ${paypalCaptureId}
    `;
    await tx`
      UPDATE public.orders
         SET status = ${orderStatus},
             updated_at = pg_catalog.clock_timestamp()
       WHERE id = ${orderId}::UUID
    `;
  });
}

function makeGate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDatabaseLock(
  backendPid: number,
  description: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [activity] = await sqlObserver<{
      state: string | null;
      wait_event_type: string | null;
      wait_event: string | null;
    }[]>`
      SELECT state, wait_event_type, wait_event
      FROM pg_catalog.pg_stat_activity
      WHERE pid = ${backendPid}
    `;
    if (activity?.state === 'active' && activity.wait_event_type === 'Lock') {
      return;
    }
    await delay(10);
  }
  throw new Error(`${description} did not reach a PostgreSQL lock wait within ${timeoutMs}ms`);
}

beforeAll(async () => {
  supa = await requireSupabase();
  sqlA = postgres(getTestDbUrl(), { max: 1 });
  sqlB = postgres(getTestDbUrl(), { max: 1 });
  sqlObserver = postgres(getTestDbUrl(), { max: 1 });
  // The adversarial interleaving tests deliberately hold transactions open
  // while a second session reaches a lock wait. Keep a server-side fuse so an
  // interrupted or timed-out test cannot retain database locks indefinitely.
  await Promise.all([
    sqlA`SET idle_in_transaction_session_timeout = '15s'`,
    sqlB`SET lock_timeout = '10s'`,
    sqlB`SET statement_timeout = '15s'`,
    sqlObserver`SET statement_timeout = '10s'`,
  ]);
  const [backend] = await sqlB<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
  if (!backend?.pid) throw new Error('failed to capture the second database client PID');
  sqlBBackendPid = backend.pid;
  const { error } = await supa.from('guild').insert([
    { id: GUILD_A, name: 'Commerce wall integration A', owner_discord_id: 'owner-a' },
    { id: GUILD_B, name: 'Commerce wall integration B', owner_discord_id: 'owner-b' },
  ]);
  expect(error).toBeNull();
});

beforeEach(async () => {
  await cleanFixtures();
});

afterAll(async () => {
  try {
    if (supa) {
      await cleanFixtures();
      // The retained append-only audit rows FK-reference these guild rows
      // (audit_logs.guild_id -> guild.id, NO ACTION), so the guild rows must
      // also be retained. Guild ids embed RUN_ID, so leftovers are inert.
    }
  } finally {
    // Cleanup assertions may fail after a migration regression. Always close
    // all raw clients so their sessions cannot make the next reset/test wait.
    await Promise.allSettled([
      sqlA?.end({ timeout: 5 }),
      sqlB?.end({ timeout: 5 }),
      sqlObserver?.end({ timeout: 5 }),
    ]);
  }
});

describe('commerce income wall database invariant', () => {
  it('guards product create, activation, deactivation, repricing, role, and type transitions', async () => {
    const incomeRole = nextName('income-role');
    await createIncome(incomeRole);

    const conflictingCreate = await supa.from('products').insert(productRow({
      granted_role_ids: [incomeRole],
    }));
    expectWallConflict(conflictingCreate.error);

    const productId = await createProduct({
      active: false,
      granted_role_ids: [incomeRole],
    });
    const activation = await supa.from('products').update({ active: true }).eq('id', productId);
    expectWallConflict(activation.error);

    const zeroPrice = await supa.from('products').update({ price_cents: 0 }).eq('id', productId);
    expect(zeroPrice.error).toBeNull();
    const zeroPriceActivation = await supa.from('products').update({ active: true }).eq('id', productId);
    expect(zeroPriceActivation.error).toBeNull();
    const reprice = await supa.from('products').update({ price_cents: 1 }).eq('id', productId);
    expectWallConflict(reprice.error);

    const safeRole = nextName('safe-role');
    const roleRemoval = await supa
      .from('products')
      .update({ granted_role_ids: [safeRole] })
      .eq('id', productId);
    expect(roleRemoval.error).toBeNull();
    const safeReprice = await supa.from('products').update({ price_cents: 1_000 }).eq('id', productId);
    expect(safeReprice.error).toBeNull();
    const roleAddition = await supa
      .from('products')
      .update({ granted_role_ids: [incomeRole] })
      .eq('id', productId);
    expectWallConflict(roleAddition.error);

    const typeProduct = await createProduct({
      type: 'subscription',
      granted_role_ids: [incomeRole],
    });
    const opensOneTimePath = await supa
      .from('products')
      .update({ type: 'one_time' })
      .eq('id', typeProduct);
    expectWallConflict(opensOneTimePath.error);

    const reverseRole = nextName('reverse-type-role');
    const reverseTypeProduct = await createProduct({ granted_role_ids: [reverseRole] });
    const closesOneTimePath = await supa
      .from('products')
      .update({ type: 'subscription' })
      .eq('id', reverseTypeProduct);
    expect(closesOneTimePath.error).toBeNull();
    await createIncome(reverseRole);

    const deactivationRole = nextName('deactivation-role');
    const deactivationProduct = await createProduct({ granted_role_ids: [deactivationRole] });
    const incomeWhileActive = await supa.from('economy_role_income').insert({
      guild_id: GUILD_A,
      role_id: deactivationRole,
      amount: 10,
      interval_minutes: 60,
    });
    expectWallConflict(incomeWhileActive.error);
    const deactivate = await supa
      .from('products')
      .update({ active: false })
      .eq('id', deactivationProduct);
    expect(deactivate.error).toBeNull();
    await createIncome(deactivationRole);
  });

  it('guards income insert/update, rejects non-positive amounts, and isolates guilds', async () => {
    const sharedRole = nextName('shared-role');
    await createProduct({ granted_role_ids: [sharedRole] });
    await createIncome(sharedRole, { guild_id: GUILD_B });

    const sameGuildIncome = await supa.from('economy_role_income').insert({
      guild_id: GUILD_A,
      role_id: sharedRole,
      amount: 10,
      interval_minutes: 60,
    });
    expectWallConflict(sameGuildIncome.error);

    const safeRole = nextName('income-update-safe');
    const incomeId = await createIncome(safeRole);
    const unsafeUpdate = await supa
      .from('economy_role_income')
      .update({ role_id: sharedRole })
      .eq('id', incomeId);
    expectWallConflict(unsafeUpdate.error);

    const zeroAmount = await supa.from('economy_role_income').insert({
      guild_id: GUILD_A,
      role_id: nextName('zero-income'),
      amount: 0,
      interval_minutes: 60,
    });
    expect(zeroAmount.error?.code).toBe('23514');
    const negativeAmount = await supa
      .from('economy_role_income')
      .update({ amount: -1 })
      .eq('id', incomeId);
    expect(negativeAmount.error?.code).toBe('23514');

    const otherGuildProduct = await supa.from('products').insert(productRow({
      guild_id: GUILD_B,
      granted_role_ids: [sharedRole],
    }));
    expectWallConflict(otherGuildProduct.error);
  });

  it('selects one active nonblank PayPal plan by price then id, including zero price', async () => {
    const productId = await createProduct({
      type: 'subscription',
      granted_role_ids: [nextName('selector-role')],
    });
    const [lowerId, higherId] = [randomUUID(), randomUUID()].sort();
    const zeroPriceId = randomUUID();

    await createPlan(productId, {
      id: zeroPriceId,
      price_cents: 0,
      paypal_plan_id: 'P-ZERO-CHARGEABLE',
    });
    await createPlan(productId, {
      id: randomUUID(),
      price_cents: 1,
      paypal_plan_id: '   ',
    });
    await createPlan(productId, {
      id: higherId,
      price_cents: 500,
      paypal_plan_id: 'P-HIGH-ID',
    });
    await createPlan(productId, {
      id: lowerId,
      price_cents: 500,
      paypal_plan_id: 'P-LOW-ID',
    });

    expect((await selectedPlan(GUILD_A, productId))?.id).toBe(zeroPriceId);
    expect(await selectedPlan(GUILD_B, productId)).toBeNull();

    const deactivateZero = await supa
      .from('plans')
      .update({ active: false })
      .eq('id', zeroPriceId);
    expect(deactivateZero.error).toBeNull();
    expect((await selectedPlan(GUILD_A, productId))?.id).toBe(lowerId);

    const reprice = await supa.from('plans').update({ price_cents: 600 }).eq('id', lowerId);
    expect(reprice.error).toBeNull();
    expect((await selectedPlan(GUILD_A, productId))?.id).toBe(higherId);

    const deletion = await supa.from('plans').delete().eq('id', higherId);
    expect(deletion.error).toBeNull();
    expect((await selectedPlan(GUILD_A, productId))?.id).toBe(lowerId);

    const privileges = await sqlA`
      SELECT
        pg_catalog.has_function_privilege(
          'service_role',
          'public.commerce_select_checkout_plan(text,uuid)',
          'EXECUTE'
        ) AS service_role_can_execute,
        pg_catalog.has_function_privilege(
          'anon',
          'public.commerce_select_checkout_plan(text,uuid)',
          'EXECUTE'
        ) AS anon_can_execute,
        pg_catalog.has_function_privilege(
          'authenticated',
          'public.commerce_select_checkout_plan(text,uuid)',
          'EXECUTE'
        ) AS authenticated_can_execute
    `;
    expect(privileges[0]?.service_role_can_execute).toBe(true);
    expect(privileges[0]?.anon_can_execute).toBe(false);
    expect(privileges[0]?.authenticated_can_execute).toBe(false);
  });

  it('enforces typed temporary-role identity, duration bounds, and the income wall', async () => {
    const temporaryRole = nextSnowflake();
    const productId = await createProduct();

    const { data: config, error: configError } = await supa
      .from('commerce_product_temp_role_config')
      .insert({
        product_id: productId,
        guild_id: GUILD_A,
        role_id: temporaryRole,
        duration_seconds: 3_600,
      })
      .select('id')
      .single();
    expect(configError).toBeNull();
    expect(config?.id).toMatch(/^[0-9a-f-]{36}$/i);

    const duplicate = await supa.from('commerce_product_temp_role_config').insert({
      product_id: productId,
      guild_id: GUILD_A,
      role_id: temporaryRole,
      duration_seconds: 7_200,
    });
    expect(duplicate.error?.code).toBe('23505');

    const forgedChildMove = await supa
      .from('commerce_product_temp_role_config')
      .update({ guild_id: GUILD_B })
      .eq('id', config!.id);
    expect(forgedChildMove.error).toMatchObject({
      code: '23514',
      message: 'commerce temporary-role config guild follows its product',
    });

    const malformedRole = await supa.from('commerce_product_temp_role_config').insert({
      product_id: productId,
      guild_id: GUILD_A,
      role_id: 'not-a-discord-snowflake',
      duration_seconds: 60,
    });
    expect(malformedRole.error?.code).toBe('23514');

    const excessiveDuration = await supa.from('commerce_product_temp_role_config').insert({
      product_id: productId,
      guild_id: GUILD_A,
      role_id: nextSnowflake(),
      duration_seconds: 315_360_001,
    });
    expect(excessiveDuration.error?.code).toBe('23514');

    const blockedIncome = await supa.from('economy_role_income').insert({
      guild_id: GUILD_A,
      role_id: temporaryRole,
      amount: 25,
      interval_minutes: 60,
    });
    expectWallConflict(blockedIncome.error);

    const removeConfig = await supa
      .from('commerce_product_temp_role_config')
      .delete()
      .eq('id', config!.id);
    expect(removeConfig.error).toBeNull();
    await createIncome(temporaryRole);

    const conflictingRecreate = await supa.from('commerce_product_temp_role_config').insert({
      product_id: productId,
      guild_id: GUILD_A,
      role_id: temporaryRole,
      duration_seconds: 3_600,
    });
    expectWallConflict(conflictingRecreate.error);

    const cascadeRole = nextSnowflake();
    const cascadeProduct = await createProduct();
    const cascadeConfig = await supa.from('commerce_product_temp_role_config').insert({
      product_id: cascadeProduct,
      guild_id: GUILD_A,
      role_id: cascadeRole,
      duration_seconds: 60,
    });
    expect(cascadeConfig.error).toBeNull();
    const deleteCascadeProduct = await supa.from('products').delete().eq('id', cascadeProduct);
    expect(deleteCascadeProduct.error).toBeNull();
    const { count: cascadedConfigCount } = await supa
      .from('commerce_product_temp_role_config')
      .select('*', { count: 'exact', head: true })
      .eq('product_id', cascadeProduct);
    expect(cascadedConfigCount).toBe(0);
  });

  it('freezes immutable order grants and finalizes one capture exactly once', async () => {
    const roleId = nextSnowflake();
    const tempRoleId = nextSnowflake();
    const pendingTempRoleId = nextSnowflake();
    const channelId = nextSnowflake();
    const discordId = nextSnowflake();
    const productId = await createProduct({
      granted_role_ids: [roleId],
      granted_channel_ids: [channelId],
    });
    const { error: configError } = await supa.from('commerce_product_temp_role_config').insert({
      product_id: productId,
      guild_id: GUILD_A,
      role_id: tempRoleId,
      duration_seconds: 3_600,
    });
    expect(configError).toBeNull();
    const { error: pendingConfigError } = await supa
      .from('commerce_product_temp_role_config')
      .insert({
        product_id: productId,
        guild_id: GUILD_A,
        role_id: pendingTempRoleId,
        duration_seconds: 1_800,
      });
    expect(pendingConfigError).toBeNull();

    const { data: customer, error: customerError } = await supa
      .from('customers')
      .insert({
        guild_id: GUILD_A,
        discord_id: discordId,
        discord_username: nextName('snapshot-customer'),
      })
      .select('id')
      .single();
    expect(customerError).toBeNull();

    const paypalOrderId = nextName('paypal-order');
    const { data: order, error: orderError } = await supa
      .from('orders')
      .insert({
        order_number: nextName('snapshot-order'),
        customer_id: customer!.id,
        guild_id: GUILD_A,
        product_id: productId,
        paypal_order_id: paypalOrderId,
        amount_cents: 1_000,
        currency: 'USD',
        source: 'purchase',
        status: 'pending',
      })
      .select('id')
      .single();
    expect(orderError).toBeNull();

    const freezeArgs = {
      p_order_id: order!.id,
      p_guild_id: GUILD_A,
      p_customer_id: customer!.id,
      p_product_id: productId,
    };

    // The checkout read and provider call happen before the order is frozen.
    // A product mutation in that gap must make the compare-and-freeze fail.
    const repriceBeforeFreeze = await supa
      .from('products')
      .update({ price_cents: 1_200 })
      .eq('id', productId);
    expect(repriceBeforeFreeze.error).toBeNull();
    const stalePriceFreeze = await supa.rpc('commerce_freeze_order_grant_snapshot', freezeArgs);
    expect(stalePriceFreeze.error).not.toBeNull();

    const restorePriceAndDeactivate = await supa
      .from('products')
      .update({ price_cents: 1_000, active: false })
      .eq('id', productId);
    expect(restorePriceAndDeactivate.error).toBeNull();
    const inactiveFreeze = await supa.rpc('commerce_freeze_order_grant_snapshot', freezeArgs);
    expect(inactiveFreeze.error).not.toBeNull();

    const restoreBuyableProduct = await supa
      .from('products')
      .update({ active: true })
      .eq('id', productId);
    expect(restoreBuyableProduct.error).toBeNull();

    const frozen = await supa.rpc('commerce_freeze_order_grant_snapshot', freezeArgs);
    expect(frozen.error).toBeNull();
    expect(frozen.data).toMatchObject({
      order_id: order!.id,
      granted_role_ids_snapshot: [roleId],
      granted_channel_ids_snapshot: [channelId],
      temporary_role_grants_snapshot: [
        { role_id: tempRoleId, duration_seconds: 3_600 },
        { role_id: pendingTempRoleId, duration_seconds: 1_800 },
      ],
    });
    expect((frozen.data as Record<string, unknown>).grant_snapshot_frozen_at).toBeTruthy();

    const mutateProduct = await supa
      .from('products')
      .update({
        type: 'subscription',
        granted_role_ids: [],
        granted_channel_ids: [],
      })
      .eq('id', productId);
    expect(mutateProduct.error).toBeNull();
    const mutateTemp = await supa
      .from('commerce_product_temp_role_config')
      .update({ duration_seconds: 7_200 })
      .eq('product_id', productId)
      .eq('role_id', tempRoleId);
    expect(mutateTemp.error).toBeNull();

    const replayedFreeze = await supa.rpc('commerce_freeze_order_grant_snapshot', freezeArgs);
    expect(replayedFreeze.error).toBeNull();
    expect(replayedFreeze.data).toEqual(frozen.data);

    const protectedMutations: Array<[string, Record<string, unknown>]> = [
      ['id', { id: randomUUID() }],
      ['order_number', { order_number: nextName('rewritten-order') }],
      ['guild_id', { guild_id: GUILD_B }],
      ['customer_id', { customer_id: randomUUID() }],
      ['product_id', { product_id: randomUUID() }],
      ['plan_id', { plan_id: randomUUID() }],
      ['paypal_order_id', { paypal_order_id: nextName('rewritten-paypal-order') }],
      [
        'paypal_subscription_id',
        { paypal_subscription_id: nextName('rewritten-paypal-subscription') },
      ],
      ['amount_cents', { amount_cents: 1_001 }],
      ['currency', { currency: 'EUR' }],
      ['discount_cents', { discount_cents: 1 }],
      ['promotion_id', { promotion_id: randomUUID() }],
      ['source', { source: 'manual' }],
      ['created_at', { created_at: '2000-01-01T00:00:00.000Z' }],
      ['granted_role_ids_snapshot', { granted_role_ids_snapshot: [] }],
      ['granted_channel_ids_snapshot', { granted_channel_ids_snapshot: [] }],
      ['temporary_role_grants_snapshot', { temporary_role_grants_snapshot: [] }],
      ['grant_snapshot_frozen_at', { grant_snapshot_frozen_at: '2000-01-01T00:00:00.000Z' }],
    ];

    for (const [field, patch] of protectedMutations) {
      const forbiddenRewrite = await supa.from('orders').update(patch).eq('id', order!.id);
      if (forbiddenRewrite.error?.code !== '23514') {
        throw new Error(
          `expected frozen order field ${field} to reject with 23514, got ${forbiddenRewrite.error?.code ?? 'success'}: ${forbiddenRewrite.error?.message ?? ''}`,
        );
      }
    }

    const frozenOneTimeReprice = await supa
      .from('orders')
      .update({ amount_cents: 1_100, currency: 'EUR' })
      .eq('id', order!.id);
    expect(frozenOneTimeReprice.error?.code).toBe('23514');

    const captureId = nextName('capture');
    const finalizeArgs = {
      p_order_id: order!.id,
      p_guild_id: GUILD_A,
      p_customer_id: customer!.id,
      p_product_id: productId,
      p_paypal_order_id: paypalOrderId,
      p_paypal_capture_id: captureId,
      p_amount_cents: 1_000,
      p_currency: 'USD',
    };
    const finalized = await supa.rpc('commerce_finalize_paypal_capture', finalizeArgs);
    expect(finalized.error).toBeNull();
    expect(finalized.data).toMatchObject({
      order_id: order!.id,
      order_status: 'completed',
      payment_created: true,
    });

    const finalizedReplay = await supa.rpc('commerce_finalize_paypal_capture', finalizeArgs);
    expect(finalizedReplay.error).toBeNull();
    expect(finalizedReplay.data).toMatchObject({
      order_id: order!.id,
      order_status: 'completed',
      payment_created: false,
    });

    const { data: totals, error: totalsError } = await supa
      .from('customers')
      .select('total_spent_cents,total_orders')
      .eq('id', customer!.id)
      .single();
    expect(totalsError).toBeNull();
    expect(totals).toMatchObject({ total_spent_cents: 1_000, total_orders: 1 });

    const { data: entitlement, error: entitlementError } = await supa
      .from('entitlements')
      .insert({
        customer_id: customer!.id,
        guild_id: GUILD_A,
        product_id: productId,
        order_id: order!.id,
        type: 'one_time',
        status: 'active',
        source: 'purchase',
        granted_role_ids: [roleId],
        granted_channel_ids: [channelId],
      })
      .select('id')
      .single();
    expect(entitlementError).toBeNull();

    const prepared = await supa.rpc('commerce_prepare_temp_role_grant', {
      p_guild_id: GUILD_A,
      p_user_id: discordId,
      p_role_id: tempRoleId,
      p_order_id: order!.id,
      p_product_id: productId,
      p_duration_seconds: 3_600,
    });
    expect(prepared.error).toBeNull();
    expect(prepared.data).toMatchObject({ grant_status: 'pending' });

    const preparedReplay = await supa.rpc('commerce_prepare_temp_role_grant', {
      p_guild_id: GUILD_A,
      p_user_id: discordId,
      p_role_id: tempRoleId,
      p_order_id: order!.id,
      p_product_id: productId,
      p_duration_seconds: 3_600,
    });
    expect(preparedReplay.error).toBeNull();
    expect(preparedReplay.data).toMatchObject({
      id: (prepared.data as Record<string, unknown>).id,
      expires_at: (prepared.data as Record<string, unknown>).expires_at,
    });

    const pendingPrepared = await supa.rpc('commerce_prepare_temp_role_grant', {
      p_guild_id: GUILD_A,
      p_user_id: discordId,
      p_role_id: pendingTempRoleId,
      p_order_id: order!.id,
      p_product_id: productId,
      p_duration_seconds: 1_800,
    });
    expect(pendingPrepared.error).toBeNull();
    expect(pendingPrepared.data).toMatchObject({ grant_status: 'pending' });
    const pendingGrantId = String(
      (pendingPrepared.data as Record<string, unknown>).id,
    );

    const pendingOwner = await supa.rpc('commerce_find_live_temp_role_owner', {
      p_guild_id: GUILD_A,
      p_user_id: discordId,
      p_role_id: tempRoleId,
      p_exclude_grant_id: null,
      p_exclude_order_id: null,
    });
    expect(pendingOwner.error).toBeNull();
    expect(pendingOwner.data).toMatchObject({
      id: (prepared.data as Record<string, unknown>).id,
      order_id: order!.id,
      grant_status: 'pending',
    });

    const grantExcludedOwner = await supa.rpc('commerce_find_live_temp_role_owner', {
      p_guild_id: GUILD_A,
      p_user_id: discordId,
      p_role_id: tempRoleId,
      p_exclude_grant_id: (prepared.data as Record<string, unknown>).id,
      p_exclude_order_id: null,
    });
    expect(grantExcludedOwner.error).toBeNull();
    expect(grantExcludedOwner.data).toBeNull();

    const orderExcludedOwner = await supa.rpc('commerce_find_live_temp_role_owner', {
      p_guild_id: GUILD_A,
      p_user_id: discordId,
      p_role_id: tempRoleId,
      p_exclude_grant_id: null,
      p_exclude_order_id: order!.id,
    });
    expect(orderExcludedOwner.error).toBeNull();
    expect(orderExcludedOwner.data).toBeNull();

    const pendingInspection = await supa.rpc('commerce_inspect_temp_role_grant', {
      p_grant_id: (prepared.data as Record<string, unknown>).id,
    });
    expect(pendingInspection.error).toBeNull();
    expect(pendingInspection.data).toMatchObject({
      id: (prepared.data as Record<string, unknown>).id,
      order_id: order!.id,
      duration_seconds: 3_600,
      grant_status: 'pending',
      parent_order_status: 'completed',
      entitlement_is_live: true,
    });

    const missingInspection = await supa.rpc('commerce_inspect_temp_role_grant', {
      p_grant_id: randomUUID(),
    });
    expect(missingInspection.error).toBeNull();
    expect(missingInspection.data).toBeNull();

    const invalidPendingLifecycle = await supa
      .from('temp_role_grants')
      .update({ applied_at: new Date().toISOString() })
      .eq('id', pendingGrantId);
    expect(invalidPendingLifecycle.error?.code).toBe('23514');

    // Raw lifecycle rewrites cannot manufacture a queue delay. The paid
    // duration begins only at the acknowledgement RPC, and replaying that
    // acknowledgement must not extend it.
    const grantId = String((prepared.data as Record<string, unknown>).id);
    const delayed = await supa
      .from('temp_role_grants')
      .update({ expires_at: '2000-01-01T00:00:00.000Z' })
      .eq('id', grantId);
    expect(delayed.error?.code).toBe('23514');

    const acknowledged = await supa.rpc('commerce_acknowledge_temp_role_grant', {
      p_grant_id: grantId,
    });
    expect(acknowledged.error).toBeNull();
    expect(acknowledged.data).toMatchObject({
      id: grantId,
      grant_status: 'applied',
    });
    const appliedAt = Date.parse(
      String((acknowledged.data as Record<string, unknown>).applied_at),
    );
    const expiresAt = Date.parse(
      String((acknowledged.data as Record<string, unknown>).expires_at),
    );
    expect(Number.isFinite(appliedAt)).toBe(true);
    expect(expiresAt - appliedAt).toBe(3_600_000);

    const appliedInspection = await supa.rpc('commerce_inspect_temp_role_grant', {
      p_grant_id: grantId,
    });
    expect(appliedInspection.error).toBeNull();
    expect(appliedInspection.data).toMatchObject({
      id: grantId,
      order_id: order!.id,
      duration_seconds: 3_600,
      grant_status: 'applied',
      applied_at: (acknowledged.data as Record<string, unknown>).applied_at,
      expires_at: (acknowledged.data as Record<string, unknown>).expires_at,
      parent_order_status: 'completed',
      entitlement_is_live: true,
    });

    const invalidAppliedNullTimestamp = await supa
      .from('temp_role_grants')
      .update({ applied_at: null })
      .eq('id', grantId);
    expect(invalidAppliedNullTimestamp.error?.code).toBe('23514');

    const invalidAppliedInterval = await supa
      .from('temp_role_grants')
      .update({ expires_at: '2999-01-01T00:00:00.000Z' })
      .eq('id', grantId);
    expect(invalidAppliedInterval.error?.code).toBe('23514');

    const acknowledgedReplay = await supa.rpc('commerce_acknowledge_temp_role_grant', {
      p_grant_id: grantId,
    });
    expect(acknowledgedReplay.error).toBeNull();
    expect(acknowledgedReplay.data).toEqual(acknowledged.data);

    const expireAppliedGrant = await supa
      .from('temp_role_grants')
      .update({
        applied_at: '1999-12-31T23:00:00.000Z',
        expires_at: '2000-01-01T00:00:00.000Z',
      })
      .eq('id', grantId);
    expect(expireAppliedGrant.error?.code).toBe('23514');
    const ownerAfterRejectedExpiry = await supa.rpc('commerce_find_live_temp_role_owner', {
      p_guild_id: GUILD_A,
      p_user_id: discordId,
      p_role_id: tempRoleId,
      p_exclude_grant_id: null,
      p_exclude_order_id: null,
    });
    expect(ownerAfterRejectedExpiry.error).toBeNull();
    expect(ownerAfterRejectedExpiry.data).toMatchObject({ id: grantId });

    const appliedOwner = await supa.rpc('commerce_find_live_temp_role_owner', {
      p_guild_id: GUILD_A,
      p_user_id: discordId,
      p_role_id: tempRoleId,
      p_exclude_grant_id: null,
      p_exclude_order_id: null,
    });
    expect(appliedOwner.error).toBeNull();
    expect(appliedOwner.data).toMatchObject({
      id: grantId,
      order_id: order!.id,
      grant_status: 'applied',
    });

    const liveEntitlementBlocksTerminalOrder = await supa
      .from('orders')
      .update({ status: 'refunded' })
      .eq('id', order!.id);
    expect(liveEntitlementBlocksTerminalOrder.error?.code).toBe('23503');

    const expirePurchaseEntitlement = await supa
      .from('entitlements')
      .update({ status: 'expired' })
      .eq('id', entitlement!.id);
    expect(expirePurchaseEntitlement.error).toBeNull();

    // With the entitlement expired only the settled capture still pins the
    // order status: the deferred capture FK rejects an order-only rewrite, so
    // the terminal flip must move the payment and order together, exactly as
    // the production refund pipeline does in one transaction.
    const terminalOrderOnly = await supa
      .from('orders')
      .update({ status: 'refunded' })
      .eq('id', order!.id);
    expect(terminalOrderOnly.error?.code).toBe('23503');
    await setCaptureSuccessorPair(String(order!.id), captureId, 'refunded', 'refunded');
    const terminalOrderOwner = await supa.rpc('commerce_find_live_temp_role_owner', {
      p_guild_id: GUILD_A,
      p_user_id: discordId,
      p_role_id: tempRoleId,
      p_exclude_grant_id: null,
      p_exclude_order_id: null,
    });
    expect(terminalOrderOwner.error).toBeNull();
    expect(terminalOrderOwner.data).toBeNull();
    const terminalOrderInspection = await supa.rpc(
      'commerce_inspect_temp_role_grant',
      { p_grant_id: grantId },
    );
    expect(terminalOrderInspection.error).toBeNull();
    expect(terminalOrderInspection.data).toMatchObject({
      id: grantId,
      grant_status: 'applied',
      parent_order_status: 'refunded',
      entitlement_is_live: false,
    });
    await setCaptureSuccessorPair(String(order!.id), captureId, 'completed', 'completed');
    const restoreLiveEntitlement = await supa
      .from('entitlements')
      .update({ status: 'active' })
      .eq('id', entitlement!.id);
    expect(restoreLiveEntitlement.error).toBeNull();

    const liveParentRetirement = await supa.rpc('commerce_retire_temp_role_grant', {
      p_grant_id: grantId,
      p_expected_grant_status: 'applied',
      p_expected_expires_at: (acknowledged.data as Record<string, unknown>).expires_at,
      p_expected_remove_on_expiry: false,
    });
    expect(liveParentRetirement.error).toBeNull();
    expect(liveParentRetirement.data).toMatchObject({
      id: grantId,
      retired: false,
      grant_status: 'applied',
      source: 'commerce_purchase',
    });
    const { data: preservedLiveGrant, error: preservedLiveGrantError } = await supa
      .from('temp_role_grants')
      .select('grant_status, source, remove_on_expiry')
      .eq('id', grantId)
      .single();
    expect(preservedLiveGrantError).toBeNull();
    expect(preservedLiveGrant).toEqual({
      grant_status: 'applied',
      source: 'commerce_purchase',
      remove_on_expiry: false,
    });

    const staleLifecycleRetirement = await supa.rpc('commerce_retire_temp_role_grant', {
      p_grant_id: grantId,
      p_expected_grant_status: 'pending',
      p_expected_expires_at: (acknowledged.data as Record<string, unknown>).expires_at,
      p_expected_remove_on_expiry: false,
    });
    expect(staleLifecycleRetirement.error).not.toBeNull();

    const staleExpiryRetirement = await supa.rpc('commerce_retire_temp_role_grant', {
      p_grant_id: grantId,
      p_expected_grant_status: 'applied',
      p_expected_expires_at: new Date(expiresAt + 1_000).toISOString(),
      p_expected_remove_on_expiry: false,
    });
    expect(staleExpiryRetirement.error).not.toBeNull();

    const staleRemovalIntentRetirement = await supa.rpc(
      'commerce_retire_temp_role_grant',
      {
        p_grant_id: grantId,
        p_expected_grant_status: 'applied',
        p_expected_expires_at: (acknowledged.data as Record<string, unknown>).expires_at,
        p_expected_remove_on_expiry: true,
      },
    );
    expect(staleRemovalIntentRetirement.error).not.toBeNull();

    const preparedAfterAcknowledgement = await supa.rpc('commerce_prepare_temp_role_grant', {
      p_guild_id: GUILD_A,
      p_user_id: discordId,
      p_role_id: tempRoleId,
      p_order_id: order!.id,
      p_product_id: productId,
      p_duration_seconds: 3_600,
    });
    expect(preparedAfterAcknowledgement.error).toBeNull();
    expect(preparedAfterAcknowledgement.data).toMatchObject({
      id: grantId,
      grant_status: 'applied',
      expires_at: (acknowledged.data as Record<string, unknown>).expires_at,
    });

    const corruptReplaySource = await supa
      .from('temp_role_grants')
      .update({ source: 'forged_source' })
      .eq('id', grantId);
    expect(corruptReplaySource.error?.code).toBe('23514');
    const mismatchedSourceReplay = await supa.rpc('commerce_prepare_temp_role_grant', {
      p_guild_id: GUILD_A,
      p_user_id: discordId,
      p_role_id: tempRoleId,
      p_order_id: order!.id,
      p_product_id: productId,
      p_duration_seconds: 3_600,
    });
    expect(mismatchedSourceReplay.error).toBeNull();
    expect(mismatchedSourceReplay.data).toMatchObject({ id: grantId });
    const malformedInspection = await supa.rpc('commerce_inspect_temp_role_grant', {
      p_grant_id: grantId,
    });
    expect(malformedInspection.error).toBeNull();
    expect(malformedInspection.data).toMatchObject({
      id: grantId,
      grant_status: 'applied',
    });

    const corruptFrozenDuration = await supa
      .from('temp_role_grants')
      .update({ duration_seconds: 7_200 })
      .eq('id', grantId);
    expect(corruptFrozenDuration.error?.code).toBe('23514');
    const inspectionAfterRejectedDuration = await supa.rpc(
      'commerce_inspect_temp_role_grant',
      { p_grant_id: grantId },
    );
    expect(inspectionAfterRejectedDuration.error).toBeNull();
    expect(inspectionAfterRejectedDuration.data).toMatchObject({
      id: grantId,
      duration_seconds: 3_600,
      grant_status: 'applied',
    });

    const mutableDurationRejected = await supa.rpc('commerce_prepare_temp_role_grant', {
      p_guild_id: GUILD_A,
      p_user_id: discordId,
      p_role_id: tempRoleId,
      p_order_id: order!.id,
      p_product_id: productId,
      p_duration_seconds: 7_200,
    });
    expect(mutableDurationRejected.error).not.toBeNull();

    const terminalWithoutRemovalIntent = await supa
      .from('entitlements')
      .update({ status: 'cancelled' })
      .eq('id', entitlement!.id);
    expect(terminalWithoutRemovalIntent.error).toBeNull();
    const { data: firstRevokeAction, error: firstRevokeError } = await supa
      .from('bot_action_queue')
      .select('payload')
      .eq('action', 'revoke_roles')
      .eq('guild_id', GUILD_A)
      .contains('payload', { entitlement_id: entitlement!.id })
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    expect(firstRevokeError).toBeNull();
    expect(firstRevokeAction).toBeNull();

    const terminalEntitlementOwner = await supa.rpc(
      'commerce_find_live_temp_role_owner',
      {
        p_guild_id: GUILD_A,
        p_user_id: discordId,
        p_role_id: tempRoleId,
        p_exclude_grant_id: null,
        p_exclude_order_id: null,
      },
    );
    expect(terminalEntitlementOwner.error).toBeNull();
    expect(terminalEntitlementOwner.data).toBeNull();
    const terminalEntitlementInspection = await supa.rpc(
      'commerce_inspect_temp_role_grant',
      { p_grant_id: grantId },
    );
    expect(terminalEntitlementInspection.error).toBeNull();
    expect(terminalEntitlementInspection.data).toMatchObject({
      id: grantId,
      grant_status: 'applied',
      parent_order_status: 'completed',
      entitlement_is_live: false,
    });

    const terminalAck = await supa.rpc('commerce_acknowledge_temp_role_grant', {
      p_grant_id: grantId,
    });
    expect(terminalAck.error).not.toBeNull();
    const terminalPrepare = await supa.rpc('commerce_prepare_temp_role_grant', {
      p_guild_id: GUILD_A,
      p_user_id: discordId,
      p_role_id: tempRoleId,
      p_order_id: order!.id,
      p_product_id: productId,
      p_duration_seconds: 3_600,
    });
    expect(terminalPrepare.error).not.toBeNull();

    const reactivate = await supa
      .from('entitlements')
      .update({ status: 'active' })
      .eq('id', entitlement!.id);
    expect(reactivate.error).toBeNull();
    const removalIntent = await supa
      .from('temp_role_grants')
      .update({ remove_on_expiry: true })
      .in('id', [grantId, pendingGrantId]);
    expect(removalIntent.error?.code).toBe('23514');

    const reactivatedRetirement = await supa.rpc('commerce_retire_temp_role_grant', {
      p_grant_id: grantId,
      p_expected_grant_status: 'applied',
      p_expected_expires_at: (acknowledged.data as Record<string, unknown>).expires_at,
      p_expected_remove_on_expiry: false,
    });
    expect(reactivatedRetirement.error).toBeNull();
    expect(reactivatedRetirement.data).toMatchObject({
      id: grantId,
      retired: false,
      grant_status: 'applied',
      source: 'commerce_purchase',
    });

    const terminalAfterRejectedEscalation = await supa
      .from('entitlements')
      .update({ status: 'cancelled' })
      .eq('id', entitlement!.id);
    expect(terminalAfterRejectedEscalation.error).toBeNull();
    const { data: capturedRevokeAction, error: capturedRevokeError } = await supa
      .from('bot_action_queue')
      .select('payload')
      .eq('action', 'revoke_roles')
      .eq('guild_id', GUILD_A)
      .contains('payload', { entitlement_id: entitlement!.id })
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    expect(capturedRevokeError).toBeNull();
    expect(capturedRevokeAction).toBeNull();

    const retired = await supa.rpc('commerce_retire_temp_role_grant', {
      p_grant_id: grantId,
      p_expected_grant_status: 'applied',
      p_expected_expires_at: (acknowledged.data as Record<string, unknown>).expires_at,
      p_expected_remove_on_expiry: false,
    });
    expect(retired.error).toBeNull();
    expect(retired.data).toMatchObject({
      id: grantId,
      retired: true,
      grant_status: 'removed',
      source: 'commerce_reconciled',
    });
    const retiredReplay = await supa.rpc('commerce_retire_temp_role_grant', {
      p_grant_id: grantId,
      p_expected_grant_status: 'applied',
      p_expected_expires_at: (acknowledged.data as Record<string, unknown>).expires_at,
      p_expected_remove_on_expiry: false,
    });
    expect(retiredReplay.error).toBeNull();
    // A replay against the retained tombstone is state-idempotent but reports
    // itself distinctly: the first retirement transitions the row
    // ('retired'), the replay observes the tombstone ('already_retired').
    expect(retiredReplay.data).toEqual({
      ...(retired.data as Record<string, unknown>),
      disposition: 'already_retired',
    });

    const pendingRetired = await supa.rpc('commerce_retire_temp_role_grant', {
      p_grant_id: pendingGrantId,
      p_expected_grant_status: 'pending',
      p_expected_expires_at: (pendingPrepared.data as Record<string, unknown>).expires_at,
      p_expected_remove_on_expiry: false,
    });
    expect(pendingRetired.error).toBeNull();
    expect(pendingRetired.data).toMatchObject({
      id: pendingGrantId,
      retired: true,
      grant_status: 'removed',
      source: 'commerce_reconciled',
    });

    const removedOwner = await supa.rpc('commerce_find_live_temp_role_owner', {
      p_guild_id: GUILD_A,
      p_user_id: discordId,
      p_role_id: tempRoleId,
      p_exclude_grant_id: null,
      p_exclude_order_id: null,
    });
    expect(removedOwner.error).toBeNull();
    expect(removedOwner.data).toBeNull();
    const removedInspection = await supa.rpc('commerce_inspect_temp_role_grant', {
      p_grant_id: grantId,
    });
    expect(removedInspection.error).toBeNull();
    expect(removedInspection.data).toBeNull();
    const { data: tombstone, error: tombstoneError } = await supa
      .from('temp_role_grants')
      .select('id, grant_status, source, remove_on_expiry')
      .eq('id', grantId)
      .single();
    expect(tombstoneError).toBeNull();
    expect(tombstone).toMatchObject({
      id: grantId,
      grant_status: 'removed',
      source: 'commerce_reconciled',
      remove_on_expiry: false,
    });

    const validSuccessorStates = [
      { payment: 'completed', order: 'refunded' },
      { payment: 'completed', order: 'disputed' },
      { payment: 'refunded', order: 'refunded' },
      { payment: 'reversed', order: 'refunded' },
      { payment: 'reversed', order: 'disputed' },
    ] as const;

    for (const successor of validSuccessorStates) {
      // Some tolerated replay pairs (e.g. completed/refunded) are legacy
      // crash states the deferred capture FK forbids for new writes, so
      // every pair is installed atomically as replica-mode fixture surgery.
      await setCaptureSuccessorPair(
        String(order!.id),
        captureId,
        successor.payment,
        successor.order,
      );

      const successorReplay = await supa.rpc('commerce_finalize_paypal_capture', finalizeArgs);
      expect(successorReplay.error).toBeNull();
      expect(successorReplay.data).toMatchObject({
        order_id: order!.id,
        order_status: successor.order,
        payment_created: false,
      });
    }

    const paymentStates = [
      'completed',
      'refunded',
      'reversed',
      'pending',
      'failed',
      'pending_review',
    ] as const;
    const orderStates = [
      'pending',
      'completed',
      'refunded',
      'disputed',
      'cancelled',
      'pending_review',
    ] as const;
    const validReplayPairs = new Set([
      'completed:completed',
      'completed:refunded',
      'completed:disputed',
      'refunded:refunded',
      'reversed:refunded',
      'reversed:disputed',
    ]);

    for (const paymentStatus of paymentStates) {
      for (const orderStatus of orderStates) {
        const replayPair = `${paymentStatus}:${orderStatus}`;
        if (validReplayPairs.has(replayPair)) continue;

        await setCaptureSuccessorPair(
          String(order!.id),
          captureId,
          paymentStatus,
          orderStatus,
        );

        const inconsistentReplay = await supa.rpc(
          'commerce_finalize_paypal_capture',
          finalizeArgs,
        );
        if (!inconsistentReplay.error?.message.includes('successor state mismatch')) {
          throw new Error(
            `expected capture replay state pair ${replayPair} to be rejected, got ${inconsistentReplay.error?.message ?? 'success'}`,
          );
        }
      }
    }

    await setCaptureSuccessorPair(String(order!.id), captureId, 'completed', 'completed');

    const mismatchedCaptureReplay = await supa.rpc('commerce_finalize_paypal_capture', {
      ...finalizeArgs,
      p_amount_cents: 999,
    });
    expect(mismatchedCaptureReplay.error?.message).toContain('existing capture identity mismatch');

    const { data: replayTotals, error: replayTotalsError } = await supa
      .from('customers')
      .select('total_spent_cents,total_orders')
      .eq('id', customer!.id)
      .single();
    expect(replayTotalsError).toBeNull();
    expect(replayTotals).toMatchObject({ total_spent_cents: 1_000, total_orders: 1 });
  }, 60_000);

  it('rejects noncanonical direct first-freeze updates', async () => {
    const permanentRoleId = nextSnowflake();
    const temporaryRoleId = nextSnowflake();
    const channelId = nextSnowflake();
    const productId = await createProduct({
      granted_role_ids: [permanentRoleId],
      granted_channel_ids: [channelId],
    });
    const { error: configError } = await supa.from('commerce_product_temp_role_config').insert({
      product_id: productId,
      guild_id: GUILD_A,
      role_id: temporaryRoleId,
      duration_seconds: 3_600,
    });
    expect(configError).toBeNull();

    const { data: customer, error: customerError } = await supa
      .from('customers')
      .insert({
        guild_id: GUILD_A,
        discord_id: nextSnowflake(),
        discord_username: nextName('first-freeze-customer'),
      })
      .select('id')
      .single();
    expect(customerError).toBeNull();

    const { data: order, error: orderError } = await supa
      .from('orders')
      .insert({
        order_number: nextName('first-freeze-order'),
        customer_id: customer!.id,
        guild_id: GUILD_A,
        product_id: productId,
        paypal_order_id: nextName('first-freeze-paypal-order'),
        amount_cents: 1_000,
        currency: 'USD',
        source: 'purchase',
        status: 'pending',
      })
      .select('id')
      .single();
    expect(orderError).toBeNull();

    const canonicalFreeze = {
      granted_role_ids_snapshot: [permanentRoleId],
      granted_channel_ids_snapshot: [channelId],
      temporary_role_grants_snapshot: [
        { role_id: temporaryRoleId, duration_seconds: 3_600 },
      ],
      grant_snapshot_frozen_at: new Date().toISOString(),
    };
    const firstFreezeForgeries: Array<[string, Record<string, unknown>]> = [
      [
        'non-finite timestamp',
        { ...canonicalFreeze, grant_snapshot_frozen_at: 'infinity' },
      ],
      ['financial', { ...canonicalFreeze, amount_cents: 999 }],
      [
        'permanent role',
        { ...canonicalFreeze, granted_role_ids_snapshot: [nextSnowflake()] },
      ],
      [
        'channel',
        { ...canonicalFreeze, granted_channel_ids_snapshot: [nextSnowflake()] },
      ],
      [
        'temporary role',
        {
          ...canonicalFreeze,
          temporary_role_grants_snapshot: [
            { role_id: temporaryRoleId, duration_seconds: 7_200 },
          ],
        },
      ],
    ];

    for (const [kind, patch] of firstFreezeForgeries) {
      const rejected = await supa.from('orders').update(patch).eq('id', order!.id);
      if (rejected.error?.code !== '23514') {
        throw new Error(
          `expected ${kind} first-freeze forgery to reject with 23514, got ${rejected.error?.code ?? 'success'}`,
        );
      }
    }

    const { data: unchangedOrder, error: unchangedOrderError } = await supa
      .from('orders')
      .select('amount_cents,grant_snapshot_frozen_at')
      .eq('id', order!.id)
      .single();
    expect(unchangedOrderError).toBeNull();
    expect(unchangedOrder).toMatchObject({
      amount_cents: 1_000,
      grant_snapshot_frozen_at: null,
    });

    const crossGuildProductId = await createProduct({ guild_id: GUILD_B });
    const { data: crossGuildOrder, error: crossGuildOrderError } = await supa
      .from('orders')
      .insert({
        order_number: nextName('cross-guild-first-freeze-order'),
        customer_id: customer!.id,
        guild_id: GUILD_A,
        product_id: crossGuildProductId,
        paypal_order_id: nextName('cross-guild-first-freeze-paypal-order'),
        amount_cents: 1_000,
        currency: 'USD',
        source: 'purchase',
        status: 'pending',
      })
      .select('id')
      .single();
    expect(crossGuildOrderError).toBeNull();

    const crossGuildFreeze = await supa
      .from('orders')
      .update({
        granted_role_ids_snapshot: [],
        granted_channel_ids_snapshot: [],
        temporary_role_grants_snapshot: [],
        grant_snapshot_frozen_at: new Date().toISOString(),
      })
      .eq('id', crossGuildOrder!.id);
    expect(crossGuildFreeze.error?.code).toBe('23514');
  });

  it('finalizes and replays a frozen capture after product catalog movement', async () => {
    const roleId = nextSnowflake();
    const discordId = nextSnowflake();
    const productId = await createProduct();
    const tempConfig = await supa.from('commerce_product_temp_role_config').insert({
      product_id: productId,
      guild_id: GUILD_A,
      role_id: roleId,
      duration_seconds: 60,
    });
    expect(tempConfig.error).toBeNull();
    const { data: customer, error: customerError } = await supa
      .from('customers')
      .insert({
        guild_id: GUILD_A,
        discord_id: discordId,
        discord_username: nextName('moved-product-customer'),
      })
      .select('id')
      .single();
    expect(customerError).toBeNull();

    const paypalOrderId = nextName('moved-product-paypal-order');
    const { data: order, error: orderError } = await supa
      .from('orders')
      .insert({
        order_number: nextName('moved-product-order'),
        customer_id: customer!.id,
        guild_id: GUILD_A,
        product_id: productId,
        paypal_order_id: paypalOrderId,
        amount_cents: 1_000,
        currency: 'USD',
        source: 'purchase',
        status: 'pending',
      })
      .select('id')
      .single();
    expect(orderError).toBeNull();

    const frozen = await supa.rpc('commerce_freeze_order_grant_snapshot', {
      p_order_id: order!.id,
      p_guild_id: GUILD_A,
      p_customer_id: customer!.id,
      p_product_id: productId,
    });
    expect(frozen.error).toBeNull();

    const destinationIncomeId = await createIncome(roleId, { guild_id: GUILD_B });
    const blockedMove = await supa
      .from('products')
      .update({ guild_id: GUILD_B })
      .eq('id', productId);
    expectWallConflict(blockedMove.error);

    const { data: blockedProduct, error: blockedProductError } = await supa
      .from('products')
      .select('id,guild_id')
      .eq('id', productId)
      .single();
    expect(blockedProductError).toBeNull();
    expect(blockedProduct).toMatchObject({ id: productId, guild_id: GUILD_A });
    const { data: blockedConfig, error: blockedConfigError } = await supa
      .from('commerce_product_temp_role_config')
      .select('product_id,guild_id,role_id')
      .eq('product_id', productId)
      .single();
    expect(blockedConfigError).toBeNull();
    expect(blockedConfig).toMatchObject({
      product_id: productId,
      guild_id: GUILD_A,
      role_id: roleId,
    });

    const removeDestinationIncome = await supa
      .from('economy_role_income')
      .delete()
      .eq('id', destinationIncomeId);
    expect(removeDestinationIncome.error).toBeNull();

    const { data: movedProduct, error: moveError } = await supa
      .from('products')
      .update({ guild_id: GUILD_B })
      .eq('id', productId)
      .select('id,guild_id')
      .single();
    expect(moveError).toBeNull();
    expect(movedProduct).toMatchObject({ id: productId, guild_id: GUILD_B });
    const { data: movedConfig, error: movedConfigError } = await supa
      .from('commerce_product_temp_role_config')
      .select('product_id,guild_id,role_id')
      .eq('product_id', productId)
      .single();
    expect(movedConfigError).toBeNull();
    expect(movedConfig).toMatchObject({
      product_id: productId,
      guild_id: GUILD_B,
      role_id: roleId,
    });

    const captureId = nextName('moved-product-capture');
    const finalizeArgs = {
      p_order_id: order!.id,
      p_guild_id: GUILD_A,
      p_customer_id: customer!.id,
      p_product_id: productId,
      p_paypal_order_id: paypalOrderId,
      p_paypal_capture_id: captureId,
      p_amount_cents: 1_000,
      p_currency: 'USD',
    };
    const finalized = await supa.rpc('commerce_finalize_paypal_capture', finalizeArgs);
    expect(finalized.error).toBeNull();
    expect(finalized.data).toMatchObject({
      order_id: order!.id,
      order_status: 'completed',
      payment_created: true,
    });

    const replayed = await supa.rpc('commerce_finalize_paypal_capture', finalizeArgs);
    expect(replayed.error).toBeNull();
    expect(replayed.data).toMatchObject({
      order_id: order!.id,
      order_status: 'completed',
      payment_created: false,
    });

    const { data: totals, error: totalsError } = await supa
      .from('customers')
      .select('total_spent_cents,total_orders')
      .eq('id', customer!.id)
      .single();
    expect(totalsError).toBeNull();
    expect(totals).toMatchObject({ total_spent_cents: 1_000, total_orders: 1 });

    const { data: entitlement, error: entitlementError } = await supa
      .from('entitlements')
      .insert({
        customer_id: customer!.id,
        guild_id: GUILD_A,
        product_id: productId,
        order_id: order!.id,
        type: 'one_time',
        status: 'active',
        source: 'purchase',
        granted_role_ids: [],
        granted_channel_ids: [],
      })
      .select('id')
      .single();
    expect(entitlementError).toBeNull();

    const preparedAfterMove = await supa.rpc('commerce_prepare_temp_role_grant', {
      p_guild_id: GUILD_A,
      p_user_id: discordId,
      p_role_id: roleId,
      p_order_id: order!.id,
      p_product_id: productId,
      p_duration_seconds: 60,
    });
    expect(preparedAfterMove.error).toBeNull();
    const movedGrantId = String((preparedAfterMove.data as Record<string, unknown>).id);
    const intentAfterMove = await supa
      .from('temp_role_grants')
      .update({ remove_on_expiry: true })
      .eq('id', movedGrantId);
    expect(intentAfterMove.error?.code).toBe('23514');
    const terminalAfterMove = await supa
      .from('entitlements')
      .update({ status: 'cancelled' })
      .eq('id', entitlement!.id);
    expect(terminalAfterMove.error).toBeNull();
    const { data: movedRevoke, error: movedRevokeError } = await supa
      .from('bot_action_queue')
      .select('payload')
      .eq('action', 'revoke_roles')
      .eq('guild_id', GUILD_A)
      .contains('payload', { entitlement_id: entitlement!.id })
      .maybeSingle();
    expect(movedRevokeError).toBeNull();
    expect(movedRevoke).toBeNull();
  });

  it('replays only exact legacy capture proof with lowercase stored currencies', async () => {
    const productId = await createProduct();
    const { data: customer, error: customerError } = await supa
      .from('customers')
      .insert({
        guild_id: GUILD_A,
        discord_id: nextSnowflake(),
        discord_username: nextName('legacy-capture-customer'),
        total_spent_cents: 1_000,
        total_orders: 1,
      })
      .select('id')
      .single();
    expect(customerError).toBeNull();

    const paypalOrderId = nextName('legacy-paypal-order');
    const captureId = nextName('legacy-capture');
    const { data: order, error: orderError } = await supa
      .from('orders')
      .insert({
        order_number: nextName('legacy-order'),
        customer_id: customer!.id,
        guild_id: GUILD_A,
        product_id: productId,
        paypal_order_id: paypalOrderId,
        amount_cents: 1_000,
        currency: 'usd',
        source: 'purchase',
        status: 'completed',
      })
      .select('id,grant_snapshot_frozen_at')
      .single();
    expect(orderError).toBeNull();
    expect(order?.grant_snapshot_frozen_at).toBeNull();

    const { data: payment, error: paymentError } = await supa
      .from('payments')
      .insert({
        order_id: order!.id,
        customer_id: customer!.id,
        guild_id: GUILD_A,
        paypal_payment_id: captureId,
        paypal_resource_type: 'capture',
        amount_cents: 1_000,
        currency: 'usd',
        status: 'completed',
        provider: 'paypal',
      })
      .select('id')
      .single();
    expect(paymentError).toBeNull();

    const finalizeArgs = {
      p_order_id: order!.id,
      p_guild_id: GUILD_A,
      p_customer_id: customer!.id,
      p_product_id: productId,
      p_paypal_order_id: paypalOrderId,
      p_paypal_capture_id: captureId,
      p_amount_cents: 1_000,
      p_currency: 'USD',
    };
    const exactReplay = await supa.rpc('commerce_finalize_paypal_capture', finalizeArgs);
    expect(exactReplay.error).toBeNull();
    expect(exactReplay.data).toMatchObject({
      order_id: order!.id,
      order_status: 'completed',
      payment_id: payment!.id,
      payment_created: false,
    });

    const { data: replayedOrder, error: replayedOrderError } = await supa
      .from('orders')
      .select('status,grant_snapshot_frozen_at')
      .eq('id', order!.id)
      .single();
    expect(replayedOrderError).toBeNull();
    expect(replayedOrder).toMatchObject({
      status: 'completed',
      grant_snapshot_frozen_at: null,
    });

    const amountForgery = await supa.rpc('commerce_finalize_paypal_capture', {
      ...finalizeArgs,
      p_amount_cents: 999,
    });
    expect(amountForgery.error?.message).toContain('existing capture identity mismatch');

    const currencyForgery = await supa.rpc('commerce_finalize_paypal_capture', {
      ...finalizeArgs,
      p_currency: 'EUR',
    });
    expect(currencyForgery.error?.message).toContain('existing capture identity mismatch');

    const malformedPaymentCurrency = await supa
      .from('payments')
      .update({ currency: ' usd' })
      .eq('id', payment!.id);
    expect(malformedPaymentCurrency.error).toBeNull();
    const malformedPaymentReplay = await supa.rpc(
      'commerce_finalize_paypal_capture',
      finalizeArgs,
    );
    expect(malformedPaymentReplay.error?.message).toContain(
      'existing capture identity mismatch',
    );
    const restorePaymentCurrency = await supa
      .from('payments')
      .update({ currency: 'usd' })
      .eq('id', payment!.id);
    expect(restorePaymentCurrency.error).toBeNull();

    const malformedOrderCurrency = await supa
      .from('orders')
      .update({ currency: 'usd ' })
      .eq('id', order!.id);
    expect(malformedOrderCurrency.error).toBeNull();
    const malformedOrderReplay = await supa.rpc(
      'commerce_finalize_paypal_capture',
      finalizeArgs,
    );
    expect(malformedOrderReplay.error?.message).toContain('successor state mismatch');
    const restoreOrderCurrency = await supa
      .from('orders')
      .update({ currency: 'usd' })
      .eq('id', order!.id);
    expect(restoreOrderCurrency.error).toBeNull();

    const forgedCaptureId = nextName('forged-legacy-capture');
    const unknownCapture = await supa.rpc('commerce_finalize_paypal_capture', {
      ...finalizeArgs,
      p_paypal_capture_id: forgedCaptureId,
    });
    expect(unknownCapture.error?.message).toContain('grant snapshot is not frozen');

    const { data: absentForgery, error: absentForgeryError } = await supa
      .from('payments')
      .select('id')
      .eq('paypal_payment_id', forgedCaptureId)
      .maybeSingle();
    expect(absentForgeryError).toBeNull();
    expect(absentForgery).toBeNull();

    const { data: totals, error: totalsError } = await supa
      .from('customers')
      .select('total_spent_cents,total_orders')
      .eq('id', customer!.id)
      .single();
    expect(totalsError).toBeNull();
    expect(totals).toMatchObject({ total_spent_cents: 1_000, total_orders: 1 });
  });

  it('accepts only exact pending-review capture replay without changing totals', async () => {
    const discordId = nextSnowflake();
    const productId = await createProduct();
    const { data: customer, error: customerError } = await supa
      .from('customers')
      .insert({
        guild_id: GUILD_A,
        discord_id: discordId,
        discord_username: nextName('pending-review-customer'),
      })
      .select('id')
      .single();
    expect(customerError).toBeNull();

    const paypalOrderId = nextName('pending-review-paypal-order');
    const { data: order, error: orderError } = await supa
      .from('orders')
      .insert({
        order_number: nextName('pending-review-order'),
        customer_id: customer!.id,
        guild_id: GUILD_A,
        product_id: productId,
        paypal_order_id: paypalOrderId,
        amount_cents: 1_000,
        currency: 'USD',
        source: 'purchase',
        status: 'pending',
      })
      .select('id')
      .single();
    expect(orderError).toBeNull();

    const captureId = nextName('pending-review-capture');
    const finalizeArgs = {
      p_order_id: order!.id,
      p_guild_id: GUILD_A,
      p_customer_id: customer!.id,
      p_product_id: productId,
      p_paypal_order_id: paypalOrderId,
      p_paypal_capture_id: captureId,
      p_amount_cents: 900,
      p_currency: 'USD',
    };
    const unfrozenFinalization = await supa.rpc(
      'commerce_finalize_paypal_capture',
      finalizeArgs,
    );
    expect(unfrozenFinalization.error?.message).toContain('grant snapshot is not frozen');
    const { data: absentPayment, error: absentPaymentError } = await supa
      .from('payments')
      .select('id')
      .eq('paypal_payment_id', captureId)
      .maybeSingle();
    expect(absentPaymentError).toBeNull();
    expect(absentPayment).toBeNull();

    const frozen = await supa.rpc('commerce_freeze_order_grant_snapshot', {
      p_order_id: order!.id,
      p_guild_id: GUILD_A,
      p_customer_id: customer!.id,
      p_product_id: productId,
    });
    expect(frozen.error).toBeNull();

    const finalized = await supa.rpc('commerce_finalize_paypal_capture', finalizeArgs);
    expect(finalized.error).toBeNull();
    expect(finalized.data).toMatchObject({
      order_id: order!.id,
      order_status: 'pending_review',
      payment_created: true,
    });

    const exactReplay = await supa.rpc('commerce_finalize_paypal_capture', finalizeArgs);
    expect(exactReplay.error).toBeNull();
    expect(exactReplay.data).toMatchObject({
      order_id: order!.id,
      order_status: 'pending_review',
      payment_created: false,
    });

    const pendingReviewContractRewrite = await supa
      .from('orders')
      .update({ paypal_order_id: nextName('rewritten-pending-review-order') })
      .eq('id', order!.id);
    expect(pendingReviewContractRewrite.error?.code).toBe('23514');

    const unsupportedOrderResolution = await supa
      .from('orders')
      .update({ status: 'completed', updated_at: new Date().toISOString() })
      .eq('id', order!.id);
    expect(unsupportedOrderResolution.error).toBeNull();
    const resolvedOrderReplay = await supa.rpc('commerce_finalize_paypal_capture', finalizeArgs);
    expect(resolvedOrderReplay.error?.message).toContain('successor state mismatch');

    const restorePendingReviewOrder = await supa
      .from('orders')
      .update({ status: 'pending_review', updated_at: new Date().toISOString() })
      .eq('id', order!.id);
    expect(restorePendingReviewOrder.error).toBeNull();
    // A payment-only manual completion is structurally impossible: the
    // deferred capture FK requires the parent order to be 'completed' in the
    // same transaction. Assert the guard, then install the nearest reachable
    // unsupported resolution (payment and order completed together) and show
    // the capture replay still refuses to bless it.
    const paymentOnlyResolution = await supa
      .from('payments')
      .update({ status: 'completed' })
      .eq('paypal_payment_id', captureId);
    expect(paymentOnlyResolution.error?.code).toBe('23503');
    await sqlA.begin(async (tx) => {
      await tx`
        UPDATE public.payments
           SET status = 'completed'
         WHERE paypal_payment_id = ${captureId}
      `;
      await tx`
        UPDATE public.orders
           SET status = 'completed',
               updated_at = pg_catalog.clock_timestamp()
         WHERE id = ${order!.id}::UUID
      `;
    });
    const resolvedPaymentReplay = await supa.rpc('commerce_finalize_paypal_capture', finalizeArgs);
    expect(resolvedPaymentReplay.error?.message).toContain('successor state mismatch');

    const { data: totals, error: totalsError } = await supa
      .from('customers')
      .select('total_spent_cents,total_orders')
      .eq('id', customer!.id)
      .single();
    expect(totalsError).toBeNull();
    expect(totals).toMatchObject({ total_spent_cents: 0, total_orders: 0 });
  });

  it('freezes only the authoritative current subscription plan contract', async () => {
    const roleId = nextSnowflake();
    const discordId = nextSnowflake();
    const productId = await createProduct({
      type: 'subscription',
      price_cents: 0,
      granted_role_ids: [roleId],
    });
    const selectedPlanId = await createPlan(productId, {
      // A zero local placeholder is valid until PayPal supplies the
      // authoritative activation amount below.
      price_cents: 0,
      currency: 'USD',
    });
    const nonSelectedPlanId = await createPlan(productId, {
      price_cents: 700,
      currency: 'EUR',
    });
    const { data: customer, error: customerError } = await supa
      .from('customers')
      .insert({
        guild_id: GUILD_A,
        discord_id: discordId,
        discord_username: nextName('subscription-snapshot-customer'),
      })
      .select('id')
      .single();
    expect(customerError).toBeNull();

    const { data: order, error: orderError } = await supa
      .from('orders')
      .insert({
        order_number: nextName('subscription-snapshot-order'),
        customer_id: customer!.id,
        guild_id: GUILD_A,
        product_id: productId,
        plan_id: nonSelectedPlanId,
        paypal_subscription_id: '   ',
        amount_cents: 700,
        currency: 'EUR',
        source: 'purchase',
        status: 'pending',
      })
      .select('id')
      .single();
    expect(orderError).toBeNull();

    const freezeArgs = {
      p_order_id: order!.id,
      p_guild_id: GUILD_A,
      p_customer_id: customer!.id,
      p_product_id: productId,
    };
    const blankProviderIdentity = await supa.rpc(
      'commerce_freeze_order_grant_snapshot',
      freezeArgs,
    );
    expect(blankProviderIdentity.error).not.toBeNull();

    const nonSelectedContract = await supa
      .from('orders')
      .update({ paypal_subscription_id: nextName('paypal-subscription') })
      .eq('id', order!.id);
    expect(nonSelectedContract.error).toBeNull();
    const wrongPlanFreeze = await supa.rpc('commerce_freeze_order_grant_snapshot', freezeArgs);
    expect(wrongPlanFreeze.error).not.toBeNull();

    const selectCurrentContract = await supa
      .from('orders')
      .update({
        plan_id: selectedPlanId,
        amount_cents: 0,
        currency: 'USD',
      })
      .eq('id', order!.id);
    expect(selectCurrentContract.error).toBeNull();
    const frozen = await supa.rpc('commerce_freeze_order_grant_snapshot', freezeArgs);
    expect(frozen.error).toBeNull();
    expect(frozen.data).toMatchObject({
      order_id: order!.id,
      granted_role_ids_snapshot: [roleId],
      temporary_role_grants_snapshot: [],
    });

    const providerReprice = await supa
      .from('orders')
      .update({ amount_cents: 650, currency: 'CAD' })
      .eq('id', order!.id);
    expect(providerReprice.error).toBeNull();

    const { data: repricedOrder, error: repricedOrderError } = await supa
      .from('orders')
      .select('status,amount_cents,currency')
      .eq('id', order!.id)
      .single();
    expect(repricedOrderError).toBeNull();
    expect(repricedOrder).toMatchObject({
      status: 'pending',
      amount_cents: 650,
      currency: 'CAD',
    });

    const malformedProviderReprice = await supa
      .from('orders')
      .update({ amount_cents: -1, currency: 'usd' })
      .eq('id', order!.id);
    expect(malformedProviderReprice.error?.code).toBe('23514');

    const identityChangeWithReprice = await supa
      .from('orders')
      .update({ customer_id: randomUUID(), amount_cents: 675 })
      .eq('id', order!.id);
    expect(identityChangeWithReprice.error?.code).toBe('23514');

    const completeSubscription = await supa
      .from('orders')
      .update({ status: 'completed', updated_at: new Date().toISOString() })
      .eq('id', order!.id);
    expect(completeSubscription.error).toBeNull();
    const completedSubscriptionReprice = await supa
      .from('orders')
      .update({ amount_cents: 700, currency: 'EUR' })
      .eq('id', order!.id);
    expect(completedSubscriptionReprice.error?.code).toBe('23514');

    // Replay is an immutable-order read, not a second authorization against
    // mutable plan/product configuration.
    const mutateAfterFreeze = await supa
      .from('products')
      .update({ active: false, granted_role_ids: [] })
      .eq('id', productId);
    expect(mutateAfterFreeze.error).toBeNull();
    const replay = await supa.rpc('commerce_freeze_order_grant_snapshot', freezeArgs);
    expect(replay.error).toBeNull();
    expect(replay.data).toEqual(frozen.data);
  });

  it('keeps staged outbox rows non-dispatchable and idempotent', async () => {
    const idempotencyKey = `paypal:capture:${nextName('capture-key')}:fulfill_purchase`;
    const { data: staged, error: stagedError } = await supa
      .from('bot_action_queue')
      .insert({
        guild_id: GUILD_A,
        action: 'fulfill_purchase',
        payload: { fixture: true },
        status: 'staged',
        idempotency_key: idempotencyKey,
      })
      .select('id,status')
      .single();
    expect(stagedError).toBeNull();
    expect(staged?.status).toBe('staged');

    const duplicate = await supa.from('bot_action_queue').insert({
      guild_id: GUILD_A,
      action: 'fulfill_purchase',
      payload: { fixture: 'duplicate' },
      status: 'staged',
      idempotency_key: idempotencyKey,
    });
    expect(duplicate.error?.code).toBe('23505');

    const stagedClaim = await supa.rpc('bot_action_queue_claim', {
      p_action_id: staged!.id,
      p_protocol_version: 2,
    });
    expect(stagedClaim.error).toBeNull();
    expect(stagedClaim.data).toEqual([]);

    const release = await supa.rpc('bot_action_queue_release_staged', {
      p_action_id: staged!.id,
      p_guild_id: GUILD_A,
      p_idempotency_key: idempotencyKey,
    });
    expect(release.error).toBeNull();
    const pendingClaim = await supa.rpc('bot_action_queue_claim', {
      p_action_id: staged!.id,
      p_protocol_version: 2,
    });
    expect(pendingClaim.error).toBeNull();
    expect(pendingClaim.data).toHaveLength(1);
    expect(pendingClaim.data?.[0]?.status).toBe('processing');
  });

  it('persists and replays only an exact staged legacy subscription contract', async () => {
    const roleId = nextSnowflake();
    const channelId = nextSnowflake();
    const discordId = nextSnowflake();
    const productName = nextName('legacy-contract-product');
    const { data: product, error: productError } = await supa
      .from('products')
      .insert(productRow({
        name: productName,
        type: 'subscription',
        price_cents: 0,
        granted_role_ids: [roleId],
        granted_channel_ids: [channelId],
      }))
      .select('id')
      .single();
    expect(productError).toBeNull();

    const paypalPlanId = `P-${nextName('legacy-contract-plan')}`;
    const { data: plan, error: planError } = await supa
      .from('plans')
      .insert(planRow(product!.id, {
        paypal_plan_id: paypalPlanId,
        price_cents: 500,
        currency: 'USD',
      }))
      .select('id')
      .single();
    expect(planError).toBeNull();

    const { data: customer, error: customerError } = await supa
      .from('customers')
      .insert({
        guild_id: GUILD_A,
        discord_id: discordId,
        discord_username: nextName('legacy-contract-customer'),
      })
      .select('id')
      .single();
    expect(customerError).toBeNull();

    const orderNumber = nextName('legacy-contract-order');
    const subscriptionId = nextName('legacy-contract-subscription');
    const { data: order, error: orderError } = await supa
      .from('orders')
      .insert({
        order_number: orderNumber,
        customer_id: customer!.id,
        guild_id: GUILD_A,
        product_id: product!.id,
        plan_id: plan!.id,
        paypal_subscription_id: subscriptionId,
        amount_cents: 500,
        currency: 'USD',
        source: 'purchase',
        status: 'pending',
      })
      .select('id')
      .single();
    expect(orderError).toBeNull();
    const completed = await supa
      .from('orders')
      .update({ status: 'completed' })
      .eq('id', order!.id);
    expect(completed.error).toBeNull();

    const payload = {
      fulfillment_type: 'subscription_activated',
      entitlement_type: 'subscription',
      guild_id: GUILD_A,
      customer_id: customer!.id,
      discord_id: discordId,
      product_id: product!.id,
      product_name: productName,
      order_id: order!.id,
      order_number: orderNumber,
      plan_id: plan!.id,
      paypal_subscription_id: subscriptionId,
      paypal_plan_id: paypalPlanId,
      amount_cents: 500,
      currency: 'USD',
      granted_role_ids: [roleId],
      granted_channel_ids: [channelId],
    };
    const queueKey = `paypal:subscription:${subscriptionId}:fulfill_subscription`;
    const { data: queue, error: queueError } = await supa
      .from('bot_action_queue')
      .insert({
        guild_id: GUILD_A,
        action: 'fulfill_subscription',
        payload,
        status: 'staged',
        idempotency_key: queueKey,
      })
      .select('id,status')
      .single();
    expect(queueError).toBeNull();

    const adoptArgs = {
      p_order_id: order!.id,
      p_source_queue_id: queue!.id,
    };
    const adopted = await supa.rpc(
      'commerce_adopt_legacy_subscription_grant_contract',
      adoptArgs,
    );
    expect(adopted.error).toBeNull();
    expect(adopted.data).toMatchObject({
      order_id: order!.id,
      source_queue_id: queue!.id,
      granted_role_ids_snapshot: [roleId],
      granted_channel_ids_snapshot: [channelId],
    });

    const { data: contract, error: contractError } = await supa
      .from('commerce_legacy_subscription_grant_contracts')
      .select('*')
      .eq('order_id', order!.id)
      .single();
    expect(contractError).toBeNull();
    expect(contract).toMatchObject({
      source_queue_id: queue!.id,
      guild_id: GUILD_A,
      customer_id: customer!.id,
      discord_id: discordId,
      product_id: product!.id,
      product_name: productName,
      order_number: orderNumber,
      plan_id: plan!.id,
      paypal_subscription_id: subscriptionId,
      paypal_plan_id: paypalPlanId,
      amount_cents: 500,
      currency: 'USD',
      granted_role_ids_snapshot: [roleId],
      granted_channel_ids_snapshot: [channelId],
    });

    const release = await supa.rpc('bot_action_queue_release_staged', {
      p_action_id: queue!.id,
      p_guild_id: GUILD_A,
      p_idempotency_key: queueKey,
    });
    expect(release.error).toBeNull();
    const replay = await supa.rpc(
      'commerce_adopt_legacy_subscription_grant_contract',
      adoptArgs,
    );
    expect(replay.error).toBeNull();
    expect(replay.data).toEqual(adopted.data);

    const wrongQueue = await supa.rpc(
      'commerce_adopt_legacy_subscription_grant_contract',
      { ...adoptArgs, p_source_queue_id: randomUUID() },
    );
    expect(wrongQueue.error).not.toBeNull();

    const tamperedQueue = await supa
      .from('bot_action_queue')
      .update({ payload: { ...payload, granted_role_ids: [nextSnowflake()] } })
      .eq('id', queue!.id);
    expect(tamperedQueue.error).toMatchObject({
      code: '23514',
      message: 'bot action queue durable identity and payload are immutable',
    });
    const tamperedReplay = await supa.rpc(
      'commerce_adopt_legacy_subscription_grant_contract',
      adoptArgs,
    );
    expect(tamperedReplay.error).toBeNull();
    expect(tamperedReplay.data).toEqual(adopted.data);

    const changedOrder = await supa
      .from('orders')
      .update({ amount_cents: 501 })
      .eq('id', order!.id);
    expect(changedOrder.error).toBeNull();
    const changedQueue = await supa
      .from('bot_action_queue')
      .update({ payload: { ...payload, amount_cents: 501 } })
      .eq('id', queue!.id);
    expect(changedQueue.error).toMatchObject({
      code: '23514',
      message: 'bot action queue durable identity and payload are immutable',
    });
    const changedOrderReplay = await supa.rpc(
      'commerce_adopt_legacy_subscription_grant_contract',
      adoptArgs,
    );
    expect(changedOrderReplay.error).not.toBeNull();

    // Queue retention is intentionally independent of the immutable contract.
    const queueDelete = await supa.from('bot_action_queue').delete().eq('id', queue!.id);
    expect(queueDelete.error).toBeNull();
    const retainedContract = await supa
      .from('commerce_legacy_subscription_grant_contracts')
      .select('order_id')
      .eq('order_id', order!.id)
      .single();
    expect(retainedContract.error).toBeNull();

    // Order/member retention remains authoritative and can cascade the
    // compatibility row without an immutability trigger or queue foreign key.
    const orderDelete = await supa.from('orders').delete().eq('id', order!.id);
    expect(orderDelete.error).toBeNull();
    const { data: purgedContract, error: purgedContractError } = await supa
      .from('commerce_legacy_subscription_grant_contracts')
      .select('order_id')
      .eq('order_id', order!.id)
      .maybeSingle();
    expect(purgedContractError).toBeNull();
    expect(purgedContract).toBeNull();
  });

  it('rolls capture payment and order state back when customer totals fail', async () => {
    const productId = await createProduct({ price_cents: 1 });
    const { data: customer, error: customerError } = await supa
      .from('customers')
      .insert({
        guild_id: GUILD_A,
        discord_id: nextSnowflake(),
        discord_username: nextName('overflow-customer'),
        total_spent_cents: 2_147_483_647,
      })
      .select('id')
      .single();
    expect(customerError).toBeNull();
    const paypalOrderId = nextName('overflow-paypal-order');
    const { data: order, error: orderError } = await supa
      .from('orders')
      .insert({
        order_number: nextName('overflow-order'),
        customer_id: customer!.id,
        guild_id: GUILD_A,
        product_id: productId,
        paypal_order_id: paypalOrderId,
        amount_cents: 1,
        currency: 'USD',
        source: 'purchase',
        status: 'pending',
      })
      .select('id')
      .single();
    expect(orderError).toBeNull();
    const freeze = await supa.rpc('commerce_freeze_order_grant_snapshot', {
      p_order_id: order!.id,
      p_guild_id: GUILD_A,
      p_customer_id: customer!.id,
      p_product_id: productId,
    });
    expect(freeze.error).toBeNull();

    const captureId = nextName('overflow-capture');
    const failed = await supa.rpc('commerce_finalize_paypal_capture', {
      p_order_id: order!.id,
      p_guild_id: GUILD_A,
      p_customer_id: customer!.id,
      p_product_id: productId,
      p_paypal_order_id: paypalOrderId,
      p_paypal_capture_id: captureId,
      p_amount_cents: 1,
      p_currency: 'USD',
    });
    expect(failed.error).not.toBeNull();

    const { data: rolledBackOrder } = await supa
      .from('orders')
      .select('status')
      .eq('id', order!.id)
      .single();
    expect(rolledBackOrder?.status).toBe('pending');
    const { count: rolledBackPayments } = await supa
      .from('payments')
      .select('*', { count: 'exact', head: true })
      .eq('paypal_payment_id', captureId);
    expect(rolledBackPayments).toBe(0);
  });

  it('persists provider outcome before atomically finalizing and exactly replaying an admin refund', async () => {
    const fixture = await createPaidRefundFixture({
      priorRefundCents: 250,
      withAccess: true,
    });
    const actorA = nextSnowflake();
    const actorB = nextSnowflake();

    const wrongGuild = await supa.rpc('commerce_prepare_admin_refund', {
      p_order_id: fixture.orderId,
      p_guild_id: GUILD_B,
      p_actor_id: actorA,
      p_reason: 'wrong guild',
    });
    expect(wrongGuild.error).toMatchObject({ code: '23514' });

    const prepared = await supa.rpc('commerce_prepare_admin_refund', {
      p_order_id: fixture.orderId,
      p_guild_id: GUILD_A,
      p_actor_id: actorA,
      p_reason: 'customer requested',
    });
    expect(prepared.error).toBeNull();
    const preparedRow = prepared.data as Record<string, unknown>;
    const attemptId = String(preparedRow.attempt_id);
    expect(attemptId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(preparedRow).toMatchObject({
      order_id: fixture.orderId,
      attempt_id: attemptId,
      request_id: attemptId,
      status: 'prepared',
      provider_action: 'create',
      resource_type: 'capture',
      paypal_payment_id: fixture.captureId,
      paypal_refund_id: null,
      refund_amount_cents: 750,
      currency: 'USD',
      reason: 'customer requested',
      actor_id: actorA,
    });

    // A different currently-authorized owner may recover the attempt. The
    // initiating owner remains the immutable audit actor.
    const recoveredByOwnerB = await supa.rpc('commerce_prepare_admin_refund', {
      p_order_id: fixture.orderId,
      p_guild_id: GUILD_A,
      p_actor_id: actorB,
      p_reason: 'owner B recovery text must not rewrite the attempt',
    });
    expect(recoveredByOwnerB.error).toBeNull();
    expect(recoveredByOwnerB.data).toEqual(prepared.data);

    await expect(
      sqlA`
        UPDATE public.commerce_admin_refund_operations
           SET actor_id = ${actorB}
         WHERE attempt_id = ${attemptId}
      `,
    ).rejects.toMatchObject({
      code: '23514',
      message: expect.stringContaining('prepared contract is immutable'),
    });

    const refundId = nextName('provider-refund');
    const pending = await supa.rpc('commerce_record_admin_refund_outcome', {
      p_attempt_id: attemptId,
      p_guild_id: GUILD_A,
      p_provider_status: 'PENDING',
      p_paypal_refund_id: refundId,
      p_refund_amount_cents: 750,
      p_currency: 'USD',
    });
    expect(pending.error).toBeNull();
    expect(pending.data).toMatchObject({
      attempt_id: attemptId,
      request_id: attemptId,
      status: 'pending',
      provider_action: 'poll',
      paypal_refund_id: refundId,
      actor_id: actorA,
    });

    const pendingReplay = await supa.rpc('commerce_record_admin_refund_outcome', {
      p_attempt_id: attemptId,
      p_guild_id: GUILD_A,
      p_provider_status: 'PENDING',
      p_paypal_refund_id: refundId,
      p_refund_amount_cents: 750,
      p_currency: 'USD',
    });
    expect(pendingReplay.error).toBeNull();
    expect(pendingReplay.data).toEqual(pending.data);

    const prematureFinalize = await supa.rpc('commerce_finalize_admin_refund', {
      p_attempt_id: attemptId,
      p_guild_id: GUILD_A,
    });
    expect(prematureFinalize.error).toMatchObject({ code: '23514' });
    expect(prematureFinalize.error?.message).toContain(
      'completed provider outcome is required',
    );

    const [{ order_status: pendingOrderStatus }] = await sqlA<
      { order_status: string }[]
    >`
      SELECT status AS order_status FROM public.orders WHERE id = ${fixture.orderId}
    `;
    const [{ payment_status: pendingPaymentStatus }] = await sqlA<
      { payment_status: string }[]
    >`
      SELECT status AS payment_status FROM public.payments WHERE id = ${fixture.paymentId}
    `;
    expect(pendingOrderStatus).toBe('completed');
    expect(pendingPaymentStatus).toBe('completed');
    expect(
      await sqlA<{ count: number }[]>`
        SELECT pg_catalog.count(*)::INTEGER AS count
          FROM public.payment_refunds
         WHERE paypal_refund_id = ${refundId}
      `,
    ).toEqual([{ count: 0 }]);

    const providerCompleted = await supa.rpc('commerce_record_admin_refund_outcome', {
      p_attempt_id: attemptId,
      p_guild_id: GUILD_A,
      p_provider_status: 'COMPLETED',
      p_paypal_refund_id: refundId,
      p_refund_amount_cents: 750,
      p_currency: 'USD',
    });
    expect(providerCompleted.error).toBeNull();
    expect(providerCompleted.data).toMatchObject({
      status: 'provider_completed',
      provider_action: 'finalize',
      actor_id: actorA,
    });

    // Simulate a local crash after the durable provider outcome. The failed
    // local transaction must not erase that outcome or partially revoke access.
    const rollbackConstraint = `test_refund_crash_${randomUUID().replaceAll('-', '')}`;
    // DDL cannot carry bind parameters ("could not determine data type of
    // parameter $1"), so the fixture UUID is inlined. Both interpolations are
    // safe: the constraint name is locally generated hex and the order id is
    // a database-issued UUID.
    await sqlA.unsafe(`
      ALTER TABLE public.orders
      ADD CONSTRAINT ${rollbackConstraint}
      CHECK (id <> '${fixture.orderId}'::uuid OR status <> 'refunded')
    `);
    try {
      const interrupted = await supa.rpc('commerce_finalize_admin_refund', {
        p_attempt_id: attemptId,
        p_guild_id: GUILD_A,
      });
      expect(interrupted.error).toMatchObject({ code: '23514' });
    } finally {
      await sqlA`
        ALTER TABLE public.orders
        DROP CONSTRAINT IF EXISTS ${sqlA(rollbackConstraint)}
      `;
    }
    const [survivingOutcome] = await sqlA<
      { status: string; provider_status: string; actor_id: string }[]
    >`
      SELECT status, provider_status, actor_id
        FROM public.commerce_admin_refund_operations
       WHERE attempt_id = ${attemptId}
    `;
    expect(survivingOutcome).toEqual({
      status: 'provider_completed',
      provider_status: 'COMPLETED',
      actor_id: actorA,
    });
    const [unchangedAccess] = await sqlA<
      { entitlement_status: string; license_status: string; session_active: boolean }[]
    >`
      SELECT entitlement.status AS entitlement_status,
             license_key.status AS license_status,
             session.active AS session_active
        FROM public.entitlements AS entitlement
        JOIN public.license_keys AS license_key ON license_key.id = entitlement.license_key_id
        JOIN public.license_sessions AS session ON session.license_key_id = license_key.id
       WHERE entitlement.id = ${fixture.entitlementId}
    `;
    expect(unchangedAccess).toEqual({
      entitlement_status: 'active',
      license_status: 'active',
      session_active: true,
    });

    const wrongGuildFinalize = await supa.rpc('commerce_finalize_admin_refund', {
      p_attempt_id: attemptId,
      p_guild_id: GUILD_B,
    });
    expect(wrongGuildFinalize.error).toMatchObject({ code: '23514' });

    const finalized = await supa.rpc('commerce_finalize_admin_refund', {
      p_attempt_id: attemptId,
      p_guild_id: GUILD_A,
    });
    expect(finalized.error).toBeNull();
    expect(finalized.data).toMatchObject({
      order_id: fixture.orderId,
      attempt_id: attemptId,
      status: 'completed',
      order_status: 'refunded',
      already_refunded: false,
      entitlements_changed: 1,
      licenses_changed: 1,
      sessions_changed: 1,
      paypal_refund_id: refundId,
    });

    const completedForOwnerB = await supa.rpc('commerce_prepare_admin_refund', {
      p_order_id: fixture.orderId,
      p_guild_id: GUILD_A,
      p_actor_id: actorB,
      p_reason: 'owner B completed replay',
    });
    expect(completedForOwnerB.error).toBeNull();
    expect(completedForOwnerB.data).toMatchObject({
      attempt_id: attemptId,
      request_id: attemptId,
      status: 'completed',
      provider_action: 'none',
      actor_id: actorA,
    });

    const replayed = await supa.rpc('commerce_finalize_admin_refund', {
      p_attempt_id: attemptId,
      p_guild_id: GUILD_A,
    });
    expect(replayed.error).toBeNull();
    expect(replayed.data).toMatchObject({
      attempt_id: attemptId,
      already_refunded: true,
      entitlements_changed: 0,
      licenses_changed: 0,
      sessions_changed: 0,
    });

    const [terminalState] = await sqlA<{
      order_status: string;
      payment_status: string;
      entitlement_status: string;
      license_status: string;
      session_active: boolean;
    }[]>`
      SELECT paid_order.status AS order_status,
             payment.status AS payment_status,
             entitlement.status AS entitlement_status,
             license_key.status AS license_status,
             session.active AS session_active
        FROM public.orders AS paid_order
        JOIN public.payments AS payment ON payment.order_id = paid_order.id
        JOIN public.entitlements AS entitlement ON entitlement.order_id = paid_order.id
        JOIN public.license_keys AS license_key ON license_key.id = entitlement.license_key_id
        JOIN public.license_sessions AS session ON session.license_key_id = license_key.id
       WHERE paid_order.id = ${fixture.orderId}
    `;
    expect(terminalState).toEqual({
      order_status: 'refunded',
      payment_status: 'refunded',
      entitlement_status: 'expired',
      license_status: 'revoked',
      session_active: false,
    });

    const resurrectLicense = await supa
      .from('license_keys')
      .update({ status: 'active' })
      .eq('id', fixture.licenseKeyId!);
    expect(resurrectLicense.error?.code).toBe('23503');
    const resurrectSession = await supa.from('license_sessions').insert({
      license_key_id: fixture.licenseKeyId!,
      device_fingerprint: nextName('post-refund-device'),
      active: true,
    });
    expect(resurrectSession.error?.code).toBe('23503');

    const { data: secondOrder, error: secondOrderError } = await supa
      .from('orders')
      .insert({
        order_number: nextName('cross-order-license-order'),
        customer_id: fixture.customerId,
        guild_id: GUILD_A,
        product_id: fixture.productId,
        amount_cents: 0,
        currency: 'USD',
        source: 'manual',
        status: 'completed',
      })
      .select('id')
      .single();
    expect(secondOrderError).toBeNull();
    const crossOrderLicense = await supa.from('entitlements').insert({
      customer_id: fixture.customerId,
      guild_id: GUILD_A,
      product_id: fixture.productId,
      license_key_id: fixture.licenseKeyId!,
      order_id: secondOrder!.id,
      type: 'one_time',
      status: 'active',
      source: 'manual',
      granted_role_ids: [],
      granted_channel_ids: [],
    });
    expect(crossOrderLicense.error?.code).toBe('23503');

    const { data: auditRows, error: auditError } = await supa
      .from('audit_logs')
      .select('actor_id,details')
      .eq('guild_id', GUILD_A)
      .eq('action', 'order.refunded')
      .eq('target_id', fixture.orderId);
    expect(auditError).toBeNull();
    expect(auditRows).toHaveLength(1);
    expect(auditRows?.[0]).toMatchObject({
      actor_id: actorA,
      details: {
        attempt_id: attemptId,
        actor_id: actorA,
        resource_type: 'capture',
        existing_refunded_cents: 250,
        refund_amount_cents: 750,
        paypal_payment_id: fixture.captureId,
        paypal_refund_id: refundId,
      },
    });
  });

  it('treats an exact admin capture refund and capture-refunded webhook as one immutable provider event in either order', async () => {
    const adminFirst = await createPaidRefundFixture();
    const adminFirstRefundId = nextName('admin-first-provider-refund');
    const adminFirstPrepared = await supa.rpc('commerce_prepare_admin_refund', {
      p_order_id: adminFirst.orderId,
      p_guild_id: GUILD_A,
      p_actor_id: nextSnowflake(),
      p_reason: 'admin first alias race',
    });
    expect(adminFirstPrepared.error).toBeNull();
    const adminFirstAttemptId = String(
      (adminFirstPrepared.data as Record<string, unknown>).attempt_id,
    );
    const adminFirstOutcome = await supa.rpc('commerce_record_admin_refund_outcome', {
      p_attempt_id: adminFirstAttemptId,
      p_guild_id: GUILD_A,
      p_provider_status: 'COMPLETED',
      p_paypal_refund_id: adminFirstRefundId,
      p_refund_amount_cents: 1_000,
      p_currency: 'USD',
    });
    expect(adminFirstOutcome.error).toBeNull();
    const adminFirstFinalized = await supa.rpc('commerce_finalize_admin_refund', {
      p_attempt_id: adminFirstAttemptId,
      p_guild_id: GUILD_A,
    });
    expect(adminFirstFinalized.error).toBeNull();

    const adminFirstWebhook = await supa.rpc('commerce_record_paypal_refund_event', {
      p_payment_id: adminFirst.paymentId,
      p_order_id: adminFirst.orderId,
      p_guild_id: GUILD_A,
      p_customer_id: adminFirst.customerId,
      p_paypal_payment_id: adminFirst.captureId,
      p_resource_type: 'capture',
      p_paypal_refund_id: adminFirstRefundId,
      p_event_type: 'PAYMENT.CAPTURE.REFUNDED',
      p_refund_amount_cents: 1_000,
      p_currency: 'USD',
      p_audit_details: { race: 'admin-first' },
    });
    expect(adminFirstWebhook.error).toBeNull();
    expect(adminFirstWebhook.data).toMatchObject({
      paypal_refund_id: adminFirstRefundId,
      event_type: 'PAYMENT.CAPTURE.REFUNDED',
      already_recorded: true,
      terminal_witness: true,
      terminal_history_consistent: true,
      terminal_history_replay: true,
      terminal_payment_status: 'refunded',
    });
    expect(
      await sqlA<{ event_type: string; witness: boolean }[]>`
        SELECT event_type, is_terminal_event_witness AS witness
          FROM public.payment_refunds
         WHERE paypal_refund_id = ${adminFirstRefundId}
      `,
    ).toEqual([{ event_type: 'ADMIN.REFUND', witness: true }]);

    const webhookFirst = await createPaidRefundFixture();
    const webhookFirstRefundId = nextName('webhook-first-provider-refund');
    const webhookFirstPrepared = await supa.rpc('commerce_prepare_admin_refund', {
      p_order_id: webhookFirst.orderId,
      p_guild_id: GUILD_A,
      p_actor_id: nextSnowflake(),
      p_reason: 'webhook first alias race',
    });
    expect(webhookFirstPrepared.error).toBeNull();
    const webhookFirstAttemptId = String(
      (webhookFirstPrepared.data as Record<string, unknown>).attempt_id,
    );
    const webhookFirstOutcome = await supa.rpc('commerce_record_admin_refund_outcome', {
      p_attempt_id: webhookFirstAttemptId,
      p_guild_id: GUILD_A,
      p_provider_status: 'COMPLETED',
      p_paypal_refund_id: webhookFirstRefundId,
      p_refund_amount_cents: 1_000,
      p_currency: 'USD',
    });
    expect(webhookFirstOutcome.error).toBeNull();
    const webhookRecord = await supa.rpc('commerce_record_paypal_refund_event', {
      p_payment_id: webhookFirst.paymentId,
      p_order_id: webhookFirst.orderId,
      p_guild_id: GUILD_A,
      p_customer_id: webhookFirst.customerId,
      p_paypal_payment_id: webhookFirst.captureId,
      p_resource_type: 'capture',
      p_paypal_refund_id: webhookFirstRefundId,
      p_event_type: 'PAYMENT.CAPTURE.REFUNDED',
      p_refund_amount_cents: 1_000,
      p_currency: 'USD',
      p_audit_details: { race: 'webhook-first' },
    });
    expect(webhookRecord.error).toBeNull();
    const webhookFinalize = await supa.rpc('commerce_finalize_paypal_refund_status', {
      p_payment_id: webhookFirst.paymentId,
      p_order_id: webhookFirst.orderId,
      p_guild_id: GUILD_A,
      p_customer_id: webhookFirst.customerId,
      p_paypal_payment_id: webhookFirst.captureId,
      p_resource_type: 'capture',
      p_payment_status: 'refunded',
      p_paypal_refund_id: webhookFirstRefundId,
      p_event_type: 'PAYMENT.CAPTURE.REFUNDED',
      p_audit_details: { race: 'webhook-first' },
    });
    expect(webhookFinalize.error).toBeNull();
    const webhookFirstAdminFinalize = await supa.rpc('commerce_finalize_admin_refund', {
      p_attempt_id: webhookFirstAttemptId,
      p_guild_id: GUILD_A,
    });
    expect(webhookFirstAdminFinalize.error).toBeNull();
    expect(webhookFirstAdminFinalize.data).toMatchObject({
      status: 'completed',
      order_status: 'refunded',
      paypal_refund_id: webhookFirstRefundId,
    });
    expect(
      await sqlA<{ event_type: string; count: number }[]>`
        SELECT pg_catalog.min(event_type) AS event_type,
               pg_catalog.count(*)::INTEGER AS count
          FROM public.payment_refunds
         WHERE paypal_refund_id = ${webhookFirstRefundId}
      `,
    ).toEqual([{ event_type: 'PAYMENT.CAPTURE.REFUNDED', count: 1 }]);
  });

  it('recovers only an exact post-attempt terminal capture through provider idempotency without guessing its id', async () => {
    const fixture = await createPaidRefundFixture({ priorRefundCents: 250 });
    const actor = nextSnowflake();
    const prepared = await supa.rpc('commerce_prepare_admin_refund', {
      p_order_id: fixture.orderId,
      p_guild_id: GUILD_A,
      p_actor_id: actor,
      p_reason: 'provider response crash recovery',
    });
    expect(prepared.error).toBeNull();
    const preparedRow = prepared.data as Record<string, unknown>;
    const attemptId = String(preparedRow.attempt_id);
    const refundId = nextName('post-attempt-webhook-refund');

    const webhookRecord = await supa.rpc('commerce_record_paypal_refund_event', {
      p_payment_id: fixture.paymentId,
      p_order_id: fixture.orderId,
      p_guild_id: GUILD_A,
      p_customer_id: fixture.customerId,
      p_paypal_payment_id: fixture.captureId,
      p_resource_type: 'capture',
      p_paypal_refund_id: refundId,
      p_event_type: 'PAYMENT.CAPTURE.REFUNDED',
      p_refund_amount_cents: 750,
      p_currency: 'USD',
      p_audit_details: { crash: 'before-admin-outcome' },
    });
    expect(webhookRecord.error).toBeNull();
    const webhookFinalize = await supa.rpc('commerce_finalize_paypal_refund_status', {
      p_payment_id: fixture.paymentId,
      p_order_id: fixture.orderId,
      p_guild_id: GUILD_A,
      p_customer_id: fixture.customerId,
      p_paypal_payment_id: fixture.captureId,
      p_resource_type: 'capture',
      p_payment_status: 'refunded',
      p_paypal_refund_id: refundId,
      p_event_type: 'PAYMENT.CAPTURE.REFUNDED',
      p_audit_details: { crash: 'before-admin-outcome' },
    });
    expect(webhookFinalize.error).toBeNull();

    const retry = await supa.rpc('commerce_prepare_admin_refund', {
      p_order_id: fixture.orderId,
      p_guild_id: GUILD_A,
      p_actor_id: nextSnowflake(),
      p_reason: 'must retain the frozen request',
    });
    expect(retry.error).toBeNull();
    expect(retry.data).toEqual(prepared.data);
    expect(retry.data).toMatchObject({
      attempt_id: attemptId,
      request_id: attemptId,
      status: 'prepared',
      provider_action: 'create',
      paypal_refund_id: null,
      refund_amount_cents: 750,
      actor_id: actor,
    });

    const wrongProviderIdentity = await supa.rpc('commerce_record_admin_refund_outcome', {
      p_attempt_id: attemptId,
      p_guild_id: GUILD_A,
      p_provider_status: 'COMPLETED',
      p_paypal_refund_id: nextName('wrong-idempotent-provider-result'),
      p_refund_amount_cents: 750,
      p_currency: 'USD',
    });
    expect(wrongProviderIdentity.error).toMatchObject({ code: '23514' });
    expect(wrongProviderIdentity.error?.message).toContain('ledger advanced for a different attempt');

    const exactProviderReplay = await supa.rpc('commerce_record_admin_refund_outcome', {
      p_attempt_id: attemptId,
      p_guild_id: GUILD_A,
      p_provider_status: 'COMPLETED',
      p_paypal_refund_id: refundId,
      p_refund_amount_cents: 750,
      p_currency: 'USD',
    });
    expect(exactProviderReplay.error).toBeNull();
    expect(exactProviderReplay.data).toMatchObject({
      status: 'provider_completed',
      paypal_refund_id: refundId,
    });
    const completed = await supa.rpc('commerce_finalize_admin_refund', {
      p_attempt_id: attemptId,
      p_guild_id: GUILD_A,
    });
    expect(completed.error).toBeNull();
    // already_refunded flags a replay of an already-completed ATTEMPT. This is
    // the first finalize of this attempt (provider_completed -> completed), so
    // it reports false even though the money moved through the webhook path.
    expect(completed.data).toMatchObject({ status: 'completed', already_refunded: false });

    const splitFixture = await createPaidRefundFixture();
    const splitPrepared = await supa.rpc('commerce_prepare_admin_refund', {
      p_order_id: splitFixture.orderId,
      p_guild_id: GUILD_A,
      p_actor_id: nextSnowflake(),
      p_reason: 'split external evidence must not be claimed',
    });
    expect(splitPrepared.error).toBeNull();
    const splitPartialId = nextName('post-attempt-split-partial');
    const splitTerminalId = nextName('post-attempt-split-terminal');
    for (const [id, cents] of [[splitPartialId, 400], [splitTerminalId, 600]] as const) {
      const recorded = await supa.rpc('commerce_record_paypal_refund_event', {
        p_payment_id: splitFixture.paymentId,
        p_order_id: splitFixture.orderId,
        p_guild_id: GUILD_A,
        p_customer_id: splitFixture.customerId,
        p_paypal_payment_id: splitFixture.captureId,
        p_resource_type: 'capture',
        p_paypal_refund_id: id,
        p_event_type: 'PAYMENT.CAPTURE.REFUNDED',
        p_refund_amount_cents: cents,
        p_currency: 'USD',
        p_audit_details: { crash: 'unrelated-split-evidence' },
      });
      expect(recorded.error).toBeNull();
    }
    const splitFinalize = await supa.rpc('commerce_finalize_paypal_refund_status', {
      p_payment_id: splitFixture.paymentId,
      p_order_id: splitFixture.orderId,
      p_guild_id: GUILD_A,
      p_customer_id: splitFixture.customerId,
      p_paypal_payment_id: splitFixture.captureId,
      p_resource_type: 'capture',
      p_payment_status: 'refunded',
      p_paypal_refund_id: splitTerminalId,
      p_event_type: 'PAYMENT.CAPTURE.REFUNDED',
      p_audit_details: { crash: 'unrelated-split-evidence' },
    });
    expect(splitFinalize.error).toBeNull();
    const splitRetry = await supa.rpc('commerce_prepare_admin_refund', {
      p_order_id: splitFixture.orderId,
      p_guild_id: GUILD_A,
      p_actor_id: nextSnowflake(),
      p_reason: 'must not claim split evidence',
    });
    expect(splitRetry.error).toMatchObject({ code: '23514' });
    expect(splitRetry.error?.message).toContain('attempt ledger is stale');
  });

  it('never treats a terminal reversal witness as exact admin-refund evidence', async () => {
    const preparedFixture = await createPaidRefundFixture();
    const prepared = await supa.rpc('commerce_prepare_admin_refund', {
      p_order_id: preparedFixture.orderId,
      p_guild_id: GUILD_A,
      p_actor_id: nextSnowflake(),
      p_reason: 'reversal exclusion prepare and outcome',
    });
    expect(prepared.error).toBeNull();
    const attemptId = String((prepared.data as Record<string, unknown>).attempt_id);
    const reversalId = nextName('prepared-attempt-reversal');
    const reversal = await supa.rpc('commerce_record_paypal_refund_event', {
      p_payment_id: preparedFixture.paymentId,
      p_order_id: preparedFixture.orderId,
      p_guild_id: GUILD_A,
      p_customer_id: preparedFixture.customerId,
      p_paypal_payment_id: preparedFixture.captureId,
      p_resource_type: 'capture',
      p_paypal_refund_id: reversalId,
      p_event_type: 'PAYMENT.CAPTURE.REVERSED',
      p_refund_amount_cents: null,
      p_currency: null,
      p_audit_details: { matrix: 'admin-reversal-exclusion' },
    });
    expect(reversal.error).toBeNull();
    const prepareReplay = await supa.rpc('commerce_prepare_admin_refund', {
      p_order_id: preparedFixture.orderId,
      p_guild_id: GUILD_A,
      p_actor_id: nextSnowflake(),
      p_reason: 'reversal must remain external',
    });
    expect(prepareReplay.error).toMatchObject({ code: '23514' });
    const outcome = await supa.rpc('commerce_record_admin_refund_outcome', {
      p_attempt_id: attemptId,
      p_guild_id: GUILD_A,
      p_provider_status: 'COMPLETED',
      p_paypal_refund_id: reversalId,
      p_refund_amount_cents: 1_000,
      p_currency: 'USD',
    });
    expect(outcome.error).toMatchObject({ code: '23514' });
    expect(outcome.error?.message).toContain('ledger advanced for a different attempt');

    const finalizeFixture = await createPaidRefundFixture();
    const finalizePrepared = await supa.rpc('commerce_prepare_admin_refund', {
      p_order_id: finalizeFixture.orderId,
      p_guild_id: GUILD_A,
      p_actor_id: nextSnowflake(),
      p_reason: 'reversal exclusion finalizer',
    });
    expect(finalizePrepared.error).toBeNull();
    const finalizeAttemptId = String(
      (finalizePrepared.data as Record<string, unknown>).attempt_id,
    );
    const finalizeReversalId = nextName('provider-complete-then-reversal');
    const providerOutcome = await supa.rpc('commerce_record_admin_refund_outcome', {
      p_attempt_id: finalizeAttemptId,
      p_guild_id: GUILD_A,
      p_provider_status: 'COMPLETED',
      p_paypal_refund_id: finalizeReversalId,
      p_refund_amount_cents: 1_000,
      p_currency: 'USD',
    });
    expect(providerOutcome.error).toBeNull();
    const finalizeReversal = await supa.rpc('commerce_record_paypal_refund_event', {
      p_payment_id: finalizeFixture.paymentId,
      p_order_id: finalizeFixture.orderId,
      p_guild_id: GUILD_A,
      p_customer_id: finalizeFixture.customerId,
      p_paypal_payment_id: finalizeFixture.captureId,
      p_resource_type: 'capture',
      p_paypal_refund_id: finalizeReversalId,
      p_event_type: 'PAYMENT.CAPTURE.REVERSED',
      p_refund_amount_cents: null,
      p_currency: null,
      p_audit_details: { matrix: 'admin-finalizer-reversal-exclusion' },
    });
    expect(finalizeReversal.error).toBeNull();
    const finalization = await supa.rpc('commerce_finalize_admin_refund', {
      p_attempt_id: finalizeAttemptId,
      p_guild_id: GUILD_A,
    });
    expect(finalization.error).toMatchObject({ code: '23514' });
    expect(finalization.error?.message).toContain('ledger advanced for a different attempt');
  });

  it('retains failed and cancelled attempts and never claims a delayed old webhook for a newer attempt', async () => {
    const fixture = await createPaidRefundFixture();
    const prepare = async (actorId: string) =>
      await supa.rpc('commerce_prepare_admin_refund', {
        p_order_id: fixture.orderId,
        p_guild_id: GUILD_A,
        p_actor_id: actorId,
        p_reason: 'attempt lifecycle matrix',
      });

    const first = await prepare(nextSnowflake());
    expect(first.error).toBeNull();
    const firstAttempt = String((first.data as Record<string, unknown>).attempt_id);
    const firstRefundId = nextName('failed-provider-refund');
    const failed = await supa.rpc('commerce_record_admin_refund_outcome', {
      p_attempt_id: firstAttempt,
      p_guild_id: GUILD_A,
      p_provider_status: 'FAILED',
      p_paypal_refund_id: firstRefundId,
      p_refund_amount_cents: 1_000,
      p_currency: 'USD',
    });
    expect(failed.error).toBeNull();
    expect(failed.data).toMatchObject({ status: 'failed', provider_action: 'none' });
    const failedReplay = await supa.rpc('commerce_record_admin_refund_outcome', {
      p_attempt_id: firstAttempt,
      p_guild_id: GUILD_A,
      p_provider_status: 'FAILED',
      p_paypal_refund_id: firstRefundId,
      p_refund_amount_cents: 1_000,
      p_currency: 'USD',
    });
    expect(failedReplay.error).toBeNull();
    expect(failedReplay.data).toEqual(failed.data);

    const second = await prepare(nextSnowflake());
    expect(second.error).toBeNull();
    const secondAttempt = String((second.data as Record<string, unknown>).attempt_id);
    expect(secondAttempt).not.toBe(firstAttempt);
    const secondRefundId = nextName('cancelled-provider-refund');
    const pendingSecond = await supa.rpc('commerce_record_admin_refund_outcome', {
      p_attempt_id: secondAttempt,
      p_guild_id: GUILD_A,
      p_provider_status: 'PENDING',
      p_paypal_refund_id: secondRefundId,
      p_refund_amount_cents: 1_000,
      p_currency: 'USD',
    });
    expect(pendingSecond.error).toBeNull();

    const lossyCancellation = await supa.rpc('commerce_record_admin_refund_outcome', {
      p_attempt_id: secondAttempt,
      p_guild_id: GUILD_A,
      p_provider_status: 'CANCELLED',
      p_paypal_refund_id: null,
      p_refund_amount_cents: null,
      p_currency: null,
    });
    expect(lossyCancellation.error).toMatchObject({ code: '23514' });
    // The PENDING observation already bound this attempt to secondRefundId, so
    // a cancellation that lost the provider identity fails the identity gate
    // before the pending-specific terminal-result check can even run.
    expect(lossyCancellation.error?.message).toContain(
      'provider identity mismatch',
    );
    const cancelled = await supa.rpc('commerce_record_admin_refund_outcome', {
      p_attempt_id: secondAttempt,
      p_guild_id: GUILD_A,
      p_provider_status: 'CANCELLED',
      p_paypal_refund_id: secondRefundId,
      p_refund_amount_cents: 1_000,
      p_currency: 'USD',
    });
    expect(cancelled.error).toBeNull();
    expect(cancelled.data).toMatchObject({ status: 'cancelled', provider_action: 'none' });

    const third = await prepare(nextSnowflake());
    expect(third.error).toBeNull();
    const thirdAttempt = String((third.data as Record<string, unknown>).attempt_id);
    expect(new Set([firstAttempt, secondAttempt, thirdAttempt]).size).toBe(3);

    const delayedOldWebhook = await supa.rpc('commerce_record_paypal_refund_event', {
      p_payment_id: fixture.paymentId,
      p_order_id: fixture.orderId,
      p_guild_id: GUILD_A,
      p_customer_id: fixture.customerId,
      p_paypal_payment_id: fixture.captureId,
      p_resource_type: 'capture',
      p_paypal_refund_id: firstRefundId,
      p_event_type: 'PAYMENT.CAPTURE.REFUNDED',
      p_refund_amount_cents: 1_000,
      p_currency: 'USD',
      p_audit_details: { fixture: 'delayed old provider completion' },
    });
    expect(delayedOldWebhook.error).toBeNull();

    const oldAttemptCannotReopen = await supa.rpc(
      'commerce_record_admin_refund_outcome',
      {
        p_attempt_id: firstAttempt,
        p_guild_id: GUILD_A,
        p_provider_status: 'COMPLETED',
        p_paypal_refund_id: firstRefundId,
        p_refund_amount_cents: 1_000,
        p_currency: 'USD',
      },
    );
    expect(oldAttemptCannotReopen.error).toMatchObject({ code: '23514' });
    expect(oldAttemptCannotReopen.error?.message).toContain(
      'terminal outcome replay mismatch',
    );

    const thirdCannotClaimOldLedger = await supa.rpc(
      'commerce_record_admin_refund_outcome',
      {
        p_attempt_id: thirdAttempt,
        p_guild_id: GUILD_A,
        p_provider_status: 'PENDING',
        p_paypal_refund_id: nextName('third-provider-refund'),
        p_refund_amount_cents: 1_000,
        p_currency: 'USD',
      },
    );
    expect(thirdCannotClaimOldLedger.error).toMatchObject({ code: '23514' });
    expect(thirdCannotClaimOldLedger.error?.message).toContain(
      'ledger advanced for a different attempt',
    );
    const recoveryBlocked = await prepare(nextSnowflake());
    expect(recoveryBlocked.error).toMatchObject({ code: '23514' });
    expect(recoveryBlocked.error?.message).toContain(
      'terminal attempt has completed provider evidence',
    );

    const attempts = await sqlA<{ attempt_id: string; status: string }[]>`
      SELECT attempt_id::TEXT, status
        FROM public.commerce_admin_refund_operations
       WHERE order_id = ${fixture.orderId}
       ORDER BY created_at, attempt_id
    `;
    expect(attempts.map((row) => row.status).sort()).toEqual([
      'cancelled',
      'failed',
      'prepared',
    ]);
  });

  it('converges PENDING and COMPLETED outcome races in both commit orderings', async () => {
    const runOrdering = async (
      firstStatus: 'PENDING' | 'COMPLETED',
      secondStatus: 'PENDING' | 'COMPLETED',
    ) => {
      const fixture = await createPaidRefundFixture();
      const prepared = await supa.rpc('commerce_prepare_admin_refund', {
        p_order_id: fixture.orderId,
        p_guild_id: GUILD_A,
        p_actor_id: nextSnowflake(),
        p_reason: `${firstStatus} before ${secondStatus}`,
      });
      expect(prepared.error).toBeNull();
      const attemptId = String((prepared.data as Record<string, unknown>).attempt_id);
      const refundId = nextName('raced-provider-refund');
      const firstCommitted = makeGate();
      const releaseFirst = makeGate();
      let firstResult: Record<string, unknown> | undefined;
      let firstError: unknown;
      const firstTransaction = sqlA.begin(async (tx) => {
        const [row] = await tx<{ result: Record<string, unknown> }[]>`
          SELECT public.commerce_record_admin_refund_outcome(
            ${attemptId}::UUID,
            ${GUILD_A},
            ${firstStatus},
            ${refundId},
            1000,
            'USD'
          ) AS result
        `;
        firstResult = row?.result;
        firstCommitted.open();
        await releaseFirst.promise;
      }).catch((error: unknown) => {
        firstError = error;
        firstCommitted.open();
        releaseFirst.open();
      });
      await firstCommitted.promise;
      if (firstError) throw firstError;

      const secondCall = sqlB<{ result: Record<string, unknown> }[]>`
        SELECT public.commerce_record_admin_refund_outcome(
          ${attemptId}::UUID,
          ${GUILD_A},
          ${secondStatus},
          ${refundId},
          1000,
          'USD'
        ) AS result
      `.then(
        (rows) => ({ rows, error: null as unknown }),
        (error: unknown) => ({ rows: [], error }),
      );
      try {
        await waitForDatabaseLock(
          sqlBBackendPid,
          `${secondStatus} outcome competing with uncommitted ${firstStatus}`,
        );
      } finally {
        releaseFirst.open();
      }
      await firstTransaction;
      if (firstError) throw firstError;
      const secondResult = await secondCall;
      if (secondResult.error) throw secondResult.error;

      expect(firstResult).toMatchObject({
        status: firstStatus === 'COMPLETED' ? 'provider_completed' : 'pending',
        attempt_id: attemptId,
      });
      expect(secondResult.rows[0]?.result).toMatchObject({
        status: 'provider_completed',
        attempt_id: attemptId,
        paypal_refund_id: refundId,
      });
      const [terminal] = await sqlA<{ status: string; provider_status: string }[]>`
        SELECT status, provider_status
          FROM public.commerce_admin_refund_operations
         WHERE attempt_id = ${attemptId}
      `;
      expect(terminal).toEqual({
        status: 'provider_completed',
        provider_status: 'COMPLETED',
      });
    };

    await runOrdering('PENDING', 'COMPLETED');
    await runOrdering('COMPLETED', 'PENDING');
  });

  it('atomically converges external refund status and structurally prevents a second settled capture', async () => {
    const fixture = await createPaidRefundFixture();
    const directOrderOnly = await supa
      .from('orders')
      .update({ status: 'refunded' })
      .eq('id', fixture.orderId);
    expect(directOrderOnly.error?.code).toBe('23503');

    const partialRefundId = nextName('external-partial-refund');
    const partialRefund = await supa.rpc('commerce_record_paypal_refund_event', {
      p_payment_id: fixture.paymentId,
      p_order_id: fixture.orderId,
      p_guild_id: GUILD_A,
      p_customer_id: fixture.customerId,
      p_paypal_payment_id: fixture.captureId,
      p_resource_type: 'capture',
      p_paypal_refund_id: partialRefundId,
      p_event_type: 'PAYMENT.CAPTURE.REFUNDED',
      p_refund_amount_cents: 250,
      p_currency: 'USD',
      p_audit_details: { test_case: 'prior partial before reversal' },
    });
    expect(partialRefund.error).toBeNull();
    expect(partialRefund.data).toMatchObject({
      refund_amount_cents: 250,
      cumulative_refunded_cents: 250,
      full_refund: false,
      already_recorded: false,
      partial_audit_recorded: true,
      partial_alert_recorded: true,
    });
    const partialReplay = await supa.rpc('commerce_record_paypal_refund_event', {
      p_payment_id: fixture.paymentId,
      p_order_id: fixture.orderId,
      p_guild_id: GUILD_A,
      p_customer_id: fixture.customerId,
      p_paypal_payment_id: fixture.captureId,
      p_resource_type: 'capture',
      p_paypal_refund_id: partialRefundId,
      p_event_type: 'PAYMENT.CAPTURE.REFUNDED',
      p_refund_amount_cents: 250,
      p_currency: 'USD',
      p_audit_details: {},
    });
    expect(partialReplay.error).toBeNull();
    expect(partialReplay.data).toMatchObject({
      full_refund: false,
      already_recorded: true,
      partial_audit_recorded: false,
      partial_alert_recorded: false,
    });
    const ambiguousPartialReplay = await supa.rpc(
      'commerce_record_paypal_refund_event',
      {
        p_payment_id: fixture.paymentId,
        p_order_id: fixture.orderId,
        p_guild_id: GUILD_A,
        p_customer_id: fixture.customerId,
        p_paypal_payment_id: fixture.captureId,
        p_resource_type: 'capture',
        p_paypal_refund_id: partialRefundId,
        p_event_type: 'PAYMENT.CAPTURE.REFUNDED',
        p_refund_amount_cents: null,
        p_currency: null,
        p_audit_details: {},
      },
    );
    expect(ambiguousPartialReplay.error).toMatchObject({ code: '23514' });
    expect(ambiguousPartialReplay.error?.message).toContain(
      'refund replay identity mismatch',
    );

    const durableRefundId = nextName('external-full-reversal');
    const canonicalReversal = await supa.rpc('commerce_record_paypal_refund_event', {
      p_payment_id: fixture.paymentId,
      p_order_id: fixture.orderId,
      p_guild_id: GUILD_A,
      p_customer_id: fixture.customerId,
      p_paypal_payment_id: fixture.captureId,
      p_resource_type: 'capture',
      p_paypal_refund_id: durableRefundId,
      p_event_type: 'PAYMENT.CAPTURE.REVERSED',
      p_refund_amount_cents: null,
      p_currency: null,
      p_audit_details: {},
    });
    expect(canonicalReversal.error).toBeNull();
    expect(canonicalReversal.data).toMatchObject({
      paypal_refund_id: durableRefundId,
      refund_amount_cents: 750,
      currency: 'USD',
      cumulative_refunded_cents: 1_000,
      full_refund: true,
      terminal_witness: true,
      already_recorded: false,
    });
    const reversalReplay = await supa.rpc('commerce_record_paypal_refund_event', {
      p_payment_id: fixture.paymentId,
      p_order_id: fixture.orderId,
      p_guild_id: GUILD_A,
      p_customer_id: fixture.customerId,
      p_paypal_payment_id: fixture.captureId,
      p_resource_type: 'capture',
      p_paypal_refund_id: durableRefundId,
      p_event_type: 'PAYMENT.CAPTURE.REVERSED',
      p_refund_amount_cents: null,
      p_currency: null,
      p_audit_details: {},
    });
    expect(reversalReplay.error).toBeNull();
    expect(reversalReplay.data).toMatchObject({
      refund_amount_cents: 750,
      cumulative_refunded_cents: 1_000,
      full_refund: true,
      already_recorded: true,
    });

    const wrongResource = await supa.rpc('commerce_finalize_paypal_refund_status', {
      p_payment_id: fixture.paymentId,
      p_order_id: fixture.orderId,
      p_guild_id: GUILD_A,
      p_customer_id: fixture.customerId,
      p_paypal_payment_id: fixture.captureId,
      p_resource_type: 'sale',
      p_payment_status: 'reversed',
      p_paypal_refund_id: durableRefundId,
      p_event_type: 'PAYMENT.SALE.REVERSED',
      p_audit_details: { refund_amount_cents: 1_000 },
    });
    expect(wrongResource.error).toMatchObject({ code: '23514' });

    const atomicStatus = await supa.rpc('commerce_finalize_paypal_refund_status', {
      p_payment_id: fixture.paymentId,
      p_order_id: fixture.orderId,
      p_guild_id: GUILD_A,
      p_customer_id: fixture.customerId,
      p_paypal_payment_id: fixture.captureId,
      p_resource_type: 'capture',
      p_payment_status: 'reversed',
      p_paypal_refund_id: durableRefundId,
      p_event_type: 'PAYMENT.CAPTURE.REVERSED',
      p_audit_details: {
        refund_amount_cents: 750,
        cumulative_refunded_cents: 1_000,
      },
    });
    expect(atomicStatus.error).toBeNull();
    expect(atomicStatus.data).toEqual({
      order_id: fixture.orderId,
      payment_id: fixture.paymentId,
      order_status: 'refunded',
      payment_status: 'reversed',
      already_terminal: false,
      audit_recorded: true,
      partial_alerts_resolved: 1,
    });
    const monotonicReplay = await supa.rpc('commerce_finalize_paypal_refund_status', {
      p_payment_id: fixture.paymentId,
      p_order_id: fixture.orderId,
      p_guild_id: GUILD_A,
      p_customer_id: fixture.customerId,
      p_paypal_payment_id: fixture.captureId,
      p_resource_type: 'capture',
      p_payment_status: 'reversed',
      p_paypal_refund_id: durableRefundId,
      p_event_type: 'PAYMENT.CAPTURE.REVERSED',
      p_audit_details: { refund_amount_cents: 750 },
    });
    expect(monotonicReplay.error).toBeNull();
    expect(monotonicReplay.data).toMatchObject({
      payment_status: 'reversed',
      already_terminal: true,
      audit_recorded: false,
    });
    const delayedPartialHistory = await supa.rpc(
      'commerce_record_paypal_refund_event',
      {
        p_payment_id: fixture.paymentId,
        p_order_id: fixture.orderId,
        p_guild_id: GUILD_A,
        p_customer_id: fixture.customerId,
        p_paypal_payment_id: fixture.captureId,
        p_resource_type: 'capture',
        p_paypal_refund_id: partialRefundId,
        p_event_type: 'PAYMENT.CAPTURE.REFUNDED',
        p_refund_amount_cents: 250,
        p_currency: 'USD',
        p_audit_details: {},
      },
    );
    expect(delayedPartialHistory.error).toBeNull();
    expect(delayedPartialHistory.data).toMatchObject({
      full_refund: true,
      terminal_witness: false,
      terminal_history_consistent: true,
      terminal_history_replay: true,
      terminal_payment_status: 'reversed',
      already_recorded: true,
    });
    const { data: externalAudits, error: externalAuditError } = await supa
      .from('audit_logs')
      .select('details')
      .eq('guild_id', GUILD_A)
      .eq('action', 'order.reversed')
      .eq('target_id', fixture.orderId)
      .contains('details', { paypal_refund_id: durableRefundId });
    expect(externalAuditError).toBeNull();
    expect(externalAudits).toHaveLength(1);
    expect(externalAudits?.[0]?.details).toMatchObject({
      event_type: 'PAYMENT.CAPTURE.REVERSED',
      capture_id: fixture.captureId,
      paypal_refund_id: durableRefundId,
      refund_scope: 'full',
    });
    const { data: partialAlerts, error: partialAlertsError } = await supa
      .from('alerts')
      .select('resolved,metadata')
      .eq('guild_id', GUILD_A)
      .eq('alert_type', 'partial_refund_review')
      .contains('metadata', { paypal_refund_id: partialRefundId });
    expect(partialAlertsError).toBeNull();
    expect(partialAlerts).toHaveLength(1);
    expect(partialAlerts?.[0]?.resolved).toBe(true);
    const { data: partialAudits, error: partialAuditsError } = await supa
      .from('audit_logs')
      .select('details')
      .eq('guild_id', GUILD_A)
      .eq('action', 'order.refund_partial')
      .eq('target_id', fixture.orderId)
      .contains('details', { paypal_refund_id: partialRefundId });
    expect(partialAuditsError).toBeNull();
    expect(partialAudits).toHaveLength(1);
    const externalTerminalCannotBecomeAdmin = await supa.rpc(
      'commerce_prepare_admin_refund',
      {
        p_order_id: fixture.orderId,
        p_guild_id: GUILD_A,
        p_actor_id: nextSnowflake(),
        p_reason: 'must not create an admin attempt after external reversal',
      },
    );
    expect(externalTerminalCannotBecomeAdmin.error).toMatchObject({ code: '23514' });
    // A reversed payment leaves no refundable capture candidate at all, so
    // prepare fails closed at the capture-set gate (operator remediation)
    // before any attempt-history reasoning applies.
    expect(externalTerminalCannotBecomeAdmin.error?.message).toContain(
      'payment capture set requires operator remediation',
    );

    const zeroFixture = await createPaidRefundFixture();
    const fullRefundId = nextName('full-before-zero-reversal');
    const fullBeforeReversal = await supa.rpc('commerce_record_paypal_refund_event', {
      p_payment_id: zeroFixture.paymentId,
      p_order_id: zeroFixture.orderId,
      p_guild_id: GUILD_A,
      p_customer_id: zeroFixture.customerId,
      p_paypal_payment_id: zeroFixture.captureId,
      p_resource_type: 'capture',
      p_paypal_refund_id: fullRefundId,
      p_event_type: 'PAYMENT.CAPTURE.REFUNDED',
      p_refund_amount_cents: 1_000,
      p_currency: 'USD',
      p_audit_details: {},
    });
    expect(fullBeforeReversal.error).toBeNull();
    expect(fullBeforeReversal.data).toMatchObject({
      terminal_witness: true,
      terminal_history_replay: false,
      terminal_payment_status: 'completed',
    });
    const zeroReversalId = nextName('zero-remaining-reversal');
    const zeroReversal = await supa.rpc('commerce_record_paypal_refund_event', {
      p_payment_id: zeroFixture.paymentId,
      p_order_id: zeroFixture.orderId,
      p_guild_id: GUILD_A,
      p_customer_id: zeroFixture.customerId,
      p_paypal_payment_id: zeroFixture.captureId,
      p_resource_type: 'capture',
      p_paypal_refund_id: zeroReversalId,
      p_event_type: 'PAYMENT.CAPTURE.REVERSED',
      p_refund_amount_cents: null,
      p_currency: null,
      p_audit_details: {},
    });
    expect(zeroReversal.error).toBeNull();
    expect(zeroReversal.data).toMatchObject({
      refund_amount_cents: 0,
      cumulative_refunded_cents: 1_000,
      full_refund: true,
      terminal_witness: true,
      terminal_history_replay: false,
      already_recorded: false,
    });
    const secondReversal = await supa.rpc('commerce_record_paypal_refund_event', {
      p_payment_id: zeroFixture.paymentId,
      p_order_id: zeroFixture.orderId,
      p_guild_id: GUILD_A,
      p_customer_id: zeroFixture.customerId,
      p_paypal_payment_id: zeroFixture.captureId,
      p_resource_type: 'capture',
      p_paypal_refund_id: nextName('different-zero-reversal'),
      p_event_type: 'PAYMENT.CAPTURE.REVERSED',
      p_refund_amount_cents: null,
      p_currency: null,
      p_audit_details: {},
    });
    expect(secondReversal.error).toMatchObject({ code: '23514' });
    expect(secondReversal.error?.message).toContain(
      'a different reversal witness already exists',
    );

    const finalizedZeroReversal = await supa.rpc(
      'commerce_finalize_paypal_refund_status',
      {
        p_payment_id: zeroFixture.paymentId,
        p_order_id: zeroFixture.orderId,
        p_guild_id: GUILD_A,
        p_customer_id: zeroFixture.customerId,
        p_paypal_payment_id: zeroFixture.captureId,
        p_resource_type: 'capture',
        p_payment_status: 'reversed',
        p_paypal_refund_id: zeroReversalId,
        p_event_type: 'PAYMENT.CAPTURE.REVERSED',
        p_audit_details: {},
      },
    );
    expect(finalizedZeroReversal.error).toBeNull();
    expect(finalizedZeroReversal.data).toMatchObject({ payment_status: 'reversed' });
    const zeroReplay = await supa.rpc('commerce_record_paypal_refund_event', {
      p_payment_id: zeroFixture.paymentId,
      p_order_id: zeroFixture.orderId,
      p_guild_id: GUILD_A,
      p_customer_id: zeroFixture.customerId,
      p_paypal_payment_id: zeroFixture.captureId,
      p_resource_type: 'capture',
      p_paypal_refund_id: zeroReversalId,
      p_event_type: 'PAYMENT.CAPTURE.REVERSED',
      p_refund_amount_cents: null,
      p_currency: null,
      p_audit_details: {},
    });
    expect(zeroReplay.error).toBeNull();
    expect(zeroReplay.data).toMatchObject({
      refund_amount_cents: 0,
      terminal_witness: true,
      terminal_history_consistent: true,
      terminal_history_replay: true,
      terminal_payment_status: 'reversed',
      already_recorded: true,
    });
    const delayedFullRefundHistory = await supa.rpc(
      'commerce_record_paypal_refund_event',
      {
        p_payment_id: zeroFixture.paymentId,
        p_order_id: zeroFixture.orderId,
        p_guild_id: GUILD_A,
        p_customer_id: zeroFixture.customerId,
        p_paypal_payment_id: zeroFixture.captureId,
        p_resource_type: 'capture',
        p_paypal_refund_id: fullRefundId,
        p_event_type: 'PAYMENT.CAPTURE.REFUNDED',
        p_refund_amount_cents: 1_000,
        p_currency: 'USD',
        p_audit_details: {},
      },
    );
    expect(delayedFullRefundHistory.error).toBeNull();
    expect(delayedFullRefundHistory.data).toMatchObject({
      terminal_witness: false,
      terminal_history_consistent: true,
      terminal_history_replay: true,
      terminal_payment_status: 'reversed',
      already_recorded: true,
    });

    const unknownTerminalReversal = await supa.rpc('commerce_record_paypal_refund_event', {
      p_payment_id: zeroFixture.paymentId,
      p_order_id: zeroFixture.orderId,
      p_guild_id: GUILD_A,
      p_customer_id: zeroFixture.customerId,
      p_paypal_payment_id: zeroFixture.captureId,
      p_resource_type: 'capture',
      p_paypal_refund_id: nextName('unknown-terminal-reversal'),
      p_event_type: 'PAYMENT.CAPTURE.REVERSED',
      p_refund_amount_cents: null,
      p_currency: null,
      p_audit_details: {},
    });
    expect(unknownTerminalReversal.error).toMatchObject({ code: '23514' });
    expect(unknownTerminalReversal.error?.message).toContain(
      'terminal payment accepts exact recorded history only',
    );
    const unknownTerminalRefund = await supa.rpc('commerce_record_paypal_refund_event', {
      p_payment_id: zeroFixture.paymentId,
      p_order_id: zeroFixture.orderId,
      p_guild_id: GUILD_A,
      p_customer_id: zeroFixture.customerId,
      p_paypal_payment_id: zeroFixture.captureId,
      p_resource_type: 'capture',
      p_paypal_refund_id: nextName('unknown-terminal-refund'),
      p_event_type: 'PAYMENT.CAPTURE.REFUNDED',
      p_refund_amount_cents: 1,
      p_currency: 'USD',
      p_audit_details: {},
    });
    expect(unknownTerminalRefund.error).toMatchObject({ code: '23514' });
    expect(unknownTerminalRefund.error?.message).toContain(
      'terminal payment accepts exact recorded history only',
    );

    const corruptTerminalFixture = await createPaidRefundFixture();
    const corruptTerminalRefundId = nextName('corrupt-terminal-refund');
    const corruptTerminalRefund = await supa.rpc(
      'commerce_record_paypal_refund_event',
      {
        p_payment_id: corruptTerminalFixture.paymentId,
        p_order_id: corruptTerminalFixture.orderId,
        p_guild_id: GUILD_A,
        p_customer_id: corruptTerminalFixture.customerId,
        p_paypal_payment_id: corruptTerminalFixture.captureId,
        p_resource_type: 'capture',
        p_paypal_refund_id: corruptTerminalRefundId,
        p_event_type: 'PAYMENT.CAPTURE.REFUNDED',
        p_refund_amount_cents: 1_000,
        p_currency: 'USD',
        p_audit_details: {},
      },
    );
    expect(corruptTerminalRefund.error).toBeNull();
    await sqlA.begin(async (tx) => {
      await tx`
        UPDATE public.orders SET status = 'refunded'
         WHERE id = ${corruptTerminalFixture.orderId}
      `;
      await tx`
        UPDATE public.payments SET status = 'reversed'
         WHERE id = ${corruptTerminalFixture.paymentId}
      `;
    });
    const corruptTerminalReplay = await supa.rpc(
      'commerce_record_paypal_refund_event',
      {
        p_payment_id: corruptTerminalFixture.paymentId,
        p_order_id: corruptTerminalFixture.orderId,
        p_guild_id: GUILD_A,
        p_customer_id: corruptTerminalFixture.customerId,
        p_paypal_payment_id: corruptTerminalFixture.captureId,
        p_resource_type: 'capture',
        p_paypal_refund_id: corruptTerminalRefundId,
        p_event_type: 'PAYMENT.CAPTURE.REFUNDED',
        p_refund_amount_cents: 1_000,
        p_currency: 'USD',
        p_audit_details: {},
      },
    );
    expect(corruptTerminalReplay.error).toMatchObject({ code: '23514' });
    expect(corruptTerminalReplay.error?.message).toContain(
      'terminal payment ledger requires operator remediation',
    );

    const ambiguousFixture = await createPaidRefundFixture();
    const ambiguousRefund = await supa.rpc('commerce_record_paypal_refund_event', {
      p_payment_id: ambiguousFixture.paymentId,
      p_order_id: ambiguousFixture.orderId,
      p_guild_id: GUILD_A,
      p_customer_id: ambiguousFixture.customerId,
      p_paypal_payment_id: ambiguousFixture.captureId,
      p_resource_type: 'capture',
      p_paypal_refund_id: nextName('ambiguous-refund'),
      p_event_type: 'PAYMENT.CAPTURE.REFUNDED',
      p_refund_amount_cents: null,
      p_currency: null,
      p_audit_details: {},
    });
    expect(ambiguousRefund.error).toMatchObject({ code: '23514' });
    expect(ambiguousRefund.error?.message).toContain('refund money is ambiguous');

    const legacyCurrencyFixture = await createPaidRefundFixture();
    const legacyCurrencyUpdate = await supa
      .from('payments')
      .update({ currency: 'usd' })
      .eq('id', legacyCurrencyFixture.paymentId);
    expect(legacyCurrencyUpdate.error).toBeNull();
    const canonicalizedLegacyCurrency = await supa.rpc(
      'commerce_record_paypal_refund_event',
      {
        p_payment_id: legacyCurrencyFixture.paymentId,
        p_order_id: legacyCurrencyFixture.orderId,
        p_guild_id: GUILD_A,
        p_customer_id: legacyCurrencyFixture.customerId,
        p_paypal_payment_id: legacyCurrencyFixture.captureId,
        p_resource_type: 'capture',
        p_paypal_refund_id: nextName('legacy-lowercase-currency'),
        p_event_type: 'PAYMENT.CAPTURE.REFUNDED',
        p_refund_amount_cents: 1,
        p_currency: 'USD',
        p_audit_details: {},
      },
    );
    expect(canonicalizedLegacyCurrency.error).toBeNull();
    expect(canonicalizedLegacyCurrency.data).toMatchObject({ currency: 'USD' });

    const corruptFixture = await createPaidRefundFixture();
    await expect(
      sqlA`
        INSERT INTO public.payment_refunds (
          payment_id, order_id, guild_id, paypal_refund_id,
          event_type, amount_cents, currency
        ) VALUES (
          ${corruptFixture.paymentId}::UUID,
          ${corruptFixture.orderId}::UUID,
          ${GUILD_A},
          ${nextName('blocked-over-refunded-ledger')},
          'PAYMENT.CAPTURE.REFUNDED',
          1001,
          'USD'
        )
      `,
    ).rejects.toMatchObject({ code: '23514' });
    await sqlA.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`
        INSERT INTO public.payment_refunds (
          payment_id, order_id, guild_id, paypal_refund_id,
          event_type, amount_cents, currency
        ) VALUES (
          ${corruptFixture.paymentId}::UUID,
          ${corruptFixture.orderId}::UUID,
          ${GUILD_A},
          ${nextName('legacy-over-refunded-ledger')},
          'PAYMENT.CAPTURE.REFUNDED',
          1001,
          'USD'
        )
      `;
    });
    const corruptRejected = await supa.rpc('commerce_record_paypal_refund_event', {
      p_payment_id: corruptFixture.paymentId,
      p_order_id: corruptFixture.orderId,
      p_guild_id: GUILD_A,
      p_customer_id: corruptFixture.customerId,
      p_paypal_payment_id: corruptFixture.captureId,
      p_resource_type: 'capture',
      p_paypal_refund_id: nextName('after-corrupt-ledger'),
      p_event_type: 'PAYMENT.CAPTURE.REFUNDED',
      p_refund_amount_cents: 1,
      p_currency: 'USD',
      p_audit_details: {},
    });
    expect(corruptRejected.error).toMatchObject({ code: '23514' });
    expect(corruptRejected.error?.message).toContain(
      'refund ledger requires operator remediation',
    );

    const legacyFullFixture = await createPaidRefundFixture();
    const legacyFullRefundId = nextName('legacy-full-without-terminal-witness');
    await sqlA.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`
        INSERT INTO public.payment_refunds (
          payment_id, order_id, guild_id, paypal_refund_id,
          event_type, amount_cents, currency
        ) VALUES (
          ${legacyFullFixture.paymentId}::UUID,
          ${legacyFullFixture.orderId}::UUID,
          ${GUILD_A},
          ${legacyFullRefundId},
          'PAYMENT.CAPTURE.REFUNDED',
          1000,
          'USD'
        )
      `;
    });
    const legacyFullReplay = await supa.rpc('commerce_record_paypal_refund_event', {
      p_payment_id: legacyFullFixture.paymentId,
      p_order_id: legacyFullFixture.orderId,
      p_guild_id: GUILD_A,
      p_customer_id: legacyFullFixture.customerId,
      p_paypal_payment_id: legacyFullFixture.captureId,
      p_resource_type: 'capture',
      p_paypal_refund_id: legacyFullRefundId,
      p_event_type: 'PAYMENT.CAPTURE.REFUNDED',
      p_refund_amount_cents: 1_000,
      p_currency: 'USD',
      p_audit_details: {},
    });
    expect(legacyFullReplay.error).toMatchObject({ code: '23514' });
    expect(legacyFullReplay.error?.message).toContain(
      'full refund ledger lacks an authorized terminal witness',
    );

    const childFixture = await createPaidRefundFixture();
    const { data: secondPayment, error: secondPaymentError } = await supa
      .from('payments')
      .insert({
        order_id: childFixture.orderId,
        customer_id: childFixture.customerId,
        guild_id: GUILD_A,
        paypal_payment_id: nextName('second-pending-capture'),
        paypal_resource_type: 'capture',
        amount_cents: 1_000,
        currency: 'USD',
        provider: 'paypal',
        status: 'pending',
      })
      .select('id')
      .single();
    expect(secondPaymentError).toBeNull();
    const secondSettledBeforeRefund = await supa
      .from('payments')
      .update({ status: 'completed' })
      .eq('id', secondPayment!.id);
    expect(secondSettledBeforeRefund.error?.code).toBe('23505');

    const childPrepared = await supa.rpc('commerce_prepare_admin_refund', {
      p_order_id: childFixture.orderId,
      p_guild_id: GUILD_A,
      p_actor_id: nextSnowflake(),
      p_reason: 'full child-set invariant',
    });
    expect(childPrepared.error).toBeNull();
    const childAttemptId = String(
      (childPrepared.data as Record<string, unknown>).attempt_id,
    );
    const childRefundId = nextName('child-set-refund');
    const childOutcome = await supa.rpc('commerce_record_admin_refund_outcome', {
      p_attempt_id: childAttemptId,
      p_guild_id: GUILD_A,
      p_provider_status: 'COMPLETED',
      p_paypal_refund_id: childRefundId,
      p_refund_amount_cents: 1_000,
      p_currency: 'USD',
    });
    expect(childOutcome.error).toBeNull();
    const childFinalized = await supa.rpc('commerce_finalize_admin_refund', {
      p_attempt_id: childAttemptId,
      p_guild_id: GUILD_A,
    });
    expect(childFinalized.error).toBeNull();
    const secondSettledAfterRefund = await supa
      .from('payments')
      .update({ status: 'completed' })
      .eq('id', secondPayment!.id);
    expect(['23503', '23505']).toContain(secondSettledAfterRefund.error?.code);
  });

  it('requires exact positive frozen parent finances and the capture/sale order family in record and finalize', async () => {
    const corruptCapture = await createPaidRefundFixture();
    const shrinkCapture = await supa
      .from('payments')
      .update({ amount_cents: 1 })
      .eq('id', corruptCapture.paymentId);
    expect(shrinkCapture.error).toBeNull();
    const corruptCaptureRecord = await supa.rpc('commerce_record_paypal_refund_event', {
      p_payment_id: corruptCapture.paymentId,
      p_order_id: corruptCapture.orderId,
      p_guild_id: GUILD_A,
      p_customer_id: corruptCapture.customerId,
      p_paypal_payment_id: corruptCapture.captureId,
      p_resource_type: 'capture',
      p_paypal_refund_id: nextName('corrupt-capture-parent-refund'),
      p_event_type: 'PAYMENT.CAPTURE.REFUNDED',
      p_refund_amount_cents: 1,
      p_currency: 'USD',
      p_audit_details: { matrix: 'capture-parent-amount' },
    });
    expect(corruptCaptureRecord.error).toMatchObject({ code: '23514' });
    expect(corruptCaptureRecord.error?.message).toContain('payment identity or state mismatch');

    const corruptCaptureFinalize = await createPaidRefundFixture();
    const captureFinalizeRefundId = nextName('capture-finalize-parent-refund');
    const captureRecorded = await supa.rpc('commerce_record_paypal_refund_event', {
      p_payment_id: corruptCaptureFinalize.paymentId,
      p_order_id: corruptCaptureFinalize.orderId,
      p_guild_id: GUILD_A,
      p_customer_id: corruptCaptureFinalize.customerId,
      p_paypal_payment_id: corruptCaptureFinalize.captureId,
      p_resource_type: 'capture',
      p_paypal_refund_id: captureFinalizeRefundId,
      p_event_type: 'PAYMENT.CAPTURE.REFUNDED',
      p_refund_amount_cents: 1_000,
      p_currency: 'USD',
      p_audit_details: { matrix: 'capture-finalize-parent' },
    });
    expect(captureRecorded.error).toBeNull();
    const corruptCaptureCurrency = await supa
      .from('payments')
      .update({ currency: 'EUR' })
      .eq('id', corruptCaptureFinalize.paymentId);
    expect(corruptCaptureCurrency.error).toBeNull();
    const captureFinalize = await supa.rpc('commerce_finalize_paypal_refund_status', {
      p_payment_id: corruptCaptureFinalize.paymentId,
      p_order_id: corruptCaptureFinalize.orderId,
      p_guild_id: GUILD_A,
      p_customer_id: corruptCaptureFinalize.customerId,
      p_paypal_payment_id: corruptCaptureFinalize.captureId,
      p_resource_type: 'capture',
      p_payment_status: 'refunded',
      p_paypal_refund_id: captureFinalizeRefundId,
      p_event_type: 'PAYMENT.CAPTURE.REFUNDED',
      p_audit_details: { matrix: 'capture-finalize-parent' },
    });
    expect(captureFinalize.error).toMatchObject({ code: '23514' });
    expect(captureFinalize.error?.message).toContain('payment identity or state mismatch');

    const sale = await createSaleRefundFixture();
    const saleRefundId = nextName('sale-family-refund');
    const saleRecord = await supa.rpc('commerce_record_paypal_refund_event', {
      p_payment_id: sale.paymentId,
      p_order_id: sale.orderId,
      p_guild_id: GUILD_A,
      p_customer_id: sale.customerId,
      p_paypal_payment_id: sale.saleId,
      p_resource_type: 'sale',
      p_paypal_refund_id: saleRefundId,
      p_event_type: 'PAYMENT.SALE.REFUNDED',
      p_refund_amount_cents: 500,
      p_currency: 'USD',
      p_audit_details: { matrix: 'sale-positive' },
    });
    expect(saleRecord.error).toBeNull();
    expect(saleRecord.data).toMatchObject({ full_refund: true, terminal_witness: true });
    const saleFinalize = await supa.rpc('commerce_finalize_paypal_refund_status', {
      p_payment_id: sale.paymentId,
      p_order_id: sale.orderId,
      p_guild_id: GUILD_A,
      p_customer_id: sale.customerId,
      p_paypal_payment_id: sale.saleId,
      p_resource_type: 'sale',
      p_payment_status: 'refunded',
      p_paypal_refund_id: saleRefundId,
      p_event_type: 'PAYMENT.SALE.REFUNDED',
      p_audit_details: { matrix: 'sale-positive' },
    });
    expect(saleFinalize.error).toBeNull();

    const corruptSale = await createSaleRefundFixture();
    const shrinkSale = await supa
      .from('payments')
      .update({ amount_cents: 1 })
      .eq('id', corruptSale.paymentId);
    expect(shrinkSale.error).toBeNull();
    const corruptSaleRecord = await supa.rpc('commerce_record_paypal_refund_event', {
      p_payment_id: corruptSale.paymentId,
      p_order_id: corruptSale.orderId,
      p_guild_id: GUILD_A,
      p_customer_id: corruptSale.customerId,
      p_paypal_payment_id: corruptSale.saleId,
      p_resource_type: 'sale',
      p_paypal_refund_id: nextName('corrupt-sale-parent-refund'),
      p_event_type: 'PAYMENT.SALE.REFUNDED',
      p_refund_amount_cents: 1,
      p_currency: 'USD',
      p_audit_details: { matrix: 'sale-parent-amount' },
    });
    expect(corruptSaleRecord.error).toMatchObject({ code: '23514' });

    const malformedSale = await createSaleRefundFixture();
    // plan_id is immutable after the grant-snapshot freeze, so this legacy
    // corruption is installed as replica-mode fixture surgery like the
    // foreign-plan case below.
    await sqlA.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`
        UPDATE public.orders
           SET plan_id = NULL
         WHERE id = ${malformedSale.orderId}::UUID
      `;
    });
    const malformedSaleRecord = await supa.rpc('commerce_record_paypal_refund_event', {
      p_payment_id: malformedSale.paymentId,
      p_order_id: malformedSale.orderId,
      p_guild_id: GUILD_A,
      p_customer_id: malformedSale.customerId,
      p_paypal_payment_id: malformedSale.saleId,
      p_resource_type: 'sale',
      p_paypal_refund_id: nextName('malformed-sale-family-refund'),
      p_event_type: 'PAYMENT.SALE.REFUNDED',
      p_refund_amount_cents: 500,
      p_currency: 'USD',
      p_audit_details: { matrix: 'sale-family' },
    });
    expect(malformedSaleRecord.error).toMatchObject({ code: '23514' });
    expect(malformedSaleRecord.error?.message).toContain('payment identity or state mismatch');

    const malformedCapture = await createPaidRefundFixture();
    const subscriptionProductId = await createProduct({ type: 'subscription' });
    const foreignPlanId = await createPlan(subscriptionProductId);
    await sqlA.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`UPDATE public.orders SET plan_id = ${foreignPlanId}::UUID WHERE id = ${malformedCapture.orderId}::UUID`;
    });
    const malformedCaptureRecord = await supa.rpc('commerce_record_paypal_refund_event', {
      p_payment_id: malformedCapture.paymentId,
      p_order_id: malformedCapture.orderId,
      p_guild_id: GUILD_A,
      p_customer_id: malformedCapture.customerId,
      p_paypal_payment_id: malformedCapture.captureId,
      p_resource_type: 'capture',
      p_paypal_refund_id: nextName('malformed-capture-family-refund'),
      p_event_type: 'PAYMENT.CAPTURE.REFUNDED',
      p_refund_amount_cents: 1_000,
      p_currency: 'USD',
      p_audit_details: { matrix: 'capture-family' },
    });
    expect(malformedCaptureRecord.error).toMatchObject({ code: '23514' });
  });

  it('rejects every noncanonical PayPal payment/refund id at the database boundary', async () => {
    const fixture = await createPaidRefundFixture();
    const invalidIds = [
      '',
      '-bad-first',
      'bad:colon',
      'bad/slash',
      'bad space',
      ' bad-leading',
      'bad-trailing ',
      `bad${String.fromCharCode(1)}control`,
      'bäd-unicode',
      'A'.repeat(256),
    ];
    for (const [index, invalidId] of invalidIds.entries()) {
      const invalidPayment = await supa.rpc('commerce_record_paypal_refund_event', {
        p_payment_id: fixture.paymentId,
        p_order_id: fixture.orderId,
        p_guild_id: GUILD_A,
        p_customer_id: fixture.customerId,
        p_paypal_payment_id: invalidId,
        p_resource_type: 'capture',
        p_paypal_refund_id: nextName(`canonical-refund-${index}`),
        p_event_type: 'PAYMENT.CAPTURE.REFUNDED',
        p_refund_amount_cents: 1,
        p_currency: 'USD',
        p_audit_details: { matrix: 'invalid-payment-id' },
      });
      expect(invalidPayment.error).toMatchObject({ code: '23514' });

      const invalidRefund = await supa.rpc('commerce_record_paypal_refund_event', {
        p_payment_id: fixture.paymentId,
        p_order_id: fixture.orderId,
        p_guild_id: GUILD_A,
        p_customer_id: fixture.customerId,
        p_paypal_payment_id: fixture.captureId,
        p_resource_type: 'capture',
        p_paypal_refund_id: invalidId,
        p_event_type: 'PAYMENT.CAPTURE.REFUNDED',
        p_refund_amount_cents: 1,
        p_currency: 'USD',
        p_audit_details: { matrix: 'invalid-refund-id' },
      });
      expect(invalidRefund.error).toMatchObject({ code: '23514' });
    }

    const prepared = await supa.rpc('commerce_prepare_admin_refund', {
      p_order_id: fixture.orderId,
      p_guild_id: GUILD_A,
      p_actor_id: nextSnowflake(),
      p_reason: 'canonical admin provider id',
    });
    expect(prepared.error).toBeNull();
    const attemptId = String((prepared.data as Record<string, unknown>).attempt_id);
    for (const invalidId of invalidIds) {
      const invalidOutcome = await supa.rpc('commerce_record_admin_refund_outcome', {
        p_attempt_id: attemptId,
        p_guild_id: GUILD_A,
        p_provider_status: 'COMPLETED',
        p_paypal_refund_id: invalidId,
        p_refund_amount_cents: 1_000,
        p_currency: 'USD',
      });
      expect(invalidOutcome.error).toMatchObject({ code: '23514' });
    }

    const nullOrderFixture = await createPaidRefundFixture();
    // paypal_order_id is immutable after the grant-snapshot freeze; a legacy
    // NULL provider order id is fabricated as replica-mode fixture surgery.
    await sqlA.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`
        UPDATE public.orders
           SET paypal_order_id = NULL
         WHERE id = ${nullOrderFixture.orderId}::UUID
      `;
    });
    const nullOrderPrepared = await supa.rpc('commerce_prepare_admin_refund', {
      p_order_id: nullOrderFixture.orderId,
      p_guild_id: GUILD_A,
      p_actor_id: nextSnowflake(),
      p_reason: 'legacy null PayPal order id remains supported',
    });
    expect(nullOrderPrepared.error).toBeNull();
    expect(nullOrderPrepared.data).toMatchObject({
      status: 'prepared',
      provider_action: 'create',
      paypal_payment_id: nullOrderFixture.captureId,
    });
  });

  it('normalizes legacy lowercase payment currency but rejects malformed admin payment currency in both phases', async () => {
    const lowercaseFixture = await createPaidRefundFixture();
    const lowercaseUpdate = await supa
      .from('payments')
      .update({ currency: 'usd' })
      .eq('id', lowercaseFixture.paymentId);
    expect(lowercaseUpdate.error).toBeNull();
    const lowercasePrepared = await supa.rpc('commerce_prepare_admin_refund', {
      p_order_id: lowercaseFixture.orderId,
      p_guild_id: GUILD_A,
      p_actor_id: nextSnowflake(),
      p_reason: 'legacy lowercase payment currency',
    });
    expect(lowercasePrepared.error).toBeNull();
    const lowercaseAttemptId = String(
      (lowercasePrepared.data as Record<string, unknown>).attempt_id,
    );
    const lowercaseRefundId = nextName('lowercase-admin-refund');
    const lowercaseOutcome = await supa.rpc('commerce_record_admin_refund_outcome', {
      p_attempt_id: lowercaseAttemptId,
      p_guild_id: GUILD_A,
      p_provider_status: 'COMPLETED',
      p_paypal_refund_id: lowercaseRefundId,
      p_refund_amount_cents: 1_000,
      p_currency: 'USD',
    });
    expect(lowercaseOutcome.error).toBeNull();
    const lowercaseFinalized = await supa.rpc('commerce_finalize_admin_refund', {
      p_attempt_id: lowercaseAttemptId,
      p_guild_id: GUILD_A,
    });
    expect(lowercaseFinalized.error).toBeNull();
    expect(lowercaseFinalized.data).toMatchObject({
      status: 'completed',
      order_status: 'refunded',
      paypal_refund_id: lowercaseRefundId,
    });

    for (const storedCurrency of [' usd', 'US', 'U1D']) {
      const fixture = await createPaidRefundFixture();
      const malformedUpdate = await supa
        .from('payments')
        .update({ currency: storedCurrency })
        .eq('id', fixture.paymentId);
      expect(malformedUpdate.error).toBeNull();
      const rejectedPrepare = await supa.rpc('commerce_prepare_admin_refund', {
        p_order_id: fixture.orderId,
        p_guild_id: GUILD_A,
        p_actor_id: nextSnowflake(),
        p_reason: `reject malformed stored currency ${JSON.stringify(storedCurrency)}`,
      });
      expect(rejectedPrepare.error).toMatchObject({ code: '23514' });
      expect(rejectedPrepare.error?.message).toContain(
        'payment capture set requires operator remediation',
      );
    }

    for (const storedCurrency of ['USD ', 'EURO']) {
      const fixture = await createPaidRefundFixture();
      const prepared = await supa.rpc('commerce_prepare_admin_refund', {
        p_order_id: fixture.orderId,
        p_guild_id: GUILD_A,
        p_actor_id: nextSnowflake(),
        p_reason: 'finalizer independently revalidates stored currency',
      });
      expect(prepared.error).toBeNull();
      const attemptId = String((prepared.data as Record<string, unknown>).attempt_id);
      const outcome = await supa.rpc('commerce_record_admin_refund_outcome', {
        p_attempt_id: attemptId,
        p_guild_id: GUILD_A,
        p_provider_status: 'COMPLETED',
        p_paypal_refund_id: nextName('malformed-finalize-currency-refund'),
        p_refund_amount_cents: 1_000,
        p_currency: 'USD',
      });
      expect(outcome.error).toBeNull();
      const malformedUpdate = await supa
        .from('payments')
        .update({ currency: storedCurrency })
        .eq('id', fixture.paymentId);
      expect(malformedUpdate.error).toBeNull();
      const rejectedFinalize = await supa.rpc('commerce_finalize_admin_refund', {
        p_attempt_id: attemptId,
        p_guild_id: GUILD_A,
      });
      expect(rejectedFinalize.error).toMatchObject({ code: '23514' });
      expect(rejectedFinalize.error?.message).toContain('payment capture set changed');
      expect(
        await sqlA<{ operation_status: string; order_status: string; payment_status: string }[]>`
          SELECT operation.status AS operation_status,
                 paid_order.status AS order_status,
                 payment.status AS payment_status
            FROM public.commerce_admin_refund_operations AS operation
            JOIN public.orders AS paid_order ON paid_order.id = operation.order_id
            JOIN public.payments AS payment ON payment.id = operation.payment_id
           WHERE operation.attempt_id = ${attemptId}::UUID
        `,
      ).toEqual([{
        operation_status: 'provider_completed',
        order_status: 'completed',
        payment_status: 'completed',
      }]);
    }
  });

  it('requires the selected admin capture to be the complete payment set in prepare and finalize', async () => {
    const insertPendingSibling = async (fixture: PaidRefundFixture): Promise<void> => {
      const sibling = await supa.from('payments').insert({
        order_id: fixture.orderId,
        customer_id: fixture.customerId,
        guild_id: GUILD_A,
        paypal_payment_id: nextName('pending-sibling-capture'),
        paypal_resource_type: 'capture',
        amount_cents: 1_000,
        currency: 'USD',
        provider: 'paypal',
        status: 'pending',
      });
      expect(sibling.error).toBeNull();
    };

    const prepareFixture = await createPaidRefundFixture();
    await insertPendingSibling(prepareFixture);
    const rejectedPrepare = await supa.rpc('commerce_prepare_admin_refund', {
      p_order_id: prepareFixture.orderId,
      p_guild_id: GUILD_A,
      p_actor_id: nextSnowflake(),
      p_reason: 'hidden pending sibling at prepare',
    });
    expect(rejectedPrepare.error).toMatchObject({ code: '23514' });
    expect(rejectedPrepare.error?.message).toContain(
      'payment capture set requires operator remediation',
    );

    const finalizeFixture = await createPaidRefundFixture();
    const prepared = await supa.rpc('commerce_prepare_admin_refund', {
      p_order_id: finalizeFixture.orderId,
      p_guild_id: GUILD_A,
      p_actor_id: nextSnowflake(),
      p_reason: 'hidden pending sibling at finalize',
    });
    expect(prepared.error).toBeNull();
    const attemptId = String((prepared.data as Record<string, unknown>).attempt_id);
    const outcome = await supa.rpc('commerce_record_admin_refund_outcome', {
      p_attempt_id: attemptId,
      p_guild_id: GUILD_A,
      p_provider_status: 'COMPLETED',
      p_paypal_refund_id: nextName('pending-sibling-admin-refund'),
      p_refund_amount_cents: 1_000,
      p_currency: 'USD',
    });
    expect(outcome.error).toBeNull();
    await insertPendingSibling(finalizeFixture);
    const rejectedFinalize = await supa.rpc('commerce_finalize_admin_refund', {
      p_attempt_id: attemptId,
      p_guild_id: GUILD_A,
    });
    expect(rejectedFinalize.error).toMatchObject({ code: '23514' });
    expect(rejectedFinalize.error?.message).toContain('payment capture set changed');
  });

  it('rejects inverse target-entitlement to foreign-key provenance before admin prepare and finalize', async () => {
    const corruptInverseLink = async (
      target: PaidRefundFixture,
      foreign: PaidRefundFixture,
    ): Promise<void> => {
      await sqlA.begin(async (tx) => {
        await tx`SET LOCAL session_replication_role = replica`;
        await tx`
          UPDATE public.entitlements
             SET license_key_id = ${foreign.licenseKeyId}::UUID
           WHERE id = ${target.entitlementId}::UUID
        `;
      });
    };

    const prepareTarget = await createPaidRefundFixture({ withAccess: true });
    const prepareForeign = await createPaidRefundFixture({ withAccess: true });
    await corruptInverseLink(prepareTarget, prepareForeign);
    const rejectedPrepare = await supa.rpc('commerce_prepare_admin_refund', {
      p_order_id: prepareTarget.orderId,
      p_guild_id: GUILD_A,
      p_actor_id: nextSnowflake(),
      p_reason: 'inverse cross-link prepare rejection',
    });
    expect(rejectedPrepare.error).toMatchObject({ code: '23514' });
    expect(rejectedPrepare.error?.message).toContain('access provenance mismatch');
    expect(
      await sqlA<{ count: number }[]>`
        SELECT pg_catalog.count(*)::INTEGER AS count
          FROM public.commerce_admin_refund_operations
         WHERE order_id = ${prepareTarget.orderId}::UUID
      `,
    ).toEqual([{ count: 0 }]);

    const finalizeTarget = await createPaidRefundFixture({ withAccess: true });
    const finalizeForeign = await createPaidRefundFixture({ withAccess: true });
    const prepared = await supa.rpc('commerce_prepare_admin_refund', {
      p_order_id: finalizeTarget.orderId,
      p_guild_id: GUILD_A,
      p_actor_id: nextSnowflake(),
      p_reason: 'inverse cross-link finalizer rejection',
    });
    expect(prepared.error).toBeNull();
    const attemptId = String((prepared.data as Record<string, unknown>).attempt_id);
    const outcome = await supa.rpc('commerce_record_admin_refund_outcome', {
      p_attempt_id: attemptId,
      p_guild_id: GUILD_A,
      p_provider_status: 'COMPLETED',
      p_paypal_refund_id: nextName('inverse-cross-link-admin-refund'),
      p_refund_amount_cents: 1_000,
      p_currency: 'USD',
    });
    expect(outcome.error).toBeNull();
    await corruptInverseLink(finalizeTarget, finalizeForeign);
    const rejectedFinalize = await supa.rpc('commerce_finalize_admin_refund', {
      p_attempt_id: attemptId,
      p_guild_id: GUILD_A,
    });
    expect(rejectedFinalize.error).toMatchObject({ code: '23514' });
    expect(rejectedFinalize.error?.message).toContain('access provenance mismatch');
    expect(
      await sqlA<{
        operation_status: string;
        order_status: string;
        payment_status: string;
        entitlement_status: string;
        refund_count: number;
      }[]>`
        SELECT operation.status AS operation_status,
               paid_order.status AS order_status,
               payment.status AS payment_status,
               entitlement.status AS entitlement_status,
               (
                 SELECT pg_catalog.count(*)::INTEGER
                   FROM public.payment_refunds AS refund
                  WHERE refund.payment_id = payment.id
               ) AS refund_count
          FROM public.commerce_admin_refund_operations AS operation
          JOIN public.orders AS paid_order ON paid_order.id = operation.order_id
          JOIN public.payments AS payment ON payment.id = operation.payment_id
          JOIN public.entitlements AS entitlement ON entitlement.id = ${finalizeTarget.entitlementId}::UUID
         WHERE operation.attempt_id = ${attemptId}::UUID
      `,
    ).toEqual([{
      operation_status: 'provider_completed',
      order_status: 'completed',
      payment_status: 'completed',
      entitlement_status: 'active',
      refund_count: 0,
    }]);
  });

  it('fails closed on every legacy access-provenance corruption in both record and finalize', async () => {
    type Corruption = 'wrong-guild' | 'wrong-customer' | 'wrong-product' | 'cross-link';
    const corruptions: Corruption[] = [
      'wrong-guild',
      'wrong-customer',
      'wrong-product',
      'cross-link',
    ];

    for (const phase of ['record', 'finalize'] as const) {
      for (const corruption of corruptions) {
        const fixture = await createPaidRefundFixture({ withAccess: true });
        const foreign = await createPaidRefundFixture({ withAccess: true });
        const refundId = nextName(`${phase}-${corruption}-legacy-refund`);
        if (phase === 'finalize') {
          const recorded = await supa.rpc('commerce_record_paypal_refund_event', {
            p_payment_id: fixture.paymentId,
            p_order_id: fixture.orderId,
            p_guild_id: GUILD_A,
            p_customer_id: fixture.customerId,
            p_paypal_payment_id: fixture.captureId,
            p_resource_type: 'capture',
            p_paypal_refund_id: refundId,
            p_event_type: 'PAYMENT.CAPTURE.REFUNDED',
            p_refund_amount_cents: 1_000,
            p_currency: 'USD',
            p_audit_details: { matrix: 'legacy-provenance-finalize' },
          });
          expect(recorded.error).toBeNull();
        }

        await sqlA.begin(async (tx) => {
          await tx`SET LOCAL session_replication_role = replica`;
          if (corruption === 'wrong-guild') {
            await tx`UPDATE public.entitlements SET guild_id = ${GUILD_B} WHERE id = ${fixture.entitlementId}::UUID`;
          } else if (corruption === 'wrong-customer') {
            await tx`UPDATE public.license_keys SET customer_id = ${foreign.customerId}::UUID WHERE id = ${fixture.licenseKeyId}::UUID`;
          } else if (corruption === 'wrong-product') {
            await tx`UPDATE public.entitlements SET product_id = ${foreign.productId}::UUID WHERE id = ${fixture.entitlementId}::UUID`;
          } else {
            await tx`UPDATE public.entitlements SET license_key_id = ${foreign.licenseKeyId}::UUID WHERE id = ${fixture.entitlementId}::UUID`;
          }
        });

        const result = phase === 'record'
          ? await supa.rpc('commerce_record_paypal_refund_event', {
              p_payment_id: fixture.paymentId,
              p_order_id: fixture.orderId,
              p_guild_id: GUILD_A,
              p_customer_id: fixture.customerId,
              p_paypal_payment_id: fixture.captureId,
              p_resource_type: 'capture',
              p_paypal_refund_id: refundId,
              p_event_type: 'PAYMENT.CAPTURE.REFUNDED',
              p_refund_amount_cents: 1_000,
              p_currency: 'USD',
              p_audit_details: { matrix: 'legacy-provenance-record' },
            })
          : await supa.rpc('commerce_finalize_paypal_refund_status', {
              p_payment_id: fixture.paymentId,
              p_order_id: fixture.orderId,
              p_guild_id: GUILD_A,
              p_customer_id: fixture.customerId,
              p_paypal_payment_id: fixture.captureId,
              p_resource_type: 'capture',
              p_payment_status: 'refunded',
              p_paypal_refund_id: refundId,
              p_event_type: 'PAYMENT.CAPTURE.REFUNDED',
              p_audit_details: { matrix: 'legacy-provenance-finalize' },
            });
        expect(result.error).toMatchObject({ code: '23514' });
        expect(result.error?.message).toContain('access provenance requires operator remediation');
        const [state] = await sqlA<{
          order_status: string;
          payment_status: string;
          refund_count: number;
        }[]>`
          SELECT paid_order.status AS order_status,
                 payment.status AS payment_status,
                 (
                   SELECT pg_catalog.count(*)::INTEGER
                     FROM public.payment_refunds AS refund
                    WHERE refund.paypal_refund_id = ${refundId}
                 ) AS refund_count
            FROM public.orders AS paid_order
            JOIN public.payments AS payment ON payment.id = ${fixture.paymentId}::UUID
           WHERE paid_order.id = ${fixture.orderId}::UUID
        `;
        expect(state).toEqual({
          order_status: 'completed',
          payment_status: 'completed',
          refund_count: phase === 'record' ? 0 : 1,
        });
      }
    }

    const sale = await createSaleRefundFixture({ withAccess: true });
    const foreignSale = await createSaleRefundFixture({ withAccess: true });
    await sqlA.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`UPDATE public.entitlements SET plan_id = ${foreignSale.planId}::UUID WHERE id = ${sale.entitlementId}::UUID`;
    });
    const saleResult = await supa.rpc('commerce_record_paypal_refund_event', {
      p_payment_id: sale.paymentId,
      p_order_id: sale.orderId,
      p_guild_id: GUILD_A,
      p_customer_id: sale.customerId,
      p_paypal_payment_id: sale.saleId,
      p_resource_type: 'sale',
      p_paypal_refund_id: nextName('sale-plan-provenance-refund'),
      p_event_type: 'PAYMENT.SALE.REFUNDED',
      p_refund_amount_cents: 500,
      p_currency: 'USD',
      p_audit_details: { matrix: 'sale-plan-provenance' },
    });
    expect(saleResult.error).toMatchObject({ code: '23514' });
    expect(saleResult.error?.message).toContain('access provenance requires operator remediation');
  });

  it('serializes partial-alert creation before a competing full refund and resolves it at the terminal marker', async () => {
    const fixture = await createPaidRefundFixture();
    const partialRefundId = nextName('interleaved-partial-refund');
    const fullRefundId = nextName('interleaved-full-refund');
    const partialStarted = makeGate();
    const releasePartial = makeGate();
    let partialError: unknown;
    // The audit payloads below are inline JSONB literals: postgres.js
    // re-serializes a pre-stringified JSON string parameter once the described
    // parameter type is jsonb, which double-encodes it into a JSONB string and
    // trips the RPC's fail-closed object-shape check.
    const partialTransaction = sqlA.begin(async (tx) => {
      await tx`
        SELECT public.commerce_record_paypal_refund_event(
          ${fixture.paymentId}::UUID,
          ${fixture.orderId}::UUID,
          ${GUILD_A},
          ${fixture.customerId}::UUID,
          ${fixture.captureId},
          'capture',
          ${partialRefundId},
          'PAYMENT.CAPTURE.REFUNDED',
          250,
          'USD',
          '{"test_case":"interleaved partial"}'::JSONB
        )
      `;
      partialStarted.open();
      await releasePartial.promise;
    }).catch((error: unknown) => {
      partialError = error;
      partialStarted.open();
      releasePartial.open();
    });
    await partialStarted.promise;
    if (partialError) throw partialError;

    const fullRecord = sqlB<{ result: Record<string, unknown> }[]>`
      SELECT public.commerce_record_paypal_refund_event(
        ${fixture.paymentId}::UUID,
        ${fixture.orderId}::UUID,
        ${GUILD_A},
        ${fixture.customerId}::UUID,
        ${fixture.captureId},
        'capture',
        ${fullRefundId},
        'PAYMENT.CAPTURE.REFUNDED',
        750,
        'USD',
        '{"test_case":"interleaved full"}'::JSONB
      ) AS result
    `.then(
      (rows) => ({ rows, error: null as unknown }),
      (error: unknown) => ({ rows: [], error }),
    );
    try {
      await waitForDatabaseLock(
        sqlBBackendPid,
        'full refund competing with uncommitted partial audit and alert',
      );
    } finally {
      releasePartial.open();
    }
    await partialTransaction;
    if (partialError) throw partialError;
    const fullRecordResult = await fullRecord;
    if (fullRecordResult.error) throw fullRecordResult.error;
    expect(fullRecordResult.rows[0]?.result).toMatchObject({
      refund_amount_cents: 750,
      cumulative_refunded_cents: 1_000,
      full_refund: true,
      terminal_witness: true,
      partial_audit_recorded: false,
      partial_alert_recorded: false,
    });

    const finalized = await supa.rpc('commerce_finalize_paypal_refund_status', {
      p_payment_id: fixture.paymentId,
      p_order_id: fixture.orderId,
      p_guild_id: GUILD_A,
      p_customer_id: fixture.customerId,
      p_paypal_payment_id: fixture.captureId,
      p_resource_type: 'capture',
      p_payment_status: 'refunded',
      p_paypal_refund_id: fullRefundId,
      p_event_type: 'PAYMENT.CAPTURE.REFUNDED',
      p_audit_details: { refund_amount_cents: 750 },
    });
    expect(finalized.error).toBeNull();
    expect(finalized.data).toMatchObject({ partial_alerts_resolved: 1 });
    const [alertState] = await sqlA<{ count: number; unresolved: number }[]>`
      SELECT pg_catalog.count(*)::INTEGER AS count,
             pg_catalog.count(*) FILTER (WHERE NOT resolved)::INTEGER AS unresolved
        FROM public.alerts
       WHERE guild_id = ${GUILD_A}
         AND alert_type = 'partial_refund_review'
         AND metadata ->> 'payment_id' = ${fixture.paymentId}
    `;
    expect(alertState).toEqual({ count: 1, unresolved: 0 });
  });

  it('returns locked terminal replay proof to a loser that loaded completed state', async () => {
    const fixture = await createPaidRefundFixture();
    const refundId = nextName('concurrent-terminal-replay');
    const terminalPrepared = makeGate();
    const releaseTerminal = makeGate();
    let terminalError: unknown;
    const terminalTransaction = sqlA.begin(async (tx) => {
      await tx`
        SELECT public.commerce_record_paypal_refund_event(
          ${fixture.paymentId}::UUID,
          ${fixture.orderId}::UUID,
          ${GUILD_A},
          ${fixture.customerId}::UUID,
          ${fixture.captureId},
          'capture',
          ${refundId},
          'PAYMENT.CAPTURE.REFUNDED',
          1000,
          'USD',
          '{}'::JSONB
        )
      `;
      await tx`
        SELECT public.commerce_finalize_paypal_refund_status(
          ${fixture.paymentId}::UUID,
          ${fixture.orderId}::UUID,
          ${GUILD_A},
          ${fixture.customerId}::UUID,
          ${fixture.captureId},
          'capture',
          'refunded',
          ${refundId},
          'PAYMENT.CAPTURE.REFUNDED',
          '{}'::JSONB
        )
      `;
      terminalPrepared.open();
      await releaseTerminal.promise;
    }).catch((error: unknown) => {
      terminalError = error;
      terminalPrepared.open();
      releaseTerminal.open();
    });
    await terminalPrepared.promise;
    if (terminalError) throw terminalError;

    const losingReplay = sqlB<{ result: Record<string, unknown> }[]>`
      SELECT public.commerce_record_paypal_refund_event(
        ${fixture.paymentId}::UUID,
        ${fixture.orderId}::UUID,
        ${GUILD_A},
        ${fixture.customerId}::UUID,
        ${fixture.captureId},
        'capture',
        ${refundId},
        'PAYMENT.CAPTURE.REFUNDED',
        1000,
        'USD',
        '{}'::JSONB
      ) AS result
    `.then(
      (rows) => ({ rows, error: null as unknown }),
      (error: unknown) => ({ rows: [], error }),
    );
    try {
      await waitForDatabaseLock(
        sqlBBackendPid,
        'exact replay competing with an uncommitted terminal finalization',
      );
    } finally {
      releaseTerminal.open();
    }
    await terminalTransaction;
    if (terminalError) throw terminalError;
    const losingReplayResult = await losingReplay;
    if (losingReplayResult.error) throw losingReplayResult.error;
    expect(losingReplayResult.rows[0]?.result).toMatchObject({
      already_recorded: true,
      terminal_witness: true,
      terminal_history_consistent: true,
      terminal_history_replay: true,
      terminal_payment_status: 'refunded',
    });
  });

  it('uses frozen order/capture identity after the catalog product is moved and retyped', async () => {
    const fixture = await createPaidRefundFixture();
    const deactivate = await supa
      .from('products')
      .update({ active: false })
      .eq('id', fixture.productId);
    expect(deactivate.error).toBeNull();
    const retypeAndMove = await supa
      .from('products')
      .update({ type: 'subscription', guild_id: GUILD_B })
      .eq('id', fixture.productId);
    expect(retypeAndMove.error).toBeNull();

    const prepared = await supa.rpc('commerce_prepare_admin_refund', {
      p_order_id: fixture.orderId,
      p_guild_id: GUILD_A,
      p_actor_id: nextSnowflake(),
      p_reason: 'historical one-time capture remains refundable',
    });
    expect(prepared.error).toBeNull();
    expect(prepared.data).toMatchObject({
      order_id: fixture.orderId,
      status: 'prepared',
      provider_action: 'create',
      resource_type: 'capture',
      paypal_payment_id: fixture.captureId,
      refund_amount_cents: 1_000,
    });
  });

  it('revokes local zero-value access without fabricating broad role-removal ownership', async () => {
    const roleId = nextSnowflake();
    const actorId = nextSnowflake();
    const discordId = nextSnowflake();
    const productId = await createProduct({ granted_role_ids: [roleId] });
    const { data: customer, error: customerError } = await supa
      .from('customers')
      .insert({
        guild_id: GUILD_A,
        discord_id: discordId,
        discord_username: nextName('local-refund-customer'),
      })
      .select('id')
      .single();
    expect(customerError).toBeNull();
    const { data: order, error: orderError } = await supa
      .from('orders')
      .insert({
        order_number: nextName('local-refund-order'),
        customer_id: customer!.id,
        guild_id: GUILD_A,
        product_id: productId,
        amount_cents: 0,
        currency: 'USD',
        source: 'manual',
        status: 'completed',
      })
      .select('id')
      .single();
    expect(orderError).toBeNull();
    const { data: licenseKey, error: licenseError } = await supa
      .from('license_keys')
      .insert({
        order_id: order!.id,
        customer_id: customer!.id,
        product_id: productId,
        guild_id: GUILD_A,
        key_hash: nextName('local-refund-key'),
        key_prefix: 'TEST',
        key_suffix: nextName('local-refund-suffix'),
        bound_discord_id: discordId,
        status: 'active',
      })
      .select('id')
      .single();
    expect(licenseError).toBeNull();
    const { data: entitlement, error: entitlementError } = await supa
      .from('entitlements')
      .insert({
        customer_id: customer!.id,
        guild_id: GUILD_A,
        product_id: productId,
        license_key_id: licenseKey!.id,
        order_id: order!.id,
        type: 'one_time',
        status: 'active',
        source: 'manual',
        granted_role_ids: [roleId],
        granted_channel_ids: [],
      })
      .select('id')
      .single();
    expect(entitlementError).toBeNull();

    const prepared = await supa.rpc('commerce_prepare_admin_refund', {
      p_order_id: order!.id,
      p_guild_id: GUILD_A,
      p_actor_id: actorId,
      p_reason: 'local access reversal',
    });
    expect(prepared.error).toBeNull();
    const attemptId = String((prepared.data as Record<string, unknown>).attempt_id);
    expect(prepared.data).toMatchObject({
      order_id: order!.id,
      attempt_id: attemptId,
      request_id: attemptId,
      status: 'prepared',
      provider_action: 'finalize',
      resource_type: null,
      paypal_payment_id: null,
      paypal_refund_id: null,
      refund_amount_cents: 0,
      actor_id: actorId,
    });

    const finalized = await supa.rpc('commerce_finalize_admin_refund', {
      p_attempt_id: attemptId,
      p_guild_id: GUILD_A,
    });
    expect(finalized.error).toBeNull();
    expect(finalized.data).toMatchObject({
      attempt_id: attemptId,
      status: 'completed',
      paypal_refund_id: null,
      entitlements_changed: 1,
      licenses_changed: 1,
    });
    const { data: revokeRows, error: revokeError } = await supa
      .from('bot_action_queue')
      .select('payload')
      .eq('guild_id', GUILD_A)
      .eq('action', 'revoke_roles')
      .contains('payload', { entitlement_id: entitlement!.id });
    expect(revokeError).toBeNull();
    // The noncommerce lifecycle protocol records durable carriers for the
    // manual-source entitlement: one activation carrier bound at insert and
    // one terminal carrier when the refund expired the entitlement. Both are
    // scoped to the exact entitlement and its activation-proven role. The
    // commerce refund path must not add any broader revoke_roles authority.
    const revokePayloads = (revokeRows ?? [])
      .map((row) => row.payload as Record<string, unknown>)
      .sort((a, b) => String(a.reason).localeCompare(String(b.reason)));
    expect(revokePayloads).toHaveLength(2);
    expect(revokePayloads[0]).toMatchObject({
      source: 'noncommerce_entitlement_activation_trigger',
      reason: 'entitlement_activated',
      entitlement_id: entitlement!.id,
      role_ids: [roleId],
      temporary_role_grant_ids: [],
    });
    expect(revokePayloads[1]).toMatchObject({
      source: 'noncommerce_entitlement_status_trigger',
      reason: 'entitlement_expired',
      entitlement_id: entitlement!.id,
      role_ids: [roleId],
      temporary_role_grant_ids: [],
    });

    const { data: cleanupAlerts, error: cleanupAlertError } = await supa
      .from('alerts')
      .select('alert_type,severity,resolved,metadata')
      .eq('guild_id', GUILD_A)
      .eq('alert_type', 'commerce_role_cleanup_unproven')
      .contains('metadata', { entitlement_id: entitlement!.id });
    expect(cleanupAlertError).toBeNull();
    expect(cleanupAlerts).toEqual([
      {
        alert_type: 'commerce_role_cleanup_unproven',
        severity: 'critical',
        resolved: false,
        metadata: {
          entitlement_id: entitlement!.id,
          customer_id: customer!.id,
          order_id: order!.id,
          product_id: productId,
          next_step: 'inspect_member_baseline_and_resolve_manually',
        },
      },
    ]);
  });

  it('raises the intent-less cleanup alert when a provider-completed refund revokes legacy granted roles', async () => {
    const fixture = await createPaidRefundFixture({ withAccess: true });
    const prepared = await supa.rpc('commerce_prepare_admin_refund', {
      p_order_id: fixture.orderId,
      p_guild_id: GUILD_A,
      p_actor_id: nextSnowflake(),
      p_reason: 'legacy provider refund without delivery intents',
    });
    expect(prepared.error).toBeNull();
    const attemptId = String((prepared.data as Record<string, unknown>).attempt_id);

    const refundId = nextName('legacy-provider-refund');
    const completed = await supa.rpc('commerce_record_admin_refund_outcome', {
      p_attempt_id: attemptId,
      p_guild_id: GUILD_A,
      p_provider_status: 'COMPLETED',
      p_paypal_refund_id: refundId,
      p_refund_amount_cents: 1_000,
      p_currency: 'USD',
    });
    expect(completed.error).toBeNull();

    const finalized = await supa.rpc('commerce_finalize_admin_refund', {
      p_attempt_id: attemptId,
      p_guild_id: GUILD_A,
    });
    expect(finalized.error).toBeNull();
    expect(finalized.data).toMatchObject({
      status: 'completed',
      order_status: 'refunded',
      entitlements_changed: 1,
      paypal_refund_id: refundId,
    });

    const readCleanupAlerts = async () => {
      const { data, error } = await supa
        .from('alerts')
        .select('alert_type,severity,resolved,metadata')
        .eq('guild_id', GUILD_A)
        .eq('alert_type', 'commerce_role_cleanup_unproven')
        .contains('metadata', { entitlement_id: fixture.entitlementId });
      expect(error).toBeNull();
      return data ?? [];
    };
    expect(await readCleanupAlerts()).toEqual([
      {
        alert_type: 'commerce_role_cleanup_unproven',
        severity: 'critical',
        resolved: false,
        metadata: {
          entitlement_id: fixture.entitlementId,
          customer_id: fixture.customerId,
          order_id: fixture.orderId,
          product_id: fixture.productId,
          next_step: 'inspect_member_baseline_and_resolve_manually',
        },
      },
    ]);

    const replayed = await supa.rpc('commerce_finalize_admin_refund', {
      p_attempt_id: attemptId,
      p_guild_id: GUILD_A,
    });
    expect(replayed.error).toBeNull();
    expect(await readCleanupAlerts()).toHaveLength(1);
  });

  it('raises the intent-less cleanup alert when a webhook full refund finalizes legacy granted roles', async () => {
    const fixture = await createPaidRefundFixture({ withAccess: true });
    const refundId = nextName('webhook-full-refund-legacy');
    const recorded = await supa.rpc('commerce_record_paypal_refund_event', {
      p_payment_id: fixture.paymentId,
      p_order_id: fixture.orderId,
      p_guild_id: GUILD_A,
      p_customer_id: fixture.customerId,
      p_paypal_payment_id: fixture.captureId,
      p_resource_type: 'capture',
      p_paypal_refund_id: refundId,
      p_event_type: 'PAYMENT.CAPTURE.REFUNDED',
      p_refund_amount_cents: 1_000,
      p_currency: 'USD',
      p_audit_details: { fixture: 'legacy webhook full refund' },
    });
    expect(recorded.error).toBeNull();
    expect(recorded.data).toMatchObject({
      full_refund: true,
      terminal_witness: true,
    });

    // The webhook handler expires access before committing the terminal
    // marker; the marker RPC is the last durable write of the revocation.
    const expired = await supa
      .from('entitlements')
      .update({ status: 'expired', cancelled_at: new Date().toISOString() })
      .eq('id', fixture.entitlementId);
    expect(expired.error).toBeNull();

    const finalizeArgs = {
      p_payment_id: fixture.paymentId,
      p_order_id: fixture.orderId,
      p_guild_id: GUILD_A,
      p_customer_id: fixture.customerId,
      p_paypal_payment_id: fixture.captureId,
      p_resource_type: 'capture',
      p_payment_status: 'refunded',
      p_paypal_refund_id: refundId,
      p_event_type: 'PAYMENT.CAPTURE.REFUNDED',
      p_audit_details: { source: 'paypal_webhook' },
    };
    const finalized = await supa.rpc('commerce_finalize_paypal_refund_status', finalizeArgs);
    expect(finalized.error).toBeNull();
    expect(finalized.data).toMatchObject({
      order_status: 'refunded',
      payment_status: 'refunded',
    });

    const readCleanupAlerts = async () => {
      const { data, error } = await supa
        .from('alerts')
        .select('alert_type,severity,resolved,metadata')
        .eq('guild_id', GUILD_A)
        .eq('alert_type', 'commerce_role_cleanup_unproven')
        .contains('metadata', { entitlement_id: fixture.entitlementId });
      expect(error).toBeNull();
      return data ?? [];
    };
    expect(await readCleanupAlerts()).toEqual([
      {
        alert_type: 'commerce_role_cleanup_unproven',
        severity: 'critical',
        resolved: false,
        metadata: {
          entitlement_id: fixture.entitlementId,
          customer_id: fixture.customerId,
          order_id: fixture.orderId,
          product_id: fixture.productId,
          next_step: 'inspect_member_baseline_and_resolve_manually',
        },
      },
    ]);

    const replayed = await supa.rpc('commerce_finalize_paypal_refund_status', finalizeArgs);
    expect(replayed.error).toBeNull();
    expect(replayed.data).toMatchObject({ already_terminal: true });
    expect(await readCleanupAlerts()).toHaveLength(1);
  });

  it('rejects subscription, unproven payment, and wrong-resource ledger refund paths', async () => {
    const productId = await createProduct({ type: 'subscription' });
    const planId = await createPlan(productId);
    const { data: customer, error: customerError } = await supa
      .from('customers')
      .insert({
        guild_id: GUILD_A,
        discord_id: nextSnowflake(),
        discord_username: nextName('subscription-refund-customer'),
      })
      .select('id')
      .single();
    expect(customerError).toBeNull();
    const { data: subscriptionOrder, error: orderError } = await supa
      .from('orders')
      .insert({
        order_number: nextName('subscription-refund-order'),
        customer_id: customer!.id,
        guild_id: GUILD_A,
        product_id: productId,
        plan_id: planId,
        paypal_subscription_id: nextName('subscription-provider-id'),
        amount_cents: 500,
        currency: 'USD',
        source: 'purchase',
        status: 'pending',
      })
      .select('id')
      .single();
    expect(orderError).toBeNull();
    const freeze = await supa.rpc('commerce_freeze_order_grant_snapshot', {
      p_order_id: subscriptionOrder!.id,
      p_guild_id: GUILD_A,
      p_customer_id: customer!.id,
      p_product_id: productId,
    });
    expect(freeze.error).toBeNull();
    const completeSubscription = await supa
      .from('orders')
      .update({ status: 'completed' })
      .eq('id', subscriptionOrder!.id);
    expect(completeSubscription.error).toBeNull();
    const sale = await supa.from('payments').insert({
      order_id: subscriptionOrder!.id,
      customer_id: customer!.id,
      guild_id: GUILD_A,
      paypal_payment_id: nextName('subscription-sale'),
      paypal_resource_type: 'sale',
      amount_cents: 500,
      currency: 'USD',
      provider: 'paypal',
      status: 'completed',
    });
    expect(sale.error).toBeNull();
    const subscriptionRefund = await supa.rpc('commerce_prepare_admin_refund', {
      p_order_id: subscriptionOrder!.id,
      p_guild_id: GUILD_A,
      p_actor_id: nextSnowflake(),
      p_reason: 'unsafe installment refund',
    });
    expect(subscriptionRefund.error).toMatchObject({ code: '23514' });
    expect(subscriptionRefund.error?.message).toContain(
      'subscription refunds require the policy-driven subscription workflow',
    );

    const captureFixture = await createPaidRefundFixture();
    const unprovenPayment = await supa.from('payments').insert({
      order_id: captureFixture.orderId,
      customer_id: captureFixture.customerId,
      guild_id: GUILD_A,
      paypal_payment_id: nextName('unproven-payment-kind'),
      amount_cents: 1_000,
      currency: 'USD',
      provider: 'paypal',
      status: 'pending',
    });
    expect(unprovenPayment.error?.code).toBe('23514');

    await expect(
      sqlA`
        INSERT INTO public.payment_refunds (
          payment_id, order_id, guild_id, paypal_refund_id,
          event_type, amount_cents, currency
        ) VALUES (
          ${captureFixture.paymentId}::UUID,
          ${captureFixture.orderId}::UUID,
          ${GUILD_A},
          ${nextName('wrong-sale-refund')},
          'PAYMENT.SALE.REFUNDED',
          1000,
          'USD'
        )
      `,
    ).rejects.toMatchObject({
      code: '23514',
      message: expect.stringContaining('resource type mismatch'),
    });
    await expect(
      sqlA`
        INSERT INTO public.payment_refunds (
          payment_id, order_id, guild_id, paypal_refund_id,
          event_type, amount_cents, currency
        ) VALUES (
          ${captureFixture.paymentId}::UUID,
          ${captureFixture.orderId}::UUID,
          ${GUILD_A},
          ${nextName('unknown-resource-refund')},
          'PAYMENT.UNKNOWN.REFUNDED',
          1000,
          'USD'
        )
      `,
    ).rejects.toMatchObject({ code: '23514' });

    const immutableRefundId = nextName('immutable-refund-ledger');
    const deniedServiceAppend = await supa.from('payment_refunds').insert({
      payment_id: captureFixture.paymentId,
      order_id: captureFixture.orderId,
      guild_id: GUILD_A,
      paypal_refund_id: nextName('denied-service-refund-ledger'),
      event_type: 'PAYMENT.CAPTURE.REFUNDED',
      amount_cents: 1,
      currency: 'USD',
    });
    expect(deniedServiceAppend.error).toMatchObject({ code: '42501' });
    await sqlA`
      INSERT INTO public.payment_refunds (
        payment_id, order_id, guild_id, paypal_refund_id,
        event_type, amount_cents, currency
      ) VALUES (
        ${captureFixture.paymentId}::UUID,
        ${captureFixture.orderId}::UUID,
        ${GUILD_A},
        ${immutableRefundId},
        'PAYMENT.CAPTURE.REFUNDED',
        1,
        'USD'
      )
    `;
    const ledgerMutation = await supa
      .from('payment_refunds')
      .update({ amount_cents: 2 })
      .eq('paypal_refund_id', immutableRefundId);
    expect(ledgerMutation.error).toMatchObject({ code: '42501' });
    await expect(
      sqlA`
        UPDATE public.payment_refunds
           SET amount_cents = 2
         WHERE paypal_refund_id = ${immutableRefundId}
      `,
    ).rejects.toMatchObject({
      code: '23514',
      message: expect.stringContaining('ledger rows are immutable'),
    });
    const ledgerDeletion = await supa
      .from('payment_refunds')
      .delete()
      .eq('paypal_refund_id', immutableRefundId);
    expect(ledgerDeletion.error).toMatchObject({ code: '42501' });
  });

  it('enforces failed and cancelled provider tuple shapes at the row boundary', async () => {
    const fixture = await createPaidRefundFixture();
    const prepared = await supa.rpc('commerce_prepare_admin_refund', {
      p_order_id: fixture.orderId,
      p_guild_id: GUILD_A,
      p_actor_id: nextSnowflake(),
      p_reason: 'row shape matrix',
    });
    expect(prepared.error).toBeNull();
    const attemptId = String((prepared.data as Record<string, unknown>).attempt_id);

    await expect(
      sqlA`
        UPDATE public.commerce_admin_refund_operations
           SET status = 'failed',
               provider_status = 'FAILED',
               paypal_refund_id = ${nextName('partial-update-refund')},
               provider_reported_amount_cents = NULL,
               provider_reported_currency = NULL,
               provider_outcome_at = pg_catalog.clock_timestamp(),
               updated_at = pg_catalog.clock_timestamp()
         WHERE attempt_id = ${attemptId}
      `,
    ).rejects.toMatchObject({ code: '23514' });

    const partialInsertId = randomUUID();
    await expect(
      sqlA`
        INSERT INTO public.commerce_admin_refund_operations (
          attempt_id, request_id, order_id, guild_id, customer_id, product_id,
          plan_id, actor_id, paypal_order_id, payment_id, paypal_payment_id,
          resource_type, order_amount_cents, existing_refunded_cents,
          refund_amount_cents, currency, reason, provider_required,
          status, provider_status, paypal_refund_id,
          provider_reported_amount_cents, provider_reported_currency,
          provider_outcome_at
        )
        SELECT ${partialInsertId}::UUID, ${partialInsertId}::UUID,
               operation.order_id, operation.guild_id, operation.customer_id,
               operation.product_id, operation.plan_id, operation.actor_id,
               operation.paypal_order_id, operation.payment_id,
               operation.paypal_payment_id, operation.resource_type,
               operation.order_amount_cents, operation.existing_refunded_cents,
               operation.refund_amount_cents, operation.currency,
               operation.reason, operation.provider_required,
               'cancelled', 'CANCELLED', ${nextName('partial-insert-refund')},
               operation.refund_amount_cents, NULL,
               pg_catalog.clock_timestamp()
          FROM public.commerce_admin_refund_operations AS operation
         WHERE operation.attempt_id = ${attemptId}
      `,
    ).rejects.toMatchObject({ code: '23514' });

    const directNullTerminal = await supa.rpc('commerce_record_admin_refund_outcome', {
      p_attempt_id: attemptId,
      p_guild_id: GUILD_A,
      p_provider_status: 'FAILED',
      p_paypal_refund_id: null,
      p_refund_amount_cents: null,
      p_currency: null,
    });
    expect(directNullTerminal.error).toBeNull();
    expect(directNullTerminal.data).toMatchObject({
      status: 'failed',
      paypal_refund_id: null,
    });
    const directNullReplay = await supa.rpc('commerce_record_admin_refund_outcome', {
      p_attempt_id: attemptId,
      p_guild_id: GUILD_A,
      p_provider_status: 'FAILED',
      p_paypal_refund_id: null,
      p_refund_amount_cents: null,
      p_currency: null,
    });
    expect(directNullReplay.error).toBeNull();
    expect(directNullReplay.data).toEqual(directNullTerminal.data);
  });

  it('rejects an order inserted with a forged frozen cross-guild contract', async () => {
    const roleId = nextSnowflake();
    const discordId = nextSnowflake();
    const crossGuildProduct = await createProduct({ guild_id: GUILD_B });
    const { data: customer } = await supa
      .from('customers')
      .insert({
        guild_id: GUILD_A,
        discord_id: discordId,
        discord_username: nextName('cross-guild-customer'),
      })
      .select('id')
      .single();
    const { error: malformedOrderError } = await supa
      .from('orders')
      .insert({
        order_number: nextName('cross-guild-order'),
        customer_id: customer!.id,
        guild_id: GUILD_A,
        product_id: crossGuildProduct,
        amount_cents: 500,
        currency: 'USD',
        source: 'purchase',
        status: 'completed',
        temporary_role_grants_snapshot: [{ role_id: roleId, duration_seconds: 60 }],
        grant_snapshot_frozen_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    expect(malformedOrderError?.code).toBe('23514');
  });

  it('locks commerce snapshot/provenance RPCs to service_role', async () => {
    const privileges = await sqlA`
      SELECT
        pg_catalog.has_function_privilege(
          'service_role',
          'public.commerce_freeze_order_grant_snapshot(uuid,text,uuid,uuid)',
          'EXECUTE'
        ) AS service_can_freeze,
        pg_catalog.has_function_privilege(
          'anon',
          'public.commerce_freeze_order_grant_snapshot(uuid,text,uuid,uuid)',
          'EXECUTE'
        ) AS anon_can_freeze,
        pg_catalog.has_function_privilege(
          'authenticated',
          'public.commerce_finalize_paypal_capture(uuid,text,uuid,uuid,text,text,integer,text)',
          'EXECUTE'
        ) AS authenticated_can_finalize,
        pg_catalog.has_function_privilege(
          'service_role',
          'public.commerce_prepare_admin_refund(uuid,text,text,text)',
          'EXECUTE'
        ) AS service_can_prepare_refund,
        pg_catalog.has_function_privilege(
          'anon',
          'public.commerce_prepare_admin_refund(uuid,text,text,text)',
          'EXECUTE'
        ) AS anon_can_prepare_refund,
        pg_catalog.has_function_privilege(
          'authenticated',
          'public.commerce_prepare_admin_refund(uuid,text,text,text)',
          'EXECUTE'
        ) AS authenticated_can_prepare_refund,
        pg_catalog.has_function_privilege(
          'service_role',
          'public.commerce_record_admin_refund_outcome(uuid,text,text,text,integer,text)',
          'EXECUTE'
        ) AS service_can_record_refund,
        pg_catalog.has_function_privilege(
          'anon',
          'public.commerce_record_admin_refund_outcome(uuid,text,text,text,integer,text)',
          'EXECUTE'
        ) AS anon_can_record_refund,
        pg_catalog.has_function_privilege(
          'authenticated',
          'public.commerce_record_admin_refund_outcome(uuid,text,text,text,integer,text)',
          'EXECUTE'
        ) AS authenticated_can_record_refund,
        pg_catalog.has_function_privilege(
          'service_role',
          'public.commerce_finalize_admin_refund(uuid,text)',
          'EXECUTE'
        ) AS service_can_finalize_refund,
        pg_catalog.has_function_privilege(
          'anon',
          'public.commerce_finalize_admin_refund(uuid,text)',
          'EXECUTE'
        ) AS anon_can_finalize_refund,
        pg_catalog.has_function_privilege(
          'authenticated',
          'public.commerce_finalize_admin_refund(uuid,text)',
          'EXECUTE'
        ) AS authenticated_can_finalize_refund,
        pg_catalog.has_function_privilege(
          'service_role',
          'public.commerce_record_paypal_refund_event(uuid,uuid,text,uuid,text,text,text,text,integer,text,jsonb)',
          'EXECUTE'
        ) AS service_can_record_external_refund,
        pg_catalog.has_function_privilege(
          'anon',
          'public.commerce_record_paypal_refund_event(uuid,uuid,text,uuid,text,text,text,text,integer,text,jsonb)',
          'EXECUTE'
        ) AS anon_can_record_external_refund,
        pg_catalog.has_function_privilege(
          'authenticated',
          'public.commerce_record_paypal_refund_event(uuid,uuid,text,uuid,text,text,text,text,integer,text,jsonb)',
          'EXECUTE'
        ) AS authenticated_can_record_external_refund,
        pg_catalog.has_function_privilege(
          'service_role',
          'public.commerce_finalize_paypal_refund_status(uuid,uuid,text,uuid,text,text,text,text,text,jsonb)',
          'EXECUTE'
        ) AS service_can_finalize_external_refund,
        pg_catalog.has_function_privilege(
          'anon',
          'public.commerce_finalize_paypal_refund_status(uuid,uuid,text,uuid,text,text,text,text,text,jsonb)',
          'EXECUTE'
        ) AS anon_can_finalize_external_refund,
        pg_catalog.has_function_privilege(
          'authenticated',
          'public.commerce_finalize_paypal_refund_status(uuid,uuid,text,uuid,text,text,text,text,text,jsonb)',
          'EXECUTE'
        ) AS authenticated_can_finalize_external_refund,
        pg_catalog.has_function_privilege(
          'service_role',
          'public.commerce_prepare_temp_role_grant(text,text,text,uuid,uuid,integer)',
          'EXECUTE'
        ) AS service_can_prepare,
        pg_catalog.has_function_privilege(
          'anon',
          'public.commerce_prepare_temp_role_grant(text,text,text,uuid,uuid,integer)',
          'EXECUTE'
        ) AS anon_can_prepare,
        pg_catalog.has_function_privilege(
          'authenticated',
          'public.commerce_prepare_temp_role_grant(text,text,text,uuid,uuid,integer)',
          'EXECUTE'
        ) AS authenticated_can_prepare,
        pg_catalog.has_function_privilege(
          'service_role',
          'public.commerce_acknowledge_temp_role_grant(uuid)',
          'EXECUTE'
        ) AS service_can_acknowledge,
        pg_catalog.has_function_privilege(
          'anon',
          'public.commerce_acknowledge_temp_role_grant(uuid)',
          'EXECUTE'
        ) AS anon_can_acknowledge,
        pg_catalog.has_function_privilege(
          'authenticated',
          'public.commerce_acknowledge_temp_role_grant(uuid)',
          'EXECUTE'
        ) AS authenticated_can_acknowledge,
        pg_catalog.has_function_privilege(
          'service_role',
          'public.commerce_find_live_temp_role_owner(text,text,text,uuid,uuid)',
          'EXECUTE'
        ) AS service_can_find_temp_owner,
        pg_catalog.has_function_privilege(
          'anon',
          'public.commerce_find_live_temp_role_owner(text,text,text,uuid,uuid)',
          'EXECUTE'
        ) AS anon_can_find_temp_owner,
        pg_catalog.has_function_privilege(
          'authenticated',
          'public.commerce_find_live_temp_role_owner(text,text,text,uuid,uuid)',
          'EXECUTE'
        ) AS authenticated_can_find_temp_owner,
        pg_catalog.has_function_privilege(
          'service_role',
          'public.commerce_inspect_temp_role_grant(uuid)',
          'EXECUTE'
        ) AS service_can_inspect_temp_grant,
        pg_catalog.has_function_privilege(
          'authenticated',
          'public.commerce_inspect_temp_role_grant(uuid)',
          'EXECUTE'
        ) AS authenticated_can_inspect_temp_grant,
        pg_catalog.has_function_privilege(
          'anon',
          'public.commerce_inspect_temp_role_grant(uuid)',
          'EXECUTE'
        ) AS anon_can_inspect_temp_grant,
        pg_catalog.has_function_privilege(
          'service_role',
          'public.commerce_retire_temp_role_grant(uuid,text,timestamp with time zone,boolean)',
          'EXECUTE'
        ) AS service_can_retire_temp_grant,
        pg_catalog.has_function_privilege(
          'anon',
          'public.commerce_retire_temp_role_grant(uuid,text,timestamp with time zone,boolean)',
          'EXECUTE'
        ) AS anon_can_retire_temp_grant,
        pg_catalog.has_function_privilege(
          'authenticated',
          'public.commerce_retire_temp_role_grant(uuid,text,timestamp with time zone,boolean)',
          'EXECUTE'
        ) AS authenticated_can_retire_temp_grant,
        pg_catalog.has_function_privilege(
          'service_role',
          'public.commerce_adopt_legacy_subscription_grant_contract(uuid,uuid)',
          'EXECUTE'
        ) AS service_can_adopt_legacy_contract,
        pg_catalog.has_function_privilege(
          'anon',
          'public.commerce_adopt_legacy_subscription_grant_contract(uuid,uuid)',
          'EXECUTE'
        ) AS anon_can_adopt_legacy_contract,
        pg_catalog.has_function_privilege(
          'authenticated',
          'public.commerce_adopt_legacy_subscription_grant_contract(uuid,uuid)',
          'EXECUTE'
        ) AS authenticated_can_adopt_legacy_contract,
        pg_catalog.has_table_privilege(
          'service_role',
          'public.commerce_legacy_subscription_grant_contracts',
          'SELECT'
        ) AS service_can_read_legacy_contract,
        pg_catalog.has_table_privilege(
          'service_role',
          'public.commerce_legacy_subscription_grant_contracts',
          'INSERT'
        ) AS service_can_insert_legacy_contract,
        pg_catalog.has_table_privilege(
          'service_role',
          'public.commerce_legacy_subscription_grant_contracts',
          'UPDATE'
        ) AS service_can_update_legacy_contract,
        pg_catalog.has_table_privilege(
          'service_role',
          'public.commerce_legacy_subscription_grant_contracts',
          'DELETE'
        ) AS service_can_delete_legacy_contract,
        pg_catalog.has_table_privilege(
          'anon',
          'public.commerce_legacy_subscription_grant_contracts',
          'SELECT,INSERT,UPDATE,DELETE'
        ) AS anon_can_touch_legacy_contract,
        pg_catalog.has_table_privilege(
          'authenticated',
          'public.commerce_legacy_subscription_grant_contracts',
          'SELECT,INSERT,UPDATE,DELETE'
        ) AS authenticated_can_touch_legacy_contract,
        pg_catalog.has_table_privilege(
          'service_role',
          'public.payment_refunds',
          'SELECT'
        ) AS service_can_read_refund_ledger,
        pg_catalog.has_table_privilege(
          'service_role',
          'public.payment_refunds',
          'INSERT'
        ) AS service_can_append_refund_ledger,
        pg_catalog.has_table_privilege(
          'service_role',
          'public.payment_refunds',
          'UPDATE'
        ) AS service_can_update_refund_ledger,
        pg_catalog.has_table_privilege(
          'service_role',
          'public.payment_refunds',
          'DELETE'
        ) AS service_can_delete_refund_ledger,
        pg_catalog.has_table_privilege(
          'service_role',
          'public.payment_refunds',
          'TRUNCATE'
        ) AS service_can_truncate_refund_ledger,
        pg_catalog.has_table_privilege(
          'service_role',
          'public.payment_refunds',
          'REFERENCES'
        ) AS service_can_reference_refund_ledger,
        pg_catalog.has_table_privilege(
          'service_role',
          'public.payment_refunds',
          'TRIGGER'
        ) AS service_can_trigger_refund_ledger,
        pg_catalog.has_table_privilege(
          'service_role',
          'public.commerce_admin_refund_operations',
          'SELECT'
        ) AS service_can_read_refund_operation,
        pg_catalog.has_table_privilege(
          'service_role',
          'public.commerce_admin_refund_operations',
          'INSERT'
        ) AS service_can_insert_refund_operation,
        pg_catalog.has_table_privilege(
          'service_role',
          'public.commerce_admin_refund_operations',
          'UPDATE'
        ) AS service_can_update_refund_operation,
        pg_catalog.has_table_privilege(
          'service_role',
          'public.commerce_admin_refund_operations',
          'DELETE'
        ) AS service_can_delete_refund_operation,
        pg_catalog.has_table_privilege(
          'anon',
          'public.commerce_admin_refund_operations',
          'SELECT,INSERT,UPDATE,DELETE'
        ) AS anon_can_touch_refund_operation,
        pg_catalog.has_table_privilege(
          'authenticated',
          'public.commerce_admin_refund_operations',
          'SELECT,INSERT,UPDATE,DELETE'
        ) AS authenticated_can_touch_refund_operation,
        pg_catalog.has_table_privilege(
          'anon',
          'public.commerce_product_temp_role_config',
          'INSERT,UPDATE,DELETE'
        ) OR pg_catalog.has_table_privilege(
          'anon',
          'public.commerce_product_temp_role_config',
          'SELECT'
        ) AS anon_can_touch_temp_config,
        pg_catalog.has_table_privilege(
          'authenticated',
          'public.commerce_product_temp_role_config',
          'SELECT,INSERT,UPDATE,DELETE'
        ) AS authenticated_can_touch_temp_config,
        pg_catalog.has_table_privilege(
          'anon',
          'public.commerce_role_metadata_migration_issues',
          'SELECT,INSERT,UPDATE,DELETE'
        ) AS anon_can_touch_role_metadata_issues,
        pg_catalog.has_table_privilege(
          'authenticated',
          'public.commerce_role_metadata_migration_issues',
          'SELECT,INSERT,UPDATE,DELETE'
        ) AS authenticated_can_touch_role_metadata_issues,
        pg_catalog.has_table_privilege(
          'anon',
          'public.commerce_temp_role_migration_issues',
          'SELECT,INSERT,UPDATE,DELETE'
        ) AS anon_can_touch_temp_role_issues,
        pg_catalog.has_table_privilege(
          'authenticated',
          'public.commerce_temp_role_migration_issues',
          'SELECT,INSERT,UPDATE,DELETE'
        ) AS authenticated_can_touch_temp_role_issues,
        (
          SELECT table_class.relrowsecurity
            FROM pg_catalog.pg_class AS table_class
            JOIN pg_catalog.pg_namespace AS table_schema
              ON table_schema.oid = table_class.relnamespace
           WHERE table_schema.nspname = 'public'
              AND table_class.relname = 'commerce_legacy_subscription_grant_contracts'
        ) AS legacy_contract_rls,
        (
          SELECT table_class.relrowsecurity
            FROM pg_catalog.pg_class AS table_class
            JOIN pg_catalog.pg_namespace AS table_schema
              ON table_schema.oid = table_class.relnamespace
           WHERE table_schema.nspname = 'public'
             AND table_class.relname = 'commerce_admin_refund_operations'
        ) AS refund_operation_rls,
        (
          SELECT table_class.relrowsecurity
            FROM pg_catalog.pg_class AS table_class
            JOIN pg_catalog.pg_namespace AS table_schema
              ON table_schema.oid = table_class.relnamespace
           WHERE table_schema.nspname = 'public'
             AND table_class.relname = 'commerce_product_temp_role_config'
        ) AS temp_role_config_rls,
        (
          SELECT table_class.relrowsecurity
            FROM pg_catalog.pg_class AS table_class
            JOIN pg_catalog.pg_namespace AS table_schema
              ON table_schema.oid = table_class.relnamespace
           WHERE table_schema.nspname = 'public'
             AND table_class.relname = 'commerce_role_metadata_migration_issues'
        ) AS role_metadata_issues_rls,
        (
          SELECT table_class.relrowsecurity
            FROM pg_catalog.pg_class AS table_class
            JOIN pg_catalog.pg_namespace AS table_schema
              ON table_schema.oid = table_class.relnamespace
           WHERE table_schema.nspname = 'public'
             AND table_class.relname = 'commerce_temp_role_migration_issues'
        ) AS temp_role_issues_rls
    `;
    expect(privileges[0]).toMatchObject({
      service_can_freeze: true,
      anon_can_freeze: false,
      authenticated_can_finalize: false,
      service_can_prepare_refund: true,
      anon_can_prepare_refund: false,
      authenticated_can_prepare_refund: false,
      service_can_record_refund: true,
      anon_can_record_refund: false,
      authenticated_can_record_refund: false,
      service_can_finalize_refund: true,
      anon_can_finalize_refund: false,
      authenticated_can_finalize_refund: false,
      service_can_record_external_refund: true,
      anon_can_record_external_refund: false,
      authenticated_can_record_external_refund: false,
      service_can_finalize_external_refund: true,
      anon_can_finalize_external_refund: false,
      authenticated_can_finalize_external_refund: false,
      service_can_prepare: true,
      anon_can_prepare: false,
      authenticated_can_prepare: false,
      service_can_acknowledge: true,
      anon_can_acknowledge: false,
      authenticated_can_acknowledge: false,
      service_can_find_temp_owner: true,
      anon_can_find_temp_owner: false,
      authenticated_can_find_temp_owner: false,
      service_can_inspect_temp_grant: true,
      authenticated_can_inspect_temp_grant: false,
      anon_can_inspect_temp_grant: false,
      service_can_retire_temp_grant: true,
      anon_can_retire_temp_grant: false,
      authenticated_can_retire_temp_grant: false,
      service_can_adopt_legacy_contract: true,
      anon_can_adopt_legacy_contract: false,
      authenticated_can_adopt_legacy_contract: false,
      service_can_read_legacy_contract: true,
      service_can_insert_legacy_contract: false,
      service_can_update_legacy_contract: false,
      service_can_delete_legacy_contract: false,
      anon_can_touch_legacy_contract: false,
      authenticated_can_touch_legacy_contract: false,
      service_can_read_refund_ledger: true,
      service_can_append_refund_ledger: false,
      service_can_update_refund_ledger: false,
      service_can_delete_refund_ledger: false,
      service_can_truncate_refund_ledger: false,
      service_can_reference_refund_ledger: false,
      service_can_trigger_refund_ledger: false,
      service_can_read_refund_operation: true,
      service_can_insert_refund_operation: false,
      service_can_update_refund_operation: false,
      service_can_delete_refund_operation: false,
      anon_can_touch_refund_operation: false,
      authenticated_can_touch_refund_operation: false,
      anon_can_touch_temp_config: false,
      authenticated_can_touch_temp_config: false,
      anon_can_touch_role_metadata_issues: false,
      authenticated_can_touch_role_metadata_issues: false,
      anon_can_touch_temp_role_issues: false,
      authenticated_can_touch_temp_role_issues: false,
      legacy_contract_rls: true,
      refund_operation_rls: true,
      temp_role_config_rls: true,
      role_metadata_issues_rls: true,
      temp_role_issues_rls: true,
    });
  });

  it('guards plan activation, deactivation, repricing, PayPal id, move, and delete', async () => {
    const planRole = nextName('plan-role');
    const productId = await createProduct({
      type: 'subscription',
      granted_role_ids: [planRole],
    });
    await createIncome(planRole);

    const planId = await createPlan(productId, { active: false });
    const activation = await supa.from('plans').update({ active: true }).eq('id', planId);
    expectWallConflict(activation.error);

    const removePayPal = await supa
      .from('plans')
      .update({ paypal_plan_id: null })
      .eq('id', planId);
    expect(removePayPal.error).toBeNull();
    const activateWithoutPayPal = await supa
      .from('plans')
      .update({ active: true })
      .eq('id', planId);
    expect(activateWithoutPayPal.error).toBeNull();

    const addPayPal = await supa
      .from('plans')
      .update({ paypal_plan_id: 'P-OPENS-PATH' })
      .eq('id', planId);
    expectWallConflict(addPayPal.error);

    const zeroPricePayPalPlan = await supa.from('plans').insert(planRow(productId, {
      price_cents: 0,
      paypal_plan_id: 'P-ZERO-STILL-CHARGEABLE',
    }));
    expectWallConflict(zeroPricePayPalPlan.error);

    const closableRole = nextName('closable-plan-role');
    const closableProduct = await createProduct({
      type: 'subscription',
      granted_role_ids: [closableRole],
    });
    const closablePlan = await createPlan(closableProduct);
    const blockedIncome = await supa.from('economy_role_income').insert({
      guild_id: GUILD_A,
      role_id: closableRole,
      amount: 10,
      interval_minutes: 60,
    });
    expectWallConflict(blockedIncome.error);

    const deactivate = await supa.from('plans').update({ active: false }).eq('id', closablePlan);
    expect(deactivate.error).toBeNull();
    await createIncome(closableRole);

    const deletableRole = nextName('deletable-plan-role');
    const deletableProduct = await createProduct({
      type: 'subscription',
      granted_role_ids: [deletableRole],
    });
    const deletablePlan = await createPlan(deletableProduct);
    const deletePlan = await supa.from('plans').delete().eq('id', deletablePlan);
    expect(deletePlan.error).toBeNull();
    await createIncome(deletableRole);

    const destinationRole = nextName('destination-role');
    const sourceProduct = await createProduct({ type: 'subscription' });
    const destinationProduct = await createProduct({
      guild_id: GUILD_B,
      type: 'subscription',
      granted_role_ids: [destinationRole],
    });
    await createIncome(destinationRole, { guild_id: GUILD_B });
    const movingPlan = await createPlan(sourceProduct);

    const unsafeMove = await supa
      .from('plans')
      .update({ product_id: destinationProduct, guild_id: GUILD_B })
      .eq('id', movingPlan);
    expectWallConflict(unsafeMove.error);

    const { data: unmoved, error: unmovedError } = await supa
      .from('plans')
      .select('product_id, guild_id')
      .eq('id', movingPlan)
      .single();
    expect(unmovedError).toBeNull();
    expect(unmoved?.product_id).toBe(sourceProduct);
    expect(unmoved?.guild_id).toBe(GUILD_A);
  });

  it('validates both old and new plan parents in a direct transaction', async () => {
    const sourceRole = nextName('old-parent-role');
    const sourceProduct = await createProduct({
      type: 'subscription',
      granted_role_ids: [sourceRole],
    });
    const destinationProduct = await createProduct({
      guild_id: GUILD_B,
      type: 'subscription',
    });
    const movingPlan = await createPlan(sourceProduct);
    await createPlan(sourceProduct);

    let transactionError: unknown;
    try {
      await sqlA.begin(async (tx) => {
        await tx`
          INSERT INTO public.economy_role_income (
            guild_id, role_id, amount, interval_minutes
          ) VALUES (${GUILD_A}, ${sourceRole}, 25, 60)
        `;
        await tx`
          UPDATE public.plans
          SET product_id = ${destinationProduct}, guild_id = ${GUILD_B}
          WHERE id = ${movingPlan}
        `;
      });
    } catch (error) {
      transactionError = error;
    }
    expectPgWallConflict(transactionError);

    const { count: rolledBackIncome } = await supa
      .from('economy_role_income')
      .select('*', { count: 'exact', head: true })
      .eq('guild_id', GUILD_A)
      .eq('role_id', sourceRole);
    expect(rolledBackIncome).toBe(0);

    const { data: rolledBackPlan } = await supa
      .from('plans')
      .select('product_id, guild_id')
      .eq('id', movingPlan)
      .single();
    expect(rolledBackPlan?.product_id).toBe(sourceProduct);
    expect(rolledBackPlan?.guild_id).toBe(GUILD_A);
  });

  it('serializes product movement and destination-income races in both orderings', async () => {
    const moveFirstRole = nextSnowflake();
    const moveFirstProduct = await createProduct();
    const moveFirstConfig = await supa.from('commerce_product_temp_role_config').insert({
      product_id: moveFirstProduct,
      guild_id: GUILD_A,
      role_id: moveFirstRole,
      duration_seconds: 60,
    });
    expect(moveFirstConfig.error).toBeNull();

    const movementStarted = makeGate();
    const releaseMovement = makeGate();
    let movementReady = false;
    let movementError: unknown;
    const movementTransaction = sqlA.begin(async (tx) => {
      await tx`
        UPDATE public.products
        SET guild_id = ${GUILD_B}
        WHERE id = ${moveFirstProduct}
      `;
      movementReady = true;
      movementStarted.open();
      await releaseMovement.promise;
    }).catch((error: unknown) => {
      movementError = error;
      movementStarted.open();
      releaseMovement.open();
    });
    await movementStarted.promise;
    if (movementError) throw movementError;
    expect(movementReady).toBe(true);

    const competingIncome = sqlB`
      INSERT INTO public.economy_role_income (
        guild_id, role_id, amount, interval_minutes
      ) VALUES (${GUILD_B}, ${moveFirstRole}, 50, 60)
    `.then(
      () => ({ error: null as unknown }),
      (error: unknown) => ({ error }),
    );

    try {
      await waitForDatabaseLock(
        sqlBBackendPid,
        'destination income competing with product movement',
      );
    } finally {
      releaseMovement.open();
    }
    await movementTransaction;
    if (movementError) throw movementError;
    const competingIncomeResult = await competingIncome;

    expectPgWallConflict(competingIncomeResult.error);
    const { data: movedProduct } = await supa
      .from('products')
      .select('guild_id')
      .eq('id', moveFirstProduct)
      .single();
    const { data: movedConfig } = await supa
      .from('commerce_product_temp_role_config')
      .select('guild_id')
      .eq('product_id', moveFirstProduct)
      .single();
    expect(movedProduct?.guild_id).toBe(GUILD_B);
    expect(movedConfig?.guild_id).toBe(GUILD_B);
    const { count: rejectedIncomeCount } = await supa
      .from('economy_role_income')
      .select('*', { count: 'exact', head: true })
      .eq('guild_id', GUILD_B)
      .eq('role_id', moveFirstRole);
    expect(rejectedIncomeCount).toBe(0);

    const incomeFirstRole = nextSnowflake();
    const incomeFirstProduct = await createProduct();
    const incomeFirstConfig = await supa.from('commerce_product_temp_role_config').insert({
      product_id: incomeFirstProduct,
      guild_id: GUILD_A,
      role_id: incomeFirstRole,
      duration_seconds: 60,
    });
    expect(incomeFirstConfig.error).toBeNull();

    const incomeStarted = makeGate();
    const releaseIncome = makeGate();
    let incomeReady = false;
    let incomeError: unknown;
    const incomeTransaction = sqlA.begin(async (tx) => {
      await tx`
        INSERT INTO public.economy_role_income (
          guild_id, role_id, amount, interval_minutes
        ) VALUES (${GUILD_B}, ${incomeFirstRole}, 50, 60)
      `;
      incomeReady = true;
      incomeStarted.open();
      await releaseIncome.promise;
    }).catch((error: unknown) => {
      incomeError = error;
      incomeStarted.open();
      releaseIncome.open();
    });
    await incomeStarted.promise;
    if (incomeError) throw incomeError;
    expect(incomeReady).toBe(true);

    const competingMovement = sqlB`
      UPDATE public.products
      SET guild_id = ${GUILD_B}
      WHERE id = ${incomeFirstProduct}
    `.then(
      () => ({ error: null as unknown }),
      (error: unknown) => ({ error }),
    );

    try {
      await waitForDatabaseLock(
        sqlBBackendPid,
        'product movement competing with destination income',
      );
    } finally {
      releaseIncome.open();
    }
    await incomeTransaction;
    if (incomeError) throw incomeError;
    const competingMovementResult = await competingMovement;

    expectPgWallConflict(competingMovementResult.error);
    const { data: unmovedProduct } = await supa
      .from('products')
      .select('guild_id')
      .eq('id', incomeFirstProduct)
      .single();
    const { data: unmovedConfig } = await supa
      .from('commerce_product_temp_role_config')
      .select('guild_id')
      .eq('product_id', incomeFirstProduct)
      .single();
    expect(unmovedProduct?.guild_id).toBe(GUILD_A);
    expect(unmovedConfig?.guild_id).toBe(GUILD_A);
    const { count: committedIncomeCount } = await supa
      .from('economy_role_income')
      .select('*', { count: 'exact', head: true })
      .eq('guild_id', GUILD_B)
      .eq('role_id', incomeFirstRole);
    expect(committedIncomeCount).toBe(1);
  });

  it('serializes typed-config insertion and product movement in both orderings', async () => {
    const insertFirstProduct = await createProduct();
    const insertFirstRole = nextSnowflake();
    const insertStarted = makeGate();
    const releaseInsert = makeGate();
    let insertReady = false;
    let insertError: unknown;
    const insertTransaction = sqlA.begin(async (tx) => {
      await tx`
        INSERT INTO public.commerce_product_temp_role_config (
          product_id, guild_id, role_id, duration_seconds
        ) VALUES (
          ${insertFirstProduct}, ${GUILD_A}, ${insertFirstRole}, 60
        )
      `;
      insertReady = true;
      insertStarted.open();
      await releaseInsert.promise;
    }).catch((error: unknown) => {
      insertError = error;
      insertStarted.open();
      releaseInsert.open();
    });
    await insertStarted.promise;
    if (insertError) throw insertError;
    expect(insertReady).toBe(true);

    const movementAfterInsert = sqlB`
      UPDATE public.products
         SET guild_id = ${GUILD_B}
       WHERE id = ${insertFirstProduct}
    `.then(
      () => ({ error: null as unknown }),
      (error: unknown) => ({ error }),
    );
    try {
      await waitForDatabaseLock(
        sqlBBackendPid,
        'product movement competing with a typed-config insert',
      );
    } finally {
      releaseInsert.open();
    }
    await insertTransaction;
    if (insertError) throw insertError;
    expect((await movementAfterInsert).error).toBeNull();

    const { data: insertFirstFinal, error: insertFirstFinalError } = await supa
      .from('commerce_product_temp_role_config')
      .select('guild_id,role_id')
      .eq('product_id', insertFirstProduct)
      .single();
    expect(insertFirstFinalError).toBeNull();
    expect(insertFirstFinal).toMatchObject({
      guild_id: GUILD_B,
      role_id: insertFirstRole,
    });

    const movementFirstProduct = await createProduct();
    const movementFirstRole = nextSnowflake();
    const movementStarted = makeGate();
    const releaseMovement = makeGate();
    let movementReady = false;
    let movementError: unknown;
    const movementTransaction = sqlA.begin(async (tx) => {
      await tx`
        UPDATE public.products
           SET guild_id = ${GUILD_B}
         WHERE id = ${movementFirstProduct}
      `;
      movementReady = true;
      movementStarted.open();
      await releaseMovement.promise;
    }).catch((error: unknown) => {
      movementError = error;
      movementStarted.open();
      releaseMovement.open();
    });
    await movementStarted.promise;
    if (movementError) throw movementError;
    expect(movementReady).toBe(true);

    const insertAfterMovement = sqlB`
      INSERT INTO public.commerce_product_temp_role_config (
        product_id, guild_id, role_id, duration_seconds
      ) VALUES (
        ${movementFirstProduct}, ${GUILD_A}, ${movementFirstRole}, 60
      )
    `.then(
      () => ({ error: null as unknown }),
      (error: unknown) => ({ error }),
    );
    try {
      await waitForDatabaseLock(
        sqlBBackendPid,
        'typed-config insert competing with product movement',
      );
    } finally {
      releaseMovement.open();
    }
    await movementTransaction;
    if (movementError) throw movementError;
    const insertAfterMovementResult = await insertAfterMovement;
    expect((insertAfterMovementResult.error as DbError)?.code).toBe('23503');

    const { count: rejectedConfigCount } = await supa
      .from('commerce_product_temp_role_config')
      .select('*', { count: 'exact', head: true })
      .eq('product_id', movementFirstProduct);
    expect(rejectedConfigCount).toBe(0);
  });

  it('serializes product and typed-config row locks without deadlock in both orderings', async () => {
    const configFirstProduct = await createProduct();
    const configFirstRole = nextSnowflake();
    const { data: configFirst, error: configFirstError } = await supa
      .from('commerce_product_temp_role_config')
      .insert({
        product_id: configFirstProduct,
        guild_id: GUILD_A,
        role_id: configFirstRole,
        duration_seconds: 60,
      })
      .select('id')
      .single();
    expect(configFirstError).toBeNull();

    const directGuildRewrite = await supa
      .from('commerce_product_temp_role_config')
      .update({ guild_id: GUILD_B })
      .eq('id', configFirst!.id);
    expect(directGuildRewrite.error?.code).toBe('23514');

    const configStarted = makeGate();
    const releaseConfig = makeGate();
    let configReady = false;
    let configError: unknown;
    const configTransaction = sqlA.begin(async (tx) => {
      await tx`
        UPDATE public.commerce_product_temp_role_config
        SET duration_seconds = 61
        WHERE id = ${configFirst!.id}
      `;
      configReady = true;
      configStarted.open();
      await releaseConfig.promise;
    }).catch((error: unknown) => {
      configError = error;
      configStarted.open();
      releaseConfig.open();
    });
    await configStarted.promise;
    if (configError) throw configError;
    expect(configReady).toBe(true);

    const movementAfterConfig = sqlB`
      UPDATE public.products
      SET guild_id = ${GUILD_B}
      WHERE id = ${configFirstProduct}
    `.then(
      () => ({ error: null as unknown }),
      (error: unknown) => ({ error }),
    );
    try {
      await waitForDatabaseLock(
        sqlBBackendPid,
        'product movement competing with a typed-config writer',
      );
    } finally {
      releaseConfig.open();
    }
    await configTransaction;
    if (configError) throw configError;
    expect((await movementAfterConfig).error).toBeNull();

    const { data: configFirstFinal, error: configFirstFinalError } = await supa
      .from('commerce_product_temp_role_config')
      .select('guild_id,duration_seconds')
      .eq('id', configFirst!.id)
      .single();
    expect(configFirstFinalError).toBeNull();
    expect(configFirstFinal).toMatchObject({ guild_id: GUILD_B, duration_seconds: 61 });

    const movementFirstProduct = await createProduct();
    const movementFirstRole = nextSnowflake();
    const { data: movementFirstConfig, error: movementFirstConfigError } = await supa
      .from('commerce_product_temp_role_config')
      .insert({
        product_id: movementFirstProduct,
        guild_id: GUILD_A,
        role_id: movementFirstRole,
        duration_seconds: 60,
      })
      .select('id')
      .single();
    expect(movementFirstConfigError).toBeNull();

    const movementStarted = makeGate();
    const releaseMovement = makeGate();
    let movementReady = false;
    let movementError: unknown;
    const movementTransaction = sqlA.begin(async (tx) => {
      await tx`
        UPDATE public.products
        SET guild_id = ${GUILD_B}
        WHERE id = ${movementFirstProduct}
      `;
      movementReady = true;
      movementStarted.open();
      await releaseMovement.promise;
    }).catch((error: unknown) => {
      movementError = error;
      movementStarted.open();
      releaseMovement.open();
    });
    await movementStarted.promise;
    if (movementError) throw movementError;
    expect(movementReady).toBe(true);

    const configAfterMovement = sqlB`
      UPDATE public.commerce_product_temp_role_config
      SET duration_seconds = 62
      WHERE id = ${movementFirstConfig!.id}
    `.then(
      () => ({ error: null as unknown }),
      (error: unknown) => ({ error }),
    );
    try {
      await waitForDatabaseLock(
        sqlBBackendPid,
        'typed-config writer competing with product movement',
      );
    } finally {
      releaseMovement.open();
    }
    await movementTransaction;
    if (movementError) throw movementError;
    expect((await configAfterMovement).error).toBeNull();

    const { data: movementFirstFinal, error: movementFirstFinalError } = await supa
      .from('commerce_product_temp_role_config')
      .select('guild_id,duration_seconds')
      .eq('id', movementFirstConfig!.id)
      .single();
    expect(movementFirstFinalError).toBeNull();
    expect(movementFirstFinal).toMatchObject({ guild_id: GUILD_B, duration_seconds: 62 });
  });

  it('serializes activation-first and income-first races on two clients', async () => {
    const activationFirstRole = nextName('activation-first-role');
    const activationFirstProduct = await createProduct({
      active: false,
      granted_role_ids: [activationFirstRole],
    });

    const activationStarted = makeGate();
    const releaseActivation = makeGate();
    let activationReady = false;
    let activationError: unknown;
    const activationTransaction = sqlA.begin(async (tx) => {
      await tx`
        UPDATE public.products
        SET active = TRUE
        WHERE id = ${activationFirstProduct}
      `;
      activationReady = true;
      activationStarted.open();
      await releaseActivation.promise;
    }).catch((error: unknown) => {
      activationError = error;
      activationStarted.open();
      releaseActivation.open();
    });
    await activationStarted.promise;
    if (activationError) throw activationError;
    expect(activationReady).toBe(true);

    const competingIncome = sqlB`
      INSERT INTO public.economy_role_income (
        guild_id, role_id, amount, interval_minutes
      ) VALUES (${GUILD_A}, ${activationFirstRole}, 50, 60)
    `.then(
      () => ({ error: null as unknown }),
      (error: unknown) => ({ error }),
    );

    try {
      await waitForDatabaseLock(
        sqlBBackendPid,
        'income creation competing with product activation',
      );
    } finally {
      releaseActivation.open();
    }
    await activationTransaction;
    if (activationError) throw activationError;
    const competingIncomeResult = await competingIncome;

    expectPgWallConflict(competingIncomeResult.error);

    const { data: activationFinal } = await supa
      .from('products')
      .select('active')
      .eq('id', activationFirstProduct)
      .single();
    expect(activationFinal?.active).toBe(true);
    const { count: activationRaceIncome } = await supa
      .from('economy_role_income')
      .select('*', { count: 'exact', head: true })
      .eq('guild_id', GUILD_A)
      .eq('role_id', activationFirstRole);
    expect(activationRaceIncome).toBe(0);

    const incomeFirstRole = nextName('income-first-role');
    const incomeFirstProduct = await createProduct({
      active: false,
      granted_role_ids: [incomeFirstRole],
    });
    const incomeStarted = makeGate();
    const releaseIncome = makeGate();
    let incomeReady = false;
    let incomeError: unknown;
    const incomeTransaction = sqlA.begin(async (tx) => {
      await tx`
        INSERT INTO public.economy_role_income (
          guild_id, role_id, amount, interval_minutes
        ) VALUES (${GUILD_A}, ${incomeFirstRole}, 50, 60)
      `;
      incomeReady = true;
      incomeStarted.open();
      await releaseIncome.promise;
    }).catch((error: unknown) => {
      incomeError = error;
      incomeStarted.open();
      releaseIncome.open();
    });
    await incomeStarted.promise;
    if (incomeError) throw incomeError;
    expect(incomeReady).toBe(true);

    const competingActivation = sqlB`
      UPDATE public.products
      SET active = TRUE
      WHERE id = ${incomeFirstProduct}
    `.then(
      () => ({ error: null as unknown }),
      (error: unknown) => ({ error }),
    );

    try {
      await waitForDatabaseLock(
        sqlBBackendPid,
        'product activation competing with income creation',
      );
    } finally {
      releaseIncome.open();
    }
    await incomeTransaction;
    if (incomeError) throw incomeError;
    const competingActivationResult = await competingActivation;

    expectPgWallConflict(competingActivationResult.error);

    const { data: incomeFirstFinal } = await supa
      .from('products')
      .select('active')
      .eq('id', incomeFirstProduct)
      .single();
    expect(incomeFirstFinal?.active).toBe(false);
    const { count: incomeRaceRows } = await supa
      .from('economy_role_income')
      .select('*', { count: 'exact', head: true })
      .eq('guild_id', GUILD_A)
      .eq('role_id', incomeFirstRole);
    expect(incomeRaceRows).toBe(1);
  });
});
