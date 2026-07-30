/**
 * Real-database recovery coverage for exact commerce role-delivery carriers.
 *
 * This file is intentionally isolated from the broad commerce income-wall
 * suite. It drives the protocol through its public SECURITY DEFINER RPCs and
 * uses owner connections only to create deterministic lock interleavings,
 * inspect durable evidence, or construct explicitly-labelled corruption.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import postgres from 'postgres';
import { getTestDbUrl, requireSupabase } from './helpers.js';

const RUN_ID = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const GUILD_ID = `test-role-recovery-${RUN_ID}`;
const MIGRATION_PATH = fileURLToPath(new URL(
  '../../../../supabase/migrations/20260711030000_canonicalize_commerce_role_metadata.sql',
  import.meta.url,
));
const CHECKOUT_RAIL_MIGRATION = migrationBody(fileURLToPath(new URL(
  '../../../../supabase/migrations/20260727041000_checkout_double_charge_rails.sql',
  import.meta.url,
)));
const SNOWFLAKE_BASE = 920_000_000_000_000_000n
  + BigInt(Date.now() % 1_000_000) * 10_000n;

let supa!: SupabaseClient;
let sqlA!: ReturnType<typeof postgres>;
let sqlB!: ReturnType<typeof postgres>;
let sqlObserver!: ReturnType<typeof postgres>;
let sqlBBackendPid!: number;
let sequence = 0;

type QueueClaim = {
  id: string;
  claim_token: string;
  status: string;
};

type DeliveryBegin = {
  intent_id: string;
  mutation_token: string;
  intent_state: string;
  may_mutate: boolean;
  contract_live: boolean;
  outward_generation_id: string;
};

type RetryResult = {
  action_id: string | null;
  action_status: string | null;
  disposition: string;
};

type PaidFixture = {
  productId: string;
  productName: string;
  customerId: string;
  discordId: string;
  orderId: string;
  orderNumber: string;
  entitlementId: string;
  permanentRoleId: string | null;
  tempRoleId: string | null;
  tempDurationSeconds: number | null;
  tempGrantId: string | null;
  payload: Record<string, unknown>;
};

type ActiveDelivery = {
  actionId: string;
  claimToken: string;
  intentId: string;
  mutationToken: string;
  orderId: string;
  outwardGenerationId: string;
};

type FailedDelivery = ActiveDelivery & {
  dlqId: string;
  finishDisposition: string;
};

function migrationBody(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/^\uFEFF?\s*BEGIN;\s*/i, '')
    .replace(/\s*COMMIT;\s*$/i, '');
}

function nextName(prefix: string): string {
  sequence += 1;
  return `${prefix}-${RUN_ID}-${sequence}`;
}

function nextSnowflake(): string {
  sequence += 1;
  return (SNOWFLAKE_BASE + BigInt(sequence)).toString();
}

function uuidV7Fixture(): string {
  const value = randomUUID();
  return `${value.slice(0, 14)}7${value.slice(15)}`;
}

function onlyRow<T>(data: unknown, label: string): T {
  expect(Array.isArray(data), `${label} must return an array`).toBe(true);
  expect(data, `${label} must return exactly one row`).toHaveLength(1);
  return (data as T[])[0]!;
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

async function jsonbFingerprint(payload: Record<string, unknown>): Promise<string> {
  // The parameter must reach PostgreSQL typed as TEXT: postgres.js
  // re-serializes an already-stringified value when the placeholder's
  // described type is json/jsonb, double-encoding it into a JSON string.
  const [row] = await sqlA<{ fingerprint: string }[]>`
    SELECT pg_catalog.md5((${JSON.stringify(payload)}::TEXT)::JSONB::TEXT) AS fingerprint
  `;
  expect(row?.fingerprint).toMatch(/^[0-9a-f]{32}$/);
  return row!.fingerprint;
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
    }[]>`
      SELECT state, wait_event_type
      FROM pg_catalog.pg_stat_activity
      WHERE pid = ${backendPid}
    `;
    if (activity?.state === 'active' && activity.wait_event_type === 'Lock') return;
    await delay(10);
  }
  throw new Error(`${description} did not reach a PostgreSQL lock wait`);
}

async function cleanFixtures(): Promise<void> {
  await sqlA`
    DELETE FROM public.commerce_noncommerce_activation_heads
     WHERE guild_id = ${GUILD_ID}
  `;
  await sqlA`
    DELETE FROM public.commerce_role_delivery_intents
     WHERE guild_id = ${GUILD_ID}
  `;
  await sqlA`DELETE FROM public.alerts WHERE guild_id = ${GUILD_ID}`;
  // audit_logs rows are immutable by design (trg_prevent_audit_log_delete);
  // they accumulate for the run-unique guild and every audit assertion in
  // this suite scopes by exact row id, so retained rows are harmless.
  await sqlA`
    UPDATE public.bot_action_queue
       SET status = 'completed',
           started_at = NULL,
           completed_at = COALESCE(completed_at, pg_catalog.clock_timestamp())
     WHERE guild_id = ${GUILD_ID}
       AND action = 'revoke_roles'
       AND payload ->> 'source' IN (
         'noncommerce_entitlement_status_trigger',
         'noncommerce_entitlement_customer_relink_trigger',
         'noncommerce_entitlement_activation_trigger'
       )
       AND status <> 'completed'
  `;
  await sqlA`DELETE FROM public.action_queue_dlq WHERE guild_id = ${GUILD_ID}`;
  await sqlA`DELETE FROM public.bot_action_queue WHERE guild_id = ${GUILD_ID}`;
  await sqlA`DELETE FROM public.giveaways WHERE guild_id = ${GUILD_ID}`;
  await sqlA`DELETE FROM public.temp_role_grants WHERE guild_id = ${GUILD_ID}`;
  await sqlA`DELETE FROM public.commerce_fulfillment_holds WHERE guild_id = ${GUILD_ID}`;
  await sqlA`DELETE FROM public.commerce_fulfillment_claims WHERE guild_id = ${GUILD_ID}`;
  await sqlA`
    DELETE FROM public.commerce_fulfillment_outward_intents
     WHERE guild_id = ${GUILD_ID}
  `;
  await sqlA`
    DELETE FROM public.commerce_checkout_deactivation_proofs
     WHERE guild_id = ${GUILD_ID}
  `;
  await sqlA`DELETE FROM public.entitlements WHERE guild_id = ${GUILD_ID}`;
  await sqlA`DELETE FROM public.payment_refunds WHERE guild_id = ${GUILD_ID}`;
  await sqlA`DELETE FROM public.payments WHERE guild_id = ${GUILD_ID}`;
  await sqlA`DELETE FROM public.license_keys WHERE guild_id = ${GUILD_ID}`;
  await sqlA`DELETE FROM public.orders WHERE guild_id = ${GUILD_ID}`;
  await sqlA`
    DELETE FROM public.commerce_product_temp_role_config
     WHERE guild_id = ${GUILD_ID}
  `;
  await sqlA`DELETE FROM public.products WHERE guild_id = ${GUILD_ID}`;
  await sqlA`DELETE FROM public.customers WHERE guild_id = ${GUILD_ID}`;
}

async function createPaidFixture(options: {
  permanentRoleId?: string | null;
  grantedChannelIds?: string[];
  productType?: 'one_time' | 'subscription';
  tempRoleId?: string | null;
  tempDurationSeconds?: number;
  customer?: { id: string; discordId: string };
} = {}): Promise<PaidFixture> {
  const permanentRoleId = options.permanentRoleId ?? null;
  const tempRoleId = options.tempRoleId ?? null;
  const tempDurationSeconds = tempRoleId === null
    ? null
    : (options.tempDurationSeconds ?? 60);
  const productName = nextName('recovery-product');
  const { data: product, error: productError } = await supa
    .from('products')
    .insert({
      guild_id: GUILD_ID,
      name: productName,
      description: 'role-delivery recovery integration fixture',
      type: options.productType ?? 'one_time',
      delivery_type: 'access_pass',
      price_cents: 1_000,
      currency: 'USD',
      granted_role_ids: permanentRoleId === null ? [] : [permanentRoleId],
      granted_channel_ids: options.grantedChannelIds ?? [],
      active: true,
    })
    .select('id')
    .single();
  expect(productError).toBeNull();
  if (!product?.id) throw new Error('product fixture returned no id');
  const productId = product.id as string;

  if (tempRoleId !== null && tempDurationSeconds !== null) {
    const { error } = await supa.from('commerce_product_temp_role_config').insert({
      product_id: productId,
      guild_id: GUILD_ID,
      role_id: tempRoleId,
      duration_seconds: tempDurationSeconds,
    });
    expect(error).toBeNull();
  }

  let customerId = options.customer?.id;
  const discordId = options.customer?.discordId ?? nextSnowflake();
  if (!customerId) {
    const { data: customer, error: customerError } = await supa
      .from('customers')
      .insert({
        guild_id: GUILD_ID,
        discord_id: discordId,
        discord_username: nextName('recovery-customer'),
      })
      .select('id')
      .single();
    expect(customerError).toBeNull();
    if (!customer?.id) throw new Error('customer fixture returned no id');
    customerId = customer.id as string;
  }

  const orderNumber = nextName('recovery-order');
  const paypalOrderId = nextName('paypal-order');
  // Fixture construction is owner-only setup. API/service callers are
  // intentionally barred from direct paid-order inserts by the production
  // reservation trigger and must use sanctioned commerce RPCs.
  const [order] = await sqlObserver<{ id: string }[]>`
    INSERT INTO public.orders (
      order_number,
      customer_id,
      guild_id,
      product_id,
      paypal_order_id,
      amount_cents,
      currency,
      source,
      status
    ) VALUES (
      ${orderNumber},
      ${customerId},
      ${GUILD_ID},
      ${productId},
      ${paypalOrderId},
      1000,
      'USD',
      'purchase',
      'pending'
    )
    RETURNING id
  `;
  if (!order?.id) throw new Error('order fixture returned no id');
  const orderId = order.id;

  // The freeze/capture pair below models a one-time PayPal checkout. The
  // shipped freeze RPC fail-closes on subscription products unless the order
  // carries the exact plan + paypal_subscription_id checkout contract
  // ("subscription id is required"), which the subscription-product tests in
  // this suite never exercise: they only need the product, plan, and customer
  // identities to drive zero-dollar noncommerce grants.
  if ((options.productType ?? 'one_time') === 'one_time') {
    const freeze = await supa.rpc('commerce_freeze_order_grant_snapshot', {
      p_order_id: orderId,
      p_guild_id: GUILD_ID,
      p_customer_id: customerId,
      p_product_id: productId,
    });
    expect(freeze.error).toBeNull();

    const capture = await supa.rpc('commerce_finalize_paypal_capture', {
      p_order_id: orderId,
      p_guild_id: GUILD_ID,
      p_customer_id: customerId,
      p_product_id: productId,
      p_paypal_order_id: paypalOrderId,
      p_paypal_capture_id: nextName('capture'),
      p_amount_cents: 1_000,
      p_currency: 'USD',
    });
    expect(capture.error).toBeNull();
  } else {
    // Subscription fixtures skip the checkout pair above, so the order never
    // leaves 'pending' on its own. The paid-live FK
    // (commerce_paid_live_entitlement_order_fk) makes every live 'purchase'
    // entitlement the child of one exact COMPLETED order identity, so model
    // provider-side subscription activation by completing the never-frozen
    // order directly; the snapshot-protection trigger only locks orders after
    // their first freeze, and 'completed' is not a terminal-cleanup signal.
    await sqlObserver`
      UPDATE public.orders
         SET status = 'completed'
       WHERE id = ${orderId}
         AND guild_id = ${GUILD_ID}
    `;
  }

  const { data: entitlement, error: entitlementError } = await supa
    .from('entitlements')
    .insert({
      customer_id: customerId,
      guild_id: GUILD_ID,
      product_id: productId,
      order_id: orderId,
      type: 'one_time',
      status: 'active',
      source: 'purchase',
      granted_role_ids: permanentRoleId === null ? [] : [permanentRoleId],
      granted_channel_ids: [],
    })
    .select('id')
    .single();
  expect(entitlementError).toBeNull();
  if (!entitlement?.id) throw new Error('entitlement fixture returned no id');
  const entitlementId = entitlement.id as string;

  let tempGrantId: string | null = null;
  if (tempRoleId !== null && tempDurationSeconds !== null) {
    const prepared = await supa.rpc('commerce_prepare_temp_role_grant', {
      p_guild_id: GUILD_ID,
      p_user_id: discordId,
      p_role_id: tempRoleId,
      p_order_id: orderId,
      p_product_id: productId,
      p_duration_seconds: tempDurationSeconds,
    });
    expect(prepared.error).toBeNull();
    tempGrantId = String((prepared.data as { id?: unknown } | null)?.id ?? '');
    if (!tempGrantId) throw new Error('temporary grant fixture returned no id');
  }

  return {
    productId,
    productName,
    customerId,
    discordId,
    orderId,
    orderNumber,
    entitlementId,
    permanentRoleId,
    tempRoleId,
    tempDurationSeconds,
    tempGrantId,
    payload: {
      fulfillment_type: 'one_time_purchase',
      entitlement_type: 'one_time',
      entitlement_id: entitlementId,
      guild_id: GUILD_ID,
      customer_id: customerId,
      discord_id: discordId,
      order_id: orderId,
      product_id: productId,
      product_name: productName,
      order_number: orderNumber,
      amount_cents: 1_000,
      currency: 'USD',
      plan_id: null,
      paypal_subscription_id: null,
      granted_role_ids: permanentRoleId === null ? [] : [permanentRoleId],
      granted_channel_ids: [],
      temporary_role_grants: tempRoleId === null || tempDurationSeconds === null
        ? []
        : [{ role_id: tempRoleId, duration_seconds: tempDurationSeconds }],
    },
  };
}

async function insertCarrier(
  fixture: PaidFixture,
  options: {
    id?: string;
    action?: string;
    payload?: Record<string, unknown>;
    status?: 'staged' | 'pending' | 'failed';
    idempotencyKey?: string | null;
  } = {},
): Promise<string> {
  const id = options.id ?? randomUUID();
  const { data, error } = await supa
    .from('bot_action_queue')
    .insert({
      id,
      guild_id: GUILD_ID,
      action: options.action ?? 'fulfill_purchase',
      payload: options.payload ?? fixture.payload,
      status: options.status ?? 'pending',
      idempotency_key: options.idempotencyKey ?? null,
    })
    .select('id')
    .single();
  expect(error).toBeNull();
  if (!data?.id) throw new Error('queue carrier returned no id');
  return data.id as string;
}

async function insertDlq(actionId: string): Promise<string> {
  const { data: action, error: actionError } = await supa
    .from('bot_action_queue')
    .select('guild_id,action,payload,error_message,retry_count,lane')
    .eq('id', actionId)
    .single();
  expect(actionError).toBeNull();
  const { data: dlq, error: dlqError } = await supa
    .from('action_queue_dlq')
    .insert({
      guild_id: GUILD_ID,
      action: action!.action,
      payload: action!.payload,
      error_message: action!.error_message ?? 'fixture failure',
      retry_count: action!.retry_count ?? 0,
      max_retries: 5,
      original_id: actionId,
      lane: action!.lane,
    })
    .select('id')
    .single();
  expect(dlqError).toBeNull();
  if (!dlq?.id) throw new Error('DLQ fixture returned no id');
  return dlq.id as string;
}

async function claimAction(actionId: string): Promise<QueueClaim> {
  const claimed = await supa.rpc('bot_action_queue_claim', {
    p_action_id: actionId,
    p_protocol_version: 2,
  });
  expect(claimed.error).toBeNull();
  return onlyRow<QueueClaim>(claimed.data, 'bot_action_queue_claim');
}

async function completeNoncommerceActivation(
  actionId: string,
  roleWasPresent = true,
): Promise<void> {
  const { data: action, error: actionError } = await supa
    .from('bot_action_queue')
    .select('payload')
    .eq('id', actionId)
    .single();
  expect(actionError).toBeNull();
  const payload = action?.payload as Record<string, unknown> | undefined;
  const roleIds = payload?.role_ids;
  if (
    !payload
    || !Array.isArray(roleIds)
    || roleIds.length === 0
    || roleIds.some((roleId) => typeof roleId !== 'string')
  ) {
    throw new Error('noncommerce activation fixture has malformed role identity');
  }

  const claim = await claimAction(actionId);
  const begun = await supa.rpc('commerce_begin_noncommerce_role_delivery_attempt', {
    p_action_id: actionId,
    p_claim_token: claim.claim_token,
    p_entitlement_id: payload.entitlement_id,
    p_guild_id: payload.guild_id,
    p_customer_id: payload.customer_id,
    p_discord_id: payload.discord_id,
    p_order_id: payload.order_id,
    p_product_id: payload.product_id,
    p_plan_id: payload.plan_id,
    p_entitlement_type: payload.entitlement_type,
    p_entitlement_source: payload.entitlement_source,
    p_activation_generation: payload.activation_generation,
    p_permanent_role_ids: roleIds,
  });
  expect(begun.error).toBeNull();
  const attempt = onlyRow<{
    intent_id: string;
    mutation_token: string | null;
    disposition: string;
  }>(begun.data, 'noncommerce activation begin');

  if (attempt.disposition === 'live_mutation') {
    expect(attempt.mutation_token).toMatch(/^[0-9a-f-]{36}$/);
    for (const roleId of roleIds as string[]) {
      const attached = await supa.rpc('commerce_attach_permanent_role_delivery', {
        p_intent_id: attempt.intent_id,
        p_mutation_token: attempt.mutation_token,
        p_role_id: roleId,
        p_role_was_present: roleWasPresent,
      });
      expect(attached.error).toBeNull();
      expect(onlyRow<{ disposition: string }>(
        attached.data,
        'noncommerce role attachment',
      ).disposition).toBe(roleWasPresent ? 'manual_baseline' : 'reserve_add');
      if (roleWasPresent) {
        const baseline = await supa.rpc('commerce_confirm_permanent_role_baseline', {
          p_intent_id: attempt.intent_id,
          p_mutation_token: attempt.mutation_token,
          p_role_id: roleId,
        });
        expect(baseline.error).toBeNull();
        expect(onlyRow<{ confirmed: boolean; disposition: string }>(
          baseline.data,
          'noncommerce role baseline confirmation',
        )).toMatchObject({ confirmed: true, disposition: 'manual_baseline' });
      } else {
        const confirmed = await supa.rpc('commerce_confirm_permanent_role_delivery', {
          p_intent_id: attempt.intent_id,
          p_mutation_token: attempt.mutation_token,
          p_role_id: roleId,
        });
        expect(confirmed.error).toBeNull();
        expect(onlyRow<{ promoted: boolean }>(
          confirmed.data,
          'noncommerce role confirmation',
        ).promoted).toBe(true);
      }
    }
    const live = await supa.rpc('commerce_finish_role_delivery_attempt', {
      p_intent_id: attempt.intent_id,
      p_mutation_token: attempt.mutation_token,
      p_outcome: 'live',
      p_error: null,
    });
    expect(live.error).toBeNull();
    expect(['confirmed_open', 'settled']).toContain(
      onlyRow<{ disposition: string }>(live.data, 'noncommerce live finish').disposition,
    );
  } else {
    expect(attempt.mutation_token).toBeNull();
    expect(['confirmed_replay', 'superseded', 'unproven']).toContain(
      attempt.disposition,
    );
  }

  const queueFinished = await supa.rpc('bot_action_queue_finish_claim', {
    p_action_id: actionId,
    p_claim_token: claim.claim_token,
    p_success: true,
    p_result: { ensured: roleIds },
    p_error: null,
  });
  expect(queueFinished.error).toBeNull();
  expect(onlyRow<{ disposition: string }>(
    queueFinished.data,
    'noncommerce activation queue finish',
  ).disposition).toBe('completed');
}

async function completeNoopNoncommerceCleanup(actionId: string): Promise<string> {
  const claim = await claimAction(actionId);
  const prepared = await supa.rpc(
    'commerce_prepare_noncommerce_role_delivery_cleanup',
    {
      p_action_id: actionId,
      p_claim_token: claim.claim_token,
    },
  );
  expect(prepared.error).toBeNull();
  const result = onlyRow<{ disposition: string }>(
    prepared.data,
    'noncommerce cleanup preparation',
  );
  expect([
    'unproven',
    'destination_unproven',
    'superseded',
    'settled_noop',
  ]).toContain(result.disposition);
  const finished = await supa.rpc('bot_action_queue_finish_claim', {
    p_action_id: actionId,
    p_claim_token: claim.claim_token,
    p_success: true,
    p_result: { disposition: result.disposition },
    p_error: null,
  });
  expect(finished.error).toBeNull();
  expect(onlyRow<{ disposition: string }>(
    finished.data,
    'noncommerce no-op cleanup queue finish',
  ).disposition).toBe('completed');
  return result.disposition;
}

async function completeLegacyNoncommerceAction(actionId: string): Promise<void> {
  const { data: action, error } = await supa
    .from('bot_action_queue')
    .select('payload')
    .eq('id', actionId)
    .single();
  expect(error).toBeNull();
  const source = (action?.payload as Record<string, unknown> | null)?.source;
  if (source === 'noncommerce_entitlement_activation_trigger') {
    await completeNoncommerceActivation(actionId);
    return;
  }
  expect([
    'noncommerce_entitlement_status_trigger',
    'noncommerce_entitlement_customer_relink_trigger',
  ]).toContain(source);
  await completeNoopNoncommerceCleanup(actionId);
}

async function beginDelivery(
  fixture: PaidFixture,
  actionId: string,
  claimToken: string,
): Promise<DeliveryBegin> {
  const begun = await supa.rpc('commerce_begin_role_delivery_attempt', {
    p_action_id: actionId,
    p_claim_token: claimToken,
    p_entitlement_id: fixture.entitlementId,
    p_guild_id: GUILD_ID,
    p_customer_id: fixture.customerId,
    p_discord_id: fixture.discordId,
    p_order_id: fixture.orderId,
    p_product_id: fixture.productId,
    p_plan_id: null,
    p_entitlement_type: 'one_time',
    p_permanent_role_ids: fixture.permanentRoleId === null
      ? []
      : [fixture.permanentRoleId],
  });
  expect(begun.error).toBeNull();
  const row = onlyRow<DeliveryBegin>(begun.data, 'commerce_begin_role_delivery_attempt');
  expect(row).toMatchObject({
    intent_state: 'open',
    may_mutate: true,
    contract_live: true,
  });
  return row;
}

