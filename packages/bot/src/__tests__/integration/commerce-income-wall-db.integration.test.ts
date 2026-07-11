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
  return `${prefix}-${sequence}`;
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

async function cleanFixtures(): Promise<void> {
  const queueDelete = await supa
    .from('bot_action_queue')
    .delete()
    .in('guild_id', TEST_GUILDS);
  expect(queueDelete.error).toBeNull();

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

beforeAll(async () => {
  supa = await requireSupabase();
  sqlA = postgres(getTestDbUrl(), { max: 1 });
  sqlB = postgres(getTestDbUrl(), { max: 1 });
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
  if (supa) {
    await cleanFixtures();
    const { error } = await supa.from('guild').delete().in('id', TEST_GUILDS);
    expect(error).toBeNull();
  }
  await sqlA?.end({ timeout: 5 });
  await sqlB?.end({ timeout: 5 });
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
  });

  it('freezes immutable order grants and finalizes one capture exactly once', async () => {
    const roleId = nextSnowflake();
    const channelId = nextSnowflake();
    const discordId = nextSnowflake();
    const productId = await createProduct({
      granted_role_ids: [roleId],
      granted_channel_ids: [channelId],
    });
    const { error: configError } = await supa.from('commerce_product_temp_role_config').insert({
      product_id: productId,
      guild_id: GUILD_A,
      role_id: roleId,
      duration_seconds: 3_600,
    });
    expect(configError).toBeNull();

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
      temporary_role_grants_snapshot: [{ role_id: roleId, duration_seconds: 3_600 }],
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
      .eq('role_id', roleId);
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

    const prepared = await supa.rpc('commerce_prepare_temp_role_grant', {
      p_guild_id: GUILD_A,
      p_user_id: discordId,
      p_role_id: roleId,
      p_order_id: order!.id,
      p_product_id: productId,
      p_duration_seconds: 3_600,
    });
    expect(prepared.error).toBeNull();
    expect(prepared.data).toMatchObject({ grant_status: 'pending' });

    const preparedReplay = await supa.rpc('commerce_prepare_temp_role_grant', {
      p_guild_id: GUILD_A,
      p_user_id: discordId,
      p_role_id: roleId,
      p_order_id: order!.id,
      p_product_id: productId,
      p_duration_seconds: 3_600,
    });
    expect(preparedReplay.error).toBeNull();
    expect(preparedReplay.data).toMatchObject({
      id: (prepared.data as Record<string, unknown>).id,
      expires_at: (prepared.data as Record<string, unknown>).expires_at,
    });

    const mutableDurationRejected = await supa.rpc('commerce_prepare_temp_role_grant', {
      p_guild_id: GUILD_A,
      p_user_id: discordId,
      p_role_id: roleId,
      p_order_id: order!.id,
      p_product_id: productId,
      p_duration_seconds: 7_200,
    });
    expect(mutableDurationRejected.error).not.toBeNull();

    const validSuccessorStates = [
      { payment: 'completed', order: 'refunded' },
      { payment: 'completed', order: 'disputed' },
      { payment: 'refunded', order: 'refunded' },
      { payment: 'reversed', order: 'refunded' },
      { payment: 'reversed', order: 'disputed' },
    ] as const;

    for (const successor of validSuccessorStates) {
      const paymentTransition = await supa
        .from('payments')
        .update({ status: successor.payment })
        .eq('paypal_payment_id', captureId);
      expect(paymentTransition.error).toBeNull();

      const orderTransition = await supa
        .from('orders')
        .update({ status: successor.order, updated_at: new Date().toISOString() })
        .eq('id', order!.id);
      expect(orderTransition.error).toBeNull();

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

        const paymentTransition = await supa
          .from('payments')
          .update({ status: paymentStatus })
          .eq('paypal_payment_id', captureId);
        expect(paymentTransition.error).toBeNull();
        const orderTransition = await supa
          .from('orders')
          .update({ status: orderStatus, updated_at: new Date().toISOString() })
          .eq('id', order!.id);
        expect(orderTransition.error).toBeNull();

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

    const restorePayment = await supa
      .from('payments')
      .update({ status: 'completed' })
      .eq('paypal_payment_id', captureId);
    expect(restorePayment.error).toBeNull();
    const restoreOrder = await supa
      .from('orders')
      .update({ status: 'completed', updated_at: new Date().toISOString() })
      .eq('id', order!.id);
    expect(restoreOrder.error).toBeNull();

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
    const productId = await createProduct();
    const { data: customer, error: customerError } = await supa
      .from('customers')
      .insert({
        guild_id: GUILD_A,
        discord_id: nextSnowflake(),
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

    const { data: movedProduct, error: moveError } = await supa
      .from('products')
      .update({ guild_id: GUILD_B })
      .eq('id', productId)
      .select('id,guild_id')
      .single();
    expect(moveError).toBeNull();
    expect(movedProduct).toMatchObject({ id: productId, guild_id: GUILD_B });

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
    const unsupportedPaymentResolution = await supa
      .from('payments')
      .update({ status: 'completed' })
      .eq('paypal_payment_id', captureId);
    expect(unsupportedPaymentResolution.error).toBeNull();
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

    const stagedClaim = await supa.rpc('bot_action_queue_claim', { p_action_id: staged!.id });
    expect(stagedClaim.error).toBeNull();
    expect(stagedClaim.data).toEqual([]);

    const release = await supa
      .from('bot_action_queue')
      .update({ status: 'pending' })
      .eq('id', staged!.id);
    expect(release.error).toBeNull();
    const pendingClaim = await supa.rpc('bot_action_queue_claim', { p_action_id: staged!.id });
    expect(pendingClaim.error).toBeNull();
    expect(pendingClaim.data).toHaveLength(1);
    expect(pendingClaim.data?.[0]?.status).toBe('processing');
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
          'public.commerce_prepare_temp_role_grant(text,text,text,uuid,uuid,integer)',
          'EXECUTE'
        ) AS service_can_prepare,
        pg_catalog.has_table_privilege(
          'anon',
          'public.commerce_product_temp_role_config',
          'SELECT,INSERT,UPDATE,DELETE'
        ) AS anon_can_touch_temp_config
    `;
    expect(privileges[0]).toMatchObject({
      service_can_freeze: true,
      anon_can_freeze: false,
      authenticated_can_finalize: false,
      service_can_prepare: true,
      anon_can_touch_temp_config: false,
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

  it('serializes activation-first and income-first races on two clients', async () => {
    const activationFirstRole = nextName('activation-first-role');
    const activationFirstProduct = await createProduct({
      active: false,
      granted_role_ids: [activationFirstRole],
    });

    const activationStarted = makeGate();
    const releaseActivation = makeGate();
    const activationTransaction = sqlA.begin(async (tx) => {
      await tx`
        UPDATE public.products
        SET active = TRUE
        WHERE id = ${activationFirstProduct}
      `;
      activationStarted.open();
      await releaseActivation.promise;
    });
    await activationStarted.promise;

    let incomeSettled = false;
    const competingIncome = sqlB`
      INSERT INTO public.economy_role_income (
        guild_id, role_id, amount, interval_minutes
      ) VALUES (${GUILD_A}, ${activationFirstRole}, 50, 60)
    `.then(
      () => ({ error: null as unknown }),
      (error: unknown) => ({ error }),
    ).finally(() => {
      incomeSettled = true;
    });

    await delay(100);
    const incomeWaitedForGuildLock = !incomeSettled;
    releaseActivation.open();
    await activationTransaction;
    const competingIncomeResult = await competingIncome;

    expect(incomeWaitedForGuildLock).toBe(true);
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
    const incomeTransaction = sqlA.begin(async (tx) => {
      await tx`
        INSERT INTO public.economy_role_income (
          guild_id, role_id, amount, interval_minutes
        ) VALUES (${GUILD_A}, ${incomeFirstRole}, 50, 60)
      `;
      incomeStarted.open();
      await releaseIncome.promise;
    });
    await incomeStarted.promise;

    let activationSettled = false;
    const competingActivation = sqlB`
      UPDATE public.products
      SET active = TRUE
      WHERE id = ${incomeFirstProduct}
    `.then(
      () => ({ error: null as unknown }),
      (error: unknown) => ({ error }),
    ).finally(() => {
      activationSettled = true;
    });

    await delay(100);
    const activationWaitedForGuildLock = !activationSettled;
    releaseIncome.open();
    await incomeTransaction;
    const competingActivationResult = await competingActivation;

    expect(activationWaitedForGuildLock).toBe(true);
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
