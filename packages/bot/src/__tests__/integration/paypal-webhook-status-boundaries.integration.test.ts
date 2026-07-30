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
    paypal_payment_id TEXT,
    provider TEXT,
    paypal_resource_type TEXT
  );

  CREATE TABLE ${FIXTURE_SCHEMA}.webhook_events (
    event_id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    processed_at TIMESTAMPTZ,
    payload JSONB NOT NULL,
    result TEXT,
    error_details TEXT,
    guild_id TEXT,
    replayed_at TIMESTAMPTZ,
    replay_count INTEGER DEFAULT 0
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
    id, order_id, guild_id, paypal_payment_id, provider, paypal_resource_type
  ) VALUES
    (
      '20000000-0000-4000-8000-000000000001',
      '${ORDER_A}', '${GUILD_A}', 'CAPTURE-A', 'paypal', 'capture'
    ),
    (
      '20000000-0000-4000-8000-000000000002',
      '${ORDER_B}', '${GUILD_B}', 'CAPTURE-B', 'paypal', 'capture'
    );
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
      DELETE FROM ${FIXTURE_SCHEMA}.webhook_events;
      DELETE FROM ${FIXTURE_SCHEMA}.guild;
      UPDATE ${FIXTURE_SCHEMA}.orders
         SET status = CASE
           WHEN id = '${ORDER_PENDING}' THEN 'pending'
           ELSE 'completed'
         END
      ;
      UPDATE ${FIXTURE_SCHEMA}.payments
         SET provider = 'paypal',
             paypal_resource_type = 'capture'
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

  it('requires complete local PayPal identity coverage before changing an order', async () => {
    await expect(sql.begin(async (transaction) => {
      await transaction.unsafe('SET LOCAL ROLE service_role');
      await transaction.unsafe(`
        SELECT *
          FROM ${FIXTURE_SCHEMA}.commerce_apply_paypal_dispute(
            ARRAY['CAPTURE-A', 'CAPTURE-NOT-LOCAL']::TEXT[],
            true
          )
      `);
    })).rejects.toMatchObject({ code: '22023' });

    await sql.unsafe(`
      UPDATE ${FIXTURE_SCHEMA}.payments
         SET provider = 'stripe'
       WHERE paypal_payment_id = 'CAPTURE-A'
    `);
    await expect(sql.begin(async (transaction) => {
      await transaction.unsafe('SET LOCAL ROLE service_role');
      await transaction.unsafe(`
        SELECT *
          FROM ${FIXTURE_SCHEMA}.commerce_apply_paypal_dispute(
            ARRAY['CAPTURE-A']::TEXT[],
            true
        )
      `);
    })).rejects.toMatchObject({ code: '22023' });

    await sql.unsafe(`
      UPDATE ${FIXTURE_SCHEMA}.payments
         SET provider = 'paypal',
             paypal_resource_type = NULL
       WHERE paypal_payment_id = 'CAPTURE-A'
    `);
    await expect(sql.begin(async (transaction) => {
      await transaction.unsafe('SET LOCAL ROLE service_role');
      await transaction.unsafe(`
        SELECT *
          FROM ${FIXTURE_SCHEMA}.commerce_apply_paypal_dispute(
            ARRAY['CAPTURE-A']::TEXT[],
            true
          )
      `);
    })).rejects.toMatchObject({ code: '22023' });

    const order = await sql.unsafe<Array<{ status: string }>>(`
      SELECT status
        FROM ${FIXTURE_SCHEMA}.orders
       WHERE id = '${ORDER_A}'
    `);
    expect(order).toEqual([{ status: 'completed' }]);
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

  it('lists and claims unattributed events only inside the atomic owner boundary', async () => {
    await sql.unsafe(`
      INSERT INTO ${FIXTURE_SCHEMA}.guild (id, owner_discord_id)
      VALUES ('${GUILD_A}', '${GUILD_A}');
      INSERT INTO ${FIXTURE_SCHEMA}.webhook_events (
        event_id, event_type, processed_at, payload, result, guild_id
      ) VALUES
        ('EVT-MINE', 'CHECKOUT.ORDER.APPROVED', now(), '{}', 'error', '${GUILD_A}'),
        ('EVT-ORPHAN', 'CHECKOUT.ORDER.APPROVED', now(), '{}', 'error', NULL),
        ('EVT-OTHER', 'CHECKOUT.ORDER.APPROVED', now(), '{}', 'error', '${GUILD_B}');
    `);

    const listed = await sql.begin(async (transaction) => {
      await transaction.unsafe('SET LOCAL ROLE service_role');
      return transaction.unsafe<Array<{ result: { data: unknown[]; total: number } }>>(`
        SELECT ${FIXTURE_SCHEMA}.webhooks_list_scoped(
          '${GUILD_A}', '${GUILD_A}', NULL, NULL, 0, 50
        ) AS result
      `);
    });
    expect(listed[0]!.result.total).toBe(2);
    expect(listed[0]!.result.data).toHaveLength(2);

    const claimed = await sql.begin(async (transaction) => {
      await transaction.unsafe('SET LOCAL ROLE service_role');
      return transaction.unsafe<Array<{
        outcome: string;
        event_data: { event_id: string; replay_count: number };
        claim_token: string;
      }>>(`
        SELECT *
          FROM ${FIXTURE_SCHEMA}.webhooks_claim_scoped_replay(
            'EVT-ORPHAN', '${GUILD_A}', '${GUILD_A}', 300
          )
      `);
    });
    expect(claimed).toEqual([{
      outcome: 'claimed',
      event_data: expect.objectContaining({
        event_id: 'EVT-ORPHAN',
        replay_count: 0,
      }),
      claim_token: expect.any(String),
    }]);
    const claimToken = claimed[0]!.claim_token;
    await sql.unsafe(`
      UPDATE ${FIXTURE_SCHEMA}.webhook_events
         SET processed_at = now() - interval '1 hour'
       WHERE event_id = 'EVT-ORPHAN'
    `);
    const fenced = await sql.begin(async (transaction) => {
      await transaction.unsafe('SET LOCAL ROLE service_role');
      const secondClaim = await transaction.unsafe<Array<{
        outcome: string;
        event_data: unknown;
        claim_token: string | null;
      }>>(`
        SELECT *
          FROM ${FIXTURE_SCHEMA}.webhooks_claim_scoped_replay(
            'EVT-ORPHAN', '${GUILD_A}', '${GUILD_A}', 1
          )
      `);
      const current = await transaction.unsafe<Array<{ current: boolean }>>(`
        SELECT ${FIXTURE_SCHEMA}.webhooks_replay_claim_is_current(
          'EVT-ORPHAN', '${claimToken}'
        ) AS current
      `);
      const staleFinish = await transaction.unsafe<Array<{ finished: boolean }>>(`
        SELECT ${FIXTURE_SCHEMA}.webhooks_finish_replay_claim(
          'EVT-ORPHAN', '22222222-2222-4222-8222-222222222222',
          'error', 'stale worker'
        ) AS finished
      `);
      const listedWhileClaimed = await transaction.unsafe<Array<{
        result: { data: Array<Record<string, unknown>>; total: number };
      }>>(`
        SELECT ${FIXTURE_SCHEMA}.webhooks_list_scoped(
          '${GUILD_A}', '${GUILD_A}', NULL, NULL, 0, 50
        ) AS result
      `);
      const abandoned = await transaction.unsafe<Array<{ abandoned: boolean }>>(`
        SELECT ${FIXTURE_SCHEMA}.webhooks_abandon_stale_replay_claim(
          'EVT-ORPHAN', '${GUILD_A}', '${GUILD_A}', 900
        ) AS abandoned
      `);
      const oldFinish = await transaction.unsafe<Array<{ finished: boolean }>>(`
        SELECT ${FIXTURE_SCHEMA}.webhooks_finish_replay_claim(
          'EVT-ORPHAN', '${claimToken}', 'success', NULL
        ) AS finished
      `);
      return {
        secondClaim,
        current,
        staleFinish,
        listedWhileClaimed,
        abandoned,
        oldFinish,
      };
    });
    expect(fenced.secondClaim).toEqual([{
      outcome: 'processing',
      event_data: null,
      claim_token: null,
    }]);
    expect(fenced.current).toEqual([{ current: true }]);
    expect(fenced.staleFinish).toEqual([{ finished: false }]);
    const listedClaimedEvent = fenced.listedWhileClaimed[0]!.result.data
      .find((row) => row.event_id === 'EVT-ORPHAN');
    expect(listedClaimedEvent).toBeDefined();
    expect(listedClaimedEvent).not.toHaveProperty('replay_claim_token');
    expect(fenced.abandoned).toEqual([{ abandoned: true }]);
    expect(fenced.oldFinish).toEqual([{ finished: false }]);

    const reclaimed = await sql.begin(async (transaction) => {
      await transaction.unsafe('SET LOCAL ROLE service_role');
      const rows = await transaction.unsafe<Array<{
        outcome: string;
        claim_token: string;
      }>>(`
        SELECT *
          FROM ${FIXTURE_SCHEMA}.webhooks_claim_scoped_replay(
            'EVT-ORPHAN', '${GUILD_A}', '${GUILD_A}', 300
          )
      `);
      const finish = await transaction.unsafe<Array<{ finished: boolean }>>(`
        SELECT ${FIXTURE_SCHEMA}.webhooks_finish_replay_claim(
          'EVT-ORPHAN', '${rows[0]!.claim_token}', 'success', NULL
        ) AS finished
      `);
      return { rows, finish };
    });
    expect(reclaimed.rows[0]!.outcome).toBe('claimed');
    expect(reclaimed.rows[0]!.claim_token).not.toBe(claimToken);
    expect(reclaimed.finish).toEqual([{ finished: true }]);

    await sql.unsafe(`
      INSERT INTO ${FIXTURE_SCHEMA}.guild (id, owner_discord_id)
      VALUES ('${GUILD_B}', '${GUILD_B}');
      INSERT INTO ${FIXTURE_SCHEMA}.webhook_events (
        event_id, event_type, processed_at, payload, result, guild_id
      ) VALUES (
        'EVT-ORPHAN-2', 'CHECKOUT.ORDER.APPROVED', now(), '{}', 'error', NULL
      )
    `);
    const denied = await sql.begin(async (transaction) => {
      await transaction.unsafe('SET LOCAL ROLE service_role');
      return transaction.unsafe<Array<{ outcome: string; event_data: unknown }>>(`
        SELECT *
          FROM ${FIXTURE_SCHEMA}.webhooks_claim_scoped_replay(
            'EVT-ORPHAN-2', '${GUILD_A}', '${GUILD_A}', 300
          )
      `);
    });
    expect(denied).toEqual([{
      outcome: 'not_found',
      event_data: null,
      claim_token: null,
    }]);

    await sql.unsafe(`
      UPDATE ${FIXTURE_SCHEMA}.guild
         SET owner_discord_id = '${GUILD_B}'
       WHERE id = '${GUILD_A}'
    `);
    const staleOwner = await sql.begin(async (transaction) => {
      await transaction.unsafe('SET LOCAL ROLE service_role');
      const list = await transaction.unsafe<Array<{
        result: { data: unknown[]; total: number };
      }>>(`
        SELECT ${FIXTURE_SCHEMA}.webhooks_list_scoped(
          '${GUILD_A}', '${GUILD_A}', NULL, NULL, 0, 50
        ) AS result
      `);
      const claim = await transaction.unsafe<Array<{
        outcome: string;
        event_data: unknown;
      }>>(`
        SELECT *
          FROM ${FIXTURE_SCHEMA}.webhooks_claim_scoped_replay(
            'EVT-MINE', '${GUILD_A}', '${GUILD_A}', 300
          )
      `);
      return { list, claim };
    });
    expect(staleOwner.list[0]!.result).toEqual({ data: [], total: 0 });
    expect(staleOwner.claim).toEqual([{
      outcome: 'not_found',
      event_data: null,
      claim_token: null,
    }]);
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
      service_list: boolean;
      anon_list: boolean;
      service_claim: boolean;
      anon_claim: boolean;
      service_claim_check: boolean;
      anon_claim_check: boolean;
      service_claim_finish: boolean;
      anon_claim_finish: boolean;
      service_claim_abandon: boolean;
      anon_claim_abandon: boolean;
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
        ) AS service_scope,
        has_function_privilege(
          'service_role',
          '${FIXTURE_SCHEMA}.webhooks_list_scoped(text,text,text,text,integer,integer)',
          'EXECUTE'
        ) AS service_list,
        has_function_privilege(
          'anon',
          '${FIXTURE_SCHEMA}.webhooks_list_scoped(text,text,text,text,integer,integer)',
          'EXECUTE'
        ) AS anon_list,
        has_function_privilege(
          'service_role',
          '${FIXTURE_SCHEMA}.webhooks_claim_scoped_replay(text,text,text,integer)',
          'EXECUTE'
        ) AS service_claim,
        has_function_privilege(
          'anon',
          '${FIXTURE_SCHEMA}.webhooks_claim_scoped_replay(text,text,text,integer)',
          'EXECUTE'
        ) AS anon_claim,
        has_function_privilege(
          'service_role',
          '${FIXTURE_SCHEMA}.webhooks_replay_claim_is_current(text,text)',
          'EXECUTE'
        ) AS service_claim_check,
        has_function_privilege(
          'anon',
          '${FIXTURE_SCHEMA}.webhooks_replay_claim_is_current(text,text)',
          'EXECUTE'
        ) AS anon_claim_check,
        has_function_privilege(
          'service_role',
          '${FIXTURE_SCHEMA}.webhooks_abandon_stale_replay_claim(text,text,text,integer)',
          'EXECUTE'
        ) AS service_claim_abandon,
        has_function_privilege(
          'anon',
          '${FIXTURE_SCHEMA}.webhooks_abandon_stale_replay_claim(text,text,text,integer)',
          'EXECUTE'
        ) AS anon_claim_abandon,
        has_function_privilege(
          'service_role',
          '${FIXTURE_SCHEMA}.webhooks_finish_replay_claim(text,text,text,text)',
          'EXECUTE'
        ) AS service_claim_finish,
        has_function_privilege(
          'anon',
          '${FIXTURE_SCHEMA}.webhooks_finish_replay_claim(text,text,text,text)',
          'EXECUTE'
        ) AS anon_claim_finish
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
      service_list: true,
      anon_list: false,
      service_claim: true,
      anon_claim: false,
      service_claim_check: true,
      anon_claim_check: false,
      service_claim_abandon: true,
      anon_claim_abandon: false,
      service_claim_finish: true,
      anon_claim_finish: false,
    });
  });
});
