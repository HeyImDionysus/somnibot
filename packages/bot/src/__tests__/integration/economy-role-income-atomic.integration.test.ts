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
import { randomUUID } from 'node:crypto';
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
const STARTING_BALANCE_GUILD_ID = `${GUILD_ID}-starting-balance`;
const GUILD_PURGE_ID = `${GUILD_ID}-privacy-purge`;
const TEST_GUILD_IDS = [
  GUILD_ID,
  OTHER_GUILD_ID,
  STARTING_BALANCE_GUILD_ID,
  GUILD_PURGE_ID,
];
const USER_PREFIX = `role-income-user-${Date.now()}`;

const ROLE_REPLAY = 'role-income-replay';
const ROLE_CONCURRENT = 'role-income-concurrent';
const ROLE_PAID = 'role-income-paid';
// Live manual/giveaway/automation entitlements now go through the shipped
// noncommerce activation protocol, whose trigger requires a canonical
// snowflake role snapshot and a snowflake customer discord_id. Purchase
// entitlements have no such gate, so ROLE_PAID may stay a plain label.
const ROLE_MANUAL = '210000000000000105';
const MANUAL_USER = '210000000000000205';
const ROLE_TEMP = 'role-income-temp';
const ROLE_REVOKE = 'role-income-revoke';
const ROLE_OTHER_GUILD = 'role-income-other-guild';
const ROLE_ROLLBACK = 'role-income-rollback';
// Terminal-transition coverage seeds delivery intents, whose role vectors
// must be canonical Discord snowflakes.
const ROLE_TRIGGER = '210000000000000106';
const ROLE_STALE_QUEUE = 'role-income-stale-queue';
const ROLE_PURGE = 'role-income-purge';
const ROLE_STARTING_BALANCE = 'role-income-starting-balance';
// Delivery-intent role vectors must be canonical Discord snowflakes.
const ROLE_INTENT_CLEANUP = '210000000000000101';
const ROLE_INTENT_OPEN_TERMINAL = '210000000000000102';
const ROLE_INTENT_SETTLED = '210000000000000103';
const ROLE_INTENT_NONCOMMERCE = '210000000000000104';

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

type WalletResult = {
  guild_id: string;
  user_id: string;
  wallet: number;
  bank: number;
  bank_max: number;
  passive: boolean;
  total_earned: number;
  total_spent: number;
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

async function initializeWallet(
  guildId: string,
  userId: string,
): Promise<{ data: WalletResult | null; error: { message: string } | null }> {
  return supa.rpc('economy_get_or_create_wallet', {
    p_guild_id: guildId,
    p_user_id: userId,
  }) as unknown as Promise<{
    data: WalletResult | null;
    error: { message: string } | null;
  }>;
}

function walletLockKey(guildId: string, userId: string): string {
  return `economy-role-income:${guildId}:${userId}`;
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
    {
      id: STARTING_BALANCE_GUILD_ID,
      name: 'Atomic Role Income Starting Balance Guild',
      owner_discord_id: '100000000000000003',
    },
    {
      id: GUILD_PURGE_ID,
      name: 'Atomic Guild Privacy Purge Test Guild',
      owner_discord_id: '100000000000000004',
    },
  ]);
  if (guildError) throw new Error(`Guild seed failed: ${guildError.message}`);

  const { error: configError } = await supa.from('guild_config').insert({
    guild_id: STARTING_BALANCE_GUILD_ID,
    economy_starting_balance: 100,
  });
  if (configError) throw new Error(`Guild config seed failed: ${configError.message}`);

  const paidUser = `${USER_PREFIX}-paid`;
  const manualUser = MANUAL_USER;
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

  // Inserting the live manual entitlement enqueues one pending noncommerce
  // activation carrier (action 'revoke_roles', reason 'entitlement_activated')
  // through the shipped protocol. Retire it to its steady worker-completed
  // state so the wall tests below observe entitlement provenance, not the
  // transient ensure carrier. Status transitions are protocol-owner-only, so
  // this must run on the privileged direct connection.
  const settledCarriers = await sql`
    UPDATE public.bot_action_queue
       SET status = 'completed',
           completed_at = pg_catalog.clock_timestamp()
     WHERE guild_id = ${GUILD_ID}
       AND action = 'revoke_roles'
       AND payload ->> 'source' = 'noncommerce_entitlement_activation_trigger'
       AND payload ->> 'discord_id' = ${MANUAL_USER}
       AND status = 'pending'
  `;
  if (settledCarriers.count !== 1) {
    throw new Error(
      `Manual activation carrier seed failed: expected 1 pending carrier, settled ${settledCarriers.count}`,
    );
  }

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
    { guild_id: GUILD_ID, role_id: ROLE_INTENT_CLEANUP, amount: 80, interval_minutes: 60 },
    { guild_id: GUILD_ID, role_id: ROLE_INTENT_OPEN_TERMINAL, amount: 85, interval_minutes: 60 },
    { guild_id: GUILD_ID, role_id: ROLE_INTENT_SETTLED, amount: 90, interval_minutes: 60 },
    { guild_id: GUILD_ID, role_id: ROLE_INTENT_NONCOMMERCE, amount: 95, interval_minutes: 60 },
    { guild_id: OTHER_GUILD_ID, role_id: ROLE_OTHER_GUILD, amount: 60, interval_minutes: 60 },
    {
      guild_id: STARTING_BALANCE_GUILD_ID,
      role_id: ROLE_STARTING_BALANCE,
      amount: 25,
      interval_minutes: 60,
    },
  ]);
  if (incomeError) throw new Error(`Role-income seed failed: ${incomeError.message}`);
});

afterAll(async () => {
  // service_role holds SELECT only on the intents ledger; fixtures are
  // removed through the privileged test connection.
  await sql`
    DELETE FROM public.commerce_role_delivery_intents
     WHERE guild_id IN ${sql(TEST_GUILD_IDS)}
  `;
  // The manual entitlement's activation head pins its queue carrier through
  // an ON DELETE RESTRICT FK, so it must go before the bot_action_queue
  // sweep. service_role holds SELECT only; use the privileged connection.
  await sql`
    DELETE FROM public.commerce_noncommerce_activation_heads
     WHERE guild_id IN ${sql(TEST_GUILD_IDS)}
  `;
  // audit_logs rows are immutable by design (delete-protection trigger) and
  // are intentionally left in place; cleanup scopes to non-audit tables only.
  await supa.from('alerts').delete().in('guild_id', TEST_GUILD_IDS);
  await supa.from('action_queue_dlq').delete().in('guild_id', TEST_GUILD_IDS);
  await supa.from('bot_action_queue').delete().in('guild_id', TEST_GUILD_IDS);
  await supa.from('temp_role_grants').delete().in('guild_id', TEST_GUILD_IDS);
  await supa.from('economy_role_income_requests').delete().in('guild_id', TEST_GUILD_IDS);
  await supa.from('economy_role_income_claims').delete().in('guild_id', TEST_GUILD_IDS);
  await supa.from('economy_transactions').delete().in('guild_id', TEST_GUILD_IDS);
  await supa.from('economy_wallets').delete().in('guild_id', TEST_GUILD_IDS);
  await supa.from('economy_role_income').delete().in('guild_id', TEST_GUILD_IDS);
  await supa.from('entitlements').delete().in('guild_id', TEST_GUILD_IDS);
  await supa.from('payments').delete().in('guild_id', TEST_GUILD_IDS);
  await supa.from('orders').delete().in('guild_id', TEST_GUILD_IDS);
  await supa.from('products').delete().in('guild_id', TEST_GUILD_IDS);
  await supa.from('customers').delete().in('guild_id', TEST_GUILD_IDS);
  await supa.from('guild_config').delete().in('guild_id', TEST_GUILD_IDS);
  // Guild rows with immutable audit_logs stay behind deliberately (the FK
  // pins them); ids are unique per run, so reruns are unaffected.
  await sql?.end({ timeout: 5 });
});

