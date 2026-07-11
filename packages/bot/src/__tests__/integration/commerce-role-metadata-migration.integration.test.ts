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
    amount_cents INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    status TEXT NOT NULL,
    provider TEXT
  );

  CREATE TABLE ${FIXTURE_SCHEMA}.entitlements (
    id UUID PRIMARY KEY,
    customer_id UUID REFERENCES ${FIXTURE_SCHEMA}.customers(id),
    guild_id TEXT NOT NULL REFERENCES ${FIXTURE_SCHEMA}.guild(id),
    product_id UUID REFERENCES ${FIXTURE_SCHEMA}.products(id),
    order_id UUID REFERENCES ${FIXTURE_SCHEMA}.orders(id),
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    source TEXT,
    granted_role_ids TEXT[] DEFAULT '{}'::TEXT[]
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
    status TEXT NOT NULL
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
    guild_id TEXT, timestamp TIMESTAMPTZ
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
      'PAYPAL-MIGRATION-FIXTURE', 1000, 'USD', 'purchase', 'completed'
    ),
    (
      '${TERMINAL_ORDER_ID}', '${CUSTOMER_ID}', '${GUILD_ID}', '${PRODUCT_TERMINAL}',
      'PAYPAL-TERMINAL-FIXTURE', 1000, 'USD', 'purchase', 'completed'
    );

  INSERT INTO ${FIXTURE_SCHEMA}.entitlements (
    id, customer_id, guild_id, product_id, order_id,
    type, status, source, granted_role_ids
  ) VALUES (
    '${TERMINAL_ENTITLEMENT_ID}', '${CUSTOMER_ID}', '${GUILD_ID}',
    '${PRODUCT_TERMINAL}', '${TERMINAL_ORDER_ID}',
    'one_time', 'expired', 'purchase', ARRAY['${ROLE_TERMINAL}']
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
    const metadataLock = metadata.indexOf(
      'LOCK TABLE public.products IN SHARE ROW EXCLUSIVE MODE',
    );
    const classification = metadata.indexOf('-- Invalid grant_role_id values');
    const strip = metadata.indexOf('-- Remove every reserved side-channel key');
    const constraint = metadata.indexOf('ADD CONSTRAINT products_no_legacy_role_metadata');

    expect(metadataLock).toBeGreaterThan(-1);
    expect(classification).toBeGreaterThan(metadataLock);
    expect(strip).toBeGreaterThan(classification);
    expect(constraint).toBeGreaterThan(strip);
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

  it('backfills one exact pending revoke intent for an already-terminal paid entitlement', async () => {
    const queue = await sql.unsafe<Array<{
      guild_id: string;
      action: string;
      status: string;
      idempotency_key: string;
      payload: Record<string, unknown>;
    }>>(`
      SELECT guild_id, action, status, idempotency_key, payload
        FROM ${FIXTURE_SCHEMA}.bot_action_queue
       WHERE idempotency_key =
         'commerce:terminal-entitlement:${TERMINAL_ENTITLEMENT_ID}:revoke_roles'
    `);

    expect(queue).toEqual([
      {
        guild_id: GUILD_ID,
        action: 'revoke_roles',
        status: 'pending',
        idempotency_key:
          `commerce:terminal-entitlement:${TERMINAL_ENTITLEMENT_ID}:revoke_roles`,
        payload: {
          guild_id: GUILD_ID,
          discord_id: 'migration-fixture-user',
          role_ids: [ROLE_TERMINAL],
          reason: 'entitlement_expired',
          entitlement_id: TERMINAL_ENTITLEMENT_ID,
          customer_id: CUSTOMER_ID,
          order_id: TERMINAL_ORDER_ID,
          product_id: PRODUCT_TERMINAL,
          source: 'entitlement_terminal_migration_backfill',
        },
      },
    ]);
  });
});
