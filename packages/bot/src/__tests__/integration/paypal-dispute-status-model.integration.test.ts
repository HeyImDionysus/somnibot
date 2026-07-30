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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
const LEASE_OWNER_A = '80000000-0000-4000-8000-000000000001';
const LEASE_OWNER_B = '80000000-0000-4000-8000-000000000002';

let sql: Sql;

function deferred<T = void>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function databasePid(client: Sql): Promise<number> {
  const [backend] = await client.unsafe<Array<{ pid: number }>>(
    'SELECT pg_backend_pid() AS pid',
  );
  if (!backend?.pid) throw new Error('failed to capture database client PID');
  return backend.pid;
}

async function waitForDatabaseLock(
  observer: Sql,
  backendPid: number,
  description: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [activity] = await observer.unsafe<Array<{
      state: string | null;
      wait_event_type: string | null;
    }>>(`
      SELECT state, wait_event_type
        FROM pg_catalog.pg_stat_activity
       WHERE pid = ${backendPid}
    `);
    if (activity?.state === 'active' && activity.wait_event_type === 'Lock') return;
    await delay(10);
  }
  throw new Error(`${description} did not reach a PostgreSQL lock wait`);
}

function createTestSql(): Sql {
  return postgres(getTestDbUrl(), {
    max: 1,
    connect_timeout: 5,
    connection: {
      lock_timeout: 5_000,
      statement_timeout: 30_000,
    },
  });
}

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
    GRANT USAGE ON SCHEMA ${schema} TO service_role;

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
    sql = createTestSql();
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
    try {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${FIXTURE_SCHEMA} CASCADE`);
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${DIRTY_SCHEMA} CASCADE`);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  beforeEach(async () => {
    await sql.unsafe(`DELETE FROM ${FIXTURE_SCHEMA}.paypal_reconciliation_state`);
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

    const applySql = createTestSql();
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
      try {
        await applySql.end({ timeout: 5 });
      } finally {
        await sql.unsafe(`DROP SCHEMA IF EXISTS ${DIRTY_SCHEMA} CASCADE`);
      }
    }
  });

  it('atomically grants one active owner and reports the concurrent loser busy', async () => {
    const competitor = createTestSql();
    try {
      const acquire = (connection: Sql, owner: string) => connection.unsafe<Array<{
        result: string;
      }>>(`
        SELECT ${FIXTURE_SCHEMA}.paypal_reconcile_acquire(
          '${owner}'::UUID,
          120,
          21600,
          false
        ) AS result
      `);
      const [left, right] = await Promise.all([
        acquire(sql, LEASE_OWNER_A),
        acquire(competitor, LEASE_OWNER_B),
      ]);

      expect([left[0]!.result, right[0]!.result].sort())
        .toEqual(['acquired', 'busy']);
      const state = await sql.unsafe<Array<{
        state: string;
        owner_token: string;
      }>>(`
        SELECT state, owner_token::TEXT
          FROM ${FIXTURE_SCHEMA}.paypal_reconciliation_state
      `);
      expect(state).toHaveLength(1);
      expect(state[0]!.state).toBe('running');
      expect([LEASE_OWNER_A, LEASE_OWNER_B]).toContain(state[0]!.owner_token);
    } finally {
      await competitor.end({ timeout: 5 });
    }
  });

  it('refreshes the DB clock under the inserted row lock after an empty-table wait', async () => {
    const blocker = createTestSql();
    const contender = createTestSql();
    const tableLocked = deferred();
    const releaseTable = deferred();
    try {
      const contenderPid = await databasePid(contender);
      const blockerWork = blocker.begin(async (transaction) => {
        await transaction.unsafe(`
          LOCK TABLE ${FIXTURE_SCHEMA}.paypal_reconciliation_state
          IN ACCESS EXCLUSIVE MODE
        `);
        tableLocked.resolve();
        await releaseTable.promise;
      });
      await tableLocked.promise;

      const acquirePromise = contender.unsafe<Array<{ result: string }>>(`
        SELECT ${FIXTURE_SCHEMA}.paypal_reconcile_acquire(
          '${LEASE_OWNER_A}'::UUID,
          1,
          0,
          false
        ) AS result
      `).then((rows) => rows);
      await waitForDatabaseLock(
        sql,
        contenderPid,
        'empty-table lease contender',
      );
      await delay(1_250);
      releaseTable.resolve();
      await blockerWork;

      const acquired = await acquirePromise;
      expect(acquired).toEqual([{ result: 'acquired' }]);
      const state = await sql.unsafe<Array<{
        owner_token: string;
        lease_is_active: boolean;
        remaining_seconds: number;
      }>>(`
        SELECT owner_token::TEXT,
               lease_expires_at > clock_timestamp() AS lease_is_active,
               EXTRACT(
                 EPOCH FROM lease_expires_at - clock_timestamp()
               )::DOUBLE PRECISION AS remaining_seconds
          FROM ${FIXTURE_SCHEMA}.paypal_reconciliation_state
      `);
      expect(state).toEqual([
        expect.objectContaining({
          owner_token: LEASE_OWNER_A,
          lease_is_active: true,
        }),
      ]);
      expect(state[0]!.remaining_seconds).toBeGreaterThan(0.5);
    } finally {
      releaseTable.resolve();
      await Promise.allSettled([
        blocker.end({ timeout: 5 }),
        contender.end({ timeout: 5 }),
      ]);
    }
  });

  it('never reports acquired without a fresh row when a conflict row is deleted before locking', async () => {
    await sql.unsafe(`
      INSERT INTO ${FIXTURE_SCHEMA}.paypal_reconciliation_state (
        singleton, state, owner_token, lease_expires_at, completed_at, updated_at
      ) VALUES (
        true,
        'running',
        '${LEASE_OWNER_A}'::UUID,
        clock_timestamp() - INTERVAL '1 second',
        NULL,
        clock_timestamp() - INTERVAL '1 second'
      )
    `);
    const deleter = createTestSql();
    const contender = createTestSql();
    const observer = createTestSql();
    const rowLocked = deferred();
    const releaseRow = deferred();
    let blockerWork: Promise<unknown> | null = null;
    try {
      const deleterPid = await databasePid(deleter);
      const contenderPid = await databasePid(contender);
      blockerWork = sql.begin(async (transaction) => {
        await transaction.unsafe(`
          SELECT singleton
            FROM ${FIXTURE_SCHEMA}.paypal_reconciliation_state
           WHERE singleton = true
           FOR UPDATE
        `);
        rowLocked.resolve();
        await releaseRow.promise;
      });
      await rowLocked.promise;

      const deletePromise = deleter.unsafe(`
        DELETE FROM ${FIXTURE_SCHEMA}.paypal_reconciliation_state
         WHERE singleton = true
      `).then((rows) => rows);
      await waitForDatabaseLock(
        observer,
        deleterPid,
        'reconciliation-state deleter',
      );
      const acquirePromise = contender.unsafe<Array<{ result: string }>>(`
        SELECT ${FIXTURE_SCHEMA}.paypal_reconcile_acquire(
          '${LEASE_OWNER_B}'::UUID,
          1,
          0,
          false
        ) AS result
      `).then((rows) => rows);
      await waitForDatabaseLock(
        observer,
        contenderPid,
        'reconciliation-state acquire contender',
      );
      releaseRow.resolve();
      await blockerWork;
      await deletePromise;

      const acquired = await acquirePromise;
      expect(acquired).toEqual([{ result: 'acquired' }]);
      const state = await sql.unsafe<Array<{
        owner_token: string;
        lease_is_active: boolean;
      }>>(`
        SELECT owner_token::TEXT,
               lease_expires_at > clock_timestamp() AS lease_is_active
          FROM ${FIXTURE_SCHEMA}.paypal_reconciliation_state
      `);
      expect(state).toEqual([{
        owner_token: LEASE_OWNER_B,
        lease_is_active: true,
      }]);
    } finally {
      releaseRow.resolve();
      await Promise.allSettled([
        ...(blockerWork ? [blockerWork] : []),
        deleter.end({ timeout: 5 }),
        contender.end({ timeout: 5 }),
        observer.end({ timeout: 5 }),
      ]);
    }
  });

  it('uses the database clock and lets manual bypass cooldown, never active ownership', async () => {
    const acquired = await sql.unsafe<Array<{ result: string }>>(`
      SELECT ${FIXTURE_SCHEMA}.paypal_reconcile_acquire(
        '${LEASE_OWNER_A}'::UUID,
        120,
        21600,
        false
      ) AS result
    `);
    expect(acquired[0]!.result).toBe('acquired');

    const timing = await sql.unsafe<Array<{
      remaining_seconds: number;
    }>>(`
      SELECT EXTRACT(
        EPOCH FROM lease_expires_at - clock_timestamp()
      )::DOUBLE PRECISION AS remaining_seconds
        FROM ${FIXTURE_SCHEMA}.paypal_reconciliation_state
    `);
    expect(timing[0]!.remaining_seconds).toBeGreaterThan(115);
    expect(timing[0]!.remaining_seconds).toBeLessThanOrEqual(120);

    const busyManual = await sql.unsafe<Array<{ result: string }>>(`
      SELECT ${FIXTURE_SCHEMA}.paypal_reconcile_acquire(
        '${LEASE_OWNER_B}'::UUID,
        120,
        21600,
        true
      ) AS result
    `);
    expect(busyManual[0]!.result).toBe('busy');

    const finalized = await sql.unsafe<Array<{ result: boolean }>>(`
      SELECT ${FIXTURE_SCHEMA}.paypal_reconcile_finalize(
        '${LEASE_OWNER_A}'::UUID,
        true
      ) AS result
    `);
    expect(finalized[0]!.result).toBe(true);

    const scheduledCooldown = await sql.unsafe<Array<{ result: string }>>(`
      SELECT ${FIXTURE_SCHEMA}.paypal_reconcile_acquire(
        '${LEASE_OWNER_B}'::UUID,
        120,
        21600,
        false
      ) AS result
    `);
    expect(scheduledCooldown[0]!.result).toBe('cooldown');

    const manualBypass = await sql.unsafe<Array<{ result: string }>>(`
      SELECT ${FIXTURE_SCHEMA}.paypal_reconcile_acquire(
        '${LEASE_OWNER_B}'::UUID,
        120,
        21600,
        true
      ) AS result
    `);
    expect(manualBypass[0]!.result).toBe('acquired');
  });

  it('heartbeats and finalizes only for the exact active owner', async () => {
    await sql.unsafe(`
      SELECT ${FIXTURE_SCHEMA}.paypal_reconcile_acquire(
        '${LEASE_OWNER_A}'::UUID,
        60,
        21600,
        false
      )
    `);

    const wrongHeartbeat = await sql.unsafe<Array<{ result: boolean }>>(`
      SELECT ${FIXTURE_SCHEMA}.paypal_reconcile_heartbeat(
        '${LEASE_OWNER_B}'::UUID,
        120
      ) AS result
    `);
    const wrongFinalize = await sql.unsafe<Array<{ result: boolean }>>(`
      SELECT ${FIXTURE_SCHEMA}.paypal_reconcile_finalize(
        '${LEASE_OWNER_B}'::UUID,
        true
      ) AS result
    `);
    expect(wrongHeartbeat[0]!.result).toBe(false);
    expect(wrongFinalize[0]!.result).toBe(false);

    const rightHeartbeat = await sql.unsafe<Array<{ result: boolean }>>(`
      SELECT ${FIXTURE_SCHEMA}.paypal_reconcile_heartbeat(
        '${LEASE_OWNER_A}'::UUID,
        120
      ) AS result
    `);
    const rightFinalize = await sql.unsafe<Array<{ result: boolean }>>(`
      SELECT ${FIXTURE_SCHEMA}.paypal_reconcile_finalize(
        '${LEASE_OWNER_A}'::UUID,
        false
      ) AS result
    `);
    expect(rightHeartbeat[0]!.result).toBe(true);
    expect(rightFinalize[0]!.result).toBe(true);

    const retry = await sql.unsafe<Array<{ result: string }>>(`
      SELECT ${FIXTURE_SCHEMA}.paypal_reconcile_acquire(
        '${LEASE_OWNER_B}'::UUID,
        120,
        21600,
        false
      ) AS result
    `);
    expect(retry[0]!.result).toBe('acquired');
  });

  it('exposes lease state and RPCs to service_role only', async () => {
    const privileges = await sql.unsafe<Array<{
      anon_table: boolean;
      authenticated_table: boolean;
      service_table: boolean;
      service_insert: boolean;
      service_update: boolean;
      service_delete: boolean;
      anon_acquire: boolean;
      authenticated_acquire: boolean;
      service_acquire: boolean;
    }>>(`
      SELECT
        has_table_privilege(
          'anon',
          '${FIXTURE_SCHEMA}.paypal_reconciliation_state',
          'SELECT'
        ) AS anon_table,
        has_table_privilege(
          'authenticated',
          '${FIXTURE_SCHEMA}.paypal_reconciliation_state',
          'SELECT'
        ) AS authenticated_table,
        has_table_privilege(
          'service_role',
          '${FIXTURE_SCHEMA}.paypal_reconciliation_state',
          'SELECT'
        ) AS service_table,
        has_table_privilege(
          'service_role',
          '${FIXTURE_SCHEMA}.paypal_reconciliation_state',
          'INSERT'
        ) AS service_insert,
        has_table_privilege(
          'service_role',
          '${FIXTURE_SCHEMA}.paypal_reconciliation_state',
          'UPDATE'
        ) AS service_update,
        has_table_privilege(
          'service_role',
          '${FIXTURE_SCHEMA}.paypal_reconciliation_state',
          'DELETE'
        ) AS service_delete,
        has_function_privilege(
          'anon',
          '${FIXTURE_SCHEMA}.paypal_reconcile_acquire(uuid,integer,integer,boolean)',
          'EXECUTE'
        ) AS anon_acquire,
        has_function_privilege(
          'authenticated',
          '${FIXTURE_SCHEMA}.paypal_reconcile_acquire(uuid,integer,integer,boolean)',
          'EXECUTE'
        ) AS authenticated_acquire,
        has_function_privilege(
          'service_role',
          '${FIXTURE_SCHEMA}.paypal_reconcile_acquire(uuid,integer,integer,boolean)',
          'EXECUTE'
        ) AS service_acquire
    `);

    expect(privileges).toEqual([{
      anon_table: false,
      authenticated_table: false,
      service_table: true,
      service_insert: false,
      service_update: false,
      service_delete: false,
      anon_acquire: false,
      authenticated_acquire: false,
      service_acquire: true,
    }]);
  });

  it('denies direct service_role DML while the definer RPC lifecycle succeeds', async () => {
    for (const directDml of [
      `INSERT INTO ${FIXTURE_SCHEMA}.paypal_reconciliation_state (
         singleton, state, owner_token, lease_expires_at, completed_at
       ) VALUES (
         true, 'running', '${LEASE_OWNER_A}'::UUID,
         clock_timestamp() + INTERVAL '1 minute', NULL
       )`,
      `UPDATE ${FIXTURE_SCHEMA}.paypal_reconciliation_state
          SET updated_at = clock_timestamp()
        WHERE singleton = true`,
      `DELETE FROM ${FIXTURE_SCHEMA}.paypal_reconciliation_state
        WHERE singleton = true`,
    ]) {
      await expect(sql.begin(async (transaction) => {
        await transaction.unsafe('SET LOCAL ROLE service_role');
        await transaction.unsafe(directDml);
      })).rejects.toMatchObject({ code: '42501' });
    }

    await sql.begin(async (transaction) => {
      await transaction.unsafe('SET LOCAL ROLE service_role');
      const acquired = await transaction.unsafe<Array<{ result: string }>>(`
        SELECT ${FIXTURE_SCHEMA}.paypal_reconcile_acquire(
          '${LEASE_OWNER_A}'::UUID,
          60,
          0,
          false
        ) AS result
      `);
      expect(acquired).toEqual([{ result: 'acquired' }]);
      const visible = await transaction.unsafe<Array<{ owner_token: string }>>(`
        SELECT owner_token::TEXT
          FROM ${FIXTURE_SCHEMA}.paypal_reconciliation_state
      `);
      expect(visible).toEqual([{ owner_token: LEASE_OWNER_A }]);
      const heartbeat = await transaction.unsafe<Array<{ result: boolean }>>(`
        SELECT ${FIXTURE_SCHEMA}.paypal_reconcile_heartbeat(
          '${LEASE_OWNER_A}'::UUID,
          60
        ) AS result
      `);
      expect(heartbeat).toEqual([{ result: true }]);
      const finalized = await transaction.unsafe<Array<{ result: boolean }>>(`
        SELECT ${FIXTURE_SCHEMA}.paypal_reconcile_finalize(
          '${LEASE_OWNER_A}'::UUID,
          true
        ) AS result
      `);
      expect(finalized).toEqual([{ result: true }]);
    });
  });
});