describe('economy_collect_role_income', () => {
  it('initializes a first wallet with starting balance and audits it exactly once', async () => {
    const userId = `${USER_PREFIX}-starting-balance-new`;
    const requestIds = ['interaction-starting-balance-a', 'interaction-starting-balance-b'];
    const attempts = await Promise.all(requestIds.map((requestId) => collect(
      STARTING_BALANCE_GUILD_ID,
      userId,
      [ROLE_STARTING_BALANCE],
      requestId,
    )));
    const creditedIndex = attempts.findIndex((attempt) => attempt.data?.status === 'credited');
    expect(attempts.every((attempt) => attempt.error === null)).toBe(true);
    expect(attempts.map((attempt) => attempt.data!.status).sort()).toEqual(['cooldown', 'credited']);
    expect(creditedIndex).toBeGreaterThanOrEqual(0);
    if (creditedIndex < 0) throw new Error('No concurrent collection was credited');

    const credited = attempts[creditedIndex]!;
    const replay = await collect(
      STARTING_BALANCE_GUILD_ID,
      userId,
      [ROLE_STARTING_BALANCE],
      requestIds[creditedIndex]!,
    );

    expect(replay.error).toBeNull();
    expect(replay.data).toEqual(credited.data);
    expect(credited.data).toMatchObject({
      status: 'credited',
      amount_cents: 25,
      balance_cents: 125,
      credited_role_ids: [ROLE_STARTING_BALANCE],
    });

    const { data: wallet, error: walletError } = await supa
      .from('economy_wallets')
      .select('wallet,total_earned')
      .eq('guild_id', STARTING_BALANCE_GUILD_ID)
      .eq('user_id', userId)
      .single();
    expect(walletError).toBeNull();
    expect(wallet).toEqual({ wallet: 125, total_earned: 125 });

    const { data: transactions, error: transactionError } = await supa
      .from('economy_transactions')
      .select('type,amount,balance_after,description,metadata')
      .eq('guild_id', STARTING_BALANCE_GUILD_ID)
      .eq('user_id', userId)
      .order('type', { ascending: true });
    expect(transactionError).toBeNull();
    expect(transactions).toEqual([
      {
        type: 'admin_add',
        amount: 100,
        balance_after: 100,
        description: 'Starting balance',
        metadata: null,
      },
      {
        type: 'role_income',
        amount: 25,
        balance_after: 125,
        description: 'Role income collection',
        metadata: {
          request_id: requestIds[creditedIndex],
          role_ids: [ROLE_STARTING_BALANCE],
        },
      },
    ]);
  });

  it('serializes role income behind an in-flight wallet initialization', async () => {
    const userId = `${USER_PREFIX}-initializer-wins-race`;
    let pendingCollection!: ReturnType<typeof collect>;
    let collectionSettled = false;
    let collectionWasBlocked = false;

    const initializedRows = await sql.begin(async (tx) => {
      await tx`
        SELECT pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended(${walletLockKey(STARTING_BALANCE_GUILD_ID, userId)}, 0)
        )
      `;
      const rows = await tx`
        SELECT public.economy_get_or_create_wallet(
          ${STARTING_BALANCE_GUILD_ID},
          ${userId}
        ) AS wallet
      `;
      pendingCollection = collect(
        STARTING_BALANCE_GUILD_ID,
        userId,
        [ROLE_STARTING_BALANCE],
        'interaction-initializer-wins-race',
      );
      void pendingCollection.then(
        () => { collectionSettled = true; },
        () => { collectionSettled = true; },
      );
      await tx`SELECT pg_catalog.pg_sleep(0.1)`;
      collectionWasBlocked = !collectionSettled;
      return rows;
    });
    const collected = await pendingCollection;

    expect(collectionWasBlocked).toBe(true);
    expect((initializedRows[0]!.wallet as WalletResult).wallet).toBe(100);
    expect(collected.error).toBeNull();
    expect(collected.data).toMatchObject({
      status: 'credited',
      amount_cents: 25,
      balance_cents: 125,
    });

    const { data: transactions, error: transactionError } = await supa
      .from('economy_transactions')
      .select('type,amount,balance_after')
      .eq('guild_id', STARTING_BALANCE_GUILD_ID)
      .eq('user_id', userId)
      .order('type', { ascending: true });
    expect(transactionError).toBeNull();
    expect(transactions).toEqual([
      { type: 'admin_add', amount: 100, balance_after: 100 },
      { type: 'role_income', amount: 25, balance_after: 125 },
    ]);
  });

  it('returns the final wallet when initialization waits behind role income', async () => {
    const userId = `${USER_PREFIX}-collector-wins-race`;
    let pendingInitialization!: ReturnType<typeof initializeWallet>;
    let initializationSettled = false;
    let initializationWasBlocked = false;

    const collectionRows = await sql.begin(async (tx) => {
      await tx`
        SELECT pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended(${walletLockKey(STARTING_BALANCE_GUILD_ID, userId)}, 0)
        )
      `;
      const rows = await tx`
        SELECT public.economy_collect_role_income(
          ${STARTING_BALANCE_GUILD_ID},
          ${userId},
          ARRAY[${ROLE_STARTING_BALANCE}]::TEXT[],
          ${'interaction-collector-wins-race'}
        ) AS result
      `;
      pendingInitialization = initializeWallet(STARTING_BALANCE_GUILD_ID, userId);
      void pendingInitialization.then(
        () => { initializationSettled = true; },
        () => { initializationSettled = true; },
      );
      await tx`SELECT pg_catalog.pg_sleep(0.1)`;
      initializationWasBlocked = !initializationSettled;
      return rows;
    });
    const initialized = await pendingInitialization;

    expect(initializationWasBlocked).toBe(true);
    expect(collectionRows[0]!.result).toMatchObject({
      status: 'credited',
      amount_cents: 25,
      balance_cents: 125,
    });
    expect(initialized.error).toBeNull();
    expect(initialized.data).toMatchObject({
      guild_id: STARTING_BALANCE_GUILD_ID,
      user_id: userId,
      wallet: 125,
      total_earned: 125,
    });

    const { data: transactions, error: transactionError } = await supa
      .from('economy_transactions')
      .select('type,amount,balance_after')
      .eq('guild_id', STARTING_BALANCE_GUILD_ID)
      .eq('user_id', userId)
      .order('type', { ascending: true });
    expect(transactionError).toBeNull();
    expect(transactions).toEqual([
      { type: 'admin_add', amount: 100, balance_after: 100 },
      { type: 'role_income', amount: 25, balance_after: 125 },
    ]);
  });

  it('serializes role income behind a direct first-wallet credit', async () => {
    const userId = `${USER_PREFIX}-direct-credit-wins-race`;
    let pendingCollection!: ReturnType<typeof collect>;
    let collectionSettled = false;
    let collectionWasBlocked = false;

    await sql.begin(async (tx) => {
      await tx`
        SELECT pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended(${walletLockKey(STARTING_BALANCE_GUILD_ID, userId)}, 0)
        )
      `;
      await tx`
        SELECT public.economy_add_balance(
          ${STARTING_BALANCE_GUILD_ID},
          ${userId},
          ${40}
        )
      `;
      pendingCollection = collect(
        STARTING_BALANCE_GUILD_ID,
        userId,
        [ROLE_STARTING_BALANCE],
        'interaction-direct-credit-wins-race',
      );
      void pendingCollection.then(
        () => { collectionSettled = true; },
        () => { collectionSettled = true; },
      );
      await tx`SELECT pg_catalog.pg_sleep(0.1)`;
      collectionWasBlocked = !collectionSettled;
    });
    const collected = await pendingCollection;

    expect(collectionWasBlocked).toBe(true);
    expect(collected.error).toBeNull();
    expect(collected.data).toMatchObject({
      status: 'credited',
      amount_cents: 25,
      balance_cents: 165,
    });

    const { data: wallet, error: walletError } = await supa
      .from('economy_wallets')
      .select('wallet,total_earned')
      .eq('guild_id', STARTING_BALANCE_GUILD_ID)
      .eq('user_id', userId)
      .single();
    expect(walletError).toBeNull();
    expect(wallet).toEqual({ wallet: 165, total_earned: 165 });

    const { data: transactions, error: transactionError } = await supa
      .from('economy_transactions')
      .select('type,amount,balance_after')
      .eq('guild_id', STARTING_BALANCE_GUILD_ID)
      .eq('user_id', userId)
      .order('type', { ascending: true });
    expect(transactionError).toBeNull();
    expect(transactions).toEqual([
      { type: 'admin_add', amount: 100, balance_after: 100 },
      { type: 'role_income', amount: 25, balance_after: 165 },
    ]);
  });

  it('serializes role income behind a first-wallet level-bonus credit', async () => {
    const userId = `${USER_PREFIX}-level-credit-wins-race`;
    let pendingCollection!: ReturnType<typeof collect>;
    let collectionSettled = false;
    let collectionWasBlocked = false;

    await sql.begin(async (tx) => {
      await tx`
        SELECT pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended(${walletLockKey(STARTING_BALANCE_GUILD_ID, userId)}, 0)
        )
      `;
      await tx`
        SELECT public.economy_credit_wallet(
          ${STARTING_BALANCE_GUILD_ID},
          ${userId},
          ${40},
          ${'Level milestone bonus'}
        )
      `;
      pendingCollection = collect(
        STARTING_BALANCE_GUILD_ID,
        userId,
        [ROLE_STARTING_BALANCE],
        'interaction-level-credit-wins-race',
      );
      void pendingCollection.then(
        () => { collectionSettled = true; },
        () => { collectionSettled = true; },
      );
      await tx`SELECT pg_catalog.pg_sleep(0.1)`;
      collectionWasBlocked = !collectionSettled;
    });
    const collected = await pendingCollection;

    expect(collectionWasBlocked).toBe(true);
    expect(collected.error).toBeNull();
    expect(collected.data).toMatchObject({
      status: 'credited',
      amount_cents: 25,
      balance_cents: 165,
    });

    const { data: wallet, error: walletError } = await supa
      .from('economy_wallets')
      .select('wallet,total_earned')
      .eq('guild_id', STARTING_BALANCE_GUILD_ID)
      .eq('user_id', userId)
      .single();
    expect(walletError).toBeNull();
    expect(wallet).toEqual({ wallet: 165, total_earned: 165 });

    const { data: transactions, error: transactionError } = await supa
      .from('economy_transactions')
      .select('type,amount,balance_after,description')
      .eq('guild_id', STARTING_BALANCE_GUILD_ID)
      .eq('user_id', userId)
      .order('type', { ascending: true });
    expect(transactionError).toBeNull();
    expect(transactions).toEqual([
      {
        type: 'admin_add',
        amount: 100,
        balance_after: 100,
        description: 'Starting balance',
      },
      {
        type: 'level_bonus',
        amount: 40,
        balance_after: 140,
        description: 'Level milestone bonus',
      },
      {
        type: 'role_income',
        amount: 25,
        balance_after: 165,
        description: 'Role income collection',
      },
    ]);
  });

  it('does not apply starting balance to an existing wallet', async () => {
    const userId = `${USER_PREFIX}-starting-balance-existing`;
    const { error: seedError } = await supa.from('economy_wallets').insert({
      guild_id: STARTING_BALANCE_GUILD_ID,
      user_id: userId,
      wallet: 40,
      bank: 5,
      total_earned: 40,
      total_spent: 0,
    });
    expect(seedError).toBeNull();

    const collected = await collect(
      STARTING_BALANCE_GUILD_ID,
      userId,
      [ROLE_STARTING_BALANCE],
      'interaction-existing-wallet',
    );
    expect(collected.error).toBeNull();
    expect(collected.data).toMatchObject({
      status: 'credited',
      amount_cents: 25,
      balance_cents: 65,
    });

    const { data: wallet, error: walletError } = await supa
      .from('economy_wallets')
      .select('wallet,bank,total_earned')
      .eq('guild_id', STARTING_BALANCE_GUILD_ID)
      .eq('user_id', userId)
      .single();
    expect(walletError).toBeNull();
    expect(wallet).toEqual({ wallet: 65, bank: 5, total_earned: 65 });

    const { data: transactions, error: transactionError } = await supa
      .from('economy_transactions')
      .select('type,amount,balance_after')
      .eq('guild_id', STARTING_BALANCE_GUILD_ID)
      .eq('user_id', userId);
    expect(transactionError).toBeNull();
    expect(transactions).toEqual([{ type: 'role_income', amount: 25, balance_after: 65 }]);
  });

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
      MANUAL_USER,
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

  it('does not treat a removed commerce tombstone as live paid-role evidence', async () => {
    const userId = `${USER_PREFIX}-reconciled-temp`;
    const { error } = await supa.from('temp_role_grants').insert({
      guild_id: GUILD_ID,
      user_id: userId,
      role_id: ROLE_TEMP,
      expires_at: new Date(Date.now() - 60_000).toISOString(),
      source: 'commerce_reconciled',
      source_id: inactiveProductId,
      grant_status: 'removed',
      remove_on_expiry: true,
    });
    expect(error).toBeNull();

    const result = await collect(
      GUILD_ID,
      userId,
      [ROLE_TEMP],
      'interaction-reconciled-temp',
    );
    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({
      status: 'credited',
      amount_cents: 45,
      blocked_role_ids: [],
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

  it('blocks a role an unsettled cleanup-required delivery intent still accounts for', async () => {
    const userId = `${USER_PREFIX}-intent-cleanup`;
    // The current protocol's cleanup carriers hold no role vector, so only the
    // intent itself can prove this paid role's removal is still outstanding.
    await sql`
      INSERT INTO public.commerce_role_delivery_intents (
        id, action_id, origin_claim_token, delivery_claim_token,
        guild_id, entitlement_id, customer_id, discord_id,
        order_id, product_id, entitlement_type,
        permanent_role_ids, completed_role_ids, owned_role_ids, state
      ) VALUES (
        ${randomUUID()}, ${randomUUID()}, ${randomUUID()}, ${randomUUID()},
        ${GUILD_ID}, ${randomUUID()}, ${randomUUID()}, ${userId},
        ${randomUUID()}, ${randomUUID()}, 'one_time',
        ARRAY[${ROLE_INTENT_CLEANUP}]::TEXT[],
        ARRAY[${ROLE_INTENT_CLEANUP}]::TEXT[],
        ARRAY[${ROLE_INTENT_CLEANUP}]::TEXT[],
        'cleanup_required'
      )
    `;

    const result = await collect(
      GUILD_ID,
      userId,
      [ROLE_INTENT_CLEANUP],
      'interaction-intent-cleanup',
    );
    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({
      status: 'no_eligible_roles',
      amount_cents: 0,
      blocked_role_ids: [ROLE_INTENT_CLEANUP],
    });
  });

  it('blocks a role on an open delivery intent whose parent entitlement went terminal', async () => {
    const userId = `${USER_PREFIX}-intent-open-terminal`;
    const { data: customer, error: customerError } = await supa
      .from('customers')
      .insert({
        guild_id: GUILD_ID,
        discord_id: userId,
        discord_username: 'intent-open-terminal',
      })
      .select('id')
      .single();
    expect(customerError).toBeNull();
    const { data: entitlement, error: entitlementError } = await supa
      .from('entitlements')
      .insert({
        customer_id: customer!.id,
        guild_id: GUILD_ID,
        product_id: inactiveProductId,
        type: 'one_time',
        status: 'expired',
        source: 'purchase',
        granted_role_ids: [ROLE_INTENT_OPEN_TERMINAL],
        granted_channel_ids: [],
      })
      .select('id')
      .single();
    expect(entitlementError).toBeNull();

    // Pre-deploy shape: the intent never received a terminal signal, so it is
    // still 'open' while the paid contract behind it is already dead.
    await sql`
      INSERT INTO public.commerce_role_delivery_intents (
        id, action_id, origin_claim_token, delivery_claim_token,
        guild_id, entitlement_id, customer_id, discord_id,
        order_id, product_id, entitlement_type,
        permanent_role_ids, completed_role_ids, owned_role_ids, state
      ) VALUES (
        ${randomUUID()}, ${randomUUID()}, ${randomUUID()}, ${randomUUID()},
        ${GUILD_ID}, ${entitlement!.id}, ${customer!.id}, ${userId},
        ${randomUUID()}, ${inactiveProductId}, 'one_time',
        ARRAY[${ROLE_INTENT_OPEN_TERMINAL}]::TEXT[],
        ARRAY[${ROLE_INTENT_OPEN_TERMINAL}]::TEXT[],
        ARRAY[${ROLE_INTENT_OPEN_TERMINAL}]::TEXT[],
        'open'
      )
    `;

    const result = await collect(
      GUILD_ID,
      userId,
      [ROLE_INTENT_OPEN_TERMINAL],
      'interaction-intent-open-terminal',
    );
    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({
      status: 'no_eligible_roles',
      amount_cents: 0,
      blocked_role_ids: [ROLE_INTENT_OPEN_TERMINAL],
    });
  });

  it('does not treat a settled delivery intent as outstanding removal evidence', async () => {
    const userId = `${USER_PREFIX}-intent-settled`;
    // Settlement proves removal (or a safe handoff): reserved/owned vectors
    // are empty and no cleanup mutation can be active. Only the historical
    // completed vector remains.
    await sql`
      INSERT INTO public.commerce_role_delivery_intents (
        id, action_id, origin_claim_token, delivery_claim_token,
        guild_id, entitlement_id, customer_id, discord_id,
        order_id, product_id, entitlement_type,
        permanent_role_ids, completed_role_ids, state, settled_at
      ) VALUES (
        ${randomUUID()}, ${randomUUID()}, ${randomUUID()}, ${randomUUID()},
        ${GUILD_ID}, ${randomUUID()}, ${randomUUID()}, ${userId},
        ${randomUUID()}, ${randomUUID()}, 'one_time',
        ARRAY[${ROLE_INTENT_SETTLED}]::TEXT[],
        ARRAY[${ROLE_INTENT_SETTLED}]::TEXT[],
        'settled', pg_catalog.clock_timestamp()
      )
    `;

    const result = await collect(
      GUILD_ID,
      userId,
      [ROLE_INTENT_SETTLED],
      'interaction-intent-settled',
    );
    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({
      status: 'credited',
      amount_cents: 90,
      blocked_role_ids: [],
    });
  });

  it('does not treat a non-commerce delivery carrier as real-money provenance', async () => {
    const userId = `${USER_PREFIX}-intent-noncommerce`;
    // Manual/giveaway/automation carriers police free grants of store
    // metadata; like non-purchase entitlements they never gate the game
    // economy, even while their cleanup is outstanding.
    await sql`
      INSERT INTO public.commerce_role_delivery_intents (
        id, contract_kind, entitlement_source, activation_generation,
        action_id, origin_claim_token, delivery_claim_token,
        guild_id, entitlement_id, customer_id, discord_id,
        order_id, product_id, entitlement_type,
        permanent_role_ids, completed_role_ids, owned_role_ids, state
      ) VALUES (
        ${randomUUID()}, 'noncommerce', 'giveaway', ${randomUUID()},
        ${randomUUID()}, ${randomUUID()}, ${randomUUID()},
        ${GUILD_ID}, ${randomUUID()}, ${randomUUID()}, ${userId},
        ${randomUUID()}, ${randomUUID()}, 'one_time',
        ARRAY[${ROLE_INTENT_NONCOMMERCE}]::TEXT[],
        ARRAY[${ROLE_INTENT_NONCOMMERCE}]::TEXT[],
        ARRAY[${ROLE_INTENT_NONCOMMERCE}]::TEXT[],
        'cleanup_required'
      )
    `;

    const result = await collect(
      GUILD_ID,
      userId,
      [ROLE_INTENT_NONCOMMERCE],
      'interaction-intent-noncommerce',
    );
    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({
      status: 'credited',
      amount_cents: 95,
      blocked_role_ids: [],
    });
  });

  it('atomically enqueues revocation before a paid entitlement becomes terminal', async () => {
    const userId = `${USER_PREFIX}-terminal-trigger`;
    const fixture = await createPaidEntitlementFixture(
      ROLE_TRIGGER,
      userId,
      'terminal-trigger',
    );

    // The shipped protocol no longer emits revoke_roles carriers for paid
    // entitlements: proven role custody lives on the durable delivery
    // intent, and terminal transitions enqueue exact-intent
    // reconcile_entitlement_roles cleanup carriers instead. Seed the steady
    // post-delivery custody shape (owned = completed = permanent).
    const intentId = randomUUID();
    await sql`
      INSERT INTO public.commerce_role_delivery_intents (
        id, action_id, origin_claim_token, delivery_claim_token,
        guild_id, entitlement_id, customer_id, discord_id,
        order_id, product_id, entitlement_type,
        permanent_role_ids, completed_role_ids, owned_role_ids, state
      ) VALUES (
        ${intentId}, ${randomUUID()}, ${randomUUID()}, ${randomUUID()},
        ${GUILD_ID}, ${fixture.entitlementId}, ${fixture.customerId}, ${userId},
        ${fixture.orderId}, ${inactiveProductId}, 'one_time',
        ARRAY[${ROLE_TRIGGER}]::TEXT[],
        ARRAY[${ROLE_TRIGGER}]::TEXT[],
        ARRAY[${ROLE_TRIGGER}]::TEXT[],
        'open'
      )
    `;

    const terminal = await supa
      .from('entitlements')
      .update({ status: 'expired', expires_at: new Date().toISOString() })
      .eq('id', fixture.entitlementId);
    expect(terminal.error).toBeNull();

    // The terminal transition and the durable cleanup carrier commit in the
    // same transaction. A directly-seeded intent carries no revalidatable
    // origin claim (its action_id never existed in the queue), so the
    // classifier fails closed to operator custody rather than automatic
    // cleanup_required -- but the exact-intent cleanup carrier is still
    // durably enqueued before the entitlement row goes terminal.
    expect(await sql<{ state: string }[]>`
      SELECT state
        FROM public.commerce_role_delivery_intents
       WHERE id = ${intentId}
    `).toEqual([{ state: 'operator_required' }]);

    const { data: queued, error: queueError } = await supa
      .from('bot_action_queue')
      .select('guild_id,action,status,lane,payload')
      .eq('idempotency_key', `commerce-role-delivery-cleanup:${intentId}`)
      .single();
    expect(queueError).toBeNull();
    expect(queued).toMatchObject({
      guild_id: GUILD_ID,
      action: 'reconcile_entitlement_roles',
      status: 'pending',
      lane: 'commerce',
      payload: {
        mode: 'cleanup',
        target_delivery_intent_id: intentId,
        guild_id: GUILD_ID,
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

    // 'No lost revocations' protects provably-delivered roles: only an
    // entitlement with a durable delivery intent recording live role custody
    // demands synchronous cleanup work at its terminal transition. (A bare
    // entitlement row with no intent has no proven delivery to clean up, so
    // its transition owes nothing to the queue.) Seed the proven-delivery
    // shape, then make the cleanup carrier unpersistable.
    const intentId = randomUUID();
    await sql`
      INSERT INTO public.commerce_role_delivery_intents (
        id, action_id, origin_claim_token, delivery_claim_token,
        guild_id, entitlement_id, customer_id, discord_id,
        order_id, product_id, entitlement_type,
        permanent_role_ids, completed_role_ids, owned_role_ids, state
      ) VALUES (
        ${intentId}, ${randomUUID()}, ${randomUUID()}, ${randomUUID()},
        ${GUILD_ID}, ${fixture.entitlementId}, ${fixture.customerId}, ${userId},
        ${fixture.orderId}, ${inactiveProductId}, 'one_time',
        ARRAY[${ROLE_TRIGGER}]::TEXT[],
        ARRAY[${ROLE_TRIGGER}]::TEXT[],
        ARRAY[${ROLE_TRIGGER}]::TEXT[],
        'open'
      )
    `;

    const suffix = intentId.replaceAll('-', '').slice(0, 16);
    const functionName = `test_reject_cleanup_${suffix}`;
    const triggerName = `test_reject_cleanup_${suffix}`;

    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION public.${functionName}()
      RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = ''
      AS $body$
      BEGIN
        IF NEW.action = 'reconcile_entitlement_roles'
           AND NEW.payload ->> 'target_delivery_intent_id' = '${intentId}' THEN
          RAISE EXCEPTION 'forced test cleanup carrier failure';
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
      // The whole transition rolled back: the intent never left custody
      // tracking and no cleanup carrier survived.
      expect(await sql<{ state: string }[]>`
        SELECT state
          FROM public.commerce_role_delivery_intents
         WHERE id = ${intentId}
      `).toEqual([{ state: 'open' }]);
      const { count: queuedCount } = await supa
        .from('bot_action_queue')
        .select('*', { count: 'exact', head: true })
        .eq('idempotency_key', `commerce-role-delivery-cleanup:${intentId}`);
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
      purge_status: 'completed',
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
        // Erasure replaces details entirely: payload snapshots leave with
        // the identity (owner anonymize contract) — prior keys are NOT kept.
        details: { anonymized: true },
      },
    ]);
  });

  it('keeps exact commerce identity on the first purge call and deletes settled controller and relink tombstones on retry', async () => {
    const userId = `${USER_PREFIX}-two-phase-purge`;
    const newDiscordId = `${userId}-relinked`;
    const customerId = randomUUID();
    const intentId = randomUUID();
    const originActionId = randomUUID();
    const cleanupActionId = randomUUID();
    const relinkActionId = randomUUID();
    const historicalRelinkActionId = randomUUID();
    const historicalRelinkCustomerId = randomUUID();
    const entitlementId = randomUUID();
    const orderId = randomUUID();
    const productId = randomUUID();
    const roleId = '199999999999999999';

    await sql`
      INSERT INTO public.customers (
        id, guild_id, discord_id, discord_username
      ) VALUES (
        ${customerId}, ${GUILD_ID}, ${newDiscordId}, 'two-phase-purge'
      )
    `;
    await sql`
      INSERT INTO public.bot_action_queue (
        id, guild_id, action, payload, status, lane, idempotency_key
      ) VALUES
      (
        ${originActionId}, ${GUILD_ID}, 'reconcile_entitlement_roles',
        ${sql.json({
          mode: 'ensure_live',
          action_id: originActionId,
          guild_id: GUILD_ID,
          entitlement_id: entitlementId,
          customer_id: customerId,
          discord_id: newDiscordId,
        })},
        'completed', 'commerce', ${`test-origin:${intentId}`}
      ),
      (
        ${cleanupActionId}, ${GUILD_ID}, 'reconcile_entitlement_roles',
        ${sql.json({
          mode: 'cleanup',
          action_id: cleanupActionId,
          guild_id: GUILD_ID,
          target_delivery_intent_id: intentId,
        })},
        'completed', 'commerce', ${`test-cleanup:${intentId}`}
      ),
      (
        ${relinkActionId}, ${GUILD_ID}, 'reconcile_entitlement_roles',
        ${sql.json({
          mode: 'ensure_live_request',
          action_id: relinkActionId,
          guild_id: GUILD_ID,
          entitlement_id: entitlementId,
          customer_id: customerId,
          old_discord_id: userId,
          discord_id: newDiscordId,
        })},
        'completed', 'commerce',
        ${`commerce-role-delivery-relink:${customerId}:${userId}:${newDiscordId}:${entitlementId}`}
      ),
      (
        ${historicalRelinkActionId}, ${GUILD_ID}, 'reconcile_entitlement_roles',
        ${sql.json({
          mode: 'ensure_live_request',
          action_id: historicalRelinkActionId,
          guild_id: GUILD_ID,
          entitlement_id: randomUUID(),
          customer_id: historicalRelinkCustomerId,
          old_discord_id: newDiscordId,
          discord_id: `${newDiscordId}-later`,
        })},
        'completed', 'commerce',
        ${`test-historical-relink:${historicalRelinkActionId}:${newDiscordId}`}
      )
    `;
    await sql`
      INSERT INTO public.commerce_role_delivery_intents (
        id, action_id, origin_claim_token, delivery_claim_token,
        guild_id, entitlement_id, customer_id, discord_id,
        order_id, product_id, entitlement_type, permanent_role_ids,
        completed_role_ids, owned_role_ids, state,
        cleanup_action_id, cleanup_claim_token
      ) VALUES (
        ${intentId}, ${originActionId}, ${randomUUID()}, ${randomUUID()},
        ${GUILD_ID}, ${entitlementId}, ${customerId}, ${newDiscordId},
        ${orderId}, ${productId}, 'one_time', ARRAY[${roleId}]::TEXT[],
        ARRAY[${roleId}]::TEXT[], ARRAY[${roleId}]::TEXT[], 'operator_required',
        ${cleanupActionId}, ${randomUUID()}
      )
    `;
    await sql`
      INSERT INTO public.action_queue_dlq (
        guild_id, action, payload, original_id, retried, lane
      ) VALUES (
        ${GUILD_ID}, 'reconcile_entitlement_roles',
        ${sql.json({
          mode: 'cleanup',
          action_id: cleanupActionId,
          target_delivery_intent_id: intentId,
        })},
        ${cleanupActionId}, false, 'commerce'
      ),
      (
        ${GUILD_ID}, 'reconcile_entitlement_roles',
        ${sql.json({
          mode: 'ensure_live_request',
          action_id: historicalRelinkActionId,
          customer_id: historicalRelinkCustomerId,
          old_discord_id: newDiscordId,
          discord_id: `${newDiscordId}-later`,
        })},
        ${historicalRelinkActionId}, false, 'commerce'
      )
    `;

    const first = await supa.rpc('purge_member_data', {
      p_guild_id: GUILD_ID,
      p_user_id: newDiscordId,
    });
    expect(first.error).toBeNull();
    expect(first.data).toMatchObject({
      purge_status: 'pending_role_cleanup',
      unresolved_role_delivery_intents: 1,
      active_commerce_dlq_actions: 1,
    });
    expect(await sql<{ discord_id: string }[]>`
      SELECT discord_id FROM public.customers WHERE id = ${customerId}
    `).toEqual([{ discord_id: newDiscordId }]);

    await sql`
      UPDATE public.commerce_role_delivery_intents
         SET state = 'settled',
             reserved_role_ids = '{}'::TEXT[],
             owned_role_ids = '{}'::TEXT[],
             reserved_temp_role_grant_ids = '{}'::UUID[],
             temporary_role_grant_ids = '{}'::UUID[],
             settled_at = pg_catalog.clock_timestamp(),
             updated_at = pg_catalog.clock_timestamp()
       WHERE id = ${intentId}
    `;

    const second = await supa.rpc('purge_member_data', {
      p_guild_id: GUILD_ID,
      p_user_id: newDiscordId,
    });
    expect(second.error).toBeNull();
    expect(second.data).toMatchObject({
      purge_status: 'completed',
      pending_role_cleanup_count: 0,
      commerce_role_delivery_intents: 1,
      commerce_queue_tombstones: 4,
      commerce_dlq_tombstones: 2,
      commerce_customers_anonymized: 1,
    });
    expect(await sql<{ discord_id: string }[]>`
      SELECT discord_id FROM public.customers WHERE id = ${customerId}
    `).toEqual([{ discord_id: `deleted-${customerId}` }]);
    expect(await sql<{ count: number }[]>`
      SELECT (
        SELECT pg_catalog.count(*)::INTEGER
          FROM public.commerce_role_delivery_intents
         WHERE id = ${intentId}
      ) + (
        SELECT pg_catalog.count(*)::INTEGER
          FROM public.bot_action_queue
         WHERE id IN (
           ${originActionId}, ${cleanupActionId}, ${relinkActionId},
           ${historicalRelinkActionId}
         )
      ) + (
        SELECT pg_catalog.count(*)::INTEGER
          FROM public.action_queue_dlq
         WHERE original_id IN (
           ${cleanupActionId}::TEXT,
           ${historicalRelinkActionId}::TEXT
         )
      ) AS count
    `).toEqual([{ count: 0 }]);
  });

  it('waits for and erases a relink carrier when the caller survives only as old_discord_id', async () => {
    const oldDiscordId = `${USER_PREFIX}-historical-relink-only`;
    const actionId = randomUUID();
    await sql`
      INSERT INTO public.bot_action_queue (
        id, guild_id, action, payload, status, lane, idempotency_key
      ) VALUES (
        ${actionId}, ${GUILD_ID}, 'reconcile_entitlement_roles',
        ${sql.json({
          mode: 'ensure_live_request',
          action_id: actionId,
          guild_id: GUILD_ID,
          entitlement_id: randomUUID(),
          customer_id: randomUUID(),
          old_discord_id: oldDiscordId,
          discord_id: `${oldDiscordId}-current`,
        })},
        'pending', 'commerce', ${`test-old-only-relink:${actionId}:${oldDiscordId}`}
      )
    `;

    const first = await supa.rpc('purge_member_data', {
      p_guild_id: GUILD_ID,
      p_user_id: oldDiscordId,
    });
    expect(first.error).toBeNull();
    expect(first.data).toMatchObject({
      purge_status: 'pending_role_cleanup',
      active_commerce_queue_actions: 1,
    });
    expect(await sql<{ count: number }[]>`
      SELECT pg_catalog.count(*)::INTEGER AS count
        FROM public.bot_action_queue
       WHERE id = ${actionId}
    `).toEqual([{ count: 1 }]);

    await sql`
      UPDATE public.bot_action_queue
         SET status = 'completed',
             completed_at = pg_catalog.clock_timestamp()
       WHERE id = ${actionId}
         AND status = 'pending'
    `;
    const second = await supa.rpc('purge_member_data', {
      p_guild_id: GUILD_ID,
      p_user_id: oldDiscordId,
    });
    expect(second.error).toBeNull();
    expect(second.data).toMatchObject({
      purge_status: 'completed',
      commerce_queue_tombstones: 1,
    });
    expect(await sql<{ count: number }[]>`
      SELECT pg_catalog.count(*)::INTEGER AS count
        FROM public.bot_action_queue
       WHERE id = ${actionId}
    `).toEqual([{ count: 0 }]);
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

  it('denies the wallet RPCs to anon and authenticated clients', async () => {
    const collectionArgs = {
      p_guild_id: GUILD_ID,
      p_user_id: `${USER_PREFIX}-untrusted`,
      p_discord_role_ids: [ROLE_REPLAY],
      p_request_id: 'interaction-untrusted',
    };
    const initializationArgs = {
      p_guild_id: GUILD_ID,
      p_user_id: `${USER_PREFIX}-untrusted`,
    };
    const [anonCollection, authenticatedCollection, anonInitialization, authenticatedInitialization] = await Promise.all([
      getAnonTestClient().rpc('economy_collect_role_income', collectionArgs),
      getAuthenticatedTestClient().rpc('economy_collect_role_income', collectionArgs),
      getAnonTestClient().rpc('economy_get_or_create_wallet', initializationArgs),
      getAuthenticatedTestClient().rpc('economy_get_or_create_wallet', initializationArgs),
    ]);

    expect(anonCollection.error).not.toBeNull();
    expect(authenticatedCollection.error).not.toBeNull();
    expect(anonInitialization.error).not.toBeNull();
    expect(authenticatedInitialization.error).not.toBeNull();
  });

  it('preserves the authoritative privacy RPC ABIs without exposing bypass helpers', async () => {
    const privileges = await sql`
      SELECT
        pg_catalog.pg_get_function_result(
          'public.purge_member_data(text,text)'::pg_catalog.regprocedure
        ) = 'jsonb' AS member_result_is_jsonb,
        pg_catalog.pg_get_function_result(
          'public.purge_guild_data(text)'::pg_catalog.regprocedure
        ) = 'jsonb' AS guild_result_is_jsonb,
        pg_catalog.has_function_privilege(
          'service_role',
          'public.purge_member_data(text,text)',
          'EXECUTE'
        ) AS service_can_purge_member,
        pg_catalog.has_function_privilege(
          'anon',
          'public.purge_member_data(text,text)',
          'EXECUTE'
        ) AS anon_can_purge_member,
        pg_catalog.has_function_privilege(
          'authenticated',
          'public.purge_member_data(text,text)',
          'EXECUTE'
        ) AS authenticated_can_purge_member,
        pg_catalog.has_function_privilege(
          'service_role',
          'public.purge_guild_data(text)',
          'EXECUTE'
        ) AS service_can_purge_guild,
        pg_catalog.has_function_privilege(
          'anon',
          'public.purge_guild_data(text)',
          'EXECUTE'
        ) AS anon_can_purge_guild,
        pg_catalog.has_function_privilege(
          'authenticated',
          'public.purge_guild_data(text)',
          'EXECUTE'
        ) AS authenticated_can_purge_guild,
        pg_catalog.has_function_privilege(
          'service_role',
          'public.commerce_purge_member_data_base(text,text)',
          'EXECUTE'
        ) AS service_can_call_member_base,
        pg_catalog.to_regprocedure(
          'public.purge_member_data_before_role_income_atomic(text,text)'
        ) IS NULL AS bypass_helper_absent,
        NOT EXISTS (
          SELECT 1
            FROM pg_catalog.pg_depend AS dependency
           WHERE dependency.refclassid = 'pg_catalog.pg_proc'::pg_catalog.regclass
             AND dependency.refobjid =
               'public.purge_guild_data(text)'::pg_catalog.regprocedure
             AND dependency.deptype = 'n'
        ) AS guild_rpc_has_no_normal_dependents,
        pg_catalog.to_regprocedure(
          'public.commerce_enqueue_entitlement_role_revocation()'
        ) IS NULL AS legacy_trigger_helper_dropped,
        pg_catalog.has_function_privilege(
          'service_role',
          'public.economy_get_or_create_wallet(text,text)',
          'EXECUTE'
        ) AS service_can_initialize_wallet,
        pg_catalog.has_function_privilege(
          'anon',
          'public.economy_get_or_create_wallet(text,text)',
          'EXECUTE'
        ) AS anon_can_initialize_wallet,
        pg_catalog.has_function_privilege(
          'service_role',
          'public.economy_credit_wallet(text,text,bigint,text)',
          'EXECUTE'
        ) AS service_can_credit_wallet,
        pg_catalog.has_function_privilege(
          'anon',
          'public.economy_credit_wallet(text,text,bigint,text)',
          'EXECUTE'
        ) AS anon_can_credit_wallet
    `;
    expect(privileges[0]).toMatchObject({
      member_result_is_jsonb: true,
      guild_result_is_jsonb: true,
      service_can_purge_member: true,
      anon_can_purge_member: false,
      authenticated_can_purge_member: false,
      service_can_purge_guild: true,
      anon_can_purge_guild: false,
      authenticated_can_purge_guild: false,
      service_can_call_member_base: false,
      bypass_helper_absent: true,
      guild_rpc_has_no_normal_dependents: true,
      legacy_trigger_helper_dropped: true,
      service_can_initialize_wallet: true,
      anon_can_initialize_wallet: false,
      service_can_credit_wallet: true,
      anon_can_credit_wallet: false,
    });
  });

  it('purges guild commerce children before their referenced parent rows', async () => {
    await sql`
      WITH product AS (
        INSERT INTO public.products (
          guild_id,
          name,
          type,
          delivery_type,
          price_cents,
          currency,
          granted_role_ids,
          granted_channel_ids,
          active
        ) VALUES (
          ${GUILD_PURGE_ID},
          'Guild purge dependency fixture',
          'one_time',
          'access_pass',
          500,
          'USD',
          '{}'::TEXT[],
          '{}'::TEXT[],
          false
        )
        RETURNING id
      ), customer AS (
        INSERT INTO public.customers (
          guild_id,
          discord_id,
          discord_username
        ) VALUES (
          ${GUILD_PURGE_ID},
          '100000000000000104',
          'guild-purge-customer'
        )
        RETURNING id
      ), paid_order AS (
        INSERT INTO public.orders (
          order_number,
          customer_id,
          guild_id,
          product_id,
          amount_cents,
          currency,
          source,
          status
        )
        SELECT
          ${`guild-purge-${Date.now()}`},
          customer.id,
          ${GUILD_PURGE_ID},
          product.id,
          500,
          'USD',
          'purchase',
          'pending'
        FROM customer, product
        RETURNING id, customer_id
      )
      INSERT INTO public.fraud_signals (
        guild_id,
        order_id,
        customer_id,
        discord_id,
        signal_type,
        severity,
        details
      )
      SELECT
        ${GUILD_PURGE_ID},
        paid_order.id,
        paid_order.customer_id,
        '100000000000000104',
        'velocity',
        'medium',
        '{"fixture":true}'::JSONB
      FROM paid_order
    `;

    // Audit rows are never deleted (owner decision, 2026-07-18): tenant
    // deletion must scrub identity and detach the skeleton so the guild row
    // itself can go.
    const auditSeeds = await sql<{ id: string }[]>`
      INSERT INTO public.audit_logs (
        guild_id, actor_type, actor_id, action, target_type, target_id,
        details, before_state, after_state, error_message, correlation_id
      ) VALUES (
        ${GUILD_PURGE_ID}, 'user', '100000000000000104',
        'guild-purge-children-audit', 'member', '100000000000000104',
        '{"pii":"seed"}'::JSONB, '{"before":true}'::JSONB,
        '{"after":true}'::JSONB, 'sensitive failure detail',
        'corr-guild-purge-children'
      )
      RETURNING id
    `;
    expect(auditSeeds).toHaveLength(1);

    const { data, error } = await supa.rpc('purge_guild_data', {
      p_guild_id: GUILD_PURGE_ID,
    });
    expect(error).toBeNull();
    expect(data).toMatchObject({
      purge_status: 'completed',
      pending_role_cleanup_count: 0,
      guild_deleted: 1,
    });

    const residue = await sql`
      SELECT
        (SELECT pg_catalog.count(*) FROM public.guild
          WHERE id = ${GUILD_PURGE_ID})::INTEGER AS guild_count,
        (SELECT pg_catalog.count(*) FROM public.products
          WHERE guild_id = ${GUILD_PURGE_ID})::INTEGER AS product_count,
        (SELECT pg_catalog.count(*) FROM public.customers
          WHERE guild_id = ${GUILD_PURGE_ID})::INTEGER AS customer_count,
        (SELECT pg_catalog.count(*) FROM public.orders
          WHERE guild_id = ${GUILD_PURGE_ID})::INTEGER AS order_count,
        (SELECT pg_catalog.count(*) FROM public.fraud_signals
          WHERE guild_id = ${GUILD_PURGE_ID})::INTEGER AS fraud_signal_count
    `;
    expect(residue[0]).toEqual({
      guild_count: 0,
      product_count: 0,
      customer_count: 0,
      order_count: 0,
      fraud_signal_count: 0,
    });

    // The audit row persists scrubbed and detached: identity, payload
    // snapshots, error text, and correlation are gone; the forensic skeleton
    // (action, actor type, time, outcome) survives with no guild link.
    expect(await sql`
      SELECT guild_id, actor_id, target_id, details, before_state,
             after_state, error_message, correlation_id
        FROM public.audit_logs
       WHERE id = ${auditSeeds[0]!.id}
    `).toEqual([
      {
        guild_id: null,
        actor_id: 'anonymized',
        target_id: 'anonymized',
        details: { anonymized: true },
        before_state: null,
        after_state: null,
        error_message: null,
        correlation_id: null,
      },
    ]);
  });

  it('anonymizes and detaches audit rows instead of deleting them on guild purge', async () => {
    const auditGuildId = `${GUILD_ID}-audit-purge`;
    const { error: guildError } = await supa.from('guild').insert({
      id: auditGuildId,
      name: 'Audit Anonymize Purge Guild',
      owner_discord_id: '100000000000000005',
    });
    expect(guildError).toBeNull();

    const seeded = await sql<{ id: string }[]>`
      INSERT INTO public.audit_logs (
        guild_id, actor_type, actor_id, action, target_type, target_id,
        details, before_state, after_state, error_message, correlation_id
      ) VALUES
      (
        ${auditGuildId}, 'user', '100000000000000005',
        'guild-audit-purge-with-target', 'member', '100000000000000006',
        '{"pii":"actor"}'::JSONB, '{"before":true}'::JSONB,
        '{"after":true}'::JSONB, 'sensitive failure', 'corr-with-target'
      ),
      (
        ${auditGuildId}, 'system', '100000000000000005',
        'guild-audit-purge-without-target', NULL, NULL,
        '{"pii":"system"}'::JSONB, NULL, NULL, NULL, NULL
      )
      RETURNING id
    `;
    expect(seeded).toHaveLength(2);

    const { data, error } = await supa.rpc('purge_guild_data', {
      p_guild_id: auditGuildId,
    });
    expect(error).toBeNull();
    // purge_guild_data reports no audit_logs deletion count: audit rows are
    // never deleted, so the completed result carries only the purge outcome.
    expect(data).toEqual({
      purge_status: 'completed',
      pending_role_cleanup_count: 0,
      guild_deleted: 1,
    });

    const survivors = await sql`
      SELECT action, guild_id, actor_id, target_id, details, before_state,
             after_state, error_message, correlation_id
        FROM public.audit_logs
       WHERE id IN ${sql(seeded.map((row) => row.id))}
       ORDER BY action COLLATE "C"
    `;
    expect(survivors).toEqual([
      {
        action: 'guild-audit-purge-with-target',
        guild_id: null,
        actor_id: 'anonymized',
        target_id: 'anonymized',
        details: { anonymized: true },
        before_state: null,
        after_state: null,
        error_message: null,
        correlation_id: null,
      },
      {
        action: 'guild-audit-purge-without-target',
        guild_id: null,
        actor_id: 'anonymized',
        target_id: null,
        details: { anonymized: true },
        before_state: null,
        after_state: null,
        error_message: null,
        correlation_id: null,
      },
    ]);

    expect(await sql<{ count: number }[]>`
      SELECT pg_catalog.count(*)::INTEGER AS count
        FROM public.guild
       WHERE id = ${auditGuildId}
    `).toEqual([{ count: 0 }]);
  });

  it('refuses direct audit log deletion even on the privileged connection', async () => {
    const seeded = await sql<{ id: string }[]>`
      INSERT INTO public.audit_logs (
        guild_id, actor_type, actor_id, action
      ) VALUES (
        ${GUILD_ID}, 'system', 'audit-delete-guard-actor',
        'audit-delete-guard-probe'
      )
      RETURNING id
    `;

    await expect(
      sql`DELETE FROM public.audit_logs WHERE id = ${seeded[0]!.id}`,
    ).rejects.toThrow('Audit log entries cannot be deleted');

    expect(await sql<{ count: number }[]>`
      SELECT pg_catalog.count(*)::INTEGER AS count
        FROM public.audit_logs
       WHERE id = ${seeded[0]!.id}
    `).toEqual([{ count: 1 }]);
  });

  it('scrubs stale audit rows once at the retention boundary while keeping guild attribution', async () => {
    const seeded = await sql<{ id: string }[]>`
      INSERT INTO public.audit_logs (
        guild_id, timestamp, actor_type, actor_id, action, target_type,
        target_id, details, before_state, after_state, error_message,
        correlation_id
      ) VALUES (
        ${GUILD_ID}, pg_catalog.clock_timestamp() - INTERVAL '91 days',
        'user', 'prune-probe-actor', 'prune-audit-probe', 'member',
        'prune-probe-target', '{"pii":"stale"}'::JSONB,
        '{"before":true}'::JSONB, '{"after":true}'::JSONB,
        'stale failure detail', 'corr-prune-probe'
      )
      RETURNING id
    `;

    const first = await supa.rpc('prune_expired_data', {
      p_guild_id: GUILD_ID,
    });
    expect(first.error).toBeNull();
    expect(first.data).toMatchObject({
      old_audit_logs: 1,
      expired_mutes: 0,
    });

    // Retention scrubs, never deletes: unlike tenant deletion the guild link
    // is KEPT so per-guild forensics stay queryable.
    expect(await sql`
      SELECT guild_id, actor_id, target_id, details, before_state,
             after_state, error_message, correlation_id
        FROM public.audit_logs
       WHERE id = ${seeded[0]!.id}
    `).toEqual([
      {
        guild_id: GUILD_ID,
        actor_id: 'anonymized',
        target_id: 'anonymized',
        details: { anonymized: true },
        before_state: null,
        after_state: null,
        error_message: null,
        correlation_id: null,
      },
    ]);

    const second = await supa.rpc('prune_expired_data', {
      p_guild_id: GUILD_ID,
    });
    expect(second.error).toBeNull();
    expect(second.data).toMatchObject({ old_audit_logs: 0 });
  });
});