async function startDelivery(fixture: PaidFixture, actionId: string): Promise<ActiveDelivery> {
  const claim = await claimAction(actionId);
  const begun = await beginDelivery(fixture, actionId, claim.claim_token);
  return {
    actionId,
    claimToken: claim.claim_token,
    intentId: begun.intent_id,
    mutationToken: begun.mutation_token,
    orderId: fixture.orderId,
    outwardGenerationId: begun.outward_generation_id,
  };
}

async function promotePermanent(
  fixture: PaidFixture,
  delivery: ActiveDelivery,
): Promise<void> {
  if (!fixture.permanentRoleId) throw new Error('fixture has no permanent role');
  await reservePermanent(fixture, delivery);
  const confirmed = await supa.rpc('commerce_confirm_permanent_role_delivery', {
    p_intent_id: delivery.intentId,
    p_mutation_token: delivery.mutationToken,
    p_role_id: fixture.permanentRoleId,
  });
  expect(confirmed.error).toBeNull();
  expect(onlyRow<{ promoted: boolean }>(confirmed.data, 'permanent confirmation').promoted)
    .toBe(true);
}

async function reservePermanent(
  fixture: PaidFixture,
  delivery: ActiveDelivery,
): Promise<void> {
  if (!fixture.permanentRoleId) throw new Error('fixture has no permanent role');
  const reserved = await supa.rpc('commerce_claim_permanent_role_delivery', {
    p_intent_id: delivery.intentId,
    p_mutation_token: delivery.mutationToken,
    p_role_id: fixture.permanentRoleId,
  });
  expect(reserved.error).toBeNull();
  expect(onlyRow<{ may_mutate: boolean }>(reserved.data, 'permanent reservation').may_mutate)
    .toBe(true);
}

async function reserveTemp(
  fixture: PaidFixture,
  delivery: ActiveDelivery,
  roleWasPresent = false,
): Promise<void> {
  if (!fixture.tempGrantId || !fixture.tempRoleId || !fixture.tempDurationSeconds) {
    throw new Error('fixture has no temporary role');
  }
  const reserved = await supa.rpc('commerce_attach_temp_role_delivery', {
    p_intent_id: delivery.intentId,
    p_mutation_token: delivery.mutationToken,
    p_grant_id: fixture.tempGrantId,
    p_role_id: fixture.tempRoleId,
    p_duration_seconds: fixture.tempDurationSeconds,
    p_role_was_present: roleWasPresent,
  });
  expect(reserved.error).toBeNull();
  expect(onlyRow<{ may_mutate: boolean }>(reserved.data, 'temporary reservation').may_mutate)
    .toBe(true);
}

async function confirmTemp(fixture: PaidFixture, delivery: ActiveDelivery): Promise<void> {
  if (!fixture.tempGrantId || !fixture.tempRoleId) {
    throw new Error('fixture has no temporary role');
  }
  const confirmed = await supa.rpc('commerce_confirm_temp_role_delivery', {
    p_intent_id: delivery.intentId,
    p_mutation_token: delivery.mutationToken,
    p_grant_id: fixture.tempGrantId,
    p_role_id: fixture.tempRoleId,
  });
  expect(confirmed.error).toBeNull();
  expect(onlyRow<{ promoted: boolean }>(confirmed.data, 'temporary confirmation').promoted)
    .toBe(true);
}

async function finishRetry(
  delivery: ActiveDelivery,
  error = 'deterministic downstream stage failure',
): Promise<string> {
  const finished = await supa.rpc('commerce_finish_role_delivery_attempt', {
    p_intent_id: delivery.intentId,
    p_mutation_token: delivery.mutationToken,
    p_outcome: 'retry',
    p_error: error,
  });
  expect(finished.error).toBeNull();
  return onlyRow<{ disposition: string }>(finished.data, 'delivery retry').disposition;
}

async function finishLive(delivery: ActiveDelivery): Promise<string> {
  const finished = await supa.rpc('commerce_finish_role_delivery_attempt', {
    p_intent_id: delivery.intentId,
    p_mutation_token: delivery.mutationToken,
    p_outcome: 'live',
    p_error: null,
  });
  expect(finished.error).toBeNull();
  const disposition = onlyRow<{ disposition: string }>(
    finished.data,
    'live delivery confirmation',
  ).disposition;
  expect(['confirmed_open', 'settled']).toContain(disposition);

  for (const intentKind of ['purchase_completed_event', 'receipt_dm']) {
    const begun = await supa.rpc('commerce_begin_fulfillment_outward_intent', {
      p_order_id: delivery.orderId,
      p_guild_id: GUILD_ID,
      p_intent_kind: intentKind,
      p_outward_generation_id: delivery.outwardGenerationId,
      p_action_id: delivery.actionId,
      p_claim_token: delivery.claimToken,
    });
    expect(begun.error).toBeNull();
    const outward = begun.data as {
      disposition: string;
      attempt_token: string | null;
    };
    expect(outward.disposition).toBe('send');
    expect(outward.attempt_token).toBeTruthy();

    const outwardFinished = await supa.rpc(
      'commerce_finish_fulfillment_outward_intent',
      {
        p_order_id: delivery.orderId,
        p_guild_id: GUILD_ID,
        p_intent_kind: intentKind,
        p_outward_generation_id: delivery.outwardGenerationId,
        p_attempt_token: outward.attempt_token,
        p_outcome: 'sent',
        p_error: null,
      },
    );
    expect(outwardFinished.error).toBeNull();
    expect((outwardFinished.data as { state: string }).state).toBe('sent');
  }

  const queueFinished = await supa.rpc('bot_action_queue_finish_claim', {
    p_action_id: delivery.actionId,
    p_claim_token: delivery.claimToken,
    p_success: true,
    p_result: { delivered: true },
    p_error: null,
  });
  expect(queueFinished.error).toBeNull();
  expect(onlyRow<{ disposition: string }>(
    queueFinished.data,
    'successful queue finalization',
  ).disposition).toBe('completed');
  return disposition;
}

async function classifyRoleOwner(
  fixture: PaidFixture,
  roleId: string,
  excludeGrantIds: string[],
): Promise<'confirmed' | 'pending' | 'none'> {
  const classified = await supa.rpc('commerce_classify_live_role_owner', {
    p_guild_id: GUILD_ID,
    p_discord_id: fixture.discordId,
    p_role_id: roleId,
    p_exclude_intent_id: null,
    p_exclude_entitlement_id: null,
    p_exclude_grant_ids: excludeGrantIds,
  });
  expect(classified.error).toBeNull();
  expect(['confirmed', 'pending', 'none']).toContain(classified.data);
  return classified.data as 'confirmed' | 'pending' | 'none';
}

async function waitUntilDatabasePast(timestamp: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await sqlA<{ expired: boolean }[]>`
      SELECT pg_catalog.clock_timestamp() >= ${timestamp}::TIMESTAMPTZ AS expired
    `;
    if (row?.expired) return;
    await delay(25);
  }
  throw new Error(`database clock did not pass ${timestamp}`);
}

async function finishQueueFailure(delivery: ActiveDelivery): Promise<string> {
  const failed = await supa.rpc('bot_action_queue_finish_claim', {
    p_action_id: delivery.actionId,
    p_claim_token: delivery.claimToken,
    p_success: false,
    p_result: null,
    p_error: 'deterministic handler failure',
  });
  expect(failed.error).toBeNull();
  expect(onlyRow<{ disposition: string }>(failed.data, 'queue failure').disposition)
    .toBe('failed');
  const { data: dlq, error } = await supa
    .from('action_queue_dlq')
    .select('id')
    .eq('original_id', delivery.actionId)
    .eq('retried', false)
    .single();
  expect(error).toBeNull();
  if (!dlq?.id) throw new Error('queue failure created no current DLQ row');
  return dlq.id as string;
}

async function failDelivery(
  fixture: PaidFixture,
  options: { promotePermanent?: boolean; promoteTemp?: boolean } = {},
): Promise<FailedDelivery> {
  const actionId = await insertCarrier(fixture);
  const delivery = await startDelivery(fixture, actionId);
  if (options.promotePermanent) await promotePermanent(fixture, delivery);
  if (options.promoteTemp) {
    await reserveTemp(fixture, delivery);
    await confirmTemp(fixture, delivery);
  }
  const finishDisposition = await finishRetry(delivery);
  const dlqId = await finishQueueFailure(delivery);
  return { ...delivery, dlqId, finishDisposition };
}

async function retryDlq(dlqId: string): Promise<RetryResult> {
  const retried = await supa.rpc('commerce_retry_role_delivery_dlq', {
    p_dlq_id: dlqId,
    p_guild_id: GUILD_ID,
  });
  expect(retried.error).toBeNull();
  return onlyRow<RetryResult>(retried.data, 'commerce_retry_role_delivery_dlq');
}

async function retryGenericDlq(dlqId: string): Promise<RetryResult> {
  const retried = await supa.rpc('bot_action_queue_retry_dlq', {
    p_dlq_id: dlqId,
    p_guild_id: GUILD_ID,
  });
  expect(retried.error).toBeNull();
  return onlyRow<RetryResult>(retried.data, 'bot_action_queue_retry_dlq');
}

beforeAll(async () => {
  supa = await requireSupabase();
  sqlA = postgres(getTestDbUrl(), { max: 1 });
  sqlB = postgres(getTestDbUrl(), { max: 1 });
  sqlObserver = postgres(getTestDbUrl(), { max: 1 });
  await Promise.all([
    sqlA`SET idle_in_transaction_session_timeout = '15s'`,
    sqlB`SET lock_timeout = '10s'`,
    sqlB`SET statement_timeout = '15s'`,
    sqlObserver`SET statement_timeout = '10s'`,
  ]);
  const [backend] = await sqlB<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
  if (!backend?.pid) throw new Error('failed to capture concurrency client PID');
  sqlBBackendPid = backend.pid;
  await sqlA.begin(async (tx) => {
    await tx.unsafe(CHECKOUT_RAIL_MIGRATION);
  });
  const { error } = await supa.from('guild').insert({
    id: GUILD_ID,
    name: 'Role recovery integration',
    owner_discord_id: nextSnowflake(),
  });
  expect(error).toBeNull();
});

beforeEach(async () => {
  await cleanFixtures();
});

afterAll(async () => {
  try {
    if (supa) {
      await cleanFixtures();
      // The guild row is intentionally retained: immutable audit_logs rows
      // (see cleanFixtures) keep an FK to guild(id), so deleting the guild
      // would fail once any audited commerce RPC ran. GUILD_ID is unique per
      // run, so retention is rerun-safe.
    }
  } finally {
    await Promise.allSettled([
      sqlA?.end({ timeout: 5 }),
      sqlB?.end({ timeout: 5 }),
      sqlObserver?.end({ timeout: 5 }),
    ]);
  }
});

describe('exact bound carrier recovery', () => {
  it('reopens partial confirmed authority repeatedly and selects only the newest unretried DLQ generation', async () => {
    const fixture = await createPaidFixture({
      permanentRoleId: nextSnowflake(),
      tempRoleId: nextSnowflake(),
    });
    const first = await failDelivery(fixture, { promotePermanent: true });
    expect(first.finishDisposition).toBe('safe_retry_owned');

    const reopened = await retryDlq(first.dlqId);
    expect(reopened).toEqual({
      action_id: first.actionId,
      action_status: 'pending',
      disposition: 'reopened',
    });
    const { data: recoveredIntent } = await supa
      .from('commerce_role_delivery_intents')
      .select('state,recovery_generation,owned_role_ids,reserved_role_ids')
      .eq('id', first.intentId)
      .single();
    expect(recoveredIntent).toMatchObject({
      state: 'open',
      recovery_generation: 1,
      owned_role_ids: [fixture.permanentRoleId],
      reserved_role_ids: [],
    });

    const staleMutation = await supa.rpc('commerce_assert_role_delivery_attempt_live', {
      p_intent_id: first.intentId,
      p_mutation_token: first.mutationToken,
    });
    expect(staleMutation.error?.code).toBe('23514');

    const nextClaim = await claimAction(first.actionId);
    const nextBegin = await beginDelivery(fixture, first.actionId, nextClaim.claim_token);
    expect(nextBegin.intent_id).toBe(first.intentId);
    const second: ActiveDelivery = {
      actionId: first.actionId,
      claimToken: nextClaim.claim_token,
      intentId: nextBegin.intent_id,
      mutationToken: nextBegin.mutation_token,
      orderId: fixture.orderId,
      outwardGenerationId: nextBegin.outward_generation_id,
    };
    expect(await finishRetry(second, 'second deterministic failure')).toBe('safe_retry_owned');
    const secondDlqId = await finishQueueFailure(second);

    const { data: generations, error: generationsError } = await supa
      .from('action_queue_dlq')
      .select('id,retried')
      .eq('original_id', first.actionId)
      .order('failed_at', { ascending: true });
    expect(generationsError).toBeNull();
    expect(generations).toHaveLength(2);
    expect(generations!.filter((row) => row.retried === false)).toEqual([
      { id: secondDlqId, retried: false },
    ]);

    expect(await retryDlq(first.dlqId)).toMatchObject({
      action_id: first.actionId,
      action_status: 'failed',
      disposition: 'operator_held',
    });
    const { data: currentAfterOldReplay } = await supa
      .from('action_queue_dlq')
      .select('retried')
      .eq('id', secondDlqId)
      .single();
    expect(currentAfterOldReplay?.retried).toBe(false);

    expect(await retryDlq(secondDlqId)).toEqual({
      action_id: first.actionId,
      action_status: 'pending',
      disposition: 'reopened',
    });
    const { data: finalIntent } = await supa
      .from('commerce_role_delivery_intents')
      .select('state,recovery_generation,owned_role_ids')
      .eq('id', first.intentId)
      .single();
    expect(finalIntent).toMatchObject({
      state: 'open',
      recovery_generation: 2,
      owned_role_ids: [fixture.permanentRoleId],
    });
  });

  it('serializes duplicate recovery so counters and authority advance once', async () => {
    const fixture = await createPaidFixture({ permanentRoleId: nextSnowflake() });
    const failed = await failDelivery(fixture, { promotePermanent: true });
    const gate = makeGate();
    const call = async (sql: ReturnType<typeof postgres>) => {
      await gate.promise;
      return sql<RetryResult[]>`
        SELECT * FROM public.commerce_retry_role_delivery_dlq(
          ${failed.dlqId}::UUID, ${GUILD_ID}::TEXT
        )
      `;
    };
    const firstCall = call(sqlA);
    const secondCall = call(sqlB);
    gate.open();
    const outcomes = (await Promise.all([firstCall, secondCall])).flat();
    expect(outcomes.map((row) => row.disposition).sort()).toEqual([
      'already_active',
      'reopened',
    ]);

    const [state] = await sqlA<{
      status: string;
      retry_count: number;
      recovery_generation: number;
    }[]>`
      SELECT queue.status, queue.retry_count, intent.recovery_generation
      FROM public.bot_action_queue AS queue
      JOIN public.commerce_role_delivery_intents AS intent
        ON intent.action_id = queue.id
      WHERE queue.id = ${failed.actionId}::UUID
    `;
    expect(state).toEqual({
      status: 'pending',
      retry_count: 1,
      recovery_generation: 1,
    });
  });

  it('serializes a worker claim against recovery commit, then begins on the reopened generation', async () => {
    const fixture = await createPaidFixture({ permanentRoleId: nextSnowflake() });
    const failed = await failDelivery(fixture, { promotePermanent: true });
    const recoveryEntered = makeGate();
    const releaseRecovery = makeGate();
    const recovery = sqlA.begin(async (tx) => {
      const rows = await tx<RetryResult[]>`
        SELECT * FROM public.commerce_retry_role_delivery_dlq(
          ${failed.dlqId}::UUID, ${GUILD_ID}::TEXT
        )
      `;
      recoveryEntered.open();
      await releaseRecovery.promise;
      return rows;
    });
    // Racing against the transaction promise surfaces an early rollback
    // instead of hanging the gate forever.
    await Promise.race([recoveryEntered.promise, recovery]);

    try {
      // bot_action_queue_claim is a strict conditional UPDATE gated on the
      // committed 'pending' status. While the recovery transaction holds the
      // reopened-but-uncommitted carrier, a concurrent worker claim must see
      // the committed 'failed' row, claim nothing, and never block on or
      // observe half-recovered state. (It cannot reach a row-lock wait: the
      // snapshot-visible tuple already fails the status qualifier.)
      const midRecoveryClaim = await sqlB<QueueClaim[]>`
        SELECT * FROM public.bot_action_queue_claim(${failed.actionId}::UUID, 2)
      `;
      expect(midRecoveryClaim).toHaveLength(0);
    } finally {
      // Never leak the held sqlA transaction, or every later beforeEach hangs
      // behind the single reserved sqlA connection.
      releaseRecovery.open();
    }
    const recoveryRows = await recovery;
    expect(recoveryRows).toEqual([{
      action_id: failed.actionId,
      action_status: 'pending',
      disposition: 'reopened',
    }]);

    const claimRows = await sqlB<QueueClaim[]>`
      SELECT * FROM public.bot_action_queue_claim(${failed.actionId}::UUID, 2)
    `;
    expect(claimRows).toHaveLength(1);
    expect(claimRows[0]).toMatchObject({ id: failed.actionId, status: 'processing' });

    const begun = await beginDelivery(fixture, failed.actionId, claimRows[0]!.claim_token);
    expect(begun).toMatchObject({ intent_id: failed.intentId, may_mutate: true });
  });
});

describe('unbound exact-carrier recovery', () => {
  it('reopens valid fulfill and relink request carriers in place and rejects malformed payloads', async () => {
    const fixture = await createPaidFixture({ permanentRoleId: nextSnowflake() });
    const fulfillId = await insertCarrier(fixture, { status: 'failed' });
    const fulfillDlq = await insertDlq(fulfillId);
    expect(await retryDlq(fulfillDlq)).toEqual({
      action_id: fulfillId,
      action_status: 'pending',
      disposition: 'reopened',
    });

    const relinkId = randomUUID();
    const oldDiscordId = nextSnowflake();
    const relinkPayload = {
      mode: 'ensure_live_request',
      action_id: relinkId,
      guild_id: GUILD_ID,
      entitlement_id: fixture.entitlementId,
      customer_id: fixture.customerId,
      old_discord_id: oldDiscordId,
      discord_id: fixture.discordId,
    };
    await insertCarrier(fixture, {
      id: relinkId,
      action: 'reconcile_entitlement_roles',
      payload: relinkPayload,
      status: 'failed',
      idempotencyKey: [
        'commerce-role-delivery-relink',
        fixture.customerId,
        oldDiscordId,
        fixture.discordId,
        fixture.entitlementId,
      ].join(':'),
    });
    const relinkDlq = await insertDlq(relinkId);
    expect(await retryDlq(relinkDlq)).toEqual({
      action_id: relinkId,
      action_status: 'pending',
      disposition: 'reopened',
    });

    const malformedId = await insertCarrier(fixture, {
      status: 'failed',
      payload: { ...fixture.payload, product_name: ' padded name ' },
    });
    const malformedDlq = await insertDlq(malformedId);
    const malformed = await supa.rpc('commerce_retry_role_delivery_dlq', {
      p_dlq_id: malformedDlq,
      p_guild_id: GUILD_ID,
    });
    expect(malformed.error).toMatchObject({ code: '23514' });
    const { data: malformedState } = await supa
      .from('bot_action_queue')
      .select('status,retry_count')
      .eq('id', malformedId)
      .single();
    expect(malformedState).toEqual({ status: 'failed', retry_count: 0 });
    const { data: malformedDlqState } = await supa
      .from('action_queue_dlq')
      .select('retried')
      .eq('id', malformedDlq)
      .single();
    expect(malformedDlqState?.retried).toBe(false);

    const { count } = await supa
      .from('bot_action_queue')
      .select('*', { count: 'exact', head: true })
      .in('id', [fulfillId, relinkId, malformedId]);
    expect(count).toBe(3);
  });
});

