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
const STARTING_BALANCE_GUILD_ID = `${GUILD_ID}-starting-balance`;
const TEST_GUILD_IDS = [GUILD_ID, OTHER_GUILD_ID, STARTING_BALANCE_GUILD_ID];
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
const ROLE_STARTING_BALANCE = 'role-income-starting-balance';

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
  ]);
  if (guildError) throw new Error(`Guild seed failed: ${guildError.message}`);

  const { error: configError } = await supa.from('guild_config').insert({
    guild_id: STARTING_BALANCE_GUILD_ID,
    economy_starting_balance: 100,
  });
  if (configError) throw new Error(`Guild config seed failed: ${configError.message}`);

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
  await supa.from('audit_logs').delete().in('guild_id', TEST_GUILD_IDS);
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
  await supa.from('guild').delete().in('id', TEST_GUILD_IDS);
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
        ) AS service_can_call_trigger_helper,
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
      service_can_purge: true,
      anon_can_purge: false,
      bypass_helper_absent: true,
      service_can_call_trigger_helper: false,
      service_can_initialize_wallet: true,
      anon_can_initialize_wallet: false,
      service_can_credit_wallet: true,
      anon_can_credit_wallet: false,
    });
  });
});
