/**
 * Real-PostgreSQL proof for the exact-identity PayPal webhook transitions.
 *
 * The fixture recreates the direct service_role status fence from the
 * production checkout trigger, applies the real migration in an isolated
 * schema, and proves that only the SECURITY DEFINER RPCs can make the two
 * sanctioned transitions.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getTestDbUrl } from './helpers.js';

const FIXTURE_SCHEMA = 'paypal_webhook_status_boundary_fixture';
const MIGRATION = '20260730010000_paypal_webhook_tenant_status_boundaries.sql';
const GUILD_A = '111111111111111111';
const GUILD_B = '222222222222222222';
const ORDER_A = '10000000-0000-4000-8000-000000000001';
const ORDER_B = '10000000-0000-4000-8000-000000000002';
const ORDER_PENDING = '10000000-0000-4000-8000-000000000003';

let sql: Sql;

function migrationSql(): string {
  const testDir = dirname(fileURLToPath(import.meta.url));
  return readFileSync(
    resolve(testDir, '../../../../supabase/migrations', MIGRATION),
    'utf8',
  ).replaceAll('public.', `${FIXTURE_SCHEMA}.`);
}

const FIXTURE_SQL = `
  CREATE SCHEMA ${FIXTURE_SCHEMA};
  GRANT USAGE ON SCHEMA ${FIXTURE_SCHEMA} TO service_role;

  CREATE TABLE ${FIXTURE_SCHEMA}.guild (
    id TEXT PRIMARY KEY,
    owner_discord_id TEXT
  );

  CREATE TABLE ${FIXTURE_SCHEMA}.orders (
    id UUID PRIMARY KEY,
    guild_id TEXT,
    paypal_order_id TEXT UNIQUE,
    status TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE ${FIXTURE_SCHEMA}.payments (
    id UUID PRIMARY KEY,
    order_id UUID,
    guild_id TEXT,
    paypal_payment_id TEXT
  );

  GRANT SELECT, UPDATE ON ${FIXTURE_SCHEMA}.orders TO service_role;
  GRANT SELECT ON ${FIXTURE_SCHEMA}.payments TO service_role;

  CREATE FUNCTION ${FIXTURE_SCHEMA}.block_direct_service_role_status_change()
  RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF current_user = 'service_role' AND NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'paid-order status transition requires an approved RPC'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END;
  $$;

  CREATE TRIGGER commerce_normalize_checkout_active
    BEFORE UPDATE ON ${FIXTURE_SCHEMA}.orders
    FOR EACH ROW
    EXECUTE FUNCTION ${FIXTURE_SCHEMA}.block_direct_service_role_status_change();

  INSERT INTO ${FIXTURE_SCHEMA}.orders (
    id, guild_id, paypal_order_id, status
  ) VALUES
    ('${ORDER_A}', '${GUILD_A}', 'PAYPAL-ORDER-A', 'completed'),
    ('${ORDER_B}', '${GUILD_B}', 'PAYPAL-ORDER-B', 'completed'),
    ('${ORDER_PENDING}', '${GUILD_A}', 'PAYPAL-ORDER-PENDING', 'pending');

  INSERT INTO ${FIXTURE_SCHEMA}.payments (
    id, order_id, guild_id, paypal_payment_id
  ) VALUES
    ('20000000-0000-4000-8000-000000000001', '${ORDER_A}', '${GUILD_A}', 'CAPTURE-A'),
    ('20000000-0000-4000-8000-000000000002', '${ORDER_B}', '${GUILD_B}', 'CAPTURE-B');
`;

describe('PayPal webhook tenant/status boundary migration', () => {
  beforeAll(async () => {
    sql = postgres(getTestDbUrl(), { max: 1 });
    await sql`SELECT 1`;
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${FIXTURE_SCHEMA} CASCADE`);
    await sql.unsafe(FIXTURE_SQL);
    await sql.unsafe(migrationSql());
  }, 60_000);

  afterAll(async () => {
    if (!sql) return;
    try {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${FIXTURE_SCHEMA} CASCADE`);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  beforeEach(async () => {
    await sql.unsafe(`
      UPDATE ${FIXTURE_SCHEMA}.orders
         SET status = CASE
           WHEN id = '${ORDER_PENDING}' THEN 'pending'
           ELSE 'completed'
         END
    `);
  });

  it('blocks a direct service_role dispute update but permits the exact RPC', async () => {
    await expect(sql.begin(async (transaction) => {
      await transaction.unsafe('SET LOCAL ROLE service_role');
      await transaction.unsafe(`
        UPDATE ${FIXTURE_SCHEMA}.orders
           SET status = 'disputed'
         WHERE id = '${ORDER_A}'
      `);
    })).rejects.toMatchObject({ code: '42501' });

    const applied = await sql.begin(async (transaction) => {
      await transaction.unsafe('SET LOCAL ROLE service_role');
      return transaction.unsafe<Array<{
        guild_id: string;
        order_id: string;
        marked_disputed: boolean;
      }>>(`
        SELECT *
          FROM ${FIXTURE_SCHEMA}.commerce_apply_paypal_dispute(
            ARRAY['CAPTURE-A']::TEXT[],
            true
          )
      `);
    });

    expect(applied).toEqual([{
      guild_id: GUILD_A,
      order_id: ORDER_A,
      marked_disputed: true,
    }]);
  });

  it('rejects mixed-guild dispute identities before changing either order', async () => {
    await expect(sql.begin(async (transaction) => {
      await transaction.unsafe('SET LOCAL ROLE service_role');
      await transaction.unsafe(`
        SELECT *
          FROM ${FIXTURE_SCHEMA}.commerce_apply_paypal_dispute(
            ARRAY['CAPTURE-A', 'CAPTURE-B']::TEXT[],
            true
          )
      `);
    })).rejects.toMatchObject({ code: '22023' });

    const orders = await sql.unsafe<Array<{ id: string; status: string }>>(`
      SELECT id::TEXT, status
        FROM ${FIXTURE_SCHEMA}.orders
       WHERE id IN ('${ORDER_A}', '${ORDER_B}')
       ORDER BY id
    `);
    expect(orders).toEqual([
      { id: ORDER_A, status: 'completed' },
      { id: ORDER_B, status: 'completed' },
    ]);
  });

  it('blocks a direct service_role cancellation but permits the exact denied-capture RPC', async () => {
    await expect(sql.begin(async (transaction) => {
      await transaction.unsafe('SET LOCAL ROLE service_role');
      await transaction.unsafe(`
        UPDATE ${FIXTURE_SCHEMA}.orders
           SET status = 'cancelled'
         WHERE id = '${ORDER_PENDING}'
      `);
    })).rejects.toMatchObject({ code: '42501' });

    const applied = await sql.begin(async (transaction) => {
      await transaction.unsafe('SET LOCAL ROLE service_role');
      return transaction.unsafe<Array<{
        guild_id: string;
        order_id: string;
        previous_status: string;
        order_cancelled: boolean;
      }>>(`
        SELECT *
          FROM ${FIXTURE_SCHEMA}.commerce_apply_capture_denied(
            'PAYPAL-ORDER-PENDING',
            '${GUILD_A}'
          )
      `);
    });

    expect(applied).toEqual([{
      guild_id: GUILD_A,
      order_id: ORDER_PENDING,
      previous_status: 'pending',
      order_cancelled: true,
    }]);
  });

  it('rejects contradictory denied-capture metadata before cancelling the order', async () => {
    await expect(sql.begin(async (transaction) => {
      await transaction.unsafe('SET LOCAL ROLE service_role');
      await transaction.unsafe(`
        SELECT *
          FROM ${FIXTURE_SCHEMA}.commerce_apply_capture_denied(
            'PAYPAL-ORDER-PENDING',
            '${GUILD_B}'
          )
      `);
    })).rejects.toMatchObject({ code: '22023' });

    const order = await sql.unsafe<Array<{ status: string }>>(`
      SELECT status
        FROM ${FIXTURE_SCHEMA}.orders
       WHERE id = '${ORDER_PENDING}'
    `);
    expect(order).toEqual([{ status: 'pending' }]);
  });

  it('proves sole ownership atomically beyond the PostgREST row cap', async () => {
    await sql.unsafe(`
      INSERT INTO ${FIXTURE_SCHEMA}.guild (id, owner_discord_id)
      SELECT 'guild-' || value::TEXT, '${GUILD_A}'
        FROM generate_series(1, 1001) AS value
    `);

    const sole = await sql.begin(async (transaction) => {
      await transaction.unsafe('SET LOCAL ROLE service_role');
      return transaction.unsafe<Array<{ result: boolean }>>(`
        SELECT ${FIXTURE_SCHEMA}.webhooks_is_sole_instance_operator(
          '${GUILD_A}'
        ) AS result
      `);
    });
    expect(sole).toEqual([{ result: true }]);

    await sql.unsafe(`
      INSERT INTO ${FIXTURE_SCHEMA}.guild (id, owner_discord_id)
      VALUES ('guild-other', '${GUILD_B}')
    `);
    const mixed = await sql.begin(async (transaction) => {
      await transaction.unsafe('SET LOCAL ROLE service_role');
      return transaction.unsafe<Array<{ result: boolean }>>(`
        SELECT ${FIXTURE_SCHEMA}.webhooks_is_sole_instance_operator(
          '${GUILD_A}'
        ) AS result
      `);
    });
    expect(mixed).toEqual([{ result: false }]);
  });

  it('exposes all three boundary functions only to service_role', async () => {
    const [privileges] = await sql.unsafe<Array<{
      anon_dispute: boolean;
      authenticated_dispute: boolean;
      service_dispute: boolean;
      anon_denied: boolean;
      authenticated_denied: boolean;
      service_denied: boolean;
      anon_scope: boolean;
      authenticated_scope: boolean;
      service_scope: boolean;
    }>>(`
      SELECT
        has_function_privilege(
          'anon',
          '${FIXTURE_SCHEMA}.commerce_apply_paypal_dispute(text[],boolean)',
          'EXECUTE'
        ) AS anon_dispute,
        has_function_privilege(
          'authenticated',
          '${FIXTURE_SCHEMA}.commerce_apply_paypal_dispute(text[],boolean)',
          'EXECUTE'
        ) AS authenticated_dispute,
        has_function_privilege(
          'service_role',
          '${FIXTURE_SCHEMA}.commerce_apply_paypal_dispute(text[],boolean)',
          'EXECUTE'
        ) AS service_dispute,
        has_function_privilege(
          'anon',
          '${FIXTURE_SCHEMA}.commerce_apply_capture_denied(text,text)',
          'EXECUTE'
        ) AS anon_denied,
        has_function_privilege(
          'authenticated',
          '${FIXTURE_SCHEMA}.commerce_apply_capture_denied(text,text)',
          'EXECUTE'
        ) AS authenticated_denied,
        has_function_privilege(
          'service_role',
          '${FIXTURE_SCHEMA}.commerce_apply_capture_denied(text,text)',
          'EXECUTE'
        ) AS service_denied,
        has_function_privilege(
          'anon',
          '${FIXTURE_SCHEMA}.webhooks_is_sole_instance_operator(text)',
          'EXECUTE'
        ) AS anon_scope,
        has_function_privilege(
          'authenticated',
          '${FIXTURE_SCHEMA}.webhooks_is_sole_instance_operator(text)',
          'EXECUTE'
        ) AS authenticated_scope,
        has_function_privilege(
          'service_role',
          '${FIXTURE_SCHEMA}.webhooks_is_sole_instance_operator(text)',
          'EXECUTE'
        ) AS service_scope
    `);

    expect(privileges).toEqual({
      anon_dispute: false,
      authenticated_dispute: false,
      service_dispute: true,
      anon_denied: false,
      authenticated_denied: false,
      service_denied: true,
      anon_scope: false,
      authenticated_scope: false,
      service_scope: true,
    });
  });
});