describe('intent-binding gap serialization', () => {
  it('does not generically finish after observing no intent and waiting behind begin', async () => {
    const fixture = await createPaidFixture();
    const actionId = await insertCarrier(fixture);
    const claim = await claimAction(actionId);
    const actionLocked = makeGate();
    const allowBegin = makeGate();
    const beginTransaction = sqlA.begin(async (tx) => {
      await tx`
        SELECT 1 FROM public.bot_action_queue
         WHERE id = ${actionId}::UUID
         FOR UPDATE
      `;
      actionLocked.open();
      await allowBegin.promise;
      return tx<DeliveryBegin[]>`
        SELECT * FROM public.commerce_begin_role_delivery_attempt(
          ${actionId}::UUID,
          ${claim.claim_token}::UUID,
          ${fixture.entitlementId}::UUID,
          ${GUILD_ID}::TEXT,
          ${fixture.customerId}::UUID,
          ${fixture.discordId}::TEXT,
          ${fixture.orderId}::UUID,
          ${fixture.productId}::UUID,
          NULL::UUID,
          'one_time'::TEXT,
          ARRAY[]::TEXT[]
        )
      `;
    });
    await Promise.race([actionLocked.promise, beginTransaction]);

    // .execute() dispatches the lazy postgres.js query immediately so it can
    // block on the action row before we start observing pg_stat_activity.
    const finishing = sqlB<{ applied: boolean; disposition: string }[]>`
      SELECT * FROM public.bot_action_queue_finish_claim(
        ${actionId}::UUID,
        ${claim.claim_token}::UUID,
        true,
        '{}'::JSONB,
        NULL::TEXT
      )
    `.execute();
    try {
      await waitForDatabaseLock(
        sqlBBackendPid,
        'finish_claim behind a concurrently binding begin',
      );
    } catch (error) {
      // Never leak the held sqlA transaction (max: 1 connection) — a leaked
      // gate wedges every later beforeEach cleanFixtures call.
      allowBegin.open();
      await Promise.allSettled([beginTransaction, finishing]);
      throw error;
    }
    allowBegin.open();
    const [begun, finishRows] = await Promise.all([beginTransaction, finishing]);
    expect(begun).toHaveLength(1);
    expect(finishRows).toHaveLength(1);
    expect(finishRows[0]?.applied).toBe(false);
    expect(finishRows[0]?.disposition).toBe('intent_raced');

    const [state] = await sqlA<{
      status: string;
      mutation_token: string | null;
    }[]>`
      SELECT queue.status, intent.mutation_token::TEXT
      FROM public.bot_action_queue AS queue
      JOIN public.commerce_role_delivery_intents AS intent
        ON intent.action_id = queue.id
      WHERE queue.id = ${actionId}::UUID
    `;
    expect(state).toEqual({
      status: 'processing',
      mutation_token: begun[0]!.mutation_token,
    });
  });

  it('does not generic-requeue a stale carrier after a concurrent begin binds it', async () => {
    const fixture = await createPaidFixture();
    const actionId = await insertCarrier(fixture);
    const claim = await claimAction(actionId);
    await sqlA`
      UPDATE public.bot_action_queue
         SET started_at = pg_catalog.clock_timestamp() - interval '2 minutes'
       WHERE id = ${actionId}::UUID
    `;
    const actionLocked = makeGate();
    const allowBegin = makeGate();
    const beginTransaction = sqlA.begin(async (tx) => {
      await tx`
        SELECT 1 FROM public.bot_action_queue
         WHERE id = ${actionId}::UUID
         FOR UPDATE
      `;
      actionLocked.open();
      await allowBegin.promise;
      return tx<DeliveryBegin[]>`
        SELECT * FROM public.commerce_begin_role_delivery_attempt(
          ${actionId}::UUID,
          ${claim.claim_token}::UUID,
          ${fixture.entitlementId}::UUID,
          ${GUILD_ID}::TEXT,
          ${fixture.customerId}::UUID,
          ${fixture.discordId}::TEXT,
          ${fixture.orderId}::UUID,
          ${fixture.productId}::UUID,
          NULL::UUID,
          'one_time'::TEXT,
          ARRAY[]::TEXT[]
        )
      `;
    });
    await Promise.race([actionLocked.promise, beginTransaction]);

    const recovering = sqlB<{ id: string; action: string; disposition: string }[]>`
      SELECT * FROM public.bot_action_queue_recover_stale(
        ${GUILD_ID}::TEXT, 1, 5
      )
    `.execute();
    try {
      await waitForDatabaseLock(
        sqlBBackendPid,
        'stale recovery behind a concurrently binding begin',
      );
    } catch (error) {
      allowBegin.open();
      await Promise.allSettled([beginTransaction, recovering]);
      throw error;
    }
    allowBegin.open();
    const [begun, recoveryRows] = await Promise.all([beginTransaction, recovering]);
    expect(begun).toHaveLength(1);
    expect(recoveryRows).toEqual([{
      id: actionId,
      action: 'fulfill_purchase',
      disposition: 'intent_raced',
    }]);

    const [state] = await sqlA<{
      status: string;
      mutation_token: string | null;
      last_delivery_mutation_token: string | null;
      last_delivery_outcome: string | null;
    }[]>`
      SELECT queue.status,
             intent.mutation_token::TEXT,
             intent.last_delivery_mutation_token::TEXT,
             intent.last_delivery_outcome
      FROM public.bot_action_queue AS queue
      JOIN public.commerce_role_delivery_intents AS intent
        ON intent.action_id = queue.id
      WHERE queue.id = ${actionId}::UUID
    `;
    expect(state).toMatchObject({
      status: 'processing',
      mutation_token: begun[0]!.mutation_token,
      last_delivery_mutation_token: null,
      last_delivery_outcome: null,
    });
  });
});

describe('stale processing recovery', () => {
  it('fences zero-authority and confirmed permanent/temp mutations without losing authority', async () => {
    const emptyFixture = await createPaidFixture();
    const emptyAction = await insertCarrier(emptyFixture);
    const emptyDelivery = await startDelivery(emptyFixture, emptyAction);

    const ownedFixture = await createPaidFixture({
      permanentRoleId: nextSnowflake(),
      tempRoleId: nextSnowflake(),
    });
    const ownedAction = await insertCarrier(ownedFixture);
    const ownedDelivery = await startDelivery(ownedFixture, ownedAction);
    await promotePermanent(ownedFixture, ownedDelivery);
    await reserveTemp(ownedFixture, ownedDelivery);
    await confirmTemp(ownedFixture, ownedDelivery);

    await sqlA`
      UPDATE public.bot_action_queue
         SET started_at = pg_catalog.clock_timestamp() - interval '2 minutes'
       WHERE id IN (${emptyAction}::UUID, ${ownedAction}::UUID)
    `;
    const recovered = await supa.rpc('bot_action_queue_recover_stale', {
      p_guild_id: GUILD_ID,
      p_timeout_seconds: 1,
      p_max_retries: 5,
    });
    expect(recovered.error).toBeNull();
    expect((recovered.data as Array<{ id: string; disposition: string }>).map((row) => ({
      id: row.id,
      disposition: row.disposition,
    })).sort((left, right) => left.id.localeCompare(right.id))).toEqual([
      { id: emptyAction, disposition: 'requeued' },
      { id: ownedAction, disposition: 'requeued' },
    ].sort((left, right) => left.id.localeCompare(right.id)));

    const { data: intents, error: intentError } = await supa
      .from('commerce_role_delivery_intents')
      .select('id,state,mutation_token,last_delivery_mutation_token,last_delivery_outcome,owned_role_ids,temporary_role_grant_ids')
      .in('id', [emptyDelivery.intentId, ownedDelivery.intentId]);
    expect(intentError).toBeNull();
    const ownedIntent = intents!.find((row) => row.id === ownedDelivery.intentId);
    expect(ownedIntent).toMatchObject({
      state: 'open',
      mutation_token: null,
      last_delivery_mutation_token: ownedDelivery.mutationToken,
      last_delivery_outcome: 'retry',
      owned_role_ids: [ownedFixture.permanentRoleId],
      temporary_role_grant_ids: [ownedFixture.tempGrantId],
    });

    for (const delivery of [emptyDelivery, ownedDelivery]) {
      const oldMutation = await supa.rpc('commerce_assert_role_delivery_attempt_live', {
        p_intent_id: delivery.intentId,
        p_mutation_token: delivery.mutationToken,
      });
      expect(oldMutation.error?.code).toBe('23514');
      const oldClaim = await supa.rpc('bot_action_queue_finish_claim', {
        p_action_id: delivery.actionId,
        p_claim_token: delivery.claimToken,
        p_success: true,
        p_result: { stale: true },
        p_error: null,
      });
      expect(oldClaim.error).toBeNull();
      expect(onlyRow<{ disposition: string }>(oldClaim.data, 'old stale claim').disposition)
        .toBe('stale_claim');
    }
  });
});

