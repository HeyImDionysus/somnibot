/**
 * Real-database evidence for exact entitlement revocation.
 *
 * The transition must serialize competing workers, reject stale observations,
 * and create lifecycle audit/role-cleanup evidence only for the winner.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import postgres, { type Sql } from 'postgres';
import {
  getAnonTestClient,
  getTestDbUrl,
  requireSupabase,
} from './helpers.js';

const RUN_ID = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const GUILD_ID = `test-entitlement-revoke-cas-${RUN_ID}`;
const OWNER_ID = '910000000000000001';
const CUSTOMER_DISCORD_ID = '910000000000000002';
const ROLE_ID = '910000000000000003';

let supa!: SupabaseClient;
let sqlA!: Sql;
let sqlB!: Sql;
let sqlObserver!: Sql;
let sqlBBackendPid!: number;
let sequence = 0;

type RevokeEvidence = {
  disposition: 'applied' | 'noop' | 'stale' | 'not_found';
  transition_id: string | null;
  entitlement_id: string | null;
  guild_id: string | null;
  discord_id?: string | null;
  status: string | null;
  updated_at: string | null;
};

type EntitlementObservation = {
  id: string;
  customer_id: string;
  product_id: string;
  status: string;
  updated_at: string | null;
};

function nextName(prefix: string): string {
  sequence += 1;
  return `${prefix}-${RUN_ID}-${sequence}`;
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
  // audit_logs rows are immutable by design (trg_prevent_audit_log_delete
  // raises on every DELETE). Cleanup must never touch them; every audit
  // assertion below scopes by the per-test entitlement target_id instead.
  await sqlA`
    UPDATE public.bot_action_queue
       SET status = 'completed',
           started_at = NULL,
           completed_at = COALESCE(completed_at, pg_catalog.clock_timestamp())
     WHERE guild_id = ${GUILD_ID}
       AND status <> 'completed'
  `;
  await sqlA`DELETE FROM public.action_queue_dlq WHERE guild_id = ${GUILD_ID}`;
  await sqlA`DELETE FROM public.bot_action_queue WHERE guild_id = ${GUILD_ID}`;
  await sqlA`DELETE FROM public.temp_role_grants WHERE guild_id = ${GUILD_ID}`;
  await sqlA`DELETE FROM public.entitlements WHERE guild_id = ${GUILD_ID}`;
  await sqlA`DELETE FROM public.orders WHERE guild_id = ${GUILD_ID}`;
  await sqlA`
    DELETE FROM public.commerce_product_temp_role_config
     WHERE guild_id = ${GUILD_ID}
  `;
  await sqlA`DELETE FROM public.products WHERE guild_id = ${GUILD_ID}`;
  await sqlA`DELETE FROM public.customers WHERE guild_id = ${GUILD_ID}`;
}

async function waitForSqlBLock(timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [activity] = await sqlObserver<{
      state: string;
      wait_event_type: string | null;
    }[]>`
      SELECT state, wait_event_type
        FROM pg_catalog.pg_stat_activity
       WHERE pid = ${sqlBBackendPid}
    `;
    if (activity?.state === 'active' && activity.wait_event_type === 'Lock') return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('revoke RPC did not reach the expected parent-row lock wait');
}

async function createActiveEntitlement(): Promise<EntitlementObservation> {
  const { data: product, error: productError } = await supa
    .from('products')
    .insert({
      guild_id: GUILD_ID,
      name: nextName('revoke-product'),
      description: 'exact revoke CAS integration fixture',
      type: 'one_time',
      delivery_type: 'access_pass',
      price_cents: 1_000,
      currency: 'USD',
      granted_role_ids: [ROLE_ID],
      granted_channel_ids: [],
      active: true,
    })
    .select('id')
    .single();
  expect(productError).toBeNull();
  if (!product?.id) throw new Error('product fixture returned no id');

  const { data: customer, error: customerError } = await supa
    .from('customers')
    .insert({
      guild_id: GUILD_ID,
      discord_id: CUSTOMER_DISCORD_ID,
      discord_username: nextName('revoke-customer'),
    })
    .select('id')
    .single();
  expect(customerError).toBeNull();
  if (!customer?.id) throw new Error('customer fixture returned no id');

  const requestId = randomUUID();
  const creation = await supa.rpc('commerce_create_noncommerce_entitlement', {
    p_request_id: requestId,
    p_guild_id: GUILD_ID,
    p_customer_id: customer.id,
    p_product_id: product.id,
    p_source: 'manual',
    p_type: 'one_time',
    p_plan_id: null,
    p_expires_at: null,
    p_granted_role_ids: [ROLE_ID],
    p_granted_channel_ids: [],
  });
  expect(creation.error).toBeNull();
  const creationRows = (creation.data ?? []) as Array<{ entitlement_id: string }>;
  expect(creationRows).toHaveLength(1);

  const { data: entitlement, error: entitlementError } = await supa
    .from('entitlements')
    .select('id, customer_id, product_id, status, updated_at')
    .eq('id', creationRows[0]!.entitlement_id)
    .single();
  expect(entitlementError).toBeNull();
  if (!entitlement) throw new Error('entitlement fixture returned no row');
  return entitlement as EntitlementObservation;
}

async function revoke(
  observation: EntitlementObservation,
  reason: 'expired' | 'cancelled' | 'revoked' | 'refund' = 'cancelled',
): Promise<RevokeEvidence> {
  const { data, error } = await supa.rpc('commerce_revoke_entitlement_exact', {
    p_entitlement_id: observation.id,
    p_guild_id: GUILD_ID,
    p_expected_status: observation.status,
    p_expected_updated_at: observation.updated_at,
    p_reason: reason,
  });
  expect(error).toBeNull();
  const rows = (data ?? []) as RevokeEvidence[];
  expect(rows).toHaveLength(1);
  return rows[0]!;
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
  if (!backend?.pid) throw new Error('failed to capture revoke test backend PID');
  sqlBBackendPid = backend.pid;
  const { error } = await supa.from('guild').insert({
    id: GUILD_ID,
    name: 'Entitlement revoke CAS integration',
    owner_discord_id: OWNER_ID,
  });
  expect(error).toBeNull();
});

beforeEach(async () => {
  await cleanFixtures();
});

afterAll(async () => {
  try {
    await cleanFixtures();
    // The guild row stays behind deliberately: the suite's immutable
    // audit_logs rows FK-reference it, and audit rows cannot be deleted.
    // GUILD_ID is unique per run, so reruns are unaffected.
  } finally {
    await Promise.allSettled([
      sqlA.end({ timeout: 5 }),
      sqlB.end({ timeout: 5 }),
      sqlObserver.end({ timeout: 5 }),
    ]);
  }
});

describe('commerce_revoke_entitlement_exact', () => {
  it('serializes concurrent revokes into one winner, one no-op, and one audit', async () => {
    const observed = await createActiveEntitlement();
    const { error: alertInsertError } = await supa.from('alerts').insert({
      guild_id: GUILD_ID,
      alert_type: 'entitlement_grace_period',
      severity: 'warning',
      title: 'Entitlement grace period',
      message: 'revoke CAS integration fixture',
      metadata: { entitlement_id: observed.id },
      resolved: false,
    });
    expect(alertInsertError).toBeNull();

    const results = await Promise.all([revoke(observed), revoke(observed)]);

    expect(results.map((result) => result.disposition).sort()).toEqual(['applied', 'noop']);
    const applied = results.find((result) => result.disposition === 'applied')!;
    expect(applied.transition_id).toEqual(expect.any(String));
    expect(applied.status).toBe('cancelled');

    const replay = await revoke(observed);
    expect(replay.disposition).toBe('noop');
    expect(replay.transition_id).toBeNull();

    const { data: entitlement, error: entitlementError } = await supa
      .from('entitlements')
      .select('status')
      .eq('id', observed.id)
      .single();
    expect(entitlementError).toBeNull();
    expect(entitlement?.status).toBe('cancelled');

    const { data: audits, error: auditError } = await supa
      .from('audit_logs')
      .select('id, action, target_id, details')
      .eq('guild_id', GUILD_ID)
      .eq('action', 'entitlement.revoked')
      .eq('target_id', observed.id);
    expect(auditError).toBeNull();
    expect(audits).toHaveLength(1);
    expect(audits?.[0]?.id).toBe(applied.transition_id);
    expect(audits?.[0]?.details).toMatchObject({ reason: 'cancelled' });

    const { data: alert, error: alertError } = await supa
      .from('alerts')
      .select('resolved, resolved_at')
      .eq('guild_id', GUILD_ID)
      .eq('metadata->>entitlement_id', observed.id)
      .single();
    expect(alertError).toBeNull();
    expect(alert).toMatchObject({ resolved: true, resolved_at: expect.any(String) });

    const { data: cleanup, error: cleanupError } = await supa
      .from('bot_action_queue')
      .select('id, payload')
      .eq('guild_id', GUILD_ID)
      .eq('action', 'revoke_roles')
      .eq('payload->>source', 'noncommerce_entitlement_status_trigger');
    expect(cleanupError).toBeNull();
    expect(cleanup).toHaveLength(1);
  });

  it('rejects a same-status stale updated_at observation without audit or cleanup', async () => {
    const observed = await createActiveEntitlement();

    const { data: refreshed, error: refreshError } = await supa
      .from('entitlements')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', observed.id)
      .select('id, status, updated_at')
      .single();
    expect(refreshError).toBeNull();
    expect(refreshed?.status).toBe('active');
    expect(refreshed?.updated_at).not.toBe(observed.updated_at);

    const stale = await revoke(observed);
    expect(stale).toMatchObject({
      disposition: 'stale',
      transition_id: null,
      entitlement_id: observed.id,
      status: 'active',
    });

    const { count: auditCount, error: auditError } = await supa
      .from('audit_logs')
      .select('id', { count: 'exact', head: true })
      .eq('guild_id', GUILD_ID)
      .eq('action', 'entitlement.revoked')
      .eq('target_id', observed.id);
    expect(auditError).toBeNull();
    expect(auditCount).toBe(0);

    const retried = await revoke(refreshed as EntitlementObservation, 'refund');
    expect(retried.disposition).toBe('applied');
    expect(retried.status).toBe('expired');
  });

  it('waits on the row lock without holding the customer advisory (trigger lock order)', async () => {
    // Admin cancel acquires the entitlement row lock first and only then the
    // 'noncommerce-entitlement-customer' advisory key (its AFTER-UPDATE
    // trigger chain cannot do otherwise). The revoke RPC must follow the same
    // row -> advisory order; advisory-first is a two-transaction deadlock.
    const observed = await createActiveEntitlement();
    const advisoryKey = `noncommerce-entitlement-customer:${observed.customer_id}`;
    let revokePromise!: Promise<RevokeEvidence[]>;

    await sqlA.begin(async (admin) => {
      const locked = await admin`
        SELECT id FROM public.entitlements
         WHERE id = ${observed.id}::uuid
         FOR UPDATE
      `;
      expect(locked).toHaveLength(1);

      revokePromise = sqlB<RevokeEvidence[]>`
        SELECT disposition, transition_id, entitlement_id, guild_id,
               status, updated_at
          FROM public.commerce_revoke_entitlement_exact(
            ${observed.id}::uuid,
            ${GUILD_ID}::text,
            ${observed.status}::text,
            ${observed.updated_at}::text::timestamptz, -- text-first: a direct ::timestamptz cast makes postgres.js serialize via Date, truncating microseconds and breaking CAS evidence
            'cancelled'::text
          )
      `.execute();
      await waitForSqlBLock();

      // The parked revoke must hold no advisory lock while it waits on the
      // row; holding the customer key here is the deadlock inversion.
      const [advisory] = await sqlObserver<{ held: number }[]>`
        SELECT pg_catalog.count(*)::int AS held
          FROM pg_catalog.pg_locks
         WHERE pid = ${sqlBBackendPid}
           AND locktype = 'advisory'
           AND granted
      `;
      expect(advisory?.held).toBe(0);

      // The row-lock holder can therefore still take the same advisory key,
      // exactly as the status triggers do mid-UPDATE, and finish the cancel.
      await admin`
        SELECT pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended(${advisoryKey}::text, 0)
        )
      `;
      const adminCancel = await admin`
        SELECT status
          FROM public.commerce_update_entitlement_status_admin(
            ${observed.id}::uuid,
            ${observed.customer_id}::uuid,
            ${GUILD_ID}::text,
            'cancelled'::text,
            NULL::timestamptz
          )
      `;
      expect(adminCancel[0]?.status).toBe('cancelled');
    });

    // The admin cancel won the row; the exact revoke observes the terminal
    // state as a completed no-op and manufactures no second audit or carrier.
    const revokeRows = await revokePromise;
    expect(revokeRows).toHaveLength(1);
    expect(revokeRows[0]).toMatchObject({ disposition: 'noop', transition_id: null });

    const { data: entitlement, error: entitlementError } = await supa
      .from('entitlements')
      .select('status')
      .eq('id', observed.id)
      .single();
    expect(entitlementError).toBeNull();
    expect(entitlement?.status).toBe('cancelled');

    const { count: auditCount, error: auditError } = await supa
      .from('audit_logs')
      .select('id', { count: 'exact', head: true })
      .eq('guild_id', GUILD_ID)
      .eq('action', 'entitlement.revoked')
      .eq('target_id', observed.id);
    expect(auditError).toBeNull();
    expect(auditCount).toBe(0);

    const { data: cleanup, error: cleanupError } = await supa
      .from('bot_action_queue')
      .select('id')
      .eq('guild_id', GUILD_ID)
      .eq('action', 'revoke_roles')
      .eq('payload->>source', 'noncommerce_entitlement_status_trigger');
    expect(cleanupError).toBeNull();
    expect(cleanup).toHaveLength(1);
  });

  it('holds the entitlement row and customer advisory before waiting on the customer row', async () => {
    // Round-3 canon: entitlement FOR UPDATE -> customer advisory -> customer
    // FOR SHARE. purge_member_data holds the customers row exclusively while
    // its captured entitlements are already terminal; a customer-share-first
    // revoke (the old order) parked here while holding nothing, then took the
    // entitlement row lock the purge was waiting for -- the AB-BA this test
    // pins. The parked revoke must instead already own the entitlement row
    // and the advisory when it reaches the customer wait.
    const observed = await createActiveEntitlement();
    let revokePromise!: Promise<RevokeEvidence[]>;

    await sqlA.begin(async (purge) => {
      // Simulate purge_member_data's exclusive customers hold.
      const locked = await purge`
        SELECT id FROM public.customers
         WHERE id = ${observed.customer_id}::uuid
         FOR UPDATE
      `;
      expect(locked).toHaveLength(1);

      revokePromise = sqlB<RevokeEvidence[]>`
        SELECT disposition, transition_id, entitlement_id, guild_id,
               discord_id, status, updated_at
          FROM public.commerce_revoke_entitlement_exact(
            ${observed.id}::uuid,
            ${GUILD_ID}::text,
            ${observed.status}::text,
            ${observed.updated_at}::text::timestamptz, -- text-first: a direct ::timestamptz cast makes postgres.js serialize via Date, truncating microseconds and breaking CAS evidence
            'cancelled'::text
          )
      `.execute();
      await waitForSqlBLock();

      // Parked on the customer share lock, the revoke already holds exactly
      // the customer advisory key (entitlement -> advisory -> customer)...
      const [advisory] = await sqlObserver<{ held: number }[]>`
        SELECT pg_catalog.count(*)::int AS held
          FROM pg_catalog.pg_locks
         WHERE pid = ${sqlBBackendPid}
           AND locktype = 'advisory'
           AND granted
      `;
      expect(advisory?.held).toBe(1);

      // ...and the entitlement row lock: a third session cannot take it.
      await expect(
        sqlObserver.begin(async (probe) => {
          await probe`
            SELECT id FROM public.entitlements
             WHERE id = ${observed.id}::uuid
             FOR UPDATE NOWAIT
          `;
        }),
      ).rejects.toThrow(/could not obtain lock/);
    });

    // Releasing the customers row lets the parked revoke finish normally:
    // full CAS semantics survive the reorder.
    const revokeRows = await revokePromise;
    expect(revokeRows).toHaveLength(1);
    expect(revokeRows[0]).toMatchObject({
      disposition: 'applied',
      transition_id: expect.any(String),
      discord_id: CUSTOMER_DISCORD_ID,
      status: 'cancelled',
    });

    const { data: entitlement, error: entitlementError } = await supa
      .from('entitlements')
      .select('status')
      .eq('id', observed.id)
      .single();
    expect(entitlementError).toBeNull();
    expect(entitlement?.status).toBe('cancelled');
  });

  it('is not executable through the anonymous browser role', async () => {
    const observed = await createActiveEntitlement();
    const anon = getAnonTestClient();

    const { error } = await anon.rpc('commerce_revoke_entitlement_exact', {
      p_entitlement_id: observed.id,
      p_guild_id: GUILD_ID,
      p_expected_status: observed.status,
      p_expected_updated_at: observed.updated_at,
      p_reason: 'cancelled',
    });

    expect(error).not.toBeNull();
    expect((await supa.from('entitlements').select('status').eq('id', observed.id).single())
      .data?.status).toBe('active');
  });
});
