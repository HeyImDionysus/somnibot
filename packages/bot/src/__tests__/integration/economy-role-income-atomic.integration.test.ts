/**
 * Integration coverage for economy_collect_role_income.
 *
 * These tests use the real local Supabase stack.  They prove the properties
 * mocks cannot: transaction rollback, advisory-lock serialization, durable
 * request replay, guild isolation, and service-role-only access.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import postgres from 'postgres';
import {
  getAnonTestClient,
  getAuthenticatedTestClient,
  getTestDbUrl,
  requireSupabase,
} from './helpers.js';

let supa!: SupabaseClient;
let sql!: ReturnType<typeof postgres>;

const GUILD_ID = `test-role-income-${Date.now()}`;
const OTHER_GUILD_ID = `${GUILD_ID}-other`;
const USER_PREFIX = `role-income-user-${Date.now()}`;

const ROLE_REPLAY = 'role-income-replay';
const ROLE_CONCURRENT = 'role-income-concurrent';
const ROLE_PAID = 'role-income-paid';
const ROLE_MANUAL = 'role-income-manual';
const ROLE_TEMP = 'role-income-temp';
const ROLE_REVOKE = 'role-income-revoke';
const ROLE_OTHER_GUILD = 'role-income-other-guild';
const ROLE_ROLLBACK = 'role-income-rollback';
const ROLE_TRIGGER = 'role-income-trigger';
const ROLE_STALE_QUEUE = 'role-income-stale-queue';
const ROLE_PURGE = 'role-income-purge';

let inactiveProductId: string;
let paidCustomerId: string;
let manualCustomerId: string;
let paidOrderId: string;

type CollectionResult = {
  status: 'credited' | 'cooldown' | 'no_eligible_roles' | 'verification_unavailable';
  amount_cents: number;
  balance_cents: number | null;
  credited_role_ids: string[];
  blocked_role_ids: string[];
  next_available_at: string | null;
};

async function collect(
  guildId: string,
  userId: string,
  roleIds: string[],
  requestId: string,
): Promise<{ data: CollectionResult | null; error: { message: string } | null }> {
  return supa.rpc('economy_collect_role_income', {
    p_guild_id: guildId,
    p_user_id: userId,
    p_discord_role_ids: roleIds,
    p_request_id: requestId,
  }) as unknown as Promise<{
    data: CollectionResult | null;
    error: { message: string } | null;
  }>;
}

async function createPaidEntitlementFixture(
  roleId: string,
  userId: string,
  label: string,
): Promise<{ customerId: string; orderId: string; entitlementId: string }> {
  const { data: customer, error: customerError } = await supa
    .from('customers')
    .insert({
      guild_id: GUILD_ID,
      discord_id: userId,
      discord_username: `${label}-customer`,
    })
    .select('id')
    .single();
  if (customerError) throw new Error(customerError.message);

  const { data: order, error: orderError } = await supa
    .from('orders')
    .insert({
      order_number: `${label}-order-${Date.now()}`,
      customer_id: customer!.id,
      guild_id: GUILD_ID,
      product_id: inactiveProductId,
      amount_cents: 500,
      currency: 'USD',
      source: 'purchase',
      status: 'completed',
    })
    .select('id')
    .single();
  if (orderError) throw new Error(orderError.message);

  const { data: entitlement, error: entitlementError } = await supa
    .from('entitlements')
    .insert({
      customer_id: customer!.id,
      guild_id: GUILD_ID,
      product_id: inactiveProductId,
      order_id: order!.id,
      type: 'one_time',
      status: 'active',
      source: 'purchase',
      granted_role_ids: [roleId],
      granted_channel_ids: [],
    })
    .select('id')
    .single();
  if (entitlementError) throw new Error(entitlementError.message);

  return {
    customerId: customer!.id,
    orderId: order!.id,
    entitlementId: entitlement!.id,
  };
}

beforeAll(async () => {
  supa = await requireSupabase();
  sql = postgres(getTestDbUrl(), { max: 1 });

  const { error: guildError } = await supa.from('guild').insert([
    {
      id: GUILD_ID,
      name: 'Atomic Role Income Test Guild',
      owner_discord_id: '100000000000000001',
    },
    {
      id: OTHER_GUILD_ID,
      name: 'Atomic Role Income Other Guild',
      owner_discord_id: '100000000000000002',
    },
  ]);
  if (guildError) throw new Error(`Guild seed failed: ${guildError.message}`);

  const paidUser = `${USER_PREFIX}-paid`;
  const manualUser = `${USER_PREFIX}-manual`;
  const { data: customers, error: customerError } = await supa
    .from('customers')
    .insert([
      {
        guild_id: GUILD_ID,
        discord_id: paidUser,
        discord_username: 'paid-role-test',
      },
      {
        guild_id: GUILD_ID,
        discord_id: manualUser,
        discord_username: 'manual-role-test',
      },
    ])
    .select('id, discord_id');
  if (customerError) throw new Error(`Customer seed failed: ${customerError.message}`);
  paidCustomerId = customers!.find((row) => row.discord_id === paidUser)!.id;
  manualCustomerId = customers!.find((row) => row.discord_id === manualUser)!.id;

  const { data: product, error: productError } = await supa
    .from('products')
    .insert({
      guild_id: GUILD_ID,
      name: 'Inactive Historical Product',
      description: 'Inactive so the config wall permits a historical entitlement fixture.',
      type: 'one_time',
      delivery_type: 'access_pass',
      price_cents: 500,
      currency: 'USD',
      granted_role_ids: [ROLE_PAID],
      granted_channel_ids: [],
      active: false,
    })
    .select('id')
    .single();
  if (productError) throw new Error(`Product seed failed: ${productError.message}`);
  inactiveProductId = product!.id;

  const { data: paidOrder, error: paidOrderError } = await supa
    .from('orders')
    .insert({
      order_number: `role-income-paid-${Date.now()}`,
      customer_id: paidCustomerId,
      guild_id: GUILD_ID,
      product_id: inactiveProductId,
      amount_cents: 500,
      currency: 'USD',
      source: 'purchase',
      status: 'completed',
    })
    .select('id')
    .single();
  if (paidOrderError) throw new Error(`Paid order seed failed: ${paidOrderError.message}`);
  paidOrderId = paidOrder!.id;

  const { error: entitlementError } = await supa.from('entitlements').insert([
    {
      customer_id: paidCustomerId,
      guild_id: GUILD_ID,
      product_id: inactiveProductId,
      order_id: paidOrderId,
      type: 'one_time',
      status: 'active',
      source: 'purchase',
      granted_role_ids: [ROLE_PAID],
      granted_channel_ids: [],
    },
    {
      customer_id: manualCustomerId,
      guild_id: GUILD_ID,
      product_id: inactiveProductId,
      type: 'one_time',
      status: 'active',
      source: 'manual',
      granted_role_ids: [ROLE_MANUAL],
      granted_channel_ids: [],
    },
  ]);
  if (entitlementError) throw new Error(`Entitlement seed failed: ${entitlementError.message}`);

  const { error: incomeError } = await supa.from('economy_role_income').insert([
    { guild_id: GUILD_ID, role_id: ROLE_REPLAY, amount: 25, interval_minutes: 60 },
    { guild_id: GUILD_ID, role_id: ROLE_CONCURRENT, amount: 30, interval_minutes: 60 },
    { guild_id: GUILD_ID, role_id: ROLE_PAID, amount: 35, interval_minutes: 60 },
    { guild_id: GUILD_ID, role_id: ROLE_MANUAL, amount: 40, interval_minutes: 60 },
    { guild_id: GUILD_ID, role_id: ROLE_TEMP, amount: 45, interval_minutes: 60 },
    { guild_id: GUILD_ID, role_id: ROLE_REVOKE, amount: 50, interval_minutes: 60 },
    { guild_id: GUILD_ID, role_id: ROLE_OTHER_GUILD, amount: 55, interval_minutes: 60 },
    { guild_id: GUILD_ID, role_id: ROLE_ROLLBACK, amount: 10_000_000_000_001, interval_minutes: 60 },
    { guild_id: GUILD_ID, role_id: ROLE_TRIGGER, amount: 65, interval_minutes: 60 },
    { guild_id: GUILD_ID, role_id: ROLE_STALE_QUEUE, amount: 70, interval_minutes: 60 },
    { guild_id: GUILD_ID, role_id: ROLE_PURGE, amount: 75, interval_minutes: 60 },
    { guild_id: OTHER_GUILD_ID, role_id: ROLE_OTHER_GUILD, amount: 60, interval_minutes: 60 },
  ]);
  if (incomeError) throw new Error(`Role-income seed failed: ${incomeError.message}`);
});

afterAll(async () => {
  await supa.from('audit_logs').delete().in('guild_id', [GUILD_ID, OTHER_GUILD_ID]);
  await supa.from('action_queue_dlq').delete().in('guild_id', [GUILD_ID, OTHER_GUILD_ID]);
  await supa.from('bot_action_queue').delete().in('guild_id', [GUILD_ID, OTHER_GUILD_ID]);
  await supa.from('temp_role_grants').delete().in('guild_id', [GUILD_ID, OTHER_GUILD_ID]);
  await supa.from('economy_role_income_requests').delete().in('guild_id', [GUILD_ID, OTHER_GUILD_ID]);
  await supa.from('economy_role_income_claims').delete().in('guild_id', [GUILD_ID, OTHER_GUILD_ID]);
  await supa.from('economy_transactions').delete().in('guild_id', [GUILD_ID, OTHER_GUILD_ID]);
  await supa.from('economy_wallets').delete().in('guild_id', [GUILD_ID, OTHER_GUILD_ID]);
  await supa.from('economy_role_income').delete().in('guild_id', [GUILD_ID, OTHER_GUILD_ID]);
  await supa.from('entitlements').delete().in('guild_id', [GUILD_ID, OTHER_GUILD_ID]);
  await supa.from('payments').delete().in('guild_id', [GUILD_ID, OTHER_GUILD_ID]);
  await supa.from('orders').delete().in('guild_id', [GUILD_ID, OTHER_GUILD_ID]);
  await supa.from('products').delete().in('guild_id', [GUILD_ID, OTHER_GUILD_ID]);
  await supa.from('customers').delete().in('guild_id', [GUILD_ID, OTHER_GUILD_ID]);
  await supa.from('guild').delete().in('id', [GUILD_ID, OTHER_GUILD_ID]);
  await sql?.end({ timeout: 5 });
});

describe('economy_collect_role_income', () => {
  it('replays one interaction without a second credit', async () => {
    const userId = `${USER_PREFIX}-replay`;
    const first = await collect(GUILD_ID, userId, [ROLE_REPLAY], 'interaction-replay');
    const replay = await collect(GUILD_ID, userId, [ROLE_REPLAY], 'interaction-replay');

    expect(first.error).toBeNull();
    expect(replay.error).toBeNull();
    expect(first.data).toEqual(replay.data);
    expect(first.data).toMatchObject({
      status: 'credited',
      amount_cents: 25,
      balance_cents: 25,
      credited_role_ids: [ROLE_REPLAY],
    });

    const { data: wallet } = await supa
      .from('economy_wallets')
      .select('wallet')
      .eq('guild_id', GUILD_ID)
      .eq('user_id', userId)
      .single();
    expect(wallet!.wallet).toBe(25);
  });

  it('serializes distinct concurrent interactions and credits exactly once', async () => {
    const userId = `${USER_PREFIX}-concurrent`;
    const attempts = await Promise.all([
      collect(GUILD_ID, userId, [ROLE_CONCURRENT], 'interaction-concurrent-a'),
      collect(GUILD_ID, userId, [ROLE_CONCURRENT], 'interaction-concurrent-b'),
    ]);

    expect(attempts.every((attempt) => attempt.error === null)).toBe(true);
    expect(attempts.map((attempt) => attempt.data!.status).sort()).toEqual(['cooldown', 'credited']);

    const { data: wallet } = await supa
      .from('economy_wallets')
      .select('wallet')
      .eq('guild_id', GUILD_ID)
      .eq('user_id', userId)
      .single();
    expect(wallet!.wallet).toBe(30);
  });

  it('blocks a role backed by a purchase entitlement snapshot', async () => {
    const result = await collect(
      GUILD_ID,
      `${USER_PREFIX}-paid`,
      [ROLE_PAID],
      'interaction-paid-entitlement',
    );

    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({
      status: 'no_eligible_roles',
      amount_cents: 0,
      blocked_role_ids: [ROLE_PAID],
    });
  });

  it('does not treat a non-purchase entitlement as real-money provenance', async () => {
    const result = await collect(
      GUILD_ID,
      `${USER_PREFIX}-manual`,
      [ROLE_MANUAL],
      'interaction-manual-entitlement',
    );

    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({
      status: 'credited',
      amount_cents: 40,
      blocked_role_ids: [],
    });
  });

  it('blocks durable temporary-commerce provenance even after its expiry time', async () => {
    const userId = `${USER_PREFIX}-temp`;
    const { error } = await supa.from('temp_role_grants').insert({
      guild_id: GUILD_ID,
      user_id: userId,
      role_id: ROLE_TEMP,
      expires_at: new Date(Date.now() - 60_000).toISOString(),
      source: 'commerce_purchase',
      source_id: inactiveProductId,
    });
    expect(error).toBeNull();

    const result = await collect(GUILD_ID, userId, [ROLE_TEMP], 'interaction-temp');
    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({
      status: 'no_eligible_roles',
      blocked_role_ids: [ROLE_TEMP],
    });
  });

  it('blocks preserved commerce provenance that still has the legacy economy label', async () => {
    const userId = `${USER_PREFIX}-legacy-temp`;
    const { error } = await supa.from('temp_role_grants').insert({
      guild_id: GUILD_ID,
      user_id: userId,
      role_id: ROLE_TEMP,
      expires_at: new Date(Date.now() - 60_000).toISOString(),
      source: 'economy_purchase',
      source_id: 'unresolved-legacy-commerce-product',
    });
    expect(error).toBeNull();

    const result = await collect(GUILD_ID, userId, [ROLE_TEMP], 'interaction-legacy-temp');
    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({
      status: 'no_eligible_roles',
      blocked_role_ids: [ROLE_TEMP],
    });
  });

  it('blocks an outstanding paid-role revocation', async () => {
    const userId = `${USER_PREFIX}-revoke`;
    const { error } = await supa.from('bot_action_queue').insert({
      guild_id: GUILD_ID,
      action: 'revoke_roles',
      payload: { discord_id: userId, role_ids: [ROLE_REVOKE] },
      status: 'pending',
    });
    expect(error).toBeNull();

    const result = await collect(GUILD_ID, userId, [ROLE_REVOKE], 'interaction-revoke');
    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({
      status: 'no_eligible_roles',
      blocked_role_ids: [ROLE_REVOKE],
    });
  });

  it('atomically enqueues revocation before a paid entitlement becomes terminal', async () => {
    const userId = `${USER_PREFIX}-terminal-trigger`;
    const fixture = await createPaidEntitlementFixture(
      ROLE_TRIGGER,
      userId,
      'terminal-trigger',
    );

    const terminal = await supa
      .from('entitlements')
      .update({ status: 'expired', expires_at: new Date().toISOString() })
      .eq('id', fixture.entitlementId);
    expect(terminal.error).toBeNull();

    const { data: queued, error: queueError } = await supa
      .from('bot_action_queue')
      .select('guild_id,action,status,payload')
      .eq('guild_id', GUILD_ID)
      .eq('action', 'revoke_roles')
      .eq('payload->>entitlement_id', fixture.entitlementId)
      .single();
    expect(queueError).toBeNull();
    expect(queued).toMatchObject({
      guild_id: GUILD_ID,
      action: 'revoke_roles',
      status: 'pending',
      payload: {
        guild_id: GUILD_ID,
        discord_id: userId,
        role_ids: [ROLE_TRIGGER],
        entitlement_id: fixture.entitlementId,
        customer_id: fixture.customerId,
        order_id: fixture.orderId,
        product_id: inactiveProductId,
        source: 'entitlement_status_trigger',
      },
    });

    const result = await collect(
      GUILD_ID,
      userId,
      [ROLE_TRIGGER],
      'interaction-terminal-trigger',
    );
    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({
      status: 'no_eligible_roles',
      blocked_role_ids: [ROLE_TRIGGER],
    });
  });

  it('rolls the entitlement transition back when revocation intent cannot persist', async () => {
    const userId = `${USER_PREFIX}-terminal-rollback`;
    const fixture = await createPaidEntitlementFixture(
      ROLE_TRIGGER,
      userId,
      'terminal-rollback',
    );
    const suffix = fixture.entitlementId.replaceAll('-', '').slice(0, 16);
    const functionName = `test_reject_revoke_${suffix}`;
    const triggerName = `test_reject_revoke_${suffix}`;
    const quotedEntitlementId = fixture.entitlementId.replaceAll("'", "''");

    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION public.${functionName}()
      RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = ''
      AS $body$
      BEGIN
        IF NEW.action = 'revoke_roles'
           AND NEW.payload ->> 'entitlement_id' = '${quotedEntitlementId}' THEN
          RAISE EXCEPTION 'forced test revocation queue failure';
        END IF;
        RETURN NEW;
      END;
      $body$;
    `);
    await sql.unsafe(`
      CREATE TRIGGER ${triggerName}
      BEFORE INSERT ON public.bot_action_queue
      FOR EACH ROW
      EXECUTE FUNCTION public.${functionName}()
    `);

    try {
      const failed = await supa
        .from('entitlements')
        .update({ status: 'expired' })
        .eq('id', fixture.entitlementId);
      expect(failed.error).not.toBeNull();

      const { data: entitlement } = await supa
        .from('entitlements')
        .select('status')
        .eq('id', fixture.entitlementId)
        .single();
      expect(entitlement?.status).toBe('active');
      const { count: queuedCount } = await supa
        .from('bot_action_queue')
        .select('*', { count: 'exact', head: true })
        .eq('payload->>entitlement_id', fixture.entitlementId);
      expect(queuedCount).toBe(0);
    } finally {
      await sql.unsafe(`DROP TRIGGER IF EXISTS ${triggerName} ON public.bot_action_queue`);
      await sql.unsafe(`DROP FUNCTION IF EXISTS public.${functionName}()`);
    }
  });

  it('does not keep a failed revoke as stale evidence after its DLQ retry', async () => {
    const userId = `${USER_PREFIX}-retried-revoke`;
    const { data: failedQueue, error: failedQueueError } = await supa
      .from('bot_action_queue')
      .insert({
        guild_id: GUILD_ID,
        action: 'revoke_roles',
        payload: { discord_id: userId, role_ids: [ROLE_STALE_QUEUE] },
        status: 'failed',
      })
      .select('id')
      .single();
    expect(failedQueueError).toBeNull();

    const { error: dlqError } = await supa.from('action_queue_dlq').insert({
      guild_id: GUILD_ID,
      action: 'revoke_roles',
      payload: { discord_id: userId, role_ids: [ROLE_STALE_QUEUE] },
      original_id: failedQueue!.id,
      retried: true,
      retried_at: new Date().toISOString(),
    });
    expect(dlqError).toBeNull();

    // Two legacy failure paths could preserve duplicate DLQ copies. Retrying
    // either copy retires the whole original queue attempt as blocker evidence.
    const { error: staleSiblingError } = await supa.from('action_queue_dlq').insert({
      guild_id: GUILD_ID,
      action: 'revoke_roles',
      payload: { discord_id: userId, role_ids: [ROLE_STALE_QUEUE] },
      original_id: failedQueue!.id,
      retried: false,
    });
    expect(staleSiblingError).toBeNull();

    const result = await collect(
      GUILD_ID,
      userId,
      [ROLE_STALE_QUEUE],
      'interaction-retried-revoke',
    );
    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({
      status: 'credited',
      amount_cents: 70,
      blocked_role_ids: [],
    });
  });

  it('purges the new request and cooldown ledgers through the established privacy RPC', async () => {
    const userId = `${USER_PREFIX}-purge`;
    const actorAction = `${userId}-audit-actor`;
    const targetAction = `${userId}-audit-target`;
    const unrelatedActor = `${USER_PREFIX}-unrelated-actor`;
    const unrelatedTarget = `${USER_PREFIX}-unrelated-target`;
    const { error: auditSeedError } = await supa.from('audit_logs').insert([
      {
        guild_id: GUILD_ID,
        actor_type: 'user',
        actor_id: userId,
        action: actorAction,
        target_type: 'member',
        target_id: unrelatedTarget,
        details: null,
      },
      {
        guild_id: GUILD_ID,
        actor_type: 'user',
        actor_id: unrelatedActor,
        action: targetAction,
        target_type: 'member',
        target_id: userId,
        details: { existing: 'kept' },
      },
    ]);
    expect(auditSeedError).toBeNull();

    const collected = await collect(GUILD_ID, userId, [ROLE_PURGE], 'interaction-purge');
    expect(collected.error).toBeNull();
    expect(collected.data?.status).toBe('credited');

    const { data: purged, error: purgeError } = await supa.rpc('purge_member_data', {
      p_guild_id: GUILD_ID,
      p_user_id: userId,
    });
    expect(purgeError).toBeNull();
    expect(purged).toMatchObject({
      economy_role_income_requests: 1,
      economy_role_income_claims: 1,
    });

    const { count: requestCount } = await supa
      .from('economy_role_income_requests')
      .select('*', { count: 'exact', head: true })
      .eq('guild_id', GUILD_ID)
      .eq('user_id', userId);
    const { count: claimCount } = await supa
      .from('economy_role_income_claims')
      .select('*', { count: 'exact', head: true })
      .eq('guild_id', GUILD_ID)
      .eq('user_id', userId);
    expect(requestCount).toBe(0);
    expect(claimCount).toBe(0);

    const { data: anonymizedAudit, error: auditReadError } = await supa
      .from('audit_logs')
      .select('action,actor_id,target_id,details')
      .in('action', [actorAction, targetAction])
      .order('action', { ascending: true });
    expect(auditReadError).toBeNull();
    expect(anonymizedAudit).toEqual([
      {
        action: actorAction,
        actor_id: 'deleted_user',
        target_id: unrelatedTarget,
        details: { anonymized: true },
      },
      {
        action: targetAction,
        actor_id: unrelatedActor,
        target_id: 'deleted_user',
        details: { existing: 'kept', anonymized: true },
      },
    ]);
  });

  it('keeps commerce evidence isolated by guild', async () => {
    const userId = `${USER_PREFIX}-multiguild`;
    const { error } = await supa.from('temp_role_grants').insert({
      guild_id: OTHER_GUILD_ID,
      user_id: userId,
      role_id: ROLE_OTHER_GUILD,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      source: 'commerce_purchase',
      source_id: inactiveProductId,
    });
    expect(error).toBeNull();

    const result = await collect(GUILD_ID, userId, [ROLE_OTHER_GUILD], 'interaction-multiguild');
    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({ status: 'credited', amount_cents: 55, blocked_role_ids: [] });
  });

  it('rolls back cooldown and request state when wallet credit fails', async () => {
    const userId = `${USER_PREFIX}-rollback`;
    const failed = await collect(GUILD_ID, userId, [ROLE_ROLLBACK], 'interaction-rollback');
    expect(failed.error).not.toBeNull();

    const { count: claimsAfterFailure } = await supa
      .from('economy_role_income_claims')
      .select('*', { count: 'exact', head: true })
      .eq('guild_id', GUILD_ID)
      .eq('user_id', userId);
    const { count: requestsAfterFailure } = await supa
      .from('economy_role_income_requests')
      .select('*', { count: 'exact', head: true })
      .eq('guild_id', GUILD_ID)
      .eq('user_id', userId);
    expect(claimsAfterFailure).toBe(0);
    expect(requestsAfterFailure).toBe(0);

    const { error: repairError } = await supa
      .from('economy_role_income')
      .update({ amount: 65 })
      .eq('guild_id', GUILD_ID)
      .eq('role_id', ROLE_ROLLBACK);
    expect(repairError).toBeNull();

    const retry = await collect(GUILD_ID, userId, [ROLE_ROLLBACK], 'interaction-rollback');
    expect(retry.error).toBeNull();
    expect(retry.data).toMatchObject({ status: 'credited', amount_cents: 65, balance_cents: 65 });
  });

  it('denies the RPC to anon and authenticated clients', async () => {
    const args = {
      p_guild_id: GUILD_ID,
      p_user_id: `${USER_PREFIX}-untrusted`,
      p_discord_role_ids: [ROLE_REPLAY],
      p_request_id: 'interaction-untrusted',
    };
    const [anon, authenticated] = await Promise.all([
      getAnonTestClient().rpc('economy_collect_role_income', args),
      getAuthenticatedTestClient().rpc('economy_collect_role_income', args),
    ]);

    expect(anon.error).not.toBeNull();
    expect(authenticated.error).not.toBeNull();
  });

  it('exposes only the authoritative privacy RPC and no bypass helper', async () => {
    const privileges = await sql`
      SELECT
        pg_catalog.has_function_privilege(
          'service_role',
          'public.purge_member_data(text,text)',
          'EXECUTE'
        ) AS service_can_purge,
        pg_catalog.has_function_privilege(
          'anon',
          'public.purge_member_data(text,text)',
          'EXECUTE'
        ) AS anon_can_purge,
        pg_catalog.to_regprocedure(
          'public.purge_member_data_before_role_income_atomic(text,text)'
        ) IS NULL AS bypass_helper_absent,
        pg_catalog.has_function_privilege(
          'service_role',
          'public.commerce_enqueue_entitlement_role_revocation()',
          'EXECUTE'
        ) AS service_can_call_trigger_helper
    `;
    expect(privileges[0]).toMatchObject({
      service_can_purge: true,
      anon_can_purge: false,
      bypass_helper_absent: true,
      service_can_call_trigger_helper: false,
    });
  });
});