describe('recovery and temporary-authority guard boundaries', () => {
  it('captures CAS success before transaction-scope cleanup can clobber PL/pgSQL FOUND', () => {
    const migration = readFileSync(MIGRATION_PATH, 'utf8');
    expect(migration).toMatch(
      /RETURNING \* INTO v_grant;\s+v_grant_promoted := FOUND;\s+PERFORM pg_catalog\.set_config\(/,
    );
    expect(migration).toMatch(
      /RETURNING \* INTO v_intent;\s+v_intent_recovered := FOUND;\s+PERFORM pg_catalog\.set_config\(/,
    );
    expect(migration).toMatch(
      /RETURNING \* INTO v_grant;\s+v_grant_retired := FOUND;\s+PERFORM pg_catalog\.set_config\(/,
    );
  });

  it('rejects raw operator recovery even with a spoofed scope while the exact RPC succeeds', async () => {
    const fixture = await createPaidFixture({ permanentRoleId: nextSnowflake() });
    const failed = await failDelivery(fixture, { promotePermanent: true });

    const rawServiceUpdate = await supa
      .from('commerce_role_delivery_intents')
      .update({ state: 'open', recovery_generation: 1 })
      .eq('id', failed.intentId);
    expect(rawServiceUpdate.error).not.toBeNull();

    let spoofedError: { code?: string; message?: string } | null = null;
    try {
      await sqlA.begin(async (tx) => {
        await tx.unsafe('SET LOCAL ROLE service_role');
        await tx`
          SELECT pg_catalog.set_config(
            'somnibot.commerce_role_delivery_recovery_intent_id',
            ${failed.intentId},
            true
          )
        `;
        await tx`
          UPDATE public.commerce_role_delivery_intents
             SET state = 'open', recovery_generation = recovery_generation + 1
           WHERE id = ${failed.intentId}::UUID
        `;
      });
    } catch (error) {
      spoofedError = error as { code?: string; message?: string };
    }
    expect(spoofedError).not.toBeNull();
    expect(['23514', '42501']).toContain(spoofedError?.code);

    expect(await retryDlq(failed.dlqId)).toEqual({
      action_id: failed.actionId,
      action_status: 'pending',
      disposition: 'reopened',
    });
    const { data: state, error: stateError } = await supa
      .from('commerce_role_delivery_intents')
      .select('state,recovery_generation,last_delivery_mutation_token,last_delivery_outcome')
      .eq('id', failed.intentId)
      .single();
    expect(stateError).toBeNull();
    expect(state).toMatchObject({
      state: 'open',
      recovery_generation: 1,
      last_delivery_mutation_token: failed.mutationToken,
      last_delivery_outcome: 'retry',
    });
  });

  it('keeps a provisional grant pending and blocks raw authority mint/retirement with spoofed scopes', async () => {
    const fixture = await createPaidFixture({ tempRoleId: nextSnowflake() });
    const actionId = await insertCarrier(fixture);
    const delivery = await startDelivery(fixture, actionId);
    await reserveTemp(fixture, delivery);
    expect(await classifyRoleOwner(
      fixture,
      fixture.tempRoleId!,
      [fixture.tempGrantId!],
    )).toBe('pending');

    const { data: before, error: beforeError } = await supa
      .from('temp_role_grants')
      .select('grant_status,source,applied_at,expires_at,remove_on_expiry')
      .eq('id', fixture.tempGrantId!)
      .single();
    expect(beforeError).toBeNull();

    const retired = await supa.rpc('commerce_retire_temp_role_grant', {
      p_grant_id: fixture.tempGrantId,
      p_expected_grant_status: 'pending',
      p_expected_expires_at: before!.expires_at,
      p_expected_remove_on_expiry: false,
    });
    expect(retired.error).toBeNull();
    expect(retired.data).toMatchObject({
      id: fixture.tempGrantId,
      retired: false,
      disposition: 'provisional_reservation',
    });

    const directRetirement = await supa
      .from('temp_role_grants')
      .update({ grant_status: 'removed', source: 'commerce_reconciled' })
      .eq('id', fixture.tempGrantId!);
    expect(directRetirement.error).not.toBeNull();

    let confirmationSpoofError: { code?: string } | null = null;
    try {
      await sqlA.begin(async (tx) => {
        await tx.unsafe('SET LOCAL ROLE service_role');
        await tx`
          SELECT pg_catalog.set_config(
                   'somnibot.commerce_temp_confirmation_grant_id',
                   ${fixture.tempGrantId!}, true
                 ),
                 pg_catalog.set_config(
                   'somnibot.commerce_temp_confirmation_intent_id',
                   ${delivery.intentId}, true
                 ),
                 pg_catalog.set_config(
                   'somnibot.commerce_temp_confirmation_mutation_token',
                   ${delivery.mutationToken}, true
                 )
        `;
        await tx`
          UPDATE public.temp_role_grants
             SET grant_status = 'applied',
                 applied_at = stamp.now,
                 expires_at = stamp.now + (duration_seconds * interval '1 second'),
                 remove_on_expiry = true,
                 last_error = NULL,
                 updated_at = stamp.now
            FROM (SELECT pg_catalog.clock_timestamp() AS now) AS stamp
           WHERE id = ${fixture.tempGrantId!}::UUID
        `;
      });
    } catch (error) {
      confirmationSpoofError = error as { code?: string };
    }
    expect(confirmationSpoofError).not.toBeNull();
    expect(['23514', '42501']).toContain(confirmationSpoofError?.code);

    let retirementSpoofError: { code?: string } | null = null;
    try {
      await sqlA.begin(async (tx) => {
        await tx.unsafe('SET LOCAL ROLE service_role');
        await tx`
          SELECT pg_catalog.set_config(
            'somnibot.commerce_temp_retirement_grant_id',
            ${fixture.tempGrantId!},
            true
          )
        `;
        await tx`
          UPDATE public.temp_role_grants
             SET grant_status = 'removed', source = 'commerce_reconciled'
           WHERE id = ${fixture.tempGrantId!}::UUID
        `;
      });
    } catch (error) {
      retirementSpoofError = error as { code?: string };
    }
    expect(retirementSpoofError).not.toBeNull();
    expect(['23514', '42501']).toContain(retirementSpoofError?.code);

    const { data: after, error: afterError } = await supa
      .from('temp_role_grants')
      .select('grant_status,source,applied_at,expires_at,remove_on_expiry')
      .eq('id', fixture.tempGrantId!)
      .single();
    expect(afterError).toBeNull();
    expect(after).toEqual(before);
    const { data: intentAfter } = await supa
      .from('commerce_role_delivery_intents')
      .select('reserved_temp_role_grant_ids,temporary_role_grant_ids')
      .eq('id', delivery.intentId)
      .single();
    expect(intentAfter).toEqual({
      reserved_temp_role_grant_ids: [fixture.tempGrantId],
      temporary_role_grant_ids: [],
    });
  });

  it('rejects applied false-to-true escalation and applied-to-removed service DML', async () => {
    const fixture = await createPaidFixture({ tempRoleId: nextSnowflake() });
    const acknowledged = await supa.rpc('commerce_acknowledge_temp_role_grant', {
      p_grant_id: fixture.tempGrantId,
    });
    expect(acknowledged.error).toBeNull();
    expect(acknowledged.data).toMatchObject({
      id: fixture.tempGrantId,
      grant_status: 'applied',
    });

    const mintRemoval = await supa
      .from('temp_role_grants')
      .update({ remove_on_expiry: true })
      .eq('id', fixture.tempGrantId!);
    expect(mintRemoval.error).toMatchObject({ code: '23514' });

    const rawRetire = await supa
      .from('temp_role_grants')
      .update({ grant_status: 'removed', source: 'commerce_reconciled' })
      .eq('id', fixture.tempGrantId!);
    expect(rawRetire.error).not.toBeNull();
    const { data: unchanged } = await supa
      .from('temp_role_grants')
      .select('grant_status,source,remove_on_expiry')
      .eq('id', fixture.tempGrantId!)
      .single();
    expect(unchanged).toEqual({
      grant_status: 'applied',
      source: 'commerce_purchase',
      remove_on_expiry: false,
    });
  });
});

describe('queue status transition authority', () => {
  it('releases a staged carrier only by exact identity and replays idempotently', async () => {
    const fixture = await createPaidFixture();
    const idempotencyKey = nextName('staged-release');
    const actionId = await insertCarrier(fixture, {
      status: 'staged',
      idempotencyKey,
    });

    const wrongIdentity = await supa.rpc('bot_action_queue_release_staged', {
      p_action_id: actionId,
      p_guild_id: GUILD_ID,
      p_idempotency_key: `${idempotencyKey}-wrong`,
    });
    expect(wrongIdentity.error).toBeNull();
    expect(wrongIdentity.data).toEqual([]);
    const { data: stillStaged, error: stillStagedError } = await supa
      .from('bot_action_queue')
      .select('status')
      .eq('id', actionId)
      .single();
    expect(stillStagedError).toBeNull();
    expect(stillStaged?.status).toBe('staged');

    const released = await supa.rpc('bot_action_queue_release_staged', {
      p_action_id: actionId,
      p_guild_id: GUILD_ID,
      p_idempotency_key: idempotencyKey,
    });
    expect(released.error).toBeNull();
    expect(onlyRow<RetryResult>(released.data, 'staged release')).toEqual({
      action_id: actionId,
      action_status: 'pending',
      disposition: 'released',
    });
    const replayed = await supa.rpc('bot_action_queue_release_staged', {
      p_action_id: actionId,
      p_guild_id: GUILD_ID,
      p_idempotency_key: idempotencyKey,
    });
    expect(replayed.error).toBeNull();
    expect(onlyRow<RetryResult>(replayed.data, 'staged release replay')).toEqual({
      action_id: actionId,
      action_status: 'pending',
      disposition: 'already_released',
    });
  });
});

describe('atomic owner entitlement administration', () => {
  it('creates a replay-safe zero-dollar grant and rolls back invalid requests', async () => {
    const roleId = nextSnowflake();
    const fixture = await createPaidFixture({
      permanentRoleId: roleId,
      productType: 'subscription',
    });
    const { data: grantPlan, error: grantPlanError } = await supa
      .from('plans')
      .insert({
        product_id: fixture.productId,
        guild_id: GUILD_ID,
        name: nextName('manual-grant-plan'),
        interval_unit: 'MONTH',
        interval_count: 1,
        price_cents: 1_000,
        currency: 'USD',
        active: true,
      })
      .select('id')
      .single();
    expect(grantPlanError).toBeNull();
    const requestId = uuidV7Fixture();
    const args = {
      p_request_id: requestId,
      p_guild_id: GUILD_ID,
      p_customer_id: fixture.customerId,
      p_product_id: fixture.productId,
      p_source: 'manual',
      p_type: 'subscription',
      p_plan_id: grantPlan!.id,
      p_expires_at: null,
      p_granted_role_ids: [roleId],
      p_granted_channel_ids: [],
    };
    const first = await supa.rpc('commerce_create_noncommerce_entitlement', args);
    expect(first.error).toBeNull();
    const created = onlyRow<{
      entitlement_id: string;
      order_id: string;
      request_id: string;
    }>(first.data, 'commerce_create_noncommerce_entitlement');
    expect(created).toMatchObject({ order_id: requestId, request_id: requestId });
    const { data: grantAudit, error: grantAuditError } = await supa
      .from('audit_logs')
      .select('id,actor_id,action,target_id,details,correlation_id')
      .eq('id', requestId)
      .single();
    expect(grantAuditError).toBeNull();
    expect(grantAudit).toMatchObject({
      id: requestId,
      actor_id: fixture.discordId,
      action: 'entitlement.granted',
      target_id: created.entitlement_id,
      details: {
        productId: fixture.productId,
        roleIds: [roleId],
      },
      correlation_id: `commerce-entitlement-transition:${requestId}`,
    });

    const arbitraryRoleRequestId = uuidV7Fixture();
    const arbitraryRole = await supa.rpc('commerce_create_noncommerce_entitlement', {
      ...args,
      p_request_id: arbitraryRoleRequestId,
      p_granted_role_ids: [nextSnowflake()],
    });
    expect(arbitraryRole.error).toMatchObject({ code: '23514' });
    const arbitraryChannelRequestId = uuidV7Fixture();
    const arbitraryChannel = await supa.rpc('commerce_create_noncommerce_entitlement', {
      ...args,
      p_request_id: arbitraryChannelRequestId,
      p_granted_channel_ids: [nextSnowflake()],
    });
    expect(arbitraryChannel.error).toMatchObject({ code: '23514' });
    const missingPlanRequestId = uuidV7Fixture();
    const missingPlan = await supa.rpc('commerce_create_noncommerce_entitlement', {
      ...args,
      p_request_id: missingPlanRequestId,
      p_plan_id: null,
    });
    expect(missingPlan.error).toMatchObject({ code: '23514' });
    for (const rejectedRequestId of [
      arbitraryRoleRequestId,
      arbitraryChannelRequestId,
      missingPlanRequestId,
    ]) {
      const [{ count: orderCount }, { count: entitlementCount }] = await Promise.all([
        supa.from('orders').select('id', { count: 'exact', head: true })
          .eq('id', rejectedRequestId),
        supa.from('entitlements').select('id', { count: 'exact', head: true })
          .eq('order_id', rejectedRequestId),
      ]);
      expect(orderCount).toBe(0);
      expect(entitlementCount).toBe(0);
    }

    const { data: initialActivation, error: initialActivationError } = await supa
      .from('bot_action_queue')
      .select('id,status,idempotency_key,payload')
      .contains('payload', {
        source: 'noncommerce_entitlement_activation_trigger',
        entitlement_id: created.entitlement_id,
        activation_generation: created.entitlement_id,
      })
      .single();
    expect(initialActivationError).toBeNull();
    expect(initialActivation).toMatchObject({
      status: 'pending',
      payload: {
        discord_id: fixture.discordId,
        role_ids: [roleId],
        reason: 'entitlement_activated',
      },
    });
    expect(initialActivation?.idempotency_key).toMatch(
      new RegExp(`^noncommerce:activation-entitlement:${created.entitlement_id}:${fixture.discordId}:${created.entitlement_id}:[0-9a-f]{32}:v1$`),
    );
    const failedInitialClaim = await claimAction(initialActivation!.id as string);
    expect((await supa.rpc('bot_action_queue_finish_claim', {
      p_action_id: initialActivation!.id,
      p_claim_token: failedInitialClaim.claim_token,
      p_success: false,
      p_result: null,
      p_error: 'lost initial activation delivery',
    })).error).toBeNull();
    const { data: initialFailureDlq, error: initialFailureDlqError } = await supa
      .from('action_queue_dlq')
      .select('id,retried')
      .eq('original_id', initialActivation!.id)
      .eq('retried', false)
      .single();
    expect(initialFailureDlqError).toBeNull();

    const replay = await supa.rpc('commerce_create_noncommerce_entitlement', args);
    expect(replay.error).toBeNull();
    expect(onlyRow(replay.data, 'noncommerce grant replay')).toEqual(created);
    const { data: reopenedInitial, error: reopenedInitialError } = await supa
      .from('bot_action_queue')
      .select('id,status')
      .eq('id', initialActivation!.id)
      .single();
    expect(reopenedInitialError).toBeNull();
    expect(reopenedInitial).toEqual({ id: initialActivation!.id, status: 'pending' });
    const { data: retiredInitialFailure, error: retiredInitialFailureError } = await supa
      .from('action_queue_dlq')
      .select('retried')
      .eq('id', initialFailureDlq!.id)
      .single();
    expect(retiredInitialFailureError).toBeNull();
    expect(retiredInitialFailure?.retried).toBe(true);

    await completeNoncommerceActivation(initialActivation!.id as string);
    const protectedHeadDelete = await supa.from('bot_action_queue').delete()
      .eq('id', initialActivation!.id);
    expect(protectedHeadDelete.error).toMatchObject({ code: '23503' });

    const replayAfterCarrierCompletion = await supa.rpc(
      'commerce_create_noncommerce_entitlement',
      args,
    );
    expect(replayAfterCarrierCompletion.error).toBeNull();
    expect(onlyRow(replayAfterCarrierCompletion.data, 'protected-carrier grant replay'))
      .toEqual(created);
    const { data: retainedInitial, error: retainedInitialError } = await supa
      .from('bot_action_queue')
      .select('id,status,payload')
      .contains('payload', {
        source: 'noncommerce_entitlement_activation_trigger',
        entitlement_id: created.entitlement_id,
        activation_generation: created.entitlement_id,
      })
      .single();
    expect(retainedInitialError).toBeNull();
    expect(retainedInitial).toMatchObject({
      id: initialActivation!.id,
      status: 'completed',
    });
    const { count: grantAuditCount, error: grantAuditCountError } = await supa
      .from('audit_logs')
      .select('id', { count: 'exact', head: true })
      .eq('id', requestId);
    expect(grantAuditCountError).toBeNull();
    expect(grantAuditCount).toBe(1);

    const forgedActivationPayload = {
      ...(retainedInitial!.payload as Record<string, unknown>),
      activation_generation: randomUUID(),
    };
    const forgedActivationKey = `noncommerce:activation-entitlement:${created.entitlement_id}:${fixture.discordId}:${String(forgedActivationPayload.activation_generation)}:${await jsonbFingerprint(forgedActivationPayload)}:v1`;
    const forgedActivation = await supa.from('bot_action_queue').insert({
      guild_id: GUILD_ID,
      action: 'revoke_roles',
      payload: forgedActivationPayload,
      status: 'pending',
      lane: 'commerce',
      idempotency_key: forgedActivationKey,
    });
    expect(forgedActivation.error).toMatchObject({ code: '42501' });
    const { data: stored, error: storedError } = await supa
      .from('entitlements')
      .select('id,order_id,type,plan_id,source,granted_role_ids')
      .eq('order_id', requestId)
      .single();
    expect(storedError).toBeNull();
    expect(stored).toMatchObject({
      id: created.entitlement_id,
      order_id: requestId,
      type: 'subscription',
      plan_id: grantPlan!.id,
      source: 'manual',
      granted_role_ids: [roleId],
    });

    const relinkedDiscordId = nextSnowflake();
    expect((await supa.from('customers')
      .update({ discord_id: relinkedDiscordId })
      .eq('id', fixture.customerId)).error).toBeNull();
    const { data: v7Relink, error: v7RelinkError } = await supa
      .from('bot_action_queue')
      .select('payload')
      .contains('payload', {
        source: 'noncommerce_entitlement_customer_relink_trigger',
        entitlement_id: created.entitlement_id,
        order_id: requestId,
      })
      .single();
    expect(v7RelinkError).toBeNull();
    expect(v7Relink?.payload).toMatchObject({ discord_id: relinkedDiscordId });
    const terminal = await supa.rpc('commerce_update_entitlement_status_admin', {
      p_entitlement_id: created.entitlement_id,
      p_customer_id: fixture.customerId,
      p_guild_id: GUILD_ID,
      p_status: 'cancelled',
      p_grace_period_ends_at: null,
    });
    expect(terminal.error).toBeNull();
    const { data: v7Terminal, error: v7TerminalError } = await supa
      .from('bot_action_queue')
      .select('payload')
      .contains('payload', {
        source: 'noncommerce_entitlement_status_trigger',
        entitlement_id: created.entitlement_id,
        order_id: requestId,
      })
      .single();
    expect(v7TerminalError).toBeNull();
    expect(v7Terminal?.payload).toMatchObject({ discord_id: relinkedDiscordId });
    const replayAfterTerminal = await supa.rpc(
      'commerce_create_noncommerce_entitlement',
      args,
    );
    expect(replayAfterTerminal.error).toBeNull();
    expect(onlyRow(replayAfterTerminal.data, 'post-terminal grant replay'))
      .toEqual(created);
    const { count: replayOrderCount, error: replayOrderCountError } = await supa
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('id', requestId);
    const { count: replayEntitlementCount, error: replayEntitlementCountError } = await supa
      .from('entitlements')
      .select('id', { count: 'exact', head: true })
      .eq('order_id', requestId);
    expect(replayOrderCountError).toBeNull();
    expect(replayEntitlementCountError).toBeNull();
    expect(replayOrderCount).toBe(1);
    expect(replayEntitlementCount).toBe(1);

    const crossLinkedReplay = await supa.rpc(
      'commerce_create_noncommerce_entitlement',
      { ...args, p_source: 'giveaway' },
    );
    expect(crossLinkedReplay.error).toMatchObject({ code: '23514' });

    const poisonedRequestId = randomUUID();
    const poisonedRoleId = nextSnowflake();
    const poisonedArgs = {
      ...args,
      p_request_id: poisonedRequestId,
      p_granted_role_ids: [poisonedRoleId],
    };
    const poisonedOrder = await supa.from('orders').insert({
      id: poisonedRequestId,
      order_number: `ORD-NC-${poisonedRequestId.replaceAll('-', '').toUpperCase()}`,
      customer_id: fixture.customerId,
      guild_id: GUILD_ID,
      product_id: fixture.productId,
      plan_id: grantPlan!.id,
      amount_cents: 0,
      currency: 'USD',
      discount_cents: 0,
      source: 'manual',
      status: 'completed',
      granted_role_ids_snapshot: [poisonedRoleId],
      granted_channel_ids_snapshot: [],
      temporary_role_grants_snapshot: [],
    });
    expect(poisonedOrder.error).toBeNull();
    const { data: poisonedLicense, error: poisonedLicenseError } = await supa
      .from('license_keys')
      .insert({
        order_id: poisonedRequestId,
        customer_id: fixture.customerId,
        product_id: fixture.productId,
        guild_id: GUILD_ID,
        key_hash: nextName('noncommerce-replay-poison-hash'),
        key_prefix: 'POISON',
        key_suffix: nextName('noncommerce-replay-poison-suffix'),
        bound_discord_id: relinkedDiscordId,
        status: 'active',
      })
      .select('id')
      .single();
    expect(poisonedLicenseError).toBeNull();
    const poisonedEntitlement = await supa.from('entitlements').insert({
      customer_id: fixture.customerId,
      guild_id: GUILD_ID,
      product_id: fixture.productId,
      plan_id: grantPlan!.id,
      license_key_id: poisonedLicense!.id,
      order_id: poisonedRequestId,
      type: 'subscription',
      status: 'active',
      source: 'manual',
      granted_role_ids: [poisonedRoleId],
      granted_channel_ids: [],
    });
    expect(poisonedEntitlement.error).toBeNull();
    const licenseCrossLinkedReplay = await supa.rpc(
      'commerce_create_noncommerce_entitlement',
      poisonedArgs,
    );
    expect(licenseCrossLinkedReplay.error).toMatchObject({ code: '23514' });

    const forgedLicenseBinding = await supa
      .from('entitlements')
      .update({ license_key_id: poisonedLicense!.id })
      .eq('id', created.entitlement_id);
    expect(forgedLicenseBinding.error).toMatchObject({
      code: '23514',
      message: 'entitlement grant identity and snapshots are lifetime-immutable',
    });

    const rejectedRequestId = randomUUID();
    const rejected = await supa.rpc('commerce_create_noncommerce_entitlement', {
      ...args,
      p_request_id: rejectedRequestId,
      p_product_id: randomUUID(),
    });
    expect(rejected.error).toMatchObject({ code: '23514' });
    const { count: orphanCount, error: orphanError } = await supa
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('id', rejectedRequestId);
    expect(orphanError).toBeNull();
    expect(orphanCount).toBe(0);
  });

  it('blocks owner resurrection of paid access but permits explicit noncommerce lifecycle', async () => {
    const paid = await createPaidFixture();
    const paidTerminal = await supa.rpc('commerce_update_entitlement_status_admin', {
      p_entitlement_id: paid.entitlementId,
      p_customer_id: paid.customerId,
      p_guild_id: GUILD_ID,
      p_status: 'expired',
      p_grace_period_ends_at: null,
    });
    expect(paidTerminal.error).toBeNull();
    const paidResurrection = await supa.rpc(
      'commerce_update_entitlement_status_admin',
      {
        p_entitlement_id: paid.entitlementId,
        p_customer_id: paid.customerId,
        p_guild_id: GUILD_ID,
        p_status: 'active',
        p_grace_period_ends_at: null,
      },
    );
    expect(paidResurrection.error).toMatchObject({ code: '23514' });
    const paidRelabel = await supa
      .from('entitlements')
      .update({ source: 'manual', granted_role_ids: [nextSnowflake()] })
      .eq('id', paid.entitlementId);
    expect(paidRelabel.error).toMatchObject({ code: '23514' });
    const { count: fabricatedCarrierCount, error: fabricatedCarrierError } = await supa
      .from('bot_action_queue')
      .select('id', { count: 'exact', head: true })
      .contains('payload', {
        source: 'noncommerce_entitlement_status_trigger',
        entitlement_id: paid.entitlementId,
      });
    expect(fabricatedCarrierError).toBeNull();
    expect(fabricatedCarrierCount).toBe(0);
    const paidNoop = await supa.rpc('commerce_update_entitlement_status_admin', {
      p_entitlement_id: paid.entitlementId,
      p_customer_id: paid.customerId,
      p_guild_id: GUILD_ID,
      p_status: 'expired',
      p_grace_period_ends_at: null,
    });
    expect(paidNoop.error).toBeNull();

    const [paidGrace] = await sqlA<{ grace_deadline: string }[]>`
      UPDATE public.entitlements
         SET status = 'grace_period',
             grace_period_ends_at = pg_catalog.clock_timestamp() + interval '1 day'
       WHERE id = ${paid.entitlementId}::UUID
       RETURNING grace_period_ends_at::TEXT AS grace_deadline
    `;
    const graceExtension = new Date(
      new Date(paidGrace!.grace_deadline).getTime() + 86_400_000,
    ).toISOString();
    const paidGraceExtension = await supa.rpc(
      'commerce_update_entitlement_status_admin',
      {
        p_entitlement_id: paid.entitlementId,
        p_customer_id: paid.customerId,
        p_guild_id: GUILD_ID,
        p_status: 'grace_period',
        p_grace_period_ends_at: graceExtension,
      },
    );
    expect(paidGraceExtension.error).toMatchObject({ code: '23514' });
    const paidGraceNoop = await supa.rpc(
      'commerce_update_entitlement_status_admin',
      {
        p_entitlement_id: paid.entitlementId,
        p_customer_id: paid.customerId,
        p_guild_id: GUILD_ID,
        p_status: 'grace_period',
        p_grace_period_ends_at: paidGrace!.grace_deadline,
      },
    );
    expect(paidGraceNoop.error).toBeNull();

    const roleId = nextSnowflake();
    const { data: grantProduct, error: grantProductError } = await supa
      .from('products')
      .insert({
        guild_id: GUILD_ID,
        name: nextName('automation-grant-product'),
        description: 'authoritative automation grant fixture',
        type: 'subscription',
        delivery_type: 'access_pass',
        price_cents: 1_000,
        currency: 'USD',
        granted_role_ids: [roleId],
        granted_channel_ids: [],
        active: true,
      })
      .select('id')
      .single();
    expect(grantProductError).toBeNull();
    const { data: automationPlan, error: automationPlanError } = await supa
      .from('plans')
      .insert({
        product_id: grantProduct!.id,
        guild_id: GUILD_ID,
        name: nextName('automation-grant-plan'),
        interval_unit: 'MONTH',
        interval_count: 1,
        price_cents: 1_000,
        currency: 'USD',
        active: true,
      })
      .select('id')
      .single();
    expect(automationPlanError).toBeNull();
    const requestId = randomUUID();
    const created = await supa.rpc('commerce_create_noncommerce_entitlement', {
      p_request_id: requestId,
      p_guild_id: GUILD_ID,
      p_customer_id: paid.customerId,
      p_product_id: grantProduct!.id,
      p_source: 'automation',
      p_type: 'subscription',
      p_plan_id: automationPlan!.id,
      p_expires_at: null,
      p_granted_role_ids: [roleId],
      p_granted_channel_ids: [],
    });
    expect(created.error).toBeNull();
    const grant = onlyRow<{ entitlement_id: string }>(created.data, 'automation grant');
    const { data: initialActivation, error: initialActivationError } = await supa
      .from('bot_action_queue')
      .select('id,status,payload')
      .contains('payload', {
        source: 'noncommerce_entitlement_activation_trigger',
        entitlement_id: grant.entitlement_id,
        activation_generation: grant.entitlement_id,
      })
      .single();
    expect(initialActivationError).toBeNull();
    expect(initialActivation?.status).toBe('pending');
    const cancelled = await supa.rpc('commerce_update_entitlement_status_admin', {
      p_entitlement_id: grant.entitlement_id,
      p_customer_id: paid.customerId,
      p_guild_id: GUILD_ID,
      p_status: 'cancelled',
      p_grace_period_ends_at: null,
    });
    expect(cancelled.error).toBeNull();
    const reactivated = await supa.rpc('commerce_update_entitlement_status_admin', {
      p_entitlement_id: grant.entitlement_id,
      p_customer_id: paid.customerId,
      p_guild_id: GUILD_ID,
      p_status: 'active',
      p_grace_period_ends_at: null,
    });
    expect(reactivated.error).toBeNull();
    expect(onlyRow<{ status: string }>(reactivated.data, 'automation reactivation').status)
      .toBe('active');

    const { data: firstActivationRows, error: firstActivationRowsError } = await supa
      .from('bot_action_queue')
      .select('id,status,payload')
      .contains('payload', {
        source: 'noncommerce_entitlement_activation_trigger',
        entitlement_id: grant.entitlement_id,
      });
    expect(firstActivationRowsError).toBeNull();
    expect(firstActivationRows).toHaveLength(2);
    const firstReactivation = firstActivationRows!.find((row) =>
      (row.payload as Record<string, unknown>).activation_generation !== grant.entitlement_id);
    expect(firstReactivation).toMatchObject({ status: 'pending' });
    const firstReactivationGeneration = (firstReactivation!.payload as Record<string, unknown>)
      .activation_generation;
    expect(firstReactivationGeneration).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect((await supa.rpc('commerce_update_entitlement_status_admin', {
      p_entitlement_id: grant.entitlement_id,
      p_customer_id: paid.customerId,
      p_guild_id: GUILD_ID,
      p_status: 'cancelled',
      p_grace_period_ends_at: null,
    })).error).toBeNull();
    expect((await supa.rpc('commerce_update_entitlement_status_admin', {
      p_entitlement_id: grant.entitlement_id,
      p_customer_id: paid.customerId,
      p_guild_id: GUILD_ID,
      p_status: 'active',
      p_grace_period_ends_at: null,
    })).error).toBeNull();

    const { data: recurrenceRows, error: recurrenceRowsError } = await supa
      .from('bot_action_queue')
      .select('id,status,payload')
      .contains('payload', {
        source: 'noncommerce_entitlement_activation_trigger',
        entitlement_id: grant.entitlement_id,
      });
    expect(recurrenceRowsError).toBeNull();
    expect(recurrenceRows).toHaveLength(3);
    const generations = recurrenceRows!.map((row) =>
      (row.payload as Record<string, unknown>).activation_generation);
    expect(new Set(generations).size).toBe(3);
    expect(generations).toContain(grant.entitlement_id);
    expect(generations).toContain(firstReactivationGeneration);
    expect(recurrenceRows!.some((row) =>
      row.status === 'pending'
      && ![grant.entitlement_id, firstReactivationGeneration].includes(
        (row.payload as Record<string, unknown>).activation_generation,
      ))).toBe(true);

    await completeNoncommerceActivation(firstReactivation!.id as string);
  });
});

describe('checkout and noncommerce grant serialization', () => {
  type GrantSource = 'manual' | 'giveaway' | 'automation';
  type GrantRaceFixture = {
    customerId: string;
    productId: string;
    requestId: string;
    checkoutOrderId: string;
    checkoutProviderId: string;
    checkoutOrderNumber: string;
    source: GrantSource;
  };

  async function createGrantRaceFixture(source: GrantSource): Promise<GrantRaceFixture> {
    const [customer] = await sqlA<{ id: string }[]>`
      INSERT INTO public.customers (
        guild_id,
        discord_id,
        discord_username
      ) VALUES (
        ${GUILD_ID},
        ${nextSnowflake()},
        ${nextName(`grant-race-${source}-customer`)}
      )
      RETURNING id
    `;
    const [product] = await sqlA<{ id: string }[]>`
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
        ${nextName(`grant-race-${source}-product`)},
        'checkout/noncommerce serialization fixture',
        'one_time',
        'access_pass',
        100,
        'USD',
        ARRAY[]::TEXT[],
        ARRAY[]::TEXT[],
        true
      )
      RETURNING id
    `;
    return {
      customerId: customer!.id,
      productId: product!.id,
      requestId: uuidV7Fixture(),
      checkoutOrderId: randomUUID(),
      checkoutProviderId: nextName(`grant-race-${source}-provider`),
      checkoutOrderNumber: nextName(`grant-race-${source}-order`),
      source,
    };
  }

  function createNoncommerceGrant(
    sql: any,
    fixture: GrantRaceFixture,
  ) {
    return sql<{
      entitlement_id: string;
      order_id: string;
      request_id: string;
    }[]>`
      SELECT *
      FROM public.commerce_create_noncommerce_entitlement(
        ${fixture.requestId}::UUID,
        ${GUILD_ID},
        ${fixture.customerId}::UUID,
        ${fixture.productId}::UUID,
        ${fixture.source},
        'one_time',
        NULL::UUID,
        NULL::TIMESTAMPTZ,
        ARRAY[]::TEXT[],
        ARRAY[]::TEXT[]
      )
    `;
  }

  function createPayableCheckout(
    sql: any,
    fixture: GrantRaceFixture,
  ) {
    return sql<{ id: string; checkout_active: boolean }[]>`
      INSERT INTO public.orders (
        id,
        order_number,
        customer_id,
        guild_id,
        product_id,
        paypal_order_id,
        amount_cents,
        currency,
        source,
        status,
        checkout_active
      ) VALUES (
        ${fixture.checkoutOrderId}::UUID,
        ${fixture.checkoutOrderNumber},
        ${fixture.customerId}::UUID,
        ${GUILD_ID},
        ${fixture.productId}::UUID,
        ${fixture.checkoutProviderId},
        100,
        'USD',
        'purchase',
        'pending',
        true
      )
      RETURNING id, checkout_active
    `;
  }

  it.each(['manual', 'giveaway', 'automation'] as const)(
    'lets a first %s grant commit and rejects the checkout waiting behind it',
    async (source) => {
      const fixture = await createGrantRaceFixture(source);
      const grantReady = makeGate();
      const releaseGrant = makeGate();
      const granting = sqlA.begin(async (tx) => {
        const rows = await createNoncommerceGrant(tx, fixture);
        grantReady.open();
        await releaseGrant.promise;
        return rows;
      });
      await Promise.race([grantReady.promise, granting]);

      const checkout = createPayableCheckout(sqlB, fixture).execute();
      try {
        await waitForDatabaseLock(
          sqlBBackendPid,
          `${source} checkout behind noncommerce grant`,
        );
      } catch (error) {
        releaseGrant.open();
        await Promise.allSettled([granting, checkout]);
        throw error;
      }
      releaseGrant.open();
      const grantRows = await granting;
      expect(grantRows).toEqual([{
        entitlement_id: expect.any(String),
        order_id: fixture.requestId,
        request_id: fixture.requestId,
      }]);
      await expect(checkout).rejects.toMatchObject({
        code: '23505',
        message: expect.stringContaining('commerce_checkout_blocked: active_entitlement'),
      });

      const [evidence] = await sqlObserver<{
        grant_order_count: number;
        entitlement_count: number;
        checkout_count: number;
      }[]>`
        SELECT
          (
            SELECT pg_catalog.count(*)::INTEGER
            FROM public.orders
            WHERE id = ${fixture.requestId}::UUID
          ) AS grant_order_count,
          (
            SELECT pg_catalog.count(*)::INTEGER
            FROM public.entitlements
            WHERE order_id = ${fixture.requestId}::UUID
          ) AS entitlement_count,
          (
            SELECT pg_catalog.count(*)::INTEGER
            FROM public.orders
            WHERE id = ${fixture.checkoutOrderId}::UUID
          ) AS checkout_count
      `;
      expect(evidence).toEqual({
        grant_order_count: 1,
        entitlement_count: 1,
        checkout_count: 0,
      });
    },
    45_000,
  );

  it.each(['manual', 'giveaway', 'automation'] as const)(
    'lets a first checkout commit and rejects the %s grant waiting behind it without orphans',
    async (source) => {
      const fixture = await createGrantRaceFixture(source);
      const checkoutReady = makeGate();
      const releaseCheckout = makeGate();
      const reserving = sqlA.begin(async (tx) => {
        const rows = await createPayableCheckout(tx, fixture);
        checkoutReady.open();
        await releaseCheckout.promise;
        return rows;
      });
      await Promise.race([checkoutReady.promise, reserving]);

      const granting = createNoncommerceGrant(sqlB, fixture).execute();
      try {
        await waitForDatabaseLock(
          sqlBBackendPid,
          `${source} noncommerce grant behind checkout`,
        );
      } catch (error) {
        releaseCheckout.open();
        await Promise.allSettled([reserving, granting]);
        throw error;
      }
      releaseCheckout.open();
      expect(await reserving).toEqual([{
        id: fixture.checkoutOrderId,
        checkout_active: true,
      }]);
      await expect(granting).rejects.toMatchObject({
        code: '23505',
        message: expect.stringContaining('commerce_noncommerce_grant_blocked: provider_checkout'),
      });

      const [evidence] = await sqlObserver<{
        grant_order_count: number;
        entitlement_count: number;
        checkout_count: number;
      }[]>`
        SELECT
          (
            SELECT pg_catalog.count(*)::INTEGER
            FROM public.orders
            WHERE id = ${fixture.requestId}::UUID
          ) AS grant_order_count,
          (
            SELECT pg_catalog.count(*)::INTEGER
            FROM public.entitlements
            WHERE order_id = ${fixture.requestId}::UUID
          ) AS entitlement_count,
          (
            SELECT pg_catalog.count(*)::INTEGER
            FROM public.orders
            WHERE id = ${fixture.checkoutOrderId}::UUID
          ) AS checkout_count
      `;
      expect(evidence).toEqual({
        grant_order_count: 0,
        entitlement_count: 0,
        checkout_count: 1,
      });
    },
    45_000,
  );

  it.each(['manual', 'giveaway', 'automation'] as const)(
    'blocks direct and admin %s reactivation while a provider checkout is payable',
    async (source) => {
      const fixture = await createGrantRaceFixture(source);
      const [created] = await createNoncommerceGrant(sqlA, fixture);
      const terminal = await supa.rpc('commerce_update_entitlement_status_admin', {
        p_entitlement_id: created!.entitlement_id,
        p_customer_id: fixture.customerId,
        p_guild_id: GUILD_ID,
        p_status: 'cancelled',
        p_grace_period_ends_at: null,
      });
      expect(terminal.error).toBeNull();
      expect(await createPayableCheckout(sqlA, fixture)).toEqual([{
        id: fixture.checkoutOrderId,
        checkout_active: true,
      }]);

      await expect(sqlA.begin(async (tx) => {
        await tx`SET LOCAL ROLE service_role`;
        await tx`
          UPDATE public.entitlements
          SET status = 'active'
          WHERE id = ${created!.entitlement_id}::UUID
            AND status = 'cancelled'
        `;
      })).rejects.toMatchObject({
        code: '23505',
        message: expect.stringContaining('commerce_noncommerce_grant_blocked: provider_checkout'),
      });

      const adminReactivation = await supa.rpc(
        'commerce_update_entitlement_status_admin',
        {
          p_entitlement_id: created!.entitlement_id,
          p_customer_id: fixture.customerId,
          p_guild_id: GUILD_ID,
          p_status: 'active',
          p_grace_period_ends_at: null,
        },
      );
      expect(adminReactivation.error).toMatchObject({
        code: '23505',
        message: expect.stringContaining('commerce_noncommerce_grant_blocked: provider_checkout'),
      });
      const { data: retained, error } = await supa
        .from('entitlements')
        .select('status')
        .eq('id', created!.entitlement_id)
        .single();
      expect(error).toBeNull();
      expect(retained?.status).toBe('cancelled');
    },
    45_000,
  );
});

describe('atomic giveaway winner authority and notification outbox', () => {
  it('rejects non-entrants and invalid cardinality before persisting winners', async () => {
    const entrants = [
      nextSnowflake(),
      nextSnowflake(),
      nextSnowflake(),
      nextSnowflake(),
      nextSnowflake(),
    ];
    const { data: giveaway, error: giveawayError } = await supa
      .from('giveaways')
      .insert({
        guild_id: GUILD_ID,
        channel_id: nextSnowflake(),
        prize: 'Exact manual prize snapshot',
        winner_count: 2,
        ends_at: new Date(Date.now() + 60_000).toISOString(),
        entries: entrants,
        winners: [],
        status: 'active',
        created_by: nextSnowflake(),
      })
      .select('id')
      .single();
    expect(giveawayError).toBeNull();

    const nonEntrantEnd = await supa.rpc('giveaway_atomic_end', {
      p_giveaway_id: giveaway!.id,
      p_winners: [entrants[0], nextSnowflake()],
      p_ended_at: new Date().toISOString(),
    });
    expect(nonEntrantEnd.error).toMatchObject({ code: '23514' });
    const undersizedEnd = await supa.rpc('giveaway_atomic_end', {
      p_giveaway_id: giveaway!.id,
      p_winners: [entrants[0]],
      p_ended_at: new Date().toISOString(),
    });
    expect(undersizedEnd.error).toMatchObject({ code: '23514' });
    const { data: stillActive, error: stillActiveError } = await supa
      .from('giveaways')
      .select('status,winners')
      .eq('id', giveaway!.id)
      .single();
    expect(stillActiveError).toBeNull();
    expect(stillActive).toEqual({ status: 'active', winners: [] });

    const ended = await supa.rpc('giveaway_atomic_end', {
      p_giveaway_id: giveaway!.id,
      p_winners: [entrants[1], entrants[0]],
      p_ended_at: new Date().toISOString(),
    });
    expect(ended.error).toBeNull();
    expect(ended.data).toHaveLength(1);
    const { data: endNotifications, error: endNotificationsError } = await supa
      .from('bot_action_queue')
      .select('action,lane,idempotency_key,payload')
      .eq('action', 'notify_giveaway_winner')
      .eq('payload->>giveaway_id', giveaway!.id)
      .order('idempotency_key');
    expect(endNotificationsError).toBeNull();
    expect(endNotifications).toHaveLength(2);
    expect(endNotifications?.map((row) => row.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'giveaway_atomic_end',
          guild_id: GUILD_ID,
          giveaway_id: giveaway!.id,
          winner_id: entrants[0],
          product_id: null,
          delivery_kind: 'manual',
          prize_snapshot: 'Exact manual prize snapshot',
        }),
        expect.objectContaining({
          source: 'giveaway_atomic_end',
          winner_id: entrants[1],
          delivery_kind: 'manual',
        }),
      ]),
    );

    const nonEntrantReroll = await supa.rpc('giveaway_atomic_reroll', {
      p_giveaway_id: giveaway!.id,
      p_new_winners: [nextSnowflake()],
    });
    expect(nonEntrantReroll.error).toMatchObject({ code: '23514' });
    const oversizedReroll = await supa.rpc('giveaway_atomic_reroll', {
      p_giveaway_id: giveaway!.id,
      p_new_winners: [entrants[2], entrants[3], entrants[4]],
    });
    expect(oversizedReroll.error).toMatchObject({ code: '23514' });

    const rerolled = await supa.rpc('giveaway_atomic_reroll', {
      p_giveaway_id: giveaway!.id,
      p_new_winners: [entrants[3], entrants[2]],
    });
    expect(rerolled.error).toBeNull();
    expect(onlyRow<{ winners: string[] }>(rerolled.data, 'giveaway reroll').winners)
      .toEqual([entrants[1], entrants[0], entrants[3], entrants[2]]);
    const { data: allNotifications, error: allNotificationsError } = await supa
      .from('bot_action_queue')
      .select('payload')
      .eq('action', 'notify_giveaway_winner')
      .eq('payload->>giveaway_id', giveaway!.id);
    expect(allNotificationsError).toBeNull();
    expect(allNotifications).toHaveLength(4);
    expect(allNotifications?.filter((row) =>
      (row.payload as Record<string, unknown>).source === 'giveaway_atomic_reroll'))
      .toHaveLength(2);
  });
});

