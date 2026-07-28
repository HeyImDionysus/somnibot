/**
 * Real-PostgreSQL proof for migration 20260728010000.
 *
 * The normal integration database is already fully migrated, so this creates
 * an isolated schema with the exact pre-migration FK model, seeds existing
 * money/access rows, applies the production migration text with only the
 * `public.` qualifier redirected, and exercises commit-time behavior.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTestDbUrl } from './helpers.js';

const FIXTURE_SCHEMA = 'paypal_dispute_status_fixture';
const DIRTY_SCHEMA = 'paypal_dispute_status_dirty_fixture';
const MIGRATION = '20260728010000_paypal_reconciliation_review_fixes.sql';

const ORDER_ID = '40000000-0000-4000-8000-000000000001';
const DEFERRED_ORDER_ID = '40000000-0000-4000-8000-000000000002';
const PAYMENT_ID = '50000000-0000-4000-8000-000000000001';
const DEFERRED_PAYMENT_ID = '50000000-0000-4000-8000-000000000002';
const ENTITLEMENT_ID = '60000000-0000-4000-8000-000000000001';
const LICENSE_ID = '70000000-0000-4000-8000-000000000001';
const CUSTOMER_ID = '20000000-0000-4000-8000-000000000001';
const PRODUCT_ID = '10000000-0000-4000-8000-000000000001';
const GUILD_ID = '111111111111111111';

let sql: Sql;

function migrationSource(): string {
  const testDir = dirname(fileURLToPath(import.meta.url));
  return readFileSync(
    resolve(testDir, '../../../../supabase/migrations', MIGRATION),
    'utf8',
  );
}

function migrationSql(schema: string): string {
  return migrationSource().replaceAll('public.', `${schema}.`);
}

function preMigrationSchema(schema: string, includeOldFks = true): string {
  return `
    CREATE SCHEMA ${schema};

    CREATE TABLE ${schema}.orders (
      id UUID PRIMARY KEY,
      guild_id TEXT NOT NULL,
      customer_id UUID NOT NULL,
      product_id UUID NOT NULL,
      status TEXT NOT NULL
    );

    CREATE UNIQUE INDEX ${schema}_orders_id_status
      ON ${schema}.orders (id, status);
    CREATE UNIQUE INDEX ${schema}_orders_access_status
      ON ${schema}.orders (id, guild_id, customer_id, product_id, status);

    CREATE TABLE ${schema}.payments (
      id UUID PRIMARY KEY,
      order_id UUID,
      guild_id TEXT,
      customer_id UUID,
      paypal_resource_type TEXT,
      status TEXT NOT NULL,
      commerce_required_order_status TEXT
      GENERATED ALWAYS AS (
        CASE
          WHEN paypal_resource_type = 'capture' AND status = 'completed'
            THEN 'completed'::TEXT
          WHEN paypal_resource_type = 'capture' AND status IN ('refunded', 'reversed')
            THEN 'refunded'::TEXT
          ELSE NULL::TEXT
        END
      ) STORED
    );

    CREATE TABLE ${schema}.entitlements (
      id UUID PRIMARY KEY,
      order_id UUID,
      guild_id TEXT,
      customer_id UUID,
      product_id UUID,
      source TEXT,
      status TEXT NOT NULL,
      commerce_required_order_status TEXT
      GENERATED ALWAYS AS (
        CASE
          WHEN (source = 'purchase' OR source IS NULL)
           AND status IN ('active', 'pending', 'grace_period', 'suspended')
            THEN 'completed'::TEXT
          ELSE NULL::TEXT
        END
      ) STORED
    );

    CREATE TABLE ${schema}.license_keys (
      id UUID PRIMARY KEY,
      order_id UUID,
      guild_id TEXT,
      customer_id UUID,
      product_id UUID,
      status TEXT NOT NULL,
      commerce_required_order_status TEXT
      GENERATED ALWAYS AS (
        CASE
          WHEN status IN ('pending_activation', 'active', 'suspended')
            THEN 'completed'::TEXT
          ELSE NULL::TEXT
        END
      ) STORED
    );

    CREATE TABLE ${schema}.alerts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      guild_id TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      resolved BOOLEAN NOT NULL DEFAULT false,
      resolved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    ${includeOldFks ? `
      ALTER TABLE ${schema}.payments
        ADD CONSTRAINT commerce_capture_payment_order_fk
        FOREIGN KEY (order_id, commerce_required_order_status)
        REFERENCES ${schema}.orders (id, status)
        DEFERRABLE INITIALLY DEFERRED;

      ALTER TABLE ${schema}.entitlements
        ADD CONSTRAINT commerce_paid_live_entitlement_order_fk
        FOREIGN KEY (
          order_id, guild_id, customer_id, product_id,
          commerce_required_order_status
        )
        REFERENCES ${schema}.orders (
          id, guild_id, customer_id, product_id, status
        )
        DEFERRABLE INITIALLY IMMEDIATE;

      ALTER TABLE ${schema}.license_keys
        ADD CONSTRAINT commerce_live_license_order_fk
        FOREIGN KEY (
          order_id, guild_id, customer_id, product_id,
          commerce_required_order_status
        )
        REFERENCES ${schema}.orders (
          id, guild_id, customer_id, product_id, status
        )
        DEFERRABLE INITIALLY IMMEDIATE;
    ` : ''}
  `;
}

const EXISTING_VALID_ROWS = `
  INSERT INTO ${FIXTURE_SCHEMA}.orders (
    id, guild_id, customer_id, product_id, status
  ) VALUES
    ('${ORDER_ID}', '${GUILD_ID}', '${CUSTOMER_ID}', '${PRODUCT_ID}', 'completed'),
    ('${DEFERRED_ORDER_ID}', '${GUILD_ID}', '${CUSTOMER_ID}', '${PRODUCT_ID}', 'completed');

  INSERT INTO ${FIXTURE_SCHEMA}.payments (
    id, order_id, guild_id, customer_id, paypal_resource_type, status
  ) VALUES
    ('${PAYMENT_ID}', '${ORDER_ID}', '${GUILD_ID}', '${CUSTOMER_ID}', 'capture', 'completed'),
    ('${DEFERRED_PAYMENT_ID}', '${DEFERRED_ORDER_ID}', '${GUILD_ID}', '${CUSTOMER_ID}', 'capture', 'completed');

  INSERT INTO ${FIXTURE_SCHEMA}.entitlements (
    id, order_id, guild_id, customer_id, product_id, source, status
  ) VALUES (
    '${ENTITLEMENT_ID}', '${ORDER_ID}', '${GUILD_ID}', '${CUSTOMER_ID}',
    '${PRODUCT_ID}', 'purchase', 'active'
  );

  INSERT INTO ${FIXTURE_SCHEMA}.license_keys (
    id, order_id, guild_id, customer_id, product_id, status
  ) VALUES (
    '${LICENSE_ID}', '${ORDER_ID}', '${GUILD_ID}', '${CUSTOMER_ID}',
    '${PRODUCT_ID}', 'active'
  );
`;

describe('PayPal disputed-order compatibility migration', () => {
  beforeAll(async () => {
    sql = postgres(getTestDbUrl(), { max: 1 });
    // This proof needs PostgreSQL DDL/catalog behavior, not PostgREST. Verify
    // the direct local database connection so a missing service-role API key
    // cannot incorrectly report that PostgreSQL itself is unavailable.
    await sql`SELECT 1`;
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${FIXTURE_SCHEMA} CASCADE`);
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${DIRTY_SCHEMA} CASCADE`);
    await sql.unsafe(preMigrationSchema(FIXTURE_SCHEMA));
    await sql.unsafe(EXISTING_VALID_ROWS);
    await sql.unsafe(migrationSql(FIXTURE_SCHEMA));
  }, 60_000);

  afterAll(async () => {
    if (!sql) return;
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${FIXTURE_SCHEMA} CASCADE`);
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${DIRTY_SCHEMA} CASCADE`);
    await sql.end();
  });

  it('validated every pre-existing-row FK and preserved its deferrability mode', async () => {
    const constraints = await sql.unsafe<Array<{
      conname: string;
      convalidated: boolean;
      condeferrable: boolean;
      condeferred: boolean;
      definition: string;
    }>>(`
      SELECT constraint_row.conname,
             constraint_row.convalidated,
             constraint_row.condeferrable,
             constraint_row.condeferred,
             pg_get_constraintdef(constraint_row.oid) AS definition
        FROM pg_constraint AS constraint_row
        JOIN pg_namespace AS namespace_row
          ON namespace_row.oid = constraint_row.connamespace
       WHERE namespace_row.nspname = '${FIXTURE_SCHEMA}'
         AND constraint_row.conname IN (
           'commerce_capture_payment_order_fk',
           'commerce_paid_live_entitlement_order_fk',
           'commerce_live_license_order_fk'
         )
       ORDER BY constraint_row.conname
    `);

    expect(constraints).toEqual([
      expect.objectContaining({
        conname: 'commerce_capture_payment_order_fk',
        convalidated: true,
        condeferrable: true,
        condeferred: true,
        definition: expect.stringContaining('commerce_compatible_child_status'),
      }),
      expect.objectContaining({
        conname: 'commerce_live_license_order_fk',
        convalidated: true,
        condeferrable: true,
        condeferred: false,
        definition: expect.stringContaining('commerce_compatible_child_status'),
      }),
      expect.objectContaining({
        conname: 'commerce_paid_live_entitlement_order_fk',
        convalidated: true,
        condeferrable: true,
        condeferred: false,
        definition: expect.stringContaining('commerce_compatible_child_status'),
      }),
    ]);
  });

  it('atomically marks a fulfilled order disputed without rewriting settlement or access', async () => {
    await sql.begin(async (transaction) => {
      await transaction.unsafe(`
        UPDATE ${FIXTURE_SCHEMA}.orders
           SET status = 'disputed'
         WHERE id = '${ORDER_ID}'
      `);
      await transaction.unsafe('SET CONSTRAINTS ALL IMMEDIATE');
    });

    const rows = await sql.unsafe<Array<{
      order_status: string;
      compatible_status: string;
      payment_status: string;
      entitlement_status: string;
      license_status: string;
    }>>(`
      SELECT paid_order.status AS order_status,
             paid_order.commerce_compatible_child_status AS compatible_status,
             payment.status AS payment_status,
             entitlement.status AS entitlement_status,
             license_key.status AS license_status
        FROM ${FIXTURE_SCHEMA}.orders AS paid_order
        JOIN ${FIXTURE_SCHEMA}.payments AS payment
          ON payment.order_id = paid_order.id
        JOIN ${FIXTURE_SCHEMA}.entitlements AS entitlement
          ON entitlement.order_id = paid_order.id
        JOIN ${FIXTURE_SCHEMA}.license_keys AS license_key
          ON license_key.order_id = paid_order.id
       WHERE paid_order.id = '${ORDER_ID}'
    `);

    expect(rows).toEqual([{
      order_status: 'disputed',
      compatible_status: 'completed',
      payment_status: 'completed',
      entitlement_status: 'active',
      license_status: 'active',
    }]);
  });

  it('keeps the capture FK genuinely deferred for a joint refund transition', async () => {
    await sql.begin(async (transaction) => {
      // Parent first would fail under an immediate FK. The deferred capture
      // constraint permits both halves to reach the compatible state at commit.
      await transaction.unsafe(`
        UPDATE ${FIXTURE_SCHEMA}.orders
           SET status = 'refunded'
         WHERE id = '${DEFERRED_ORDER_ID}'
      `);
      await transaction.unsafe(`
        UPDATE ${FIXTURE_SCHEMA}.payments
           SET status = 'refunded'
         WHERE id = '${DEFERRED_PAYMENT_ID}'
      `);
    });

    const rows = await sql.unsafe<Array<{ order_status: string; payment_status: string }>>(`
      SELECT paid_order.status AS order_status, payment.status AS payment_status
        FROM ${FIXTURE_SCHEMA}.orders AS paid_order
        JOIN ${FIXTURE_SCHEMA}.payments AS payment
          ON payment.order_id = paid_order.id
       WHERE paid_order.id = '${DEFERRED_ORDER_ID}'
    `);
    expect(rows).toEqual([{ order_status: 'refunded', payment_status: 'refunded' }]);
  });

  it('rejects an incompatible completed capture under a refunded parent', async () => {
    await expect(sql.begin(async (transaction) => {
      await transaction.unsafe(`
        UPDATE ${FIXTURE_SCHEMA}.entitlements
           SET status = 'expired'
         WHERE id = '${ENTITLEMENT_ID}'
      `);
      await transaction.unsafe(`
        UPDATE ${FIXTURE_SCHEMA}.license_keys
           SET status = 'revoked'
         WHERE id = '${LICENSE_ID}'
      `);
      await transaction.unsafe(`
        UPDATE ${FIXTURE_SCHEMA}.orders
           SET status = 'refunded'
         WHERE id = '${ORDER_ID}'
      `);
      await transaction.unsafe('SET CONSTRAINTS ALL IMMEDIATE');
    })).rejects.toMatchObject({ code: '23503' });

    const order = await sql.unsafe<Array<{ status: string }>>(`
      SELECT status
        FROM ${FIXTURE_SCHEMA}.orders
       WHERE id = '${ORDER_ID}'
    `);
    expect(order).toEqual([{ status: 'disputed' }]);
  });

  it('refuses to validate the migration over a pre-existing incompatible row', async () => {
    await sql.unsafe(preMigrationSchema(DIRTY_SCHEMA, false));
    await sql.unsafe(`
      INSERT INTO ${DIRTY_SCHEMA}.orders (
        id, guild_id, customer_id, product_id, status
      ) VALUES (
        '${ORDER_ID}', '${GUILD_ID}', '${CUSTOMER_ID}', '${PRODUCT_ID}', 'refunded'
      );
      INSERT INTO ${DIRTY_SCHEMA}.payments (
        id, order_id, guild_id, customer_id, paypal_resource_type, status
      ) VALUES (
        '${PAYMENT_ID}', '${ORDER_ID}', '${GUILD_ID}', '${CUSTOMER_ID}',
        'capture', 'completed'
      );
    `);

    const applySql = postgres(getTestDbUrl(), { max: 1 });
    try {
      await expect(
        applySql.unsafe(migrationSql(DIRTY_SCHEMA)),
      ).rejects.toMatchObject({ code: '23503' });
      try {
        await applySql.unsafe('ROLLBACK');
      } catch {
        // The driver may already have closed the failed explicit transaction.
      }
    } finally {
      await applySql.end();
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${DIRTY_SCHEMA} CASCADE`);
    }
  });
});
