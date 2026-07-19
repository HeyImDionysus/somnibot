/**
 * Executable legacy-data fixture for migration 20260711030000.
 *
 * The normal integration database has already applied every migration before
 * Vitest starts, so a post-migration test cannot prove the conversion itself.
 * This harness creates an isolated schema with the pre-030 table shape, seeds
 * representative legacy rows, rewrites only the migration's `public.` schema
 * qualifier to that isolated schema, and executes the real migration SQL.
 * Production tables and migration bookkeeping are never touched.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTestDbUrl, requireSupabase } from './helpers.js';

const FIXTURE_SCHEMA = 'commerce_metadata_migration_fixture';
const GUILD_ID = 'commerce-metadata-migration-guild';

const PRODUCT_PERMANENT = '10000000-0000-4000-8000-000000000001';
const PRODUCT_TEMPORARY = '10000000-0000-4000-8000-000000000002';
const PRODUCT_INVALID = '10000000-0000-4000-8000-000000000003';
const PRODUCT_AMBIGUOUS_ENTITLEMENT = '10000000-0000-4000-8000-000000000004';
const PRODUCT_AMBIGUOUS_ORDER = '10000000-0000-4000-8000-000000000005';
const PRODUCT_TERMINAL = '10000000-0000-4000-8000-000000000006';
const PRODUCT_INVALID_ROLE_VALID_DURATION = '10000000-0000-4000-8000-000000000007';
const PRODUCT_DURATION_ONLY = '10000000-0000-4000-8000-000000000008';
const PRODUCT_UNSUPPORTED_DURATION = '10000000-0000-4000-8000-000000000009';
const CUSTOMER_ID = '20000000-0000-4000-8000-000000000001';
const ENTITLEMENT_ID = '30000000-0000-4000-8000-000000000001';
const TERMINAL_ENTITLEMENT_ID = '30000000-0000-4000-8000-000000000002';
const ORDER_ID = '40000000-0000-4000-8000-000000000001';
const TERMINAL_ORDER_ID = '40000000-0000-4000-8000-000000000002';
const LEGACY_SALE_PLAN_ID = '40000000-0000-4000-8000-000000000003';
const LEGACY_SALE_ORDER_ID = '40000000-0000-4000-8000-000000000004';
const LEGACY_INVALID_PAYMENT_ID = '41000000-0000-4000-8000-000000000001';
const LEGACY_INVALID_SALE_PAYMENT_ID = '41000000-0000-4000-8000-000000000002';
const LEGACY_INVALID_REFUND_ID = '42000000-0000-4000-8000-000000000001';
const LEGACY_REVOKE_PENDING_ID = '50000000-0000-4000-8000-000000000001';
// The deploy fence requires a drained queue (no processing rows), so the
// legacy worker's in-flight action is represented post-drain as 'failed'.
const LEGACY_REVOKE_DRAINED_ID = '50000000-0000-4000-8000-000000000002';
const LEGACY_REVOKE_FAILED_ID = '50000000-0000-4000-8000-000000000003';
const LEGACY_REVOKE_DLQ_ID = '50000000-0000-4000-8000-000000000004';

const ROLE_EXISTING = '100000000000000001';
const ROLE_PERMANENT = '100000000000000002';
const ROLE_TEMPORARY = '100000000000000003';
const ROLE_HISTORICAL = '100000000000000004';
const ROLE_AMBIGUOUS_ENTITLEMENT = '100000000000000005';
const ROLE_AMBIGUOUS_ORDER = '100000000000000006';
const ROLE_TERMINAL = '100000000000000007';
const ROLE_UNSUPPORTED_DURATION = '100000000000000008';

let sql: Sql;

function migrationSource(filename: string): string {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const path = resolve(
    testDir,
    '../../../../supabase/migrations',
    filename,
  );

  return readFileSync(path, 'utf8');
}

function migrationSql(): string {
  // The schema name is a source-controlled constant containing only lowercase
  // identifier characters. Replacing the explicit qualifier preserves every
  // statement and expression in the production migration while isolating DDL.
  return migrationSource('20260711030000_canonicalize_commerce_role_metadata.sql')
    .replaceAll('public.', `${FIXTURE_SCHEMA}.`);
}

const PRE_MIGRATION_SCHEMA_SQL = `
  CREATE SCHEMA ${FIXTURE_SCHEMA};

  CREATE TABLE ${FIXTURE_SCHEMA}.guild (
    id TEXT PRIMARY KEY
  );

  CREATE TABLE ${FIXTURE_SCHEMA}.products (
    id UUID PRIMARY KEY,
    guild_id TEXT NOT NULL REFERENCES ${FIXTURE_SCHEMA}.guild(id),
    type TEXT NOT NULL,
    metadata JSONB,
    granted_role_ids TEXT[] DEFAULT '{}'::TEXT[],
    granted_channel_ids TEXT[] DEFAULT '{}'::TEXT[],
    active BOOLEAN NOT NULL DEFAULT false,
    price_cents INTEGER NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'USD',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE ${FIXTURE_SCHEMA}.plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES ${FIXTURE_SCHEMA}.products(id),
    guild_id TEXT NOT NULL REFERENCES ${FIXTURE_SCHEMA}.guild(id),
    name TEXT NOT NULL,
    paypal_plan_id TEXT,
    interval_unit TEXT NOT NULL DEFAULT 'MONTH',
    interval_count INTEGER NOT NULL DEFAULT 1,
    price_cents INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    trial_days INTEGER NOT NULL DEFAULT 0,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE ${FIXTURE_SCHEMA}.customers (
    id UUID PRIMARY KEY,
    guild_id TEXT NOT NULL REFERENCES ${FIXTURE_SCHEMA}.guild(id),
    discord_id TEXT NOT NULL,
    total_spent_cents INTEGER DEFAULT 0,
    total_orders INTEGER DEFAULT 0,
    first_purchase_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT now()
  );

  CREATE TABLE ${FIXTURE_SCHEMA}.orders (
    id UUID PRIMARY KEY,
    order_number TEXT,
    customer_id UUID REFERENCES ${FIXTURE_SCHEMA}.customers(id),
    guild_id TEXT NOT NULL REFERENCES ${FIXTURE_SCHEMA}.guild(id),
    product_id UUID REFERENCES ${FIXTURE_SCHEMA}.products(id),
    plan_id UUID REFERENCES ${FIXTURE_SCHEMA}.plans(id),
    paypal_order_id TEXT,
    paypal_subscription_id TEXT,
    amount_cents INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    discount_cents INTEGER NOT NULL DEFAULT 0,
    promotion_id UUID,
    source TEXT,
    status TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
  );

  CREATE TABLE ${FIXTURE_SCHEMA}.payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID REFERENCES ${FIXTURE_SCHEMA}.orders(id),
    customer_id UUID REFERENCES ${FIXTURE_SCHEMA}.customers(id),
    guild_id TEXT REFERENCES ${FIXTURE_SCHEMA}.guild(id),
    paypal_payment_id TEXT UNIQUE,
    paypal_event_id TEXT UNIQUE,
    amount_cents INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    status TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    provider TEXT DEFAULT 'paypal'
  );

  CREATE TABLE ${FIXTURE_SCHEMA}.license_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID REFERENCES ${FIXTURE_SCHEMA}.orders(id),
    customer_id UUID REFERENCES ${FIXTURE_SCHEMA}.customers(id),
    product_id UUID REFERENCES ${FIXTURE_SCHEMA}.products(id),
    guild_id TEXT REFERENCES ${FIXTURE_SCHEMA}.guild(id),
    key_hash TEXT,
    key_prefix TEXT,
    key_suffix TEXT,
    bound_discord_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending_activation',
    activated_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    revocation_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    last_failed_at TIMESTAMPTZ
  );

  CREATE TABLE ${FIXTURE_SCHEMA}.license_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    license_key_id UUID NOT NULL REFERENCES ${FIXTURE_SCHEMA}.license_keys(id),
    device_fingerprint TEXT,
    device_name TEXT,
    app_version TEXT,
    ip_address TEXT,
    active BOOLEAN NOT NULL DEFAULT true,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deactivated_at TIMESTAMPTZ,
    deactivation_reason TEXT
  );

  CREATE TABLE ${FIXTURE_SCHEMA}.entitlements (
    id UUID PRIMARY KEY,
    customer_id UUID REFERENCES ${FIXTURE_SCHEMA}.customers(id),
    guild_id TEXT NOT NULL REFERENCES ${FIXTURE_SCHEMA}.guild(id),
    product_id UUID REFERENCES ${FIXTURE_SCHEMA}.products(id),
    plan_id UUID REFERENCES ${FIXTURE_SCHEMA}.plans(id),
    license_key_id UUID REFERENCES ${FIXTURE_SCHEMA}.license_keys(id),
    order_id UUID REFERENCES ${FIXTURE_SCHEMA}.orders(id),
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    source TEXT,
    granted_role_ids TEXT[] DEFAULT '{}'::TEXT[],
    granted_channel_ids TEXT[] DEFAULT '{}'::TEXT[]
  );

  CREATE TABLE ${FIXTURE_SCHEMA}.temp_role_grants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    guild_id TEXT NOT NULL REFERENCES ${FIXTURE_SCHEMA}.guild(id),
    user_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    source TEXT,
    source_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE ${FIXTURE_SCHEMA}.bot_action_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    guild_id TEXT NOT NULL REFERENCES ${FIXTURE_SCHEMA}.guild(id),
    action TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::JSONB,
    status TEXT NOT NULL,
    result JSONB,
    error_message TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    next_retry_at TIMESTAMPTZ
  );

  CREATE TABLE ${FIXTURE_SCHEMA}.action_queue_dlq (
    id UUID PRIMARY KEY,
    guild_id TEXT NOT NULL REFERENCES ${FIXTURE_SCHEMA}.guild(id),
    action TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::JSONB,
    original_id TEXT,
    error_message TEXT,
    retried BOOLEAN NOT NULL DEFAULT false,
    retried_at TIMESTAMPTZ,
    failed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE ${FIXTURE_SCHEMA}.alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    guild_id TEXT NOT NULL REFERENCES ${FIXTURE_SCHEMA}.guild(id),
    alert_type TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'warning',
    title TEXT NOT NULL,
    message TEXT,
    metadata JSONB DEFAULT '{}'::JSONB,
    acknowledged BOOLEAN DEFAULT false,
    resolved BOOLEAN DEFAULT false,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
  );

  CREATE TABLE ${FIXTURE_SCHEMA}.payment_refunds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id UUID NOT NULL REFERENCES ${FIXTURE_SCHEMA}.payments(id),
    order_id UUID REFERENCES ${FIXTURE_SCHEMA}.orders(id),
    guild_id TEXT REFERENCES ${FIXTURE_SCHEMA}.guild(id),
    paypal_refund_id TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    amount_cents INTEGER,
    currency TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE ${FIXTURE_SCHEMA}.economy_role_income (
    guild_id TEXT NOT NULL REFERENCES ${FIXTURE_SCHEMA}.guild(id),
    role_id TEXT NOT NULL,
    amount INTEGER NOT NULL
  );

  CREATE TABLE ${FIXTURE_SCHEMA}.infractions (
    guild_id TEXT, active BOOLEAN, expires_at TIMESTAMPTZ
  );
  CREATE TABLE ${FIXTURE_SCHEMA}.mutes (
    guild_id TEXT, active BOOLEAN, expires_at TIMESTAMPTZ
  );
  CREATE TABLE ${FIXTURE_SCHEMA}.audit_logs (
    guild_id TEXT,
    actor_type TEXT,
    actor_id TEXT,
    action TEXT,
    target_type TEXT,
    target_id TEXT,
    details JSONB,
    timestamp TIMESTAMPTZ
  );
  CREATE TABLE ${FIXTURE_SCHEMA}.webhook_events (
    guild_id TEXT, processed_at TIMESTAMPTZ
  );
  CREATE TABLE ${FIXTURE_SCHEMA}.license_validations (
    product_id UUID, created_at TIMESTAMPTZ
  );

  CREATE FUNCTION ${FIXTURE_SCHEMA}.commerce_income_wall_lock_guild(TEXT)
  RETURNS void LANGUAGE sql AS 'SELECT';

  CREATE FUNCTION ${FIXTURE_SCHEMA}.commerce_income_wall_lock_row()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END;
  $$;

  CREATE FUNCTION ${FIXTURE_SCHEMA}.commerce_income_wall_validate_row()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END;
  $$;

  CREATE FUNCTION ${FIXTURE_SCHEMA}.commerce_select_checkout_plan(TEXT, UUID)
  RETURNS SETOF ${FIXTURE_SCHEMA}.plans
  LANGUAGE sql
  AS 'SELECT * FROM ${FIXTURE_SCHEMA}.plans WHERE false';

  -- Pre-030 privacy RPC stubs: the migration executes a plain
  -- ALTER FUNCTION ... RENAME on purge_member_data(TEXT, TEXT) and a plain
  -- DROP FUNCTION on purge_guild_data(TEXT), so both must pre-exist.
  CREATE FUNCTION ${FIXTURE_SCHEMA}.purge_member_data(TEXT, TEXT)
  RETURNS JSONB
  LANGUAGE sql
  AS 'SELECT ''{}''::JSONB';

  CREATE FUNCTION ${FIXTURE_SCHEMA}.purge_guild_data(TEXT)
  RETURNS void
  LANGUAGE sql
  AS 'SELECT';
`;

const LEGACY_FIXTURE_SQL = `
  INSERT INTO ${FIXTURE_SCHEMA}.guild (id) VALUES ('${GUILD_ID}');

  INSERT INTO ${FIXTURE_SCHEMA}.products (
    id, guild_id, type, metadata, granted_role_ids, active, price_cents
  ) VALUES
    (
      '${PRODUCT_PERMANENT}', '${GUILD_ID}', 'one_time',
      '{"grant_role_id":"${ROLE_PERMANENT}","role_duration_hours":0,"historical_grant_role_ids":["${ROLE_HISTORICAL}","not-a-snowflake",42],"keep":"permanent"}',
      ARRAY['${ROLE_EXISTING}'], false, 1000
    ),
    (
      '${PRODUCT_TEMPORARY}', '${GUILD_ID}', 'one_time',
      '{"grant_role_id":"${ROLE_TEMPORARY}","role_duration_hours":24,"keep":"temporary"}',
      '{}'::TEXT[], false, 1000
    ),
    (
      '${PRODUCT_INVALID}', '${GUILD_ID}', 'one_time',
      '{"grant_role_id":{"raw":"role-object"},"role_duration_hours":"forever","keep":"invalid"}',
      '{}'::TEXT[], false, 1000
    ),
    (
      '${PRODUCT_AMBIGUOUS_ENTITLEMENT}', '${GUILD_ID}', 'one_time',
      '{"grant_role_id":"${ROLE_AMBIGUOUS_ENTITLEMENT}","keep":"ambiguous-entitlement"}',
      '{}'::TEXT[], false, 1000
    ),
    (
      '${PRODUCT_AMBIGUOUS_ORDER}', '${GUILD_ID}', 'one_time',
      '{"grant_role_id":"${ROLE_AMBIGUOUS_ORDER}","keep":"ambiguous-order"}',
      '{}'::TEXT[], false, 1000
    ),
    (
      '${PRODUCT_TERMINAL}', '${GUILD_ID}', 'one_time',
      '{"keep":"terminal"}',
      ARRAY['${ROLE_TERMINAL}'], false, 1000
    ),
    (
      '${PRODUCT_INVALID_ROLE_VALID_DURATION}', '${GUILD_ID}', 'one_time',
      '{"grant_role_id":"not-a-snowflake","role_duration_hours":24,"keep":"invalid-role-valid-duration"}',
      '{}'::TEXT[], false, 1000
    ),
    (
      '${PRODUCT_DURATION_ONLY}', '${GUILD_ID}', 'one_time',
      '{"role_duration_hours":12,"keep":"duration-only"}',
      '{}'::TEXT[], false, 1000
    ),
    (
      '${PRODUCT_UNSUPPORTED_DURATION}', '${GUILD_ID}', 'subscription',
      '{"grant_role_id":"${ROLE_UNSUPPORTED_DURATION}","role_duration_hours":48,"keep":"unsupported-duration"}',
      '{}'::TEXT[], false, 1000
    );

  INSERT INTO ${FIXTURE_SCHEMA}.customers (id, guild_id, discord_id)
  VALUES ('${CUSTOMER_ID}', '${GUILD_ID}', 'migration-fixture-user');

  INSERT INTO ${FIXTURE_SCHEMA}.plans (
    id, product_id, guild_id, name, paypal_plan_id, price_cents, currency
  ) VALUES (
    '${LEGACY_SALE_PLAN_ID}', '${PRODUCT_UNSUPPORTED_DURATION}', '${GUILD_ID}',
    'Legacy sale plan', 'PLAN-LEGACY-SALE', 1000, 'USD'
  );

  INSERT INTO ${FIXTURE_SCHEMA}.entitlements (
    id, customer_id, guild_id, product_id, type, status, source, granted_role_ids
  ) VALUES (
    '${ENTITLEMENT_ID}', '${CUSTOMER_ID}', '${GUILD_ID}',
    '${PRODUCT_AMBIGUOUS_ENTITLEMENT}', 'one_time', 'active', 'purchase', '{}'::TEXT[]
  );

  INSERT INTO ${FIXTURE_SCHEMA}.orders (
    id, customer_id, guild_id, product_id, paypal_order_id,
    amount_cents, currency, source, status
  ) VALUES
    (
      '${ORDER_ID}', '${CUSTOMER_ID}', '${GUILD_ID}', '${PRODUCT_AMBIGUOUS_ORDER}',
      'bad:legacy-order', 1000, 'USD', 'purchase', 'completed'
    ),
    (
      '${TERMINAL_ORDER_ID}', '${CUSTOMER_ID}', '${GUILD_ID}', '${PRODUCT_TERMINAL}',
      'PAYPAL-TERMINAL-FIXTURE', 1000, 'USD', 'purchase', 'completed'
    ),
    (
      '${LEGACY_SALE_ORDER_ID}', '${CUSTOMER_ID}', '${GUILD_ID}',
      '${PRODUCT_UNSUPPORTED_DURATION}', NULL, 1000, 'USD', 'purchase', 'completed'
    );

  UPDATE ${FIXTURE_SCHEMA}.orders
     SET plan_id = '${LEGACY_SALE_PLAN_ID}',
         paypal_subscription_id = 'SUB-LEGACY-SALE'
   WHERE id = '${LEGACY_SALE_ORDER_ID}';

  INSERT INTO ${FIXTURE_SCHEMA}.payments (
    id, order_id, customer_id, guild_id, paypal_payment_id,
    amount_cents, currency, status, provider
  ) VALUES (
    '${LEGACY_INVALID_PAYMENT_ID}', '${ORDER_ID}', '${CUSTOMER_ID}', '${GUILD_ID}',
    'bad:legacy-capture', 1000, 'USD', 'completed', 'paypal'
  ), (
    '${LEGACY_INVALID_SALE_PAYMENT_ID}', '${LEGACY_SALE_ORDER_ID}', '${CUSTOMER_ID}',
    '${GUILD_ID}', 'bad:legacy-sale', 1000, 'USD', 'completed', 'paypal'
  );

  INSERT INTO ${FIXTURE_SCHEMA}.payment_refunds (
    id, payment_id, order_id, guild_id, paypal_refund_id,
    event_type, amount_cents, currency
  ) VALUES (
    '${LEGACY_INVALID_REFUND_ID}', '${LEGACY_INVALID_PAYMENT_ID}', '${ORDER_ID}',
    '${GUILD_ID}', 'bad/legacy-refund', 'PAYMENT.CAPTURE.REFUNDED', 1000, 'USD'
  );

  INSERT INTO ${FIXTURE_SCHEMA}.entitlements (
    id, customer_id, guild_id, product_id, order_id,
    type, status, source, granted_role_ids
  ) VALUES (
    '${TERMINAL_ENTITLEMENT_ID}', '${CUSTOMER_ID}', '${GUILD_ID}',
    '${PRODUCT_TERMINAL}', '${TERMINAL_ORDER_ID}',
    'one_time', 'expired', 'purchase', ARRAY['${ROLE_TERMINAL}']
  );

  INSERT INTO ${FIXTURE_SCHEMA}.bot_action_queue (
    id, guild_id, action, payload, status, started_at, next_retry_at
  ) VALUES
    (
      '${LEGACY_REVOKE_PENDING_ID}', '${GUILD_ID}', 'revoke_roles',
      '{"discord_id":"migration-fixture-user","role_ids":["${ROLE_TERMINAL}"],"reason":"refund","order_id":"${TERMINAL_ORDER_ID}"}',
      'pending', NULL, now()
    ),
    (
      '${LEGACY_REVOKE_DRAINED_ID}', '${GUILD_ID}', 'revoke_roles',
      '{"discord_id":"migration-fixture-user","role_ids":["${ROLE_TERMINAL}"],"reason":"subscription_expired","order_id":"${TERMINAL_ORDER_ID}","product_id":"${PRODUCT_TERMINAL}"}',
      'failed', NULL, NULL
    ),
    (
      '${LEGACY_REVOKE_FAILED_ID}', '${GUILD_ID}', 'revoke_roles',
      '{"discord_id":"migration-fixture-user","role_ids":["${ROLE_TERMINAL}"],"reason":"refunded","order_id":"${TERMINAL_ORDER_ID}"}',
      'failed', NULL, NULL
    );

  INSERT INTO ${FIXTURE_SCHEMA}.action_queue_dlq (
    id, guild_id, action, payload, error_message, retried
  ) VALUES (
    '${LEGACY_REVOKE_DLQ_ID}', '${GUILD_ID}', 'revoke_roles',
    '{"discord_id":"migration-fixture-user","role_ids":["${ROLE_TERMINAL}"],"reason":"refund","order_id":"${TERMINAL_ORDER_ID}"}',
    'legacy handler failed', false
  );
`;

describe('20260711030000 legacy metadata migration', () => {
  beforeAll(async () => {
    await requireSupabase();
    sql = postgres(getTestDbUrl(), { max: 1 });

    await sql.unsafe(`DROP SCHEMA IF EXISTS ${FIXTURE_SCHEMA} CASCADE`);
    await sql.unsafe(PRE_MIGRATION_SCHEMA_SQL);
    await sql.unsafe(LEGACY_FIXTURE_SQL);
    await sql.unsafe(migrationSql());
  }, 60_000);

  afterAll(async () => {
    if (sql) {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${FIXTURE_SCHEMA} CASCADE`);
      await sql.end();
    }
  });

  it('declares deterministic deployment write fences before validation and rewrite work', () => {
    const wall = migrationSource('20260711010000_commerce_income_wall_atomicity.sql');
    const productLock = wall.indexOf(
      'LOCK TABLE public.products IN SHARE ROW EXCLUSIVE MODE',
    );
    const planLock = wall.indexOf(
      'LOCK TABLE public.plans IN SHARE ROW EXCLUSIVE MODE',
    );
    const incomeLock = wall.indexOf(
      'LOCK TABLE public.economy_role_income IN SHARE ROW EXCLUSIVE MODE',
    );
    const dirtyValidation = wall.indexOf('-- Existing non-positive rows');
    const triggerInstall = wall.indexOf('CREATE TRIGGER commerce_income_wall_products_lock');

    expect(productLock).toBeGreaterThan(-1);
    expect(planLock).toBeGreaterThan(productLock);
    expect(incomeLock).toBeGreaterThan(planLock);
    expect(dirtyValidation).toBeGreaterThan(incomeLock);
    expect(triggerInstall).toBeGreaterThan(dirtyValidation);

    const metadata = migrationSource(
      '20260711030000_canonicalize_commerce_role_metadata.sql',
    );
    // The 030 migration takes one canonical multi-table exclusive lock up
    // front (NOWAIT), then refuses to deploy over an undrained queue, and
    // only after both fences does classification/strip/constraint work run.
    const metadataLock = metadata.indexOf('IN EXCLUSIVE MODE NOWAIT');
    const lockList = metadata.indexOf('LOCK TABLE\n  public.orders,');
    const queueInLockList = metadata.indexOf('  public.bot_action_queue,');
    const dlqInLockList = metadata.indexOf('  public.action_queue_dlq\n');
    const drainedQueueFence = metadata.indexOf(
      'commerce role-delivery protocol deploy requires a drained action queue',
    );
    const classification = metadata.indexOf('-- Invalid grant_role_id values');
    const legacyQueueQuarantine = metadata.indexOf(
      '-- Old broad revoke payloads cannot be upgraded into exact removal authority',
    );
    const strip = metadata.indexOf('-- Remove every reserved side-channel key');
    const constraint = metadata.indexOf('ADD CONSTRAINT products_no_legacy_role_metadata');

    expect(lockList).toBeGreaterThan(-1);
    expect(queueInLockList).toBeGreaterThan(lockList);
    expect(dlqInLockList).toBeGreaterThan(queueInLockList);
    expect(metadataLock).toBeGreaterThan(dlqInLockList);
    expect(drainedQueueFence).toBeGreaterThan(metadataLock);
    expect(classification).toBeGreaterThan(drainedQueueFence);
    expect(strip).toBeGreaterThan(classification);
    expect(constraint).toBeGreaterThan(strip);
    expect(legacyQueueQuarantine).toBeGreaterThan(constraint);
  });

  it('canonicalizes permanent config and moves temporary config to the typed table', async () => {
    const products = await sql.unsafe<Array<{
      id: string;
      granted_role_ids: string[];
      metadata: Record<string, unknown>;
    }>>(`
      SELECT id::TEXT, granted_role_ids, metadata
        FROM ${FIXTURE_SCHEMA}.products
       WHERE id IN ('${PRODUCT_PERMANENT}', '${PRODUCT_TEMPORARY}')
       ORDER BY id
    `);

    expect(products).toEqual([
      {
        id: PRODUCT_PERMANENT,
        granted_role_ids: [ROLE_EXISTING, ROLE_PERMANENT],
        metadata: { keep: 'permanent' },
      },
      {
        id: PRODUCT_TEMPORARY,
        granted_role_ids: [],
        metadata: { keep: 'temporary' },
      },
    ]);

    const typed = await sql.unsafe<Array<{
      id: string;
      product_id: string;
      role_id: string;
      duration_seconds: number;
    }>>(`
      SELECT id::TEXT, product_id::TEXT, role_id, duration_seconds
        FROM ${FIXTURE_SCHEMA}.commerce_product_temp_role_config
       WHERE product_id = '${PRODUCT_TEMPORARY}'
    `);

    expect(typed).toHaveLength(1);
    expect(typed[0]).toMatchObject({
      product_id: PRODUCT_TEMPORARY,
      role_id: ROLE_TEMPORARY,
      duration_seconds: 86_400,
    });
    expect(typed[0]!.id).toMatch(/^[0-9a-f-]{36}$/);

    const falseCanonicalIssue = await sql.unsafe<Array<{ count: number }>>(`
      SELECT count(*)::INTEGER AS count
        FROM ${FIXTURE_SCHEMA}.commerce_role_metadata_migration_issues
       WHERE product_id = '${PRODUCT_TEMPORARY}'
    `);
    expect(falseCanonicalIssue[0]!.count).toBe(0);
  });

  it('preserves noncanonical legacy PayPal ids for inspection without authorizing them', async () => {
    const [legacy] = await sql.unsafe<Array<{
      paypal_order_id: string;
      paypal_payment_id: string;
      paypal_refund_id: string;
      terminal_witness: boolean;
    }>>(`
      SELECT paid_order.paypal_order_id,
             payment.paypal_payment_id,
             refund.paypal_refund_id,
             refund.is_terminal_event_witness AS terminal_witness
        FROM ${FIXTURE_SCHEMA}.orders AS paid_order
        JOIN ${FIXTURE_SCHEMA}.payments AS payment
          ON payment.order_id = paid_order.id
        JOIN ${FIXTURE_SCHEMA}.payment_refunds AS refund
          ON refund.payment_id = payment.id
       WHERE paid_order.id = '${ORDER_ID}'
    `);
    expect(legacy).toEqual({
      paypal_order_id: 'bad:legacy-order',
      paypal_payment_id: 'bad:legacy-capture',
      paypal_refund_id: 'bad/legacy-refund',
      terminal_witness: false,
    });

    const [legacySale] = await sql.unsafe<Array<{
      paypal_payment_id: string;
      paypal_resource_type: string;
    }>>(`
      SELECT payment.paypal_payment_id,
             payment.paypal_resource_type
        FROM ${FIXTURE_SCHEMA}.payments AS payment
       WHERE payment.id = '${LEGACY_INVALID_SALE_PAYMENT_ID}'
    `);
    expect(legacySale).toEqual({
      paypal_payment_id: 'bad:legacy-sale',
      paypal_resource_type: 'sale',
    });

    const constraints = await sql.unsafe<Array<{
      conname: string;
      convalidated: boolean;
    }>>(`
      SELECT constraint_row.conname, constraint_row.convalidated
        FROM pg_catalog.pg_constraint AS constraint_row
        JOIN pg_catalog.pg_class AS relation
          ON relation.oid = constraint_row.conrelid
        JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = '${FIXTURE_SCHEMA}'
         AND constraint_row.conname IN (
           'orders_paypal_order_id_canonical',
           'payments_paypal_payment_id_canonical',
           'payment_refunds_provider_id_canonical'
         )
       ORDER BY constraint_row.conname
    `);
    expect(constraints).toEqual([
      { conname: 'orders_paypal_order_id_canonical', convalidated: false },
      { conname: 'payment_refunds_provider_id_canonical', convalidated: false },
      { conname: 'payments_paypal_payment_id_canonical', convalidated: false },
    ]);

    await expect(sql.unsafe(`
      SELECT ${FIXTURE_SCHEMA}.commerce_prepare_admin_refund(
        '${ORDER_ID}'::UUID,
        '${GUILD_ID}',
        '100000000000000999',
        'legacy malformed provider identity'
      )
    `)).rejects.toMatchObject({
      code: '23514',
      message: expect.stringContaining('payment capture set requires operator remediation'),
    });

    const invalidOrderIds = [
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
    for (const invalidOrderId of invalidOrderIds) {
      await expect(sql`
        UPDATE ${sql(FIXTURE_SCHEMA)}.orders
           SET paypal_order_id = ${invalidOrderId}
         WHERE id = ${TERMINAL_ORDER_ID}::UUID
      `).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('preserves raw invalid role and duration JSON in quarantine', async () => {
    const issues = await sql.unsafe<Array<{
      issue_type: string;
      details: Record<string, unknown>;
    }>>(`
      SELECT issue_type, details
        FROM ${FIXTURE_SCHEMA}.commerce_role_metadata_migration_issues
       WHERE product_id = '${PRODUCT_INVALID}'
       ORDER BY issue_type
    `);

    expect(issues).toEqual([
      {
        issue_type: 'invalid_duration',
        details: {
          source: 'metadata.role_duration_hours',
          raw_grant_role_id: { raw: 'role-object' },
          raw_role_duration_hours: 'forever',
          raw_reserved_metadata: {
            grant_role_id: { raw: 'role-object' },
            role_duration_hours: 'forever',
          },
        },
      },
      {
        issue_type: 'invalid_role_id',
        details: {
          source: 'metadata.grant_role_id',
          raw_grant_role_id: { raw: 'role-object' },
          raw_reserved_metadata: {
            grant_role_id: { raw: 'role-object' },
            role_duration_hours: 'forever',
          },
        },
      },
    ]);
  });

  it('losslessly quarantines every noncanonical role-duration combination', async () => {
    const issues = await sql.unsafe<Array<{
      product_id: string;
      issue_type: string;
      details: Record<string, unknown>;
    }>>(`
      SELECT product_id::TEXT, issue_type, details
        FROM ${FIXTURE_SCHEMA}.commerce_role_metadata_migration_issues
       WHERE product_id IN (
         '${PRODUCT_INVALID_ROLE_VALID_DURATION}',
         '${PRODUCT_DURATION_ONLY}',
         '${PRODUCT_UNSUPPORTED_DURATION}'
       )
       ORDER BY product_id, issue_type
    `);

    expect(issues).toEqual([
      {
        product_id: PRODUCT_INVALID_ROLE_VALID_DURATION,
        issue_type: 'invalid_role_id',
        details: {
          source: 'metadata.grant_role_id',
          raw_grant_role_id: 'not-a-snowflake',
          raw_reserved_metadata: {
            grant_role_id: 'not-a-snowflake',
            role_duration_hours: 24,
          },
        },
      },
      {
        product_id: PRODUCT_DURATION_ONLY,
        issue_type: 'orphan_duration',
        details: {
          source: 'metadata.role_duration_hours_without_grant_role_id',
          raw_role_duration_hours: 12,
          raw_reserved_metadata: { role_duration_hours: 12 },
        },
      },
      {
        product_id: PRODUCT_UNSUPPORTED_DURATION,
        issue_type: 'unsupported_product_type',
        details: {
          source: 'metadata.grant_role_id',
          product_type: 'subscription',
          raw_reserved_metadata: {
            grant_role_id: ROLE_UNSUPPORTED_DURATION,
            role_duration_hours: 48,
          },
        },
      },
    ]);
  });

  it('records both entitlement and completed-order ambiguity without fabricating snapshots', async () => {
    const issues = await sql.unsafe<Array<{
      product_id: string;
      role_id: string;
      details: { source: string };
    }>>(`
      SELECT product_id::TEXT, role_id, details
        FROM ${FIXTURE_SCHEMA}.commerce_role_metadata_migration_issues
       WHERE issue_type = 'ambiguous_permanent_history'
       ORDER BY product_id
    `);

    expect(issues).toEqual([
      {
        product_id: PRODUCT_AMBIGUOUS_ENTITLEMENT,
        role_id: ROLE_AMBIGUOUS_ENTITLEMENT,
        details: { source: 'legacy purchase entitlement without role snapshot' },
      },
      {
        product_id: PRODUCT_AMBIGUOUS_ORDER,
        role_id: ROLE_AMBIGUOUS_ORDER,
        details: { source: 'completed paid order without exact role snapshot' },
      },
    ]);

    const entitlement = await sql.unsafe<Array<{ granted_role_ids: string[] }>>(`
      SELECT granted_role_ids
        FROM ${FIXTURE_SCHEMA}.entitlements
       WHERE id = '${ENTITLEMENT_ID}'
    `);
    expect(entitlement[0]!.granted_role_ids).toEqual([]);
  });

  it('quarantines historical arrays and strips only reserved metadata keys', async () => {
    const issues = await sql.unsafe<Array<{
      issue_type: string;
      role_id: string | null;
      details: Record<string, unknown>;
    }>>(`
      SELECT issue_type, role_id, details
        FROM ${FIXTURE_SCHEMA}.commerce_role_metadata_migration_issues
       WHERE product_id = '${PRODUCT_PERMANENT}'
         AND issue_type IN ('ambiguous_historical_role', 'invalid_historical_roles')
       ORDER BY issue_type
    `);

    expect(issues).toEqual([
      {
        issue_type: 'ambiguous_historical_role',
        role_id: ROLE_HISTORICAL,
        details: {
          source: 'metadata.historical_grant_role_ids',
          raw_reserved_metadata: {
            grant_role_id: ROLE_PERMANENT,
            historical_grant_role_ids: [ROLE_HISTORICAL, 'not-a-snowflake', 42],
            role_duration_hours: 0,
          },
        },
      },
      {
        issue_type: 'invalid_historical_roles',
        role_id: null,
        details: {
          source: 'metadata.historical_grant_role_ids',
          raw: [ROLE_HISTORICAL, 'not-a-snowflake', 42],
          raw_reserved_metadata: {
            grant_role_id: ROLE_PERMANENT,
            historical_grant_role_ids: [ROLE_HISTORICAL, 'not-a-snowflake', 42],
            role_duration_hours: 0,
          },
        },
      },
    ]);

    const reserved = await sql.unsafe<Array<{ count: number }>>(`
      SELECT count(*)::INTEGER AS count
        FROM ${FIXTURE_SCHEMA}.products
       WHERE metadata ?| ARRAY[
         'grant_role_id', 'historical_grant_role_ids', 'role_duration_hours'
       ]
    `);
    expect(reserved[0]!.count).toBe(0);

    const retained = await sql.unsafe<Array<{ keep_value: string }>>(`
      SELECT metadata ->> 'keep' AS keep_value
        FROM ${FIXTURE_SCHEMA}.products
       ORDER BY id
    `);
    expect(retained.map((row) => row.keep_value)).toEqual([
      'permanent',
      'temporary',
      'invalid',
      'ambiguous-entitlement',
      'ambiguous-order',
      'terminal',
      'invalid-role-valid-duration',
      'duration-only',
      'unsupported-duration',
    ]);
  });

  it('does not fabricate exact removal authority for an already-terminal paid entitlement', async () => {
    // The migration's locked contract: legacy metadata is never upgraded into
    // exact Discord removal authority. A terminal paid entitlement therefore
    // gets NO backfilled revoke carrier — cleanup ownership stays unproven
    // until an operator (or a real exact intent) resolves it.
    const fabricated = await sql.unsafe<Array<{ count: number }>>(`
      SELECT count(*)::INTEGER AS count
        FROM ${FIXTURE_SCHEMA}.bot_action_queue
       WHERE idempotency_key LIKE '%terminal-entitlement:${TERMINAL_ENTITLEMENT_ID}%'
          OR payload ->> 'entitlement_id' = '${TERMINAL_ENTITLEMENT_ID}'
    `);
    expect(fabricated[0]!.count).toBe(0);

    // No live revoke authority remains anywhere after deployment: every
    // pre-protocol revoke row was quarantined, none re-issued.
    const actionable = await sql.unsafe<Array<{ count: number }>>(`
      SELECT count(*)::INTEGER AS count
        FROM ${FIXTURE_SCHEMA}.bot_action_queue
       WHERE action = 'revoke_roles'
         AND status IN ('staged', 'pending', 'processing')
    `);
    expect(actionable[0]!.count).toBe(0);

    // The terminal paid entitlement's role snapshot is untouched evidence.
    const entitlement = await sql.unsafe<Array<{ granted_role_ids: string[] }>>(`
      SELECT granted_role_ids
        FROM ${FIXTURE_SCHEMA}.entitlements
       WHERE id = '${TERMINAL_ENTITLEMENT_ID}'
    `);
    expect(entitlement[0]!.granted_role_ids).toEqual([ROLE_TERMINAL]);
  });

  it('quarantines every actionable legacy revoke row instead of honoring it', async () => {
    // Broad pre-protocol revoke payloads cannot prove Somnibot owns the roles
    // they would remove. The migration retires each one as failed operator
    // evidence and raises exactly one critical review alert per action.
    const legacyRows = await sql.unsafe<Array<{
      id: string;
      status: string;
      result: Record<string, unknown> | null;
      started_at: string | null;
      completed_at: string | null;
      next_retry_at: string | null;
      error_message: string;
    }>>(`
      SELECT id::TEXT, status, result, started_at::TEXT,
             completed_at::TEXT, next_retry_at::TEXT, error_message
        FROM ${FIXTURE_SCHEMA}.bot_action_queue
       WHERE id IN (
         '${LEGACY_REVOKE_PENDING_ID}',
         '${LEGACY_REVOKE_DRAINED_ID}',
         '${LEGACY_REVOKE_FAILED_ID}'
       )
       ORDER BY id
    `);

    expect(legacyRows).toHaveLength(3);
    for (const row of legacyRows) {
      expect(row).toMatchObject({
        status: 'failed',
        started_at: null,
        next_retry_at: null,
        completed_at: expect.any(String),
        error_message:
          'Quarantined: exact role-delivery intent is required for Discord cleanup',
      });
    }

    const alerts = await sql.unsafe<Array<{
      action_id: string;
      alert_type: string;
      severity: string;
      resolved: boolean;
    }>>(`
      SELECT metadata ->> 'action_id' AS action_id,
             alert_type, severity, resolved
        FROM ${FIXTURE_SCHEMA}.alerts
       WHERE alert_type = 'commerce_legacy_role_revoke_quarantined'
       ORDER BY metadata ->> 'action_id'
    `);
    expect(alerts).toEqual([
      LEGACY_REVOKE_PENDING_ID,
      LEGACY_REVOKE_DRAINED_ID,
      LEGACY_REVOKE_FAILED_ID,
    ].sort().map((actionId) => ({
      action_id: actionId,
      alert_type: 'commerce_legacy_role_revoke_quarantined',
      severity: 'critical',
      resolved: false,
    })));

    const dlq = await sql.unsafe<Array<{
      retried: boolean;
      retried_at: string | null;
      error_message: string;
    }>>(`
      SELECT retried, retried_at::TEXT, error_message
        FROM ${FIXTURE_SCHEMA}.action_queue_dlq
       WHERE id = '${LEGACY_REVOKE_DLQ_ID}'
    `);
    expect(dlq).toEqual([
      expect.objectContaining({
        retried: true,
        retried_at: expect.any(String),
        error_message: expect.stringContaining(
          'Quarantined: exact role-delivery intent is required for Discord cleanup',
        ),
      }),
    ]);

    // Nothing actionable survives: neither live queue rows nor unretried DLQ
    // buttons may carry pre-protocol revoke payloads out of the migration.
    const actionable = await sql.unsafe<Array<{ count: number }>>(`
      SELECT (
        SELECT count(*)
          FROM ${FIXTURE_SCHEMA}.bot_action_queue AS queue
         WHERE queue.action = 'revoke_roles'
           AND queue.status IN ('staged', 'pending', 'processing')
      ) + (
        SELECT count(*)
          FROM ${FIXTURE_SCHEMA}.action_queue_dlq AS dlq
         WHERE dlq.action = 'revoke_roles'
           AND dlq.retried = false
      ) AS count
    `);
    expect(actionable[0]!.count).toBe(0);
  });

  it('quarantines even a full-key canonical-shaped legacy revoke instead of honoring it', async () => {
    // A legacy queue row that already carries every canonical payload key is
    // still pre-protocol data: nothing proves those role_ids are Somnibot's
    // exact removal authority. Deployment must succeed while retiring the row
    // to failed quarantine evidence — never replaying it against Discord.
    const unprovableSchema = 'commerce_metadata_unprovable_fixture';
    const unprovableQueueId = '50000000-0000-4000-8000-000000000099';
    const preMigration = PRE_MIGRATION_SCHEMA_SQL.replaceAll(
      FIXTURE_SCHEMA,
      unprovableSchema,
    );
    const legacyFixture = LEGACY_FIXTURE_SQL.replaceAll(
      FIXTURE_SCHEMA,
      unprovableSchema,
    );
    const source = migrationSource(
      '20260711030000_canonicalize_commerce_role_metadata.sql',
    ).replaceAll('public.', `${unprovableSchema}.`);

    await sql.unsafe(`DROP SCHEMA IF EXISTS ${unprovableSchema} CASCADE`);
    let applySql: Sql | null = null;
    try {
      await sql.unsafe(preMigration);
      await sql.unsafe(legacyFixture);
      await sql.unsafe(`
        INSERT INTO ${unprovableSchema}.bot_action_queue (
          id, guild_id, action, payload, status, next_retry_at
        ) VALUES (
          '${unprovableQueueId}',
          '${GUILD_ID}',
          'revoke_roles',
          '{"guild_id":"${GUILD_ID}","discord_id":"migration-fixture-user","role_ids":["${ROLE_TERMINAL}","199999999999999999"],"temporary_role_grant_ids":[],"entitlement_id":"${TERMINAL_ENTITLEMENT_ID}","customer_id":"${CUSTOMER_ID}","order_id":"${TERMINAL_ORDER_ID}","product_id":"${PRODUCT_TERMINAL}","reason":"entitlement_expired","source":"entitlement_status_trigger"}',
          'pending',
          now()
        )
      `);

      // The migration owns an explicit transaction. Apply it on a disposable
      // connection so an unexpected failure cannot poison this suite's shared
      // fixture connection or its cleanup query.
      applySql = postgres(getTestDbUrl(), { max: 1 });
      await applySql.unsafe(source);

      const quarantined = await sql.unsafe<Array<{
        status: string;
        started_at: string | null;
        next_retry_at: string | null;
        error_message: string;
      }>>(`
        SELECT status, started_at::TEXT, next_retry_at::TEXT, error_message
          FROM ${unprovableSchema}.bot_action_queue
         WHERE id = '${unprovableQueueId}'
      `);
      expect(quarantined).toEqual([
        {
          status: 'failed',
          started_at: null,
          next_retry_at: null,
          error_message:
            'Quarantined: exact role-delivery intent is required for Discord cleanup',
        },
      ]);

      const alert = await sql.unsafe<Array<{ count: number }>>(`
        SELECT count(*)::INTEGER AS count
          FROM ${unprovableSchema}.alerts
         WHERE alert_type = 'commerce_legacy_role_revoke_quarantined'
           AND resolved = false
           AND metadata ->> 'action_id' = '${unprovableQueueId}'
      `);
      expect(alert[0]!.count).toBe(1);

      const actionable = await sql.unsafe<Array<{ count: number }>>(`
        SELECT count(*)::INTEGER AS count
          FROM ${unprovableSchema}.bot_action_queue
         WHERE action = 'revoke_roles'
           AND status IN ('staged', 'pending', 'processing')
      `);
      expect(actionable[0]!.count).toBe(0);
    } finally {
      if (applySql) {
        try {
          await applySql.unsafe('ROLLBACK');
        } catch (error) {
          if (
            !error ||
            typeof error !== 'object' ||
            !('code' in error) ||
            error.code !== '25P01'
          ) {
            throw error;
          }
        } finally {
          await applySql.end();
        }
      }
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${unprovableSchema} CASCADE`);
    }
  }, 60_000);
});