describe('noncommerce relink activation dependency matrix', () => {
  it('defers for a pending destination, wakes into exact cleanup, and terminalizes failed destinations', async () => {
    const fixture = await createPaidFixture();
    const roleId = nextSnowflake();
    const { data: product, error: productError } = await supa
      .from('products')
      .insert({
        guild_id: GUILD_ID,
        name: nextName('relink-product'),
        description: 'relink dependency matrix fixture',
        type: 'one_time',
        delivery_type: 'access_pass',
        price_cents: 0,
        currency: 'USD',
        granted_role_ids: [roleId],
        granted_channel_ids: [],
        active: true,
      })
      .select('id')
      .single();
    expect(productError).toBeNull();
    const requestId = randomUUID();
    const granted = await supa.rpc('commerce_create_noncommerce_entitlement', {
      p_request_id: requestId,
      p_guild_id: GUILD_ID,
      p_customer_id: fixture.customerId,
      p_product_id: product!.id,
      p_source: 'manual',
      p_type: 'one_time',
      p_plan_id: null,
      p_expires_at: null,
      p_granted_role_ids: [roleId],
      p_granted_channel_ids: [],
    });
    expect(granted.error).toBeNull();
    const entitlementId = onlyRow<{ entitlement_id: string }>(
      granted.data,
      'relink matrix grant',
    ).entitlement_id;
    const { data: initial, error: initialError } = await supa
      .from('bot_action_queue')
      .select('id')
      .contains('payload', {
        source: 'noncommerce_entitlement_activation_trigger',
        entitlement_id: entitlementId,
        activation_generation: entitlementId,
      })
      .single();
    expect(initialError).toBeNull();
    await completeNoncommerceActivation(initial!.id as string, false);

    const discordB = nextSnowflake();
    expect((await supa.from('customers')
      .update({ discord_id: discordB })
      .eq('id', fixture.customerId)).error).toBeNull();
    const { data: relink, error: relinkError } = await supa
      .from('bot_action_queue')
      .select('id,retry_count,payload')
      .contains('payload', {
        source: 'noncommerce_entitlement_customer_relink_trigger',
        entitlement_id: entitlementId,
        old_discord_id: fixture.discordId,
        discord_id: discordB,
      })
      .single();
    expect(relinkError).toBeNull();
    const relinkClaim = await claimAction(relink!.id as string);
    const pending = await supa.rpc(
      'commerce_prepare_noncommerce_role_delivery_cleanup',
      {
        p_action_id: relink!.id,
        p_claim_token: relinkClaim.claim_token,
      },
    );
    expect(pending.error).toBeNull();
    expect(onlyRow<{ disposition: string }>(pending.data, 'pending B cleanup')
      .disposition).toBe('destination_pending');
    const requested = await supa.rpc('commerce_request_noncommerce_relink_activation', {
      p_action_id: relink!.id,
      p_claim_token: relinkClaim.claim_token,
    });
    expect(requested.error).toBeNull();
    const activationB = onlyRow<{
      activation_action_id: string;
      disposition: string;
    }>(requested.data, 'B activation request');
    expect(activationB.disposition).toBe('enqueued');
    const deferred = await supa.rpc('commerce_defer_noncommerce_relink_cleanup', {
      p_action_id: relink!.id,
      p_claim_token: relinkClaim.claim_token,
    });
    expect(deferred.error).toBeNull();
    expect(onlyRow<{ applied: boolean; disposition: string }>(
      deferred.data,
      'deferred A cleanup',
    )).toEqual({ applied: true, disposition: 'deferred' });
    const { data: deferredRow, error: deferredRowError } = await supa
      .from('bot_action_queue')
      .select('status,retry_count,next_retry_at')
      .eq('id', relink!.id)
      .single();
    expect(deferredRowError).toBeNull();
    expect(deferredRow).toMatchObject({
      status: 'pending',
      retry_count: relink!.retry_count,
    });
    expect(deferredRow?.next_retry_at).not.toBeNull();

    await completeNoncommerceActivation(activationB.activation_action_id, false);
    const { data: woken, error: wokenError } = await supa
      .from('bot_action_queue')
      .select('status,next_retry_at')
      .eq('id', relink!.id)
      .single();
    expect(wokenError).toBeNull();
    expect(woken).toEqual({ status: 'pending', next_retry_at: null });

    const cleanupClaim = await claimAction(relink!.id as string);
    const prepared = await supa.rpc(
      'commerce_prepare_noncommerce_role_delivery_cleanup',
      {
        p_action_id: relink!.id,
        p_claim_token: cleanupClaim.claim_token,
      },
    );
    expect(prepared.error).toBeNull();
    const ready = onlyRow<{ intent_id: string; disposition: string }>(
      prepared.data,
      'ready A cleanup',
    );
    expect(ready.disposition).toBe('ready');
    const cleanupBegun = await supa.rpc('commerce_begin_role_delivery_cleanup', {
      p_intent_id: ready.intent_id,
      p_cleanup_action_id: relink!.id,
      p_cleanup_claim_token: cleanupClaim.claim_token,
    });
    expect(cleanupBegun.error).toBeNull();
    const cleanupMutation = onlyRow<{ cleanup_mutation_token: string }>(
      cleanupBegun.data,
      'A cleanup begin',
    ).cleanup_mutation_token;
    const cleanupFinished = await supa.rpc('commerce_finish_role_delivery_cleanup', {
      p_intent_id: ready.intent_id,
      p_cleanup_action_id: relink!.id,
      p_cleanup_claim_token: cleanupClaim.claim_token,
      p_cleanup_mutation_token: cleanupMutation,
      p_outcome: 'cleaned',
      p_error: null,
      p_removed_role_ids: [roleId],
      p_absent_role_ids: [],
      p_retained_role_ids: [],
    });
    expect(cleanupFinished.error).toBeNull();
    expect(onlyRow<{ settled: boolean }>(cleanupFinished.data, 'A cleanup finish')
      .settled).toBe(true);
    const cleanupQueueFinish = await supa.rpc('bot_action_queue_finish_claim', {
      p_action_id: relink!.id,
      p_claim_token: cleanupClaim.claim_token,
      p_success: true,
      p_result: { outcome: 'settled_cleanup' },
      p_error: null,
    });
    expect(cleanupQueueFinish.error).toBeNull();

    const discordC = nextSnowflake();
    expect((await supa.from('customers')
      .update({ discord_id: discordC })
      .eq('id', fixture.customerId)).error).toBeNull();
    const { data: relinkC, error: relinkCError } = await supa
      .from('bot_action_queue')
      .select('id')
      .contains('payload', {
        source: 'noncommerce_entitlement_customer_relink_trigger',
        entitlement_id: entitlementId,
        old_discord_id: discordB,
        discord_id: discordC,
      })
      .single();
    expect(relinkCError).toBeNull();
    const relinkCClaim = await claimAction(relinkC!.id as string);
    const pendingC = await supa.rpc(
      'commerce_prepare_noncommerce_role_delivery_cleanup',
      {
        p_action_id: relinkC!.id,
        p_claim_token: relinkCClaim.claim_token,
      },
    );
    expect(pendingC.error).toBeNull();
    expect(onlyRow<{ disposition: string }>(pendingC.data, 'pending C cleanup')
      .disposition).toBe('destination_pending');
    const requestedC = await supa.rpc('commerce_request_noncommerce_relink_activation', {
      p_action_id: relinkC!.id,
      p_claim_token: relinkCClaim.claim_token,
    });
    expect(requestedC.error).toBeNull();
    const activationC = onlyRow<{ activation_action_id: string }>(
      requestedC.data,
      'C activation request',
    ).activation_action_id;
    const activationCClaim = await claimAction(activationC);
    const failedC = await supa.rpc('bot_action_queue_finish_claim', {
      p_action_id: activationC,
      p_claim_token: activationCClaim.claim_token,
      p_success: false,
      p_result: null,
      p_error: 'deterministic destination failure',
    });
    expect(failedC.error).toBeNull();
    const unproven = await supa.rpc(
      'commerce_prepare_noncommerce_role_delivery_cleanup',
      {
        p_action_id: relinkC!.id,
        p_claim_token: relinkCClaim.claim_token,
      },
    );
    expect(unproven.error).toBeNull();
    expect(onlyRow<{ intent_id: string | null; disposition: string }>(
      unproven.data,
      'failed C destination',
    )).toEqual({ intent_id: null, disposition: 'destination_unproven' });
    const finalizedC = await supa.rpc('bot_action_queue_finish_claim', {
      p_action_id: relinkC!.id,
      p_claim_token: relinkCClaim.claim_token,
      p_success: true,
      p_result: { outcome: 'destination_unproven' },
      p_error: null,
    });
    expect(finalizedC.error).toBeNull();
    expect(onlyRow<{ disposition: string }>(finalizedC.data, 'failed C finalizer')
      .disposition).toBe('completed');
    const { data: survivingB, error: survivingBError } = await supa
      .from('commerce_role_delivery_intents')
      .select('state,discord_id,owned_role_ids')
      .eq('entitlement_id', entitlementId)
      .eq('discord_id', discordB)
      .single();
    expect(survivingBError).toBeNull();
    // The B -> C customer relink durably marked B's generation
    // cleanup_required at trigger time (durable cleanup intent precedes any
    // Discord write). Because C's destination delivery failed, the relink
    // carrier finalized as destination_unproven WITHOUT mutating Discord: B
    // keeps every delivered role (owned_role_ids intact) and its intent stays
    // cleanup_required until a proven destination authorizes exact cleanup.
    expect(survivingB).toEqual({
      state: 'cleanup_required',
      discord_id: discordB,
      owned_role_ids: [roleId],
    });
  });
});

describe('noncommerce terminal entitlement cleanup carrier', () => {
  it('blocks entitlement deletion until exact cleanup completes, then permits purge', async () => {
    const fixture = await createPaidFixture();
    const roleId = nextSnowflake();
    const { data: entitlement, error: entitlementError } = await supa
      .from('entitlements')
      .insert({
        customer_id: fixture.customerId,
        guild_id: GUILD_ID,
        product_id: fixture.productId,
        order_id: null,
        type: 'one_time',
        status: 'active',
        source: 'giveaway',
        granted_role_ids: [roleId],
        granted_channel_ids: [],
      })
      .select('id')
      .single();
    expect(entitlementError).toBeNull();
    const terminal = await supa
      .from('entitlements')
      .update({ status: 'cancelled' })
      .eq('id', entitlement!.id);
    expect(terminal.error).toBeNull();
    const { data: carrier, error: carrierError } = await supa
      .from('bot_action_queue')
      .select('id')
      .contains('payload', {
        source: 'noncommerce_entitlement_status_trigger',
        entitlement_id: entitlement!.id,
        entitlement_status: 'cancelled',
      })
      .single();
    expect(carrierError).toBeNull();

    const forgedCompletion = await supa
      .from('bot_action_queue')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        result: { forged: true },
      })
      .eq('id', carrier!.id);
    expect(forgedCompletion.error).toMatchObject({
      code: '42501',
      message: 'bot action queue status transitions require an exact CAS RPC',
    });
    const forgedFailure = await supa
      .from('bot_action_queue')
      .update({ status: 'failed', error_message: 'forged settlement' })
      .eq('id', carrier!.id);
    expect(forgedFailure.error).toMatchObject({ code: '42501' });

    const prematureCarrierDelete = await supa
      .from('bot_action_queue')
      .delete()
      .eq('id', carrier!.id);
    expect(prematureCarrierDelete.error).toMatchObject({ code: '23503' });

    const prematureDelete = await supa
      .from('entitlements')
      .delete()
      .eq('id', entitlement!.id);
    expect(prematureDelete.error).toMatchObject({ code: '23503' });

    expect(await completeNoopNoncommerceCleanup(carrier!.id as string))
      .toBe('unproven');
    const activationStillBlocksDelete = await supa
      .from('entitlements')
      .delete()
      .eq('id', entitlement!.id);
    expect(activationStillBlocksDelete.error).toMatchObject({ code: '23503' });
    const { data: activationCarrier, error: activationCarrierError } = await supa
      .from('bot_action_queue')
      .select('id,status,payload')
      .contains('payload', {
        source: 'noncommerce_entitlement_activation_trigger',
        entitlement_id: entitlement!.id,
        activation_generation: entitlement!.id,
      })
      .single();
    expect(activationCarrierError).toBeNull();
    expect(activationCarrier?.status).toBe('pending');
    await completeNoncommerceActivation(activationCarrier!.id as string);
    const forgedReopen = await supa
      .from('bot_action_queue')
      .update({ status: 'pending' })
      .eq('id', carrier!.id);
    expect(forgedReopen.error).toMatchObject({ code: '42501' });
    const completedCarrierDelete = await supa
      .from('bot_action_queue')
      .delete()
      .eq('id', carrier!.id);
    expect(completedCarrierDelete.error).toBeNull();
    const completedDelete = await supa
      .from('entitlements')
      .delete()
      .eq('id', entitlement!.id);
    expect(completedDelete.error).toBeNull();
    const { data: deleted } = await supa
      .from('entitlements')
      .select('id')
      .eq('id', entitlement!.id)
      .maybeSingle();
    expect(deleted).toBeNull();
  });

  it('reuses same-identity recurrences, snapshots relinks, and never duplicates an active carrier', async () => {
    const fixture = await createPaidFixture();
    const roleId = nextSnowflake();
    const { data: entitlement, error: entitlementError } = await supa
      .from('entitlements')
      .insert({
        customer_id: fixture.customerId,
        guild_id: GUILD_ID,
        product_id: fixture.productId,
        order_id: null,
        type: 'subscription',
        status: 'active',
        source: 'manual',
        granted_role_ids: [roleId],
        granted_channel_ids: [],
      })
      .select('id')
      .single();
    expect(entitlementError).toBeNull();

    const terminal = await supa
      .from('entitlements')
      .update({ status: 'expired' })
      .eq('id', entitlement!.id);
    expect(terminal.error).toBeNull();
    const { data: carrier, error: carrierError } = await supa
      .from('bot_action_queue')
      .select('id,guild_id,action,payload,status,lane,idempotency_key')
      .contains('payload', {
        source: 'noncommerce_entitlement_status_trigger',
        entitlement_id: entitlement!.id,
        entitlement_status: 'expired',
      })
      .single();
    expect(carrierError).toBeNull();
    const key = carrier!.idempotency_key as string;
    expect(key).toMatch(new RegExp(
      `^noncommerce:terminal-entitlement:${entitlement!.id}:${fixture.discordId}:expired:[0-9a-f]{32}:v1$`,
    ));
    expect(carrier).toMatchObject({
      guild_id: GUILD_ID,
      action: 'revoke_roles',
      status: 'pending',
      lane: 'commerce',
      idempotency_key: key,
      payload: {
        source: 'noncommerce_entitlement_status_trigger',
        guild_id: GUILD_ID,
        discord_id: fixture.discordId,
        entitlement_id: entitlement!.id,
        customer_id: fixture.customerId,
        order_id: null,
        product_id: fixture.productId,
        entitlement_source: 'manual',
        entitlement_status: 'expired',
        entitlement_type: 'subscription',
        plan_id: null,
        role_ids: [roleId],
        temporary_role_grant_ids: [],
        reason: 'entitlement_expired',
      },
    });

    const [replayed] = await sqlA<{ action_id: string }[]>`
      SELECT public.commerce_enqueue_noncommerce_terminal_entitlement(
        ${entitlement!.id}::UUID,
        'expired'
      ) AS action_id
    `;
    expect(replayed?.action_id).toBe(carrier!.id);
    const [count] = await sqlA<{ carrier_count: number }[]>`
      SELECT pg_catalog.count(*)::INTEGER AS carrier_count
        FROM public.bot_action_queue
       WHERE idempotency_key = ${key}
    `;
    expect(count?.carrier_count).toBe(1);

    const activeClaim = await claimAction(carrier!.id as string);
    const firstReactivation = await supa
      .from('entitlements')
      .update({ status: 'active' })
      .eq('id', entitlement!.id);
    expect(firstReactivation.error).toBeNull();
    const processingRecurrence = await supa
      .from('entitlements')
      .update({ status: 'expired' })
      .eq('id', entitlement!.id);
    expect(processingRecurrence.error).toBeNull();
    const { data: stillProcessing } = await supa
      .from('bot_action_queue')
      .select('id,status')
      .eq('idempotency_key', key)
      .single();
    expect(stillProcessing).toEqual({ id: carrier!.id, status: 'processing' });

    const preparedRecurrence = await supa.rpc(
      'commerce_prepare_noncommerce_role_delivery_cleanup',
      {
        p_action_id: carrier!.id,
        p_claim_token: activeClaim.claim_token,
      },
    );
    expect(preparedRecurrence.error).toBeNull();
    expect(onlyRow<{ disposition: string }>(
      preparedRecurrence.data,
      'processing recurrence cleanup preparation',
    ).disposition).toBe('unproven');
    const completed = await supa.rpc('bot_action_queue_finish_claim', {
      p_action_id: carrier!.id,
      p_claim_token: activeClaim.claim_token,
      p_success: true,
      p_result: { removed: [roleId] },
      p_error: null,
    });
    expect(completed.error).toBeNull();
    const secondReactivation = await supa
      .from('entitlements')
      .update({ status: 'active' })
      .eq('id', entitlement!.id);
    expect(secondReactivation.error).toBeNull();
    const completedRecurrence = await supa
      .from('entitlements')
      .update({ status: 'expired' })
      .eq('id', entitlement!.id);
    expect(completedRecurrence.error).toBeNull();
    const { data: reopened } = await supa
      .from('bot_action_queue')
      .select('id,status,retry_count')
      .eq('idempotency_key', key)
      .single();
    expect(reopened).toMatchObject({ id: carrier!.id, status: 'pending', retry_count: 1 });

    const relinkedDiscordId = nextSnowflake();
    const relink = await supa
      .from('customers')
      .update({ discord_id: relinkedDiscordId })
      .eq('id', fixture.customerId);
    expect(relink.error).toBeNull();
    const { data: afterRelink } = await supa
      .from('bot_action_queue')
      .select('payload')
      .eq('id', carrier!.id)
      .single();
    expect((afterRelink!.payload as Record<string, unknown>).discord_id).toBe(
      fixture.discordId,
    );

    const relinkReactivation = await supa
      .from('entitlements')
      .update({ status: 'active' })
      .eq('id', entitlement!.id);
    expect(relinkReactivation.error).toBeNull();
    const relinkTerminal = await supa
      .from('entitlements')
      .update({ status: 'expired' })
      .eq('id', entitlement!.id);
    expect(relinkTerminal.error).toBeNull();
    const { data: relinkedCarrier, error: relinkedCarrierError } = await supa
      .from('bot_action_queue')
      .select('id,payload,status')
      .contains('payload', {
        source: 'noncommerce_entitlement_status_trigger',
        entitlement_id: entitlement!.id,
        entitlement_status: 'expired',
        discord_id: relinkedDiscordId,
      })
      .single();
    expect(relinkedCarrierError).toBeNull();
    expect(relinkedCarrier).toMatchObject({
      status: 'pending',
      payload: { discord_id: relinkedDiscordId, role_ids: [roleId] },
    });
    expect(relinkedCarrier!.id).not.toBe(carrier!.id);
  });

  it('keeps grant identity and snapshots immutable before and after cleanup', async () => {
    const fixture = await createPaidFixture();
    const otherProduct = await createPaidFixture();
    const firstRoleId = nextSnowflake();
    const secondRoleId = nextSnowflake();
    const { data: entitlement, error: entitlementError } = await supa
      .from('entitlements')
      .insert({
        customer_id: fixture.customerId,
        guild_id: GUILD_ID,
        product_id: fixture.productId,
        order_id: null,
        type: 'one_time',
        status: 'active',
        source: 'automation',
        granted_role_ids: [firstRoleId],
        granted_channel_ids: [],
      })
      .select('id')
      .single();
    expect(entitlementError).toBeNull();
    expect((await supa
      .from('entitlements')
      .update({ status: 'expired' })
      .eq('id', entitlement!.id)).error).toBeNull();
    const { data: first, error: firstError } = await supa
      .from('bot_action_queue')
      .select('id,idempotency_key,payload')
      .contains('payload', {
        source: 'noncommerce_entitlement_status_trigger',
        entitlement_id: entitlement!.id,
        role_ids: [firstRoleId],
      })
      .single();
    expect(firstError).toBeNull();

    const unresolvedVectorChange = await supa
      .from('entitlements')
      .update({ granted_role_ids: [secondRoleId] })
      .eq('id', entitlement!.id);
    expect(unresolvedVectorChange.error).toMatchObject({ code: '23514' });
    const unresolvedPrimaryKeyChange = await supa
      .from('entitlements')
      .update({ id: randomUUID() })
      .eq('id', entitlement!.id);
    expect(unresolvedPrimaryKeyChange.error).toMatchObject({ code: '23514' });
    const unresolvedLicenseBinding = await supa
      .from('entitlements')
      .update({ license_key_id: randomUUID() })
      .eq('id', entitlement!.id);
    expect(unresolvedLicenseBinding.error).toMatchObject({
      code: '23514',
      message: 'entitlement grant identity and snapshots are lifetime-immutable',
    });
    const reactivated = await supa
      .from('entitlements')
      .update({ status: 'active' })
      .eq('id', entitlement!.id);
    expect(reactivated.error).toBeNull();
    const reexpired = await supa
      .from('entitlements')
      .update({ status: 'expired' })
      .eq('id', entitlement!.id);
    expect(reexpired.error).toBeNull();

    await completeNoopNoncommerceCleanup(first!.id as string);

    const resolvedVectorChange = await supa
      .from('entitlements')
      .update({ granted_role_ids: [secondRoleId] })
      .eq('id', entitlement!.id);
    expect(resolvedVectorChange.error).toMatchObject({ code: '23514' });
    const resolvedProductChange = await supa
      .from('entitlements')
      .update({ product_id: otherProduct.productId })
      .eq('id', entitlement!.id);
    expect(resolvedProductChange.error).toMatchObject({ code: '23514' });
    const resolvedSourceChange = await supa
      .from('entitlements')
      .update({ source: 'manual' })
      .eq('id', entitlement!.id);
    expect(resolvedSourceChange.error).toMatchObject({ code: '23514' });
    const { data: preserved, error: preservedError } = await supa
      .from('entitlements')
      .select('id,product_id,source,granted_role_ids,status')
      .eq('id', entitlement!.id)
      .single();
    expect(preservedError).toBeNull();
    expect(preserved).toMatchObject({
      id: entitlement!.id,
      product_id: fixture.productId,
      source: 'automation',
      granted_role_ids: [firstRoleId],
      status: 'expired',
    });
    const { count: carrierCount, error: carrierCountError } = await supa
      .from('bot_action_queue')
      .select('id', { count: 'exact', head: true })
      .contains('payload', {
        source: 'noncommerce_entitlement_status_trigger',
        entitlement_id: entitlement!.id,
      });
    expect(carrierCountError).toBeNull();
    expect(carrierCount).toBe(1);
  });

  it('snapshots live A-to-B-to-A relinks and terminalizes only the current identity', async () => {
    const fixture = await createPaidFixture();
    const roleId = nextSnowflake();
    const discordB = nextSnowflake();
    const { data: entitlement, error: entitlementError } = await supa
      .from('entitlements')
      .insert({
        customer_id: fixture.customerId,
        guild_id: GUILD_ID,
        product_id: fixture.productId,
        order_id: null,
        type: 'subscription',
        plan_id: null,
        status: 'active',
        source: 'manual',
        granted_role_ids: [roleId],
        granted_channel_ids: [],
      })
      .select('id')
      .single();
    expect(entitlementError).toBeNull();
    expect((await supa.from('customers').update({ discord_id: discordB })
      .eq('id', fixture.customerId)).error).toBeNull();
    expect((await supa.from('customers').update({ discord_id: fixture.discordId })
      .eq('id', fixture.customerId)).error).toBeNull();

    const { data: relinks, error: relinksError } = await supa
      .from('bot_action_queue')
      .select('id,idempotency_key,payload,status')
      .eq('payload->>source', 'noncommerce_entitlement_customer_relink_trigger')
      .eq('payload->>entitlement_id', entitlement!.id)
      .order('created_at');
    expect(relinksError).toBeNull();
    expect(relinks).toHaveLength(2);
    expect(relinks?.map((row) => ({
      old: (row.payload as Record<string, unknown>).old_discord_id,
      next: (row.payload as Record<string, unknown>).discord_id,
      type: (row.payload as Record<string, unknown>).entitlement_type,
      plan: (row.payload as Record<string, unknown>).plan_id,
    }))).toEqual([
      { old: fixture.discordId, next: discordB, type: 'subscription', plan: null },
      { old: discordB, next: fixture.discordId, type: 'subscription', plan: null },
    ]);
    const relinkEntitlementDelete = await supa.from('entitlements')
      .delete().eq('id', entitlement!.id);
    expect(relinkEntitlementDelete.error).toMatchObject({ code: '23503' });
    const relinkCustomerDelete = await supa.from('customers')
      .delete().eq('id', fixture.customerId);
    expect(relinkCustomerDelete.error).toMatchObject({ code: '23503' });

    const forgedPayload = {
      ...(relinks![0]!.payload as Record<string, unknown>),
      relink_generation: randomUUID(),
    };
    const forgedKey = `noncommerce:customer-relink:${entitlement!.id}:${fixture.discordId}:${discordB}:${await jsonbFingerprint(forgedPayload)}:v1`;
    const forged = await supa.from('bot_action_queue').insert({
      guild_id: GUILD_ID,
      action: 'revoke_roles',
      payload: forgedPayload,
      status: 'pending',
      lane: 'commerce',
      idempotency_key: forgedKey,
    });
    expect(forged.error).toMatchObject({ code: '42501' });
    const nullRelinkPayload = { ...forgedPayload, old_discord_id: null };
    const nullRelinkKey = `noncommerce:customer-relink:${entitlement!.id}::${discordB}:${await jsonbFingerprint(nullRelinkPayload)}:v1`;
    const [nullRelink] = await sqlA<{ carrier_kind: string | null }[]>`
      SELECT public.commerce_noncommerce_cleanup_carrier_kind(
        ${GUILD_ID},
        'revoke_roles',
        'commerce',
        ${nullRelinkKey},
        ${JSON.stringify(nullRelinkPayload)}::JSONB
      ) AS carrier_kind
    `;
    expect(nullRelink?.carrier_kind).toBeNull();

    const terminal = await supa
      .from('entitlements')
      .update({ status: 'cancelled' })
      .eq('id', entitlement!.id);
    expect(terminal.error).toBeNull();
    const { data: terminalCarrier, error: terminalCarrierError } = await supa
      .from('bot_action_queue')
      .select('payload')
      .contains('payload', {
        source: 'noncommerce_entitlement_status_trigger',
        entitlement_id: entitlement!.id,
        discord_id: fixture.discordId,
        entitlement_type: 'subscription',
        plan_id: null,
      })
      .single();
    expect(terminalCarrierError).toBeNull();
    expect(terminalCarrier?.payload).toMatchObject({ role_ids: [roleId] });
  });

  it('fences relink observation behind an uncommitted terminal transition', async () => {
    const fixture = await createPaidFixture();
    const roleId = nextSnowflake();
    const discordB = nextSnowflake();
    const { data: entitlement, error: entitlementError } = await supa
      .from('entitlements')
      .insert({
        customer_id: fixture.customerId,
        guild_id: GUILD_ID,
        product_id: fixture.productId,
        order_id: null,
        type: 'one_time',
        status: 'active',
        source: 'manual',
        granted_role_ids: [roleId],
        granted_channel_ids: [],
      })
      .select('id')
      .single();
    expect(entitlementError).toBeNull();
    expect((await supa.from('customers').update({ discord_id: discordB })
      .eq('id', fixture.customerId)).error).toBeNull();

    const terminalStarted = makeGate();
    const releaseTerminal = makeGate();
    let terminalError: unknown;
    const terminalTransaction = sqlA.begin(async (tx) => {
      await tx`
        UPDATE public.entitlements
           SET status = 'cancelled'
         WHERE id = ${entitlement!.id}::UUID
      `;
      terminalStarted.open();
      await releaseTerminal.promise;
    }).catch((error: unknown) => {
      terminalError = error;
      terminalStarted.open();
      releaseTerminal.open();
    });
    await terminalStarted.promise;
    if (terminalError) throw terminalError;

    const observation = sqlB<{
      entitlement_id: string;
      entitlement_status: string;
      granted_role_ids: string[];
      current_discord_id: string;
    }[]>`
      SELECT entitlement_id,
             entitlement_status,
             granted_role_ids,
             current_discord_id
        FROM public.commerce_observe_noncommerce_live_origin(
          ${entitlement!.id}::UUID,
          ${fixture.customerId}::UUID,
          ${GUILD_ID}
        )
    `.execute();
    try {
      await waitForDatabaseLock(
        sqlBBackendPid,
        'noncommerce relink observation behind terminal entitlement update',
      );
    } catch (error) {
      releaseTerminal.open();
      await Promise.allSettled([observation, terminalTransaction]);
      throw error;
    }
    releaseTerminal.open();
    await terminalTransaction;
    if (terminalError) throw terminalError;

    const rows = await observation;
    expect(rows).toEqual([{
      entitlement_id: entitlement!.id,
      entitlement_status: 'cancelled',
      granted_role_ids: [roleId],
      current_discord_id: discordB,
    }]);
  });

  it('takes the customer lock before entitlement observation to avoid the purge-order deadlock', async () => {
    const fixture = await createPaidFixture();
    const roleId = nextSnowflake();
    const { data: entitlement, error: entitlementError } = await supa
      .from('entitlements')
      .insert({
        customer_id: fixture.customerId,
        guild_id: GUILD_ID,
        product_id: fixture.productId,
        order_id: null,
        type: 'one_time',
        status: 'active',
        source: 'manual',
        granted_role_ids: [roleId],
        granted_channel_ids: [],
      })
      .select('id')
      .single();
    expect(entitlementError).toBeNull();

    const customerLocked = makeGate();
    const releaseCustomerWriter = makeGate();
    let writerError: unknown;
    const customerThenTerminalWriter = sqlA.begin(async (tx) => {
      await tx`
        SELECT id
          FROM public.customers
         WHERE id = ${fixture.customerId}::UUID
         FOR UPDATE
      `;
      customerLocked.open();
      await releaseCustomerWriter.promise;
      await tx`
        UPDATE public.entitlements
           SET status = 'cancelled'
         WHERE id = ${entitlement!.id}::UUID
      `;
    }).catch((error: unknown) => {
      writerError = error;
      customerLocked.open();
      releaseCustomerWriter.open();
    });
    await customerLocked.promise;
    if (writerError) throw writerError;

    const observation = sqlB<{
      entitlement_id: string;
      entitlement_status: string;
      current_discord_id: string;
    }[]>`
      SELECT entitlement_id, entitlement_status, current_discord_id
        FROM public.commerce_observe_noncommerce_live_origin(
          ${entitlement!.id}::UUID,
          ${fixture.customerId}::UUID,
          ${GUILD_ID}
        )
    `.execute();
    try {
      await waitForDatabaseLock(
        sqlBBackendPid,
        'noncommerce live observation behind the canonical customer lock',
      );
    } catch (error) {
      releaseCustomerWriter.open();
      await Promise.allSettled([observation, customerThenTerminalWriter]);
      throw error;
    }
    releaseCustomerWriter.open();
    await customerThenTerminalWriter;
    if (writerError) throw writerError;

    expect(await observation).toEqual([{
      entitlement_id: entitlement!.id,
      entitlement_status: 'cancelled',
      current_discord_id: fixture.discordId,
    }]);
  });

  it('retries failed noncommerce DLQs in place and rejects cross-linked replay', async () => {
    const fixture = await createPaidFixture();
    const roleId = nextSnowflake();
    const { data: entitlement, error: entitlementError } = await supa
      .from('entitlements')
      .insert({
        customer_id: fixture.customerId,
        guild_id: GUILD_ID,
        product_id: fixture.productId,
        order_id: null,
        type: 'one_time',
        status: 'active',
        source: 'giveaway',
        granted_role_ids: [roleId],
        granted_channel_ids: [],
      })
      .select('id')
      .single();
    expect(entitlementError).toBeNull();
    expect((await supa.from('entitlements').update({ status: 'expired' })
      .eq('id', entitlement!.id)).error).toBeNull();
    const { data: carrier, error: carrierError } = await supa
      .from('bot_action_queue')
      .select('id,payload')
      .contains('payload', {
        source: 'noncommerce_entitlement_status_trigger',
        entitlement_id: entitlement!.id,
      })
      .single();
    expect(carrierError).toBeNull();
    const claim = await claimAction(carrier!.id as string);
    const failed = await supa.rpc('bot_action_queue_finish_claim', {
      p_action_id: carrier!.id,
      p_claim_token: claim.claim_token,
      p_success: false,
      p_result: null,
      p_error: 'fixture Discord failure',
    });
    expect(failed.error).toBeNull();
    const { data: dlq, error: dlqError } = await supa
      .from('action_queue_dlq')
      .select('id,retried')
      .eq('original_id', carrier!.id)
      .eq('retried', false)
      .single();
    expect(dlqError).toBeNull();
    const failedDelete = await supa.from('bot_action_queue')
      .delete().eq('id', carrier!.id);
    expect(failedDelete.error).toMatchObject({ code: '23503' });

    expect(await retryGenericDlq(dlq!.id as string)).toEqual({
      action_id: carrier!.id,
      action_status: 'pending',
      disposition: 'reopened',
    });
    expect(await retryGenericDlq(dlq!.id as string)).toEqual({
      action_id: null,
      action_status: null,
      disposition: 'already_retried',
    });
    await completeNoopNoncommerceCleanup(carrier!.id as string);

    const completedDlqId = await insertDlq(carrier!.id as string);
    expect(await retryGenericDlq(completedDlqId)).toEqual({
      action_id: carrier!.id,
      action_status: 'completed',
      disposition: 'already_completed',
    });
    const { data: action, error: actionError } = await supa
      .from('bot_action_queue')
      .select('guild_id,action,lane,payload,retry_count')
      .eq('id', carrier!.id)
      .single();
    expect(actionError).toBeNull();
    const { data: poisonedDlq, error: poisonedDlqError } = await supa
      .from('action_queue_dlq')
      .insert({
        guild_id: action!.guild_id,
        action: action!.action,
        lane: action!.lane,
        payload: { ...(action!.payload as Record<string, unknown>), reason: 'forged' },
        error_message: 'cross-linked fixture',
        retry_count: action!.retry_count,
        max_retries: 5,
        original_id: carrier!.id,
      })
      .select('id')
      .single();
    expect(poisonedDlqError).toBeNull();
    const poisonedRetry = await supa.rpc('bot_action_queue_retry_dlq', {
      p_dlq_id: poisonedDlq!.id,
      p_guild_id: GUILD_ID,
    });
    expect(poisonedRetry.error).toMatchObject({ code: '23514' });
    const { count: carrierCount, error: carrierCountError } = await supa
      .from('bot_action_queue')
      .select('id', { count: 'exact', head: true })
      .eq('id', carrier!.id);
    expect(carrierCountError).toBeNull();
    expect(carrierCount).toBe(1);
  });

  it('keeps member privacy purge pending through failed cleanup then completes after replay', async () => {
    const fixture = await createPaidFixture();
    const roleId = nextSnowflake();
    const { data: entitlement, error: entitlementError } = await supa
      .from('entitlements')
      .insert({
        customer_id: fixture.customerId,
        guild_id: GUILD_ID,
        product_id: fixture.productId,
        order_id: null,
        type: 'one_time',
        status: 'active',
        source: 'manual',
        granted_role_ids: [roleId],
        granted_channel_ids: [],
      })
      .select('id')
      .single();
    expect(entitlementError).toBeNull();
    expect((await supa.from('entitlements').update({ status: 'expired' })
      .eq('id', entitlement!.id)).error).toBeNull();
    const { data: carrier, error: carrierError } = await supa
      .from('bot_action_queue')
      .select('id')
      .contains('payload', {
        source: 'noncommerce_entitlement_status_trigger',
        entitlement_id: entitlement!.id,
      })
      .single();
    expect(carrierError).toBeNull();
    const claim = await claimAction(carrier!.id as string);
    expect((await supa.rpc('bot_action_queue_finish_claim', {
      p_action_id: carrier!.id,
      p_claim_token: claim.claim_token,
      p_success: false,
      p_result: null,
      p_error: 'member purge fixture failure',
    })).error).toBeNull();
    const { data: dlq, error: dlqError } = await supa
      .from('action_queue_dlq')
      .select('id')
      .eq('original_id', carrier!.id)
      .eq('retried', false)
      .single();
    expect(dlqError).toBeNull();

    const forgedTombstone = await supa.from('customers')
      .update({ discord_id: `deleted-${fixture.customerId}` })
      .eq('id', fixture.customerId);
    expect(forgedTombstone.error).toMatchObject({ code: '23514' });

    const pending = await supa.rpc('purge_member_data', {
      p_guild_id: GUILD_ID,
      p_user_id: fixture.discordId,
    });
    expect(pending.error).toBeNull();
    expect(pending.data).toMatchObject({
      purge_status: 'pending_role_cleanup',
    });
    expect((pending.data as { pending_role_cleanup_count: number })
      .pending_role_cleanup_count).toBeGreaterThan(0);

    const identityAfterPhaseOne = nextSnowflake();
    const relinkWhilePending = await supa.from('customers')
      .update({ discord_id: identityAfterPhaseOne })
      .eq('id', fixture.customerId);
    expect(relinkWhilePending.error).toBeNull();

    expect(await retryGenericDlq(dlq!.id as string)).toMatchObject({
      action_id: carrier!.id,
      disposition: 'reopened',
    });
    await completeNoopNoncommerceCleanup(carrier!.id as string);
    const activationPending = await supa.rpc('purge_member_data', {
      p_guild_id: GUILD_ID,
      p_user_id: fixture.discordId,
    });
    expect(activationPending.error).toBeNull();
    expect(activationPending.data).toMatchObject({
      purge_status: 'pending_role_cleanup',
    });
    const { data: activationCarrier, error: activationCarrierError } = await supa
      .from('bot_action_queue')
      .select('id,status,payload')
      .contains('payload', {
        source: 'noncommerce_entitlement_activation_trigger',
        entitlement_id: entitlement!.id,
        activation_generation: entitlement!.id,
      })
      .single();
    expect(activationCarrierError).toBeNull();
    expect(activationCarrier?.status).toBe('pending');
    await completeNoncommerceActivation(activationCarrier!.id as string);
    const completed = await supa.rpc('purge_member_data', {
      p_guild_id: GUILD_ID,
      p_user_id: fixture.discordId,
    });
    expect(completed.error).toBeNull();
    expect(completed.data).toMatchObject({
      purge_status: 'completed',
      pending_role_cleanup_count: 0,
    });
    const { data: tombstonedCustomer, error: tombstonedCustomerError } = await supa
      .from('customers')
      .select('discord_id')
      .eq('id', fixture.customerId)
      .single();
    expect(tombstonedCustomerError).toBeNull();
    expect(tombstonedCustomer?.discord_id).toBe(`deleted-${fixture.customerId}`);
    const { count: mintedRelinkCount, error: mintedRelinkError } = await supa
      .from('bot_action_queue')
      .select('id', { count: 'exact', head: true })
      .eq('payload->>source', 'noncommerce_entitlement_customer_relink_trigger')
      .eq('payload->>customer_id', fixture.customerId);
    expect(mintedRelinkError).toBeNull();
    expect(mintedRelinkCount).toBe(0);
  });

  it('purges captured identity A after a relink to B wins before revocation', async () => {
    const oldDiscordId = nextSnowflake();
    const currentDiscordId = nextSnowflake();
    const roleId = nextSnowflake();
    const { data: product, error: productError } = await supa
      .from('products')
      .insert({
        guild_id: GUILD_ID,
        name: nextName('relink-wins-purge-product'),
        description: 'relink-wins member purge fixture',
        type: 'one_time',
        delivery_type: 'access_pass',
        price_cents: 100,
        currency: 'USD',
        active: true,
        granted_role_ids: [],
        granted_channel_ids: [],
      })
      .select('id')
      .single();
    expect(productError).toBeNull();
    const { data: customer, error: customerError } = await supa
      .from('customers')
      .insert({
        guild_id: GUILD_ID,
        discord_id: oldDiscordId,
        discord_username: nextName('relink-wins-purge-customer'),
      })
      .select('id')
      .single();
    expect(customerError).toBeNull();
    const { data: entitlement, error: entitlementError } = await supa
      .from('entitlements')
      .insert({
        customer_id: customer!.id,
        guild_id: GUILD_ID,
        product_id: product!.id,
        order_id: null,
        type: 'one_time',
        status: 'active',
        source: 'manual',
        granted_role_ids: [roleId],
        granted_channel_ids: [],
      })
      .select('id')
      .single();
    expect(entitlementError).toBeNull();

    const relink = await supa
      .from('customers')
      .update({ discord_id: currentDiscordId })
      .eq('id', customer!.id);
    expect(relink.error).toBeNull();
    const { data: relinkCarrier, error: relinkCarrierError } = await supa
      .from('bot_action_queue')
      .select('id,payload,status')
      .contains('payload', {
        source: 'noncommerce_entitlement_customer_relink_trigger',
        entitlement_id: entitlement!.id,
        old_discord_id: oldDiscordId,
        discord_id: currentDiscordId,
      })
      .single();
    expect(relinkCarrierError).toBeNull();
    expect(relinkCarrier?.status).toBe('pending');

    // The old identity now exists only in an authenticated carrier. The base
    // purge's current-discord filter would revoke zero rows in this state.
    const pending = await supa.rpc('purge_member_data', {
      p_guild_id: GUILD_ID,
      p_user_id: oldDiscordId,
    });
    expect(pending.error).toBeNull();
    expect(pending.data).toMatchObject({
      entitlements_revoked: 1,
      purge_status: 'pending_role_cleanup',
    });
    const { data: terminalEntitlement, error: terminalEntitlementError } = await supa
      .from('entitlements')
      .select('status')
      .eq('id', entitlement!.id)
      .single();
    expect(terminalEntitlementError).toBeNull();
    expect(terminalEntitlement?.status).toBe('cancelled');
    const { data: terminalCarrier, error: terminalCarrierError } = await supa
      .from('bot_action_queue')
      .select('id,payload,status')
      .contains('payload', {
        source: 'noncommerce_entitlement_status_trigger',
        entitlement_id: entitlement!.id,
        discord_id: currentDiscordId,
        entitlement_status: 'cancelled',
      })
      .single();
    expect(terminalCarrierError).toBeNull();
    expect(terminalCarrier?.status).toBe('pending');
    const { data: activationCarrier, error: activationCarrierError } = await supa
      .from('bot_action_queue')
      .select('id,payload,status')
      .contains('payload', {
        source: 'noncommerce_entitlement_activation_trigger',
        entitlement_id: entitlement!.id,
        discord_id: oldDiscordId,
        activation_generation: entitlement!.id,
      })
      .single();
    expect(activationCarrierError).toBeNull();
    expect(activationCarrier?.status).toBe('pending');

    for (const actionId of [relinkCarrier!.id, terminalCarrier!.id]) {
      await completeNoopNoncommerceCleanup(actionId as string);
    }

    const activationStillPending = await supa.rpc('purge_member_data', {
      p_guild_id: GUILD_ID,
      p_user_id: oldDiscordId,
    });
    expect(activationStillPending.error).toBeNull();
    expect(activationStillPending.data).toMatchObject({
      purge_status: 'pending_role_cleanup',
    });
    await completeNoncommerceActivation(activationCarrier!.id as string);

    const completed = await supa.rpc('purge_member_data', {
      p_guild_id: GUILD_ID,
      p_user_id: oldDiscordId,
    });
    expect(completed.error).toBeNull();
    expect(completed.data).toMatchObject({
      entitlements_revoked: 0,
      purge_status: 'completed',
      pending_role_cleanup_count: 0,
    });
    const { data: tombstoned, error: tombstonedError } = await supa
      .from('customers')
      .select('discord_id')
      .eq('id', customer!.id)
      .single();
    expect(tombstonedError).toBeNull();
    expect(tombstoned?.discord_id).toBe(`deleted-${customer!.id}`);
  });

  it('keeps guild purge pending on failed relink cleanup and removes the guild after convergence', async () => {
    const guildId = `test-noncommerce-guild-purge-${RUN_ID}-${++sequence}`;
    const originalDiscordId = nextSnowflake();
    const relinkedDiscordId = nextSnowflake();
    const roleId = nextSnowflake();
    let guildDeleted = false;
    try {
      expect((await supa.from('guild').insert({
        id: guildId,
        name: 'Noncommerce purge fixture',
        owner_discord_id: nextSnowflake(),
      })).error).toBeNull();
      const { data: product, error: productError } = await supa
        .from('products')
        .insert({
          guild_id: guildId,
          name: nextName('purge-product'),
          description: 'purge fixture',
          type: 'one_time',
          delivery_type: 'access_pass',
          price_cents: 100,
          currency: 'USD',
          active: true,
          granted_role_ids: [],
          granted_channel_ids: [],
        })
        .select('id')
        .single();
      expect(productError).toBeNull();
      const { data: customer, error: customerError } = await supa
        .from('customers')
        .insert({
          guild_id: guildId,
          discord_id: originalDiscordId,
          discord_username: nextName('purge-customer'),
        })
        .select('id')
        .single();
      expect(customerError).toBeNull();
      const paidOrders = await sqlA<{
        id: string;
        order_number: string;
      }[]>`
        INSERT INTO public.orders (
          order_number,
          customer_id,
          guild_id,
          product_id,
          paypal_order_id,
          amount_cents,
          currency,
          source,
          status,
          checkout_active
        ) VALUES
          (
            ${nextName('purge-paid-winner')},
            ${customer!.id}::UUID,
            ${guildId},
            ${product!.id}::UUID,
            ${nextName('purge-paypal-winner')},
            100,
            'USD',
            'purchase',
            'completed',
            false
          ),
          (
            ${nextName('purge-paid-loser')},
            ${customer!.id}::UUID,
            ${guildId},
            ${product!.id}::UUID,
            ${nextName('purge-paypal-loser')},
            100,
            'USD',
            'purchase',
            'completed',
            false
          )
        RETURNING id, order_number
      `;
      const captureWinner = nextName('purge-capture-winner');
      const captureLoser = nextName('purge-capture-loser');
      await sqlA`
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
            ${paidOrders[0]!.id}::UUID,
            ${customer!.id}::UUID,
            ${guildId},
            ${captureWinner},
            100,
            'USD',
            'completed',
            'paypal',
            'capture'
          ),
          (
            ${paidOrders[1]!.id}::UUID,
            ${customer!.id}::UUID,
            ${guildId},
            ${captureLoser},
            100,
            'USD',
            'completed',
            'paypal',
            'capture'
          )
      `;
      const [winnerClaim] = await sqlA<{ result: Record<string, unknown> }[]>`
        SELECT public.commerce_claim_paid_fulfillment(
          ${paidOrders[0]!.id}::UUID,
          ${guildId},
          ${customer!.id}::UUID,
          ${product!.id}::UUID,
          'capture',
          ${captureWinner},
          100,
          'USD'
        ) AS result
      `;
      const [loserClaim] = await sqlA<{ result: Record<string, unknown> }[]>`
        SELECT public.commerce_claim_paid_fulfillment(
          ${paidOrders[1]!.id}::UUID,
          ${guildId},
          ${customer!.id}::UUID,
          ${product!.id}::UUID,
          'capture',
          ${captureLoser},
          100,
          'USD'
        ) AS result
      `;
      expect(winnerClaim!.result).toMatchObject({
        order_id: paidOrders[0]!.id,
        disposition: 'winner',
      });
      expect(loserClaim!.result).toMatchObject({
        order_id: paidOrders[1]!.id,
        disposition: 'held',
        winning_order_id: paidOrders[0]!.id,
      });
      const [outwardIntent] = await sqlA<{
        order_id: string;
        state: string;
      }[]>`
        INSERT INTO public.commerce_fulfillment_outward_intents (
          order_id,
          guild_id,
          outward_generation_id,
          intent_kind,
          state,
          attempt_token
        ) VALUES (
          ${paidOrders[0]!.id}::UUID,
          ${guildId},
          NULL,
          'purchase_completed_event',
          'sending',
          pg_catalog.gen_random_uuid()
        )
        RETURNING order_id, state
      `;
      expect(outwardIntent).toMatchObject({
        order_id: paidOrders[0]!.id,
        state: 'sending',
      });
      const [checkoutProofProduct] = await sqlA<{ id: string }[]>`
        INSERT INTO public.products (
          guild_id,
          name,
          type,
          delivery_type,
          price_cents,
          currency,
          active,
          granted_role_ids,
          granted_channel_ids
        ) VALUES (
          ${guildId},
          ${nextName('purge-proof-product')},
          'one_time',
          'access_pass',
          100,
          'USD',
          true,
          ARRAY[]::TEXT[],
          ARRAY[]::TEXT[]
        )
        RETURNING id
      `;
      const checkoutProofProviderId = nextName('purge-proof-provider');
      const [proofOrder] = await sqlA<{ id: string }[]>`
        INSERT INTO public.orders (
          order_number,
          customer_id,
          guild_id,
          product_id,
          paypal_order_id,
          amount_cents,
          currency,
          source,
          status,
          checkout_active
        ) VALUES (
          ${nextName('purge-proof-order')},
          ${customer!.id}::UUID,
          ${guildId},
          ${checkoutProofProduct!.id}::UUID,
          ${checkoutProofProviderId},
          100,
          'USD',
          'purchase',
          'pending',
          true
        )
        RETURNING id
      `;
      const [deactivatedCheckout] = await sqlA<{ result: Record<string, unknown> }[]>`
        SELECT public.commerce_deactivate_pending_checkout(
          ${proofOrder!.id}::UUID,
          ${guildId},
          ${customer!.id}::UUID,
          ${checkoutProofProduct!.id}::UUID,
          'capture',
          ${checkoutProofProviderId},
          'provider_cancelled',
          ${nextName('purge-proof-reference')}
        ) AS result
      `;
      expect(deactivatedCheckout!.result).toMatchObject({
        order_id: proofOrder!.id,
        disposition: 'deactivated',
        checkout_active: false,
      });
      const payableCheckoutProviderId = nextName('purge-payable-provider');
      const [payableCheckout] = await sqlA<{ id: string }[]>`
        INSERT INTO public.orders (
          order_number,
          customer_id,
          guild_id,
          product_id,
          paypal_order_id,
          amount_cents,
          currency,
          source,
          status,
          checkout_active
        ) VALUES (
          ${nextName('purge-payable-order')},
          ${customer!.id}::UUID,
          ${guildId},
          ${checkoutProofProduct!.id}::UUID,
          ${payableCheckoutProviderId},
          100,
          'USD',
          'purchase',
          'pending',
          true
        )
        RETURNING id
      `;
      const { data: entitlement, error: entitlementError } = await supa
        .from('entitlements')
        .insert({
          customer_id: customer!.id,
          guild_id: guildId,
          product_id: product!.id,
          order_id: null,
          type: 'subscription',
          plan_id: null,
          status: 'active',
          source: 'automation',
          granted_role_ids: [roleId],
          granted_channel_ids: [],
        })
        .select('id')
        .single();
      expect(entitlementError).toBeNull();
      expect((await supa.from('customers')
        .update({ discord_id: relinkedDiscordId })
        .eq('id', customer!.id)).error).toBeNull();
      const { data: relinkCarrier, error: relinkCarrierError } = await supa
        .from('bot_action_queue')
        .select('id')
        .contains('payload', {
          source: 'noncommerce_entitlement_customer_relink_trigger',
          entitlement_id: entitlement!.id,
        })
        .single();
      expect(relinkCarrierError).toBeNull();
      const relinkClaim = await claimAction(relinkCarrier!.id as string);
      expect((await supa.rpc('bot_action_queue_finish_claim', {
        p_action_id: relinkCarrier!.id,
        p_claim_token: relinkClaim.claim_token,
        p_success: false,
        p_result: null,
        p_error: 'guild purge relink fixture failure',
      })).error).toBeNull();
      const { data: relinkDlq, error: relinkDlqError } = await supa
        .from('action_queue_dlq')
        .select('id')
        .eq('original_id', relinkCarrier!.id)
        .eq('retried', false)
        .single();
      expect(relinkDlqError).toBeNull();

      const pending = await supa.rpc('purge_guild_data', {
        p_guild_id: guildId,
      });
      expect(pending.error).toBeNull();
      expect(pending.data).toMatchObject({
        purge_status: 'pending_role_cleanup',
        guild_deleted: 0,
      });
      const pendingPaidRows = await sqlA<{
        order_status: string;
        payment_status: string;
      }[]>`
        SELECT paid_order.status AS order_status,
               payment.status AS payment_status
          FROM public.orders AS paid_order
          JOIN public.payments AS payment
            ON payment.order_id = paid_order.id
         WHERE paid_order.id = ANY(${paidOrders.map((order) => order.id)}::UUID[])
         ORDER BY paid_order.id
      `;
      expect(pendingPaidRows).toEqual([
        { order_status: 'completed', payment_status: 'completed' },
        { order_status: 'completed', payment_status: 'completed' },
      ]);
      const [retiredPendingCheckout] = await sqlA<{
        status: string;
        checkout_active: boolean;
      }[]>`
        SELECT status, checkout_active
          FROM public.orders
         WHERE id = ${proofOrder!.id}::UUID
      `;
      expect(retiredPendingCheckout).toEqual({
        status: 'cancelled',
        checkout_active: false,
      });
      const [preservedPayableCheckout] = await sqlA<{
        status: string;
        checkout_active: boolean;
        paypal_order_id: string;
      }[]>`
        SELECT status, checkout_active, paypal_order_id
          FROM public.orders
         WHERE id = ${payableCheckout!.id}::UUID
      `;
      expect(preservedPayableCheckout).toEqual({
        status: 'pending',
        checkout_active: true,
        paypal_order_id: payableCheckoutProviderId,
      });
      await expect(sqlA`
        INSERT INTO public.orders (
          order_number,
          customer_id,
          guild_id,
          product_id,
          paypal_order_id,
          amount_cents,
          currency,
          source,
          status,
          checkout_active
        ) VALUES (
          ${nextName('purge-second-checkout')},
          ${customer!.id}::UUID,
          ${guildId},
          ${checkoutProofProduct!.id}::UUID,
          ${nextName('purge-second-provider')},
          100,
          'USD',
          'purchase',
          'pending',
          true
        )
      `).rejects.toMatchObject({
        code: '23505',
        message: expect.stringContaining('commerce_checkout_blocked: provider_checkout'),
      });
      const retried = await supa.rpc('bot_action_queue_retry_dlq', {
        p_dlq_id: relinkDlq!.id,
        p_guild_id: guildId,
      });
      expect(retried.error).toBeNull();
      expect(onlyRow<RetryResult>(retried.data, 'guild relink retry')).toMatchObject({
        action_id: relinkCarrier!.id,
        disposition: 'reopened',
      });

      const { data: unresolved, error: unresolvedError } = await supa
        .from('bot_action_queue')
        .select('id,status,payload')
        .eq('guild_id', guildId)
        .neq('status', 'completed');
      expect(unresolvedError).toBeNull();
      const unresolvedSources = new Set((unresolved ?? []).map((row) =>
        (row.payload as Record<string, unknown>).source));
      expect(unresolvedSources).toEqual(new Set([
        'noncommerce_entitlement_activation_trigger',
        'noncommerce_entitlement_customer_relink_trigger',
        'noncommerce_entitlement_status_trigger',
      ]));
      for (const action of unresolved ?? []) {
        await completeLegacyNoncommerceAction(action.id as string);
      }

      // Owner decision (2026-07-18): audit rows are NEVER deleted. A guild
      // purge must instead scrub every identity-bearing field and detach the
      // forensic skeleton from the erased guild so the guild row itself can
      // go. Seed one maximal identity-bearing row and prove that contract.
      const auditFixtureId = randomUUID();
      await sqlA`
        INSERT INTO public.audit_logs (
          id, guild_id, actor_type, actor_id, action, category,
          target_type, target_id, details, before_state, after_state,
          correlation_id, success, error_message
        ) VALUES (
          ${auditFixtureId}, ${guildId}, 'system', ${originalDiscordId},
          'entitlement.revoked', 'commerce', 'entitlement',
          ${entitlement!.id},
          ${JSON.stringify({ productId: product!.id, roleIds: [roleId] })}::JSONB,
          ${JSON.stringify({ entitled: true })}::JSONB,
          ${JSON.stringify({ entitled: false })}::JSONB,
          ${`commerce-entitlement-transition:${auditFixtureId}`},
          true, 'identity-bearing failure text'
        )
      `;

      const completed = await supa.rpc('purge_guild_data', {
        p_guild_id: guildId,
      });
      expect(completed.error).toBeNull();
      expect(completed.data).toMatchObject({
        purge_status: 'completed',
        pending_role_cleanup_count: 0,
        guild_deleted: 1,
      });
      guildDeleted = true;

      const [paidRailResidue] = await sqlA<{
        hold_count: number;
        claim_count: number;
        outward_intent_count: number;
        checkout_proof_count: number;
        order_count: number;
        guild_count: number;
      }[]>`
        SELECT
          (
            SELECT pg_catalog.count(*)::INTEGER
            FROM public.commerce_fulfillment_holds
            WHERE guild_id = ${guildId}
          ) AS hold_count,
          (
            SELECT pg_catalog.count(*)::INTEGER
            FROM public.commerce_fulfillment_claims
            WHERE guild_id = ${guildId}
          ) AS claim_count,
          (
            SELECT pg_catalog.count(*)::INTEGER
            FROM public.commerce_fulfillment_outward_intents
            WHERE guild_id = ${guildId}
          ) AS outward_intent_count,
          (
            SELECT pg_catalog.count(*)::INTEGER
            FROM public.commerce_checkout_deactivation_proofs
            WHERE guild_id = ${guildId}
          ) AS checkout_proof_count,
          (
            SELECT pg_catalog.count(*)::INTEGER
            FROM public.orders
            WHERE guild_id = ${guildId}
          ) AS order_count,
          (
            SELECT pg_catalog.count(*)::INTEGER
            FROM public.guild
            WHERE id = ${guildId}
          ) AS guild_count
      `;
      expect(paidRailResidue).toEqual({
        hold_count: 0,
        claim_count: 0,
        outward_intent_count: 0,
        checkout_proof_count: 0,
        order_count: 0,
        guild_count: 0,
      });

      // The row persists forever, scrubbed: action/actor type/outcome remain
      // for forensics; every identity-bearing field is anonymized and the
      // guild binding is detached (which is exactly what allowed the guild
      // row deletion asserted above to succeed past the audit FK).
      const { data: anonymized, error: anonymizedError } = await supa
        .from('audit_logs')
        .select(
          'guild_id,actor_type,actor_id,action,target_id,details,'
          + 'before_state,after_state,error_message,correlation_id,success',
        )
        .eq('id', auditFixtureId)
        .single();
      expect(anonymizedError).toBeNull();
      expect(anonymized).toEqual({
        guild_id: null,
        actor_type: 'system',
        actor_id: 'anonymized',
        action: 'entitlement.revoked',
        target_id: 'anonymized',
        details: { anonymized: true },
        before_state: null,
        after_state: null,
        error_message: null,
        correlation_id: null,
        success: true,
      });
      const { count: retainedGuildAudit, error: retainedGuildAuditError } = await supa
        .from('audit_logs')
        .select('id', { count: 'exact', head: true })
        .eq('guild_id', guildId);
      expect(retainedGuildAuditError).toBeNull();
      expect(retainedGuildAudit).toBe(0);
    } finally {
      if (!guildDeleted) {
        await sqlA`
          UPDATE public.bot_action_queue
             SET status = 'completed',
                 started_at = NULL,
                 completed_at = COALESCE(
                   completed_at,
                   pg_catalog.clock_timestamp()
                 )
           WHERE guild_id = ${guildId}
             AND status <> 'completed'
        `;
        await sqlA`
          UPDATE public.action_queue_dlq
             SET retried = true,
                 retried_at = COALESCE(
                   retried_at,
                   pg_catalog.clock_timestamp()
                 )
           WHERE guild_id = ${guildId}
        `;
        // Activation heads and intents hold FKs into bot_action_queue; they
        // must be removed first or this cleanup masks the real test failure
        // with a foreign-key violation (mirrors cleanFixtures ordering).
        await sqlA`
          DELETE FROM public.commerce_noncommerce_activation_heads
           WHERE guild_id = ${guildId}
        `;
        await sqlA`
          DELETE FROM public.commerce_role_delivery_intents
           WHERE guild_id = ${guildId}
        `;
        await sqlA`DELETE FROM public.alerts WHERE guild_id = ${guildId}`;
        await sqlA`DELETE FROM public.action_queue_dlq WHERE guild_id = ${guildId}`;
        await sqlA`DELETE FROM public.bot_action_queue WHERE guild_id = ${guildId}`;
        await sqlA`
          DELETE FROM public.commerce_fulfillment_holds
           WHERE guild_id = ${guildId}
        `;
        await sqlA`
          DELETE FROM public.commerce_fulfillment_claims
           WHERE guild_id = ${guildId}
        `;
        await sqlA`
          DELETE FROM public.commerce_fulfillment_outward_intents
           WHERE guild_id = ${guildId}
        `;
        await sqlA`
          DELETE FROM public.commerce_checkout_deactivation_proofs
           WHERE guild_id = ${guildId}
        `;
        await sqlA`DELETE FROM public.entitlements WHERE guild_id = ${guildId}`;
        await sqlA`DELETE FROM public.payments WHERE guild_id = ${guildId}`;
        await sqlA`DELETE FROM public.orders WHERE guild_id = ${guildId}`;
        await sqlA`DELETE FROM public.customers WHERE guild_id = ${guildId}`;
        await sqlA`DELETE FROM public.products WHERE guild_id = ${guildId}`;
        // Immutable audit_logs rows may pin the guild via FK when an audited
        // RPC ran before the failure; guildId is run-unique, so retaining the
        // row is rerun-safe and must not mask the original test failure.
        await sqlA`DELETE FROM public.guild WHERE id = ${guildId}`
          .catch(() => undefined);
      }
    }
  });

  it('no-ops empty snapshots and rejects malformed or forged cleanup authority', async () => {
    const fixture = await createPaidFixture();
    const { data: empty, error: emptyError } = await supa
      .from('entitlements')
      .insert({
        customer_id: fixture.customerId,
        guild_id: GUILD_ID,
        product_id: fixture.productId,
        order_id: null,
        type: 'one_time',
        status: 'active',
        source: 'automation',
        granted_role_ids: [],
        granted_channel_ids: [],
      })
      .select('id')
      .single();
    expect(emptyError).toBeNull();
    const emptyTerminal = await supa
      .from('entitlements')
      .update({ status: 'expired' })
      .eq('id', empty!.id);
    expect(emptyTerminal.error).toBeNull();
    const [emptyBackfill] = await sqlA<{ action_id: string | null }[]>`
      SELECT public.commerce_enqueue_noncommerce_terminal_entitlement(
        ${empty!.id}::UUID,
        'expired'
      ) AS action_id
    `;
    expect(emptyBackfill?.action_id).toBeNull();
    const { count: emptyCarrierCount, error: emptyCarrierError } = await supa
      .from('bot_action_queue')
      .select('id', { count: 'exact', head: true })
      .contains('payload', { entitlement_id: empty!.id });
    expect(emptyCarrierError).toBeNull();
    expect(emptyCarrierCount).toBe(0);

    const { data: legacyNull, error: legacyNullError } = await supa
      .from('entitlements')
      .insert({
        customer_id: fixture.customerId,
        guild_id: GUILD_ID,
        product_id: fixture.productId,
        order_id: null,
        type: 'one_time',
        status: 'active',
        source: 'manual',
        granted_role_ids: null,
        granted_channel_ids: [],
      })
      .select('id')
      .single();
    expect(legacyNullError).toBeNull();
    const legacyNullTerminal = await supa
      .from('entitlements')
      .update({ status: 'cancelled' })
      .eq('id', legacyNull!.id);
    expect(legacyNullTerminal.error).toBeNull();
    const [legacyNullBackfill] = await sqlA<{ action_id: string | null }[]>`
      SELECT public.commerce_enqueue_noncommerce_terminal_entitlement(
        ${legacyNull!.id}::UUID,
        'cancelled'
      ) AS action_id
    `;
    expect(legacyNullBackfill?.action_id).toBeNull();

    // The shipped activation guard fail-closes malformed role snapshots at
    // write time, so a poisoned authority vector can never exist durably;
    // there is no later terminalization to reject because the row is refused.
    const { data: malformed, error: malformedError } = await supa
      .from('entitlements')
      .insert({
        customer_id: fixture.customerId,
        guild_id: GUILD_ID,
        product_id: fixture.productId,
        order_id: null,
        type: 'one_time',
        status: 'active',
        source: 'automation',
        granted_role_ids: ['malformed-role'],
        granted_channel_ids: [],
      })
      .select('id')
      .single();
    expect(malformed).toBeNull();
    expect(malformedError).toMatchObject({ code: '23514' });
    const { count: malformedCount, error: malformedCountError } = await supa
      .from('entitlements')
      .select('id', { count: 'exact', head: true })
      .eq('guild_id', GUILD_ID)
      .contains('granted_role_ids', ['malformed-role']);
    expect(malformedCountError).toBeNull();
    expect(malformedCount).toBe(0);

    const stableSourceRole = nextSnowflake();
    const { data: sourceTarget, error: sourceTargetError } = await supa
      .from('entitlements')
      .insert({
        customer_id: fixture.customerId,
        guild_id: GUILD_ID,
        product_id: fixture.productId,
        order_id: null,
        type: 'one_time',
        status: 'active',
        source: 'manual',
        granted_role_ids: [stableSourceRole],
        granted_channel_ids: [],
      })
      .select('id')
      .single();
    expect(sourceTargetError).toBeNull();
    const nullableSourceTransition = await supa
      .from('entitlements')
      .update({ status: 'expired', source: null })
      .eq('id', sourceTarget!.id);
    expect(nullableSourceTransition.error).toMatchObject({ code: '23514' });
    const terminalVectorMutation = await supa
      .from('entitlements')
      .update({ status: 'expired', granted_role_ids: [nextSnowflake()] })
      .eq('id', sourceTarget!.id);
    expect(terminalVectorMutation.error).toMatchObject({ code: '23514' });
    const { data: preservedSourceTarget, error: preservedSourceTargetError } = await supa
      .from('entitlements')
      .select('status,source,granted_role_ids')
      .eq('id', sourceTarget!.id)
      .single();
    expect(preservedSourceTargetError).toBeNull();
    expect(preservedSourceTarget).toEqual({
      status: 'active',
      source: 'manual',
      granted_role_ids: [stableSourceRole],
    });

    const roleId = nextSnowflake();
    const { data: poisonTarget, error: poisonTargetError } = await supa
      .from('entitlements')
      .insert({
        customer_id: fixture.customerId,
        guild_id: GUILD_ID,
        product_id: fixture.productId,
        order_id: null,
        type: 'one_time',
        status: 'active',
        source: 'giveaway',
        granted_role_ids: [roleId],
        granted_channel_ids: [],
      })
      .select('id')
      .single();
    expect(poisonTargetError).toBeNull();
    const forgedPayload = {
      source: 'noncommerce_entitlement_status_trigger',
      guild_id: GUILD_ID,
      discord_id: fixture.discordId,
      entitlement_id: poisonTarget!.id,
      customer_id: fixture.customerId,
      order_id: null,
      product_id: fixture.productId,
      entitlement_source: 'giveaway',
      entitlement_status: 'cancelled',
      entitlement_type: 'one_time',
      plan_id: null,
      role_ids: [roleId],
      temporary_role_grant_ids: [],
      reason: 'entitlement_cancelled',
    };
    const forgedKey = `noncommerce:terminal-entitlement:${poisonTarget!.id}:${fixture.discordId}:cancelled:${await jsonbFingerprint(forgedPayload)}:v1`;
    const poisonInsert = await supa.from('bot_action_queue').insert({
      guild_id: GUILD_ID,
      action: 'revoke_roles',
      payload: forgedPayload,
      status: 'pending',
      lane: 'commerce',
      idempotency_key: forgedKey,
    });
    expect(poisonInsert.error).toMatchObject({ code: '42501' });
    const nullTerminalPayload = {
      ...forgedPayload,
      entitlement_status: null,
    };
    const nullTerminalKey = `noncommerce:terminal-entitlement:${poisonTarget!.id}:${fixture.discordId}::${await jsonbFingerprint(nullTerminalPayload)}:v1`;
    const [nullTerminal] = await sqlA<{ carrier_kind: string | null }[]>`
      SELECT public.commerce_noncommerce_cleanup_carrier_kind(
        ${GUILD_ID},
        'revoke_roles',
        'commerce',
        ${nullTerminalKey},
        ${JSON.stringify(nullTerminalPayload)}::JSONB
      ) AS carrier_kind
    `;
    expect(nullTerminal?.carrier_kind).toBeNull();

    const protectedTerminal = await supa
      .from('entitlements')
      .update({ status: 'cancelled' })
      .eq('id', poisonTarget!.id);
    expect(protectedTerminal.error).toBeNull();
    // Locate the trigger-minted carrier by durable identity first so any
    // snapshot divergence surfaces as a field-level payload diff instead of
    // an opaque zero-row key lookup, then hold the determinism contract:
    // the canonical payload is exactly reconstructible and the idempotency
    // key is exactly the key the rejected byte-perfect forgery tried to mint.
    const { data: protectedCarrier, error: protectedCarrierError } = await supa
      .from('bot_action_queue')
      .select('id,idempotency_key,payload')
      .contains('payload', {
        source: 'noncommerce_entitlement_status_trigger',
        entitlement_id: poisonTarget!.id,
        entitlement_status: 'cancelled',
      })
      .single();
    expect(protectedCarrierError).toBeNull();
    expect(protectedCarrier?.id).toBeTruthy();
    expect(protectedCarrier?.payload).toEqual(forgedPayload);
    // Compare CANONICAL JSONB TEXTS, not object equality: toEqual coerces
    // value forms (e.g. numeric 1 vs 1.0, null vs absent) that change the
    // jsonb text and therefore the md5 in the key. Any divergence must show
    // as a byte-level diff of the two canonical texts.
    const [texts] = await sqlA<{ stored: string; forged: string }[]>`
      SELECT queue.payload::TEXT AS stored,
             (${JSON.stringify(forgedPayload)}::TEXT)::JSONB::TEXT AS forged
        FROM public.bot_action_queue AS queue
       WHERE queue.id = ${protectedCarrier!.id}
    `;
    expect(texts!.forged).toBe(texts!.stored);
    expect(protectedCarrier?.idempotency_key).toBe(forgedKey);
    const { data: unchanged, error: unchangedError } = await supa
      .from('entitlements')
      .select('status')
      .eq('id', sourceTarget!.id)
      .single();
    expect(unchangedError).toBeNull();
    expect(unchanged?.status).toBe('active');
  });
});

describe('temporary owner classification and atomic retirement', () => {
  it('classifies operator-held live authority as pending, never fabricates confirmed ownership from desired metadata, and ignores terminal cleanup peers', async () => {
    const sharedRole = nextSnowflake();
    const first = await createPaidFixture({ permanentRoleId: sharedRole });
    const firstAction = await insertCarrier(first);
    const firstDelivery = await startDelivery(first, firstAction);
    await reservePermanent(first, firstDelivery);
    expect(await finishRetry(firstDelivery, 'ambiguous provisional permanent role')).toBe(
      'operator_held',
    );
    expect(await classifyRoleOwner(first, sharedRole, [])).toBe('pending');

    const second = await createPaidFixture({
      permanentRoleId: sharedRole,
      customer: { id: first.customerId, discordId: first.discordId },
    });
    const secondAction = await insertCarrier(second);
    const secondDelivery = await startDelivery(second, secondAction);
    await reservePermanent(second, secondDelivery);
    expect(await finishRetry(secondDelivery, 'second ambiguous provisional role')).toBe(
      'operator_held',
    );
    expect(await classifyRoleOwner(first, sharedRole, [])).toBe('pending');

    const { data: manual, error: manualError } = await supa
      .from('entitlements')
      .insert({
        customer_id: first.customerId,
        guild_id: GUILD_ID,
        product_id: first.productId,
        order_id: null,
        type: 'one_time',
        status: 'active',
        source: 'manual',
        granted_role_ids: [sharedRole],
        granted_channel_ids: [],
      })
      .select('id')
      .single();
    expect(manualError).toBeNull();
    // A desired manual entitlement is metadata, not delivery proof: the
    // classifier never fabricates confirmed ownership from it, so the two
    // reserved provisional intents keep the role at exactly 'pending'.
    expect(await classifyRoleOwner(first, sharedRole, [])).toBe('pending');

    const manualTerminal = await supa
      .from('entitlements')
      .update({ status: 'expired' })
      .eq('id', manual!.id);
    expect(manualTerminal.error).toBeNull();
    expect(await classifyRoleOwner(first, sharedRole, [])).toBe('pending');

    const firstTerminal = await supa
      .from('entitlements')
      .update({ status: 'expired' })
      .eq('id', first.entitlementId);
    expect(firstTerminal.error).toBeNull();
    const secondTerminal = await supa
      .from('entitlements')
      .update({ status: 'cancelled' })
      .eq('id', second.entitlementId);
    expect(secondTerminal.error).toBeNull();
    expect(await classifyRoleOwner(first, sharedRole, [])).toBe('none');
  });

  it('keeps same-intent permanent ownership confirmed when the exact temp grant is excluded', async () => {
    const sharedRole = nextSnowflake();
    const fixture = await createPaidFixture({
      permanentRoleId: sharedRole,
      tempRoleId: sharedRole,
    });
    const actionId = await insertCarrier(fixture);
    const delivery = await startDelivery(fixture, actionId);
    await promotePermanent(fixture, delivery);
    // This deliberately models the DB truth-table cell directly: the same
    // Discord role can be represented by permanent and temporary provenance.
    await reserveTemp(fixture, delivery, false);
    await confirmTemp(fixture, delivery);
    expect(await finishLive(delivery)).toBe('confirmed_open');

    expect(await classifyRoleOwner(fixture, sharedRole, [fixture.tempGrantId!]))
      .toBe('confirmed');
  });

  it('ignores two expired intent owners, classifies a successor pending then confirmed, and retires atomically', async () => {
    const sharedRole = nextSnowflake();
    const current = await createPaidFixture({
      tempRoleId: sharedRole,
      tempDurationSeconds: 1,
    });
    const currentAction = await insertCarrier(current);
    const currentDelivery = await startDelivery(current, currentAction);
    await reserveTemp(current, currentDelivery);
    await confirmTemp(current, currentDelivery);
    expect(await finishLive(currentDelivery)).toBe('confirmed_open');

    const otherExpired = await createPaidFixture({
      tempRoleId: sharedRole,
      tempDurationSeconds: 1,
      customer: { id: current.customerId, discordId: current.discordId },
    });
    const otherExpiredAction = await insertCarrier(otherExpired);
    const otherExpiredDelivery = await startDelivery(otherExpired, otherExpiredAction);
    await reserveTemp(otherExpired, otherExpiredDelivery, false);
    await confirmTemp(otherExpired, otherExpiredDelivery);
    expect(await finishLive(otherExpiredDelivery)).toBe('confirmed_open');

    const { data: expiredGrants, error: expiredGrantError } = await supa
      .from('temp_role_grants')
      .select('id,expires_at')
      .in('id', [current.tempGrantId!, otherExpired.tempGrantId!]);
    expect(expiredGrantError).toBeNull();
    expect(expiredGrants).toHaveLength(2);
    for (const grant of expiredGrants!) {
      await waitUntilDatabasePast(grant.expires_at);
    }
    expect(await classifyRoleOwner(current, sharedRole, [])).toBe('none');

    const successor = await createPaidFixture({
      tempRoleId: sharedRole,
      tempDurationSeconds: 60,
      customer: { id: current.customerId, discordId: current.discordId },
    });
    const successorAction = await insertCarrier(successor);
    const successorDelivery = await startDelivery(successor, successorAction);
    await reserveTemp(successor, successorDelivery, false);
    expect(await classifyRoleOwner(current, sharedRole, [])).toBe('pending');

    await confirmTemp(successor, successorDelivery);
    expect(await finishLive(successorDelivery)).toBe('confirmed_open');
    expect(await classifyRoleOwner(current, sharedRole, [])).toBe('confirmed');

    const directRetirement = await supa
      .from('temp_role_grants')
      .update({ grant_status: 'removed', source: 'commerce_reconciled' })
      .eq('id', current.tempGrantId!);
    expect(directRetirement.error).not.toBeNull();

    const { data: currentGrant, error: currentGrantError } = await supa
      .from('temp_role_grants')
      .select('grant_status,expires_at,remove_on_expiry')
      .eq('id', current.tempGrantId!)
      .single();
    expect(currentGrantError).toBeNull();

    const retired = await supa.rpc('commerce_retire_temp_role_grant', {
      p_grant_id: current.tempGrantId,
      p_expected_grant_status: 'applied',
      p_expected_expires_at: currentGrant!.expires_at,
      p_expected_remove_on_expiry: true,
    });
    expect(retired.error).toBeNull();
    expect(retired.data).toMatchObject({
      id: current.tempGrantId,
      retired: true,
      grant_status: 'removed',
      source: 'commerce_reconciled',
      intent_id: currentDelivery.intentId,
      intent_state: 'settled',
      disposition: 'retired',
    });
    const { data: detachedIntent, error: detachedError } = await supa
      .from('commerce_role_delivery_intents')
      .select('state,temporary_role_grant_ids,reserved_temp_role_grant_ids')
      .eq('id', currentDelivery.intentId)
      .single();
    expect(detachedError).toBeNull();
    expect(detachedIntent).toEqual({
      state: 'settled',
      temporary_role_grant_ids: [],
      reserved_temp_role_grant_ids: [],
    });

    const replay = await supa.rpc('commerce_retire_temp_role_grant', {
      p_grant_id: current.tempGrantId,
      p_expected_grant_status: 'applied',
      p_expected_expires_at: currentGrant!.expires_at,
      p_expected_remove_on_expiry: true,
    });
    expect(replay.error).toBeNull();
    expect(replay.data).toMatchObject({
      id: current.tempGrantId,
      retired: true,
      disposition: 'already_retired',
      intent_id: null,
    });
    expect(await classifyRoleOwner(current, sharedRole, [])).toBe('confirmed');
  });

  it('retires exact temporary authority atomically through cleanup finalization', async () => {
    const roleId = nextSnowflake();
    const fixture = await createPaidFixture({
      tempRoleId: roleId,
      tempDurationSeconds: 60,
    });
    const actionId = await insertCarrier(fixture);
    const delivery = await startDelivery(fixture, actionId);
    await reserveTemp(fixture, delivery);
    await confirmTemp(fixture, delivery);
    expect(await finishLive(delivery)).toBe('confirmed_open');

    const terminal = await supa
      .from('entitlements')
      .update({ status: 'expired' })
      .eq('id', fixture.entitlementId);
    expect(terminal.error).toBeNull();

    const { data: cleanupAction, error: cleanupActionError } = await supa
      .from('bot_action_queue')
      .select('id,status')
      .eq('idempotency_key', `commerce-role-delivery-cleanup:${delivery.intentId}`)
      .single();
    expect(cleanupActionError).toBeNull();
    expect(cleanupAction?.status).toBe('pending');
    const cleanupClaim = await claimAction(cleanupAction!.id as string);
    const begun = await supa.rpc('commerce_begin_role_delivery_cleanup', {
      p_intent_id: delivery.intentId,
      p_cleanup_action_id: cleanupAction!.id,
      p_cleanup_claim_token: cleanupClaim.claim_token,
    });
    expect(begun.error).toBeNull();
    const cleanupMutation = onlyRow<{ cleanup_mutation_token: string }>(
      begun.data,
      'cleanup begin',
    ).cleanup_mutation_token;

    const finished = await supa.rpc('commerce_finish_role_delivery_cleanup', {
      p_intent_id: delivery.intentId,
      p_cleanup_action_id: cleanupAction!.id,
      p_cleanup_claim_token: cleanupClaim.claim_token,
      p_cleanup_mutation_token: cleanupMutation,
      p_outcome: 'cleaned',
      p_error: null,
      p_removed_role_ids: [roleId],
      p_absent_role_ids: [],
      p_retained_role_ids: [],
    });
    expect(finished.error).toBeNull();
    expect(onlyRow<{ intent_state: string; settled: boolean }>(
      finished.data,
      'cleanup finish',
    )).toMatchObject({ intent_state: 'settled', settled: true });

    const { data: durable, error: durableError } = await supa
      .from('temp_role_grants')
      .select('grant_status,source,remove_on_expiry')
      .eq('id', fixture.tempGrantId!)
      .single();
    expect(durableError).toBeNull();
    expect(durable).toEqual({
      grant_status: 'removed',
      source: 'commerce_reconciled',
      remove_on_expiry: true,
    });
  });

  it('fails closed when one grant is corruptly cross-bound to multiple intents', async () => {
    const fixture = await createPaidFixture({ tempRoleId: nextSnowflake() });
    const firstAction = await insertCarrier(fixture);
    const firstDelivery = await startDelivery(fixture, firstAction);

    const other = await createPaidFixture();
    const otherAction = await insertCarrier(other);
    const otherDelivery = await startDelivery(other, otherAction);
    // Owner-only corruption models a damaged pre-existing database. The
    // retirement RPC must refuse to guess which intent owns the grant.
    await sqlA`
      UPDATE public.commerce_role_delivery_intents
         SET reserved_temp_role_grant_ids = ARRAY[${fixture.tempGrantId!}::UUID],
             updated_at = pg_catalog.clock_timestamp()
       WHERE id IN (${firstDelivery.intentId}::UUID, ${otherDelivery.intentId}::UUID)
    `;
    const { data: grant, error: grantError } = await supa
      .from('temp_role_grants')
      .select('grant_status,expires_at,remove_on_expiry')
      .eq('id', fixture.tempGrantId!)
      .single();
    expect(grantError).toBeNull();

    const retirement = await supa.rpc('commerce_retire_temp_role_grant', {
      p_grant_id: fixture.tempGrantId,
      p_expected_grant_status: grant!.grant_status,
      p_expected_expires_at: grant!.expires_at,
      p_expected_remove_on_expiry: grant!.remove_on_expiry,
    });
    expect(retirement.error).toMatchObject({ code: '23514' });
    expect(retirement.error?.message).toContain('bound to multiple intents');
    const { data: unchanged } = await supa
      .from('temp_role_grants')
      .select('grant_status,source')
      .eq('id', fixture.tempGrantId!)
      .single();
    expect(unchanged).toEqual({
      grant_status: 'pending',
      source: 'commerce_purchase',
    });
  });
});
