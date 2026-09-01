import { describe, expect, it } from 'vitest';
import { claimLaunchFree, withLaunchFixture, type LaunchFixture, type LaunchTransaction } from './commerce-launch-fixtures.js';

type Mutation = 'tutorial' | 'start' | 'restart' | 'hide' | 'disable' | 'remove' | 'stage' | 'verify';

async function rejectLaunchAudit(tx: LaunchTransaction, guildId: string): Promise<void> {
  await tx`RESET ROLE`;
  await tx`SELECT pg_catalog.set_config('somnibot.test_reject_launch_audit', ${guildId}, true)`;
  await tx`CREATE FUNCTION pg_temp.reject_launch_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.guild_id = pg_catalog.current_setting('somnibot.test_reject_launch_audit', true)
         AND NEW.action LIKE 'commerce.launch.%' THEN
        RAISE EXCEPTION 'launch audit fixture failure';
      END IF;
      RETURN NEW;
    END;
  $$`;
  await tx`CREATE TRIGGER test_reject_launch_audit BEFORE INSERT ON public.audit_logs
    FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_launch_audit()`;
  await tx`SET LOCAL ROLE service_role`;
}

async function verifyRun(tx: LaunchTransaction, fixture: LaunchFixture, productRevision?: string): Promise<void> {
  const [run] = await tx<{ operation_id: string; product_revision: string; started_at: string; stages: string; version: number }[]>`
    SELECT launch.operation_id, product.updated_at::text AS product_revision,
      launch.verification_started_at::text AS started_at, launch.stages::text AS stages, launch.version
    FROM public.commerce_product_launch_runs AS launch
    JOIN public.products AS product ON product.id = launch.product_id
    WHERE launch.id = ${fixture.runId}
  `;
  if (!run) throw new Error('Launch verification fixture is missing');
  await tx`SELECT public.commerce_verify_product_launch(
    ${fixture.guildId}, ${fixture.ownerId}, ${fixture.runId}::uuid, ${run.version},
    ${productRevision ?? run.product_revision}::timestamptz, NULL::timestamptz,
    ${run.stages}::jsonb,
    pg_catalog.jsonb_build_object(
      'operation_id', ${run.operation_id}::text, 'product_id', ${fixture.productId}::text,
      'product_revision', ${productRevision ?? run.product_revision}::text, 'policy_revision', NULL,
      'verification_started_at', ${run.started_at}::text, 'environment', 'sandbox', 'stages', ${run.stages}::jsonb
    ), ${'a'.repeat(64)}, false
  )`;
}

async function applyMutation(tx: LaunchTransaction, fixture: LaunchFixture, action: Mutation): Promise<void> {
  if (action === 'tutorial') {
    await tx`SELECT public.commerce_create_tutorial_launch(${fixture.guildId}, ${fixture.ownerId})`;
  } else if (action === 'start') {
    await tx`SELECT public.commerce_start_product_launch(${fixture.guildId}, ${fixture.ownerId}, ${fixture.productId}::uuid, false)`;
  } else if (action === 'verify') {
    await verifyRun(tx, fixture);
  } else {
    await tx`SELECT public.commerce_mutate_product_launch(
      ${fixture.guildId}, ${fixture.ownerId}, ${fixture.runId}::uuid, 1, ${action},
      ${action === 'stage' ? 'webhook' : null}::text, ${action === 'stage' ? 'failed' : null}::text,
      pg_catalog.jsonb_build_object('error', 'Synthetic launch verification failure')
    )`;
  }
}

async function readSnapshot(tx: LaunchTransaction, fixture: LaunchFixture) {
  const [snapshot] = await tx<{ launch: string | null; product: string | null; proof: string | null; orders: string | null; products: number; audits: number }[]>`
    SELECT (SELECT pg_catalog.to_jsonb(launch)::text FROM public.commerce_product_launch_runs AS launch
              WHERE launch.id = ${fixture.runId}) AS launch,
      (SELECT pg_catalog.to_jsonb(product)::text FROM public.products AS product
         WHERE product.id = ${fixture.productId}) AS product,
      (SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(proof) ORDER BY proof.request_id)::text
         FROM public.commerce_free_claims AS proof WHERE proof.guild_id = ${fixture.guildId}) AS proof,
      (SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(claim_order) ORDER BY claim_order.id)::text
         FROM public.orders AS claim_order WHERE claim_order.guild_id = ${fixture.guildId}) AS orders,
      (SELECT count(*)::int FROM public.products WHERE guild_id = ${fixture.guildId}) AS products,
      (SELECT count(*)::int FROM public.audit_logs WHERE guild_id = ${fixture.guildId}) AS audits
  `;
  if (!snapshot) throw new Error('Launch rollback snapshot is missing');
  return snapshot;
}

async function prepareActivation(tx: LaunchTransaction, fixture: LaunchFixture): Promise<void> {
  await tx`UPDATE public.commerce_product_launch_runs
    SET state = 'ready', launch_receipt_hash = ${'a'.repeat(64)},
      launch_receipt = pg_catalog.jsonb_build_object(
        'product_revision', (SELECT updated_at FROM public.products WHERE id = ${fixture.productId}),
        'policy_revision', NULL
      )
    WHERE id = ${fixture.runId}`;
}

describe('real database atomic launch mutations and audit', () => {
  it('rolls back product activation and the complete launch run when activation audit fails', async () => {
    await withLaunchFixture('free', async (tx, fixture) => {
      // Given a current ready receipt, durable proof, and a failing critical audit.
      await claimLaunchFree(tx, fixture);
      await prepareActivation(tx, fixture);
      const before = await readSnapshot(tx, fixture);
      await rejectLaunchAudit(tx, fixture.guildId);

      // When a service-role activation reaches the audit insert.
      await expect(tx.savepoint((savepoint) => savepoint`
        UPDATE public.products SET active = true WHERE id = ${fixture.productId}
      `)).rejects.toMatchObject({ code: 'P0001', message: 'launch audit fixture failure' });

      // Then active, run state/version/receipt, proof, and audit history all roll back.
      expect(await readSnapshot(tx, fixture)).toEqual(before);
    });
  });

  it('records successful activation with system actor and exact operation/run/version linkage', async () => {
    await withLaunchFixture('free', async (tx, fixture) => {
      // Given a ready launch with a current product revision.
      await prepareActivation(tx, fixture);

      // When a service-role product update activates that launch.
      await tx`UPDATE public.products SET active = true WHERE id = ${fixture.productId}`;

      // Then the durable activation event identifies the updated run and system actor.
      const result = await tx<{
        active: boolean; state: string; environment: string; version: number; actor_type: string;
        actor_id: string; operation_matches: boolean; run_matches: boolean; version_matches: boolean;
        target_matches: boolean; receipt_matches: boolean; actor_matches: boolean;
      }[]>`SELECT product.active, launch.state, launch.environment, launch.version, audit.actor_type, audit.actor_id,
          audit.correlation_id = launch.operation_id::text
            AND audit.details->>'operation_id' = launch.operation_id::text AS operation_matches,
          audit.details->>'launch_run_id' = launch.id::text AS run_matches,
          (audit.details->>'version')::integer = launch.version AS version_matches,
          audit.target_type = 'product' AND audit.target_id = product.id::text AS target_matches,
          launch.launch_receipt->'activation'->>'active' = 'true'
            AND launch.launch_receipt->'activation'->>'product_id' = product.id::text
            AND (launch.launch_receipt->'activation'->>'product_revision')::timestamptz = product.updated_at
            AND (launch.launch_receipt->'activation'->>'activated_at')::timestamptz = launch.activated_at AS receipt_matches,
          launch.updated_by = audit.actor_id AS actor_matches
        FROM public.commerce_product_launch_runs AS launch
        JOIN public.products AS product ON product.id = launch.product_id
        JOIN public.audit_logs AS audit ON audit.guild_id = launch.guild_id
          AND audit.action = 'commerce.launch.activated'
        WHERE launch.id = ${fixture.runId}`;
      expect(result).toEqual([{
        active: true, state: 'live', environment: 'live', version: 2, actor_type: 'system',
        actor_id: 'system:product-activation', operation_matches: true, run_matches: true,
        version_matches: true, target_matches: true, receipt_matches: true, actor_matches: true,
      }]);
    });
  });

  it.each<Mutation>(['tutorial', 'start', 'restart', 'hide', 'disable', 'remove', 'stage', 'verify'])(
    'rolls back %s and preserves existing proof when critical audit fails', async (action) => {
      await withLaunchFixture('free', async (tx, fixture) => {
        // Given existing durable proof and an audit insert failure in this transaction only.
        await claimLaunchFree(tx, fixture);
        const before = await readSnapshot(tx, fixture);
        await rejectLaunchAudit(tx, fixture.guildId);

        // When the supported service-role mutation reaches its critical audit.
        await expect(tx.savepoint((savepoint) => applyMutation(savepoint, fixture, action)))
          .rejects.toMatchObject({ code: 'P0001', message: 'launch audit fixture failure' });

        // Then even removal's FK detachment, tutorial creation, and all state changes roll back.
        expect(await readSnapshot(tx, fixture)).toEqual(before);
      });
    },
  );

  it('commits verification with actor-attributed operation history', async () => {
    await withLaunchFixture('free', async (tx, fixture) => {
      await verifyRun(tx, fixture);

      const [result] = await tx<{ state: string; version: number; actor_id: string; operation_matches: boolean; run_matches: boolean }[]>`
        SELECT launch.state, launch.version, audit.actor_id,
          audit.correlation_id = launch.operation_id::text
            AND audit.details->>'operation_id' = launch.operation_id::text AS operation_matches,
          audit.details->>'launch_run_id' = launch.id::text AS run_matches
        FROM public.commerce_product_launch_runs AS launch
        JOIN public.audit_logs AS audit ON audit.guild_id = launch.guild_id
          AND audit.action = 'commerce.launch.verified'
        WHERE launch.id = ${fixture.runId}
      `;
      expect(result).toEqual({
        state: 'sandbox_verifying', version: 2, actor_id: fixture.ownerId, operation_matches: true, run_matches: true,
      });
    });
  });

  it('rejects a stale version without a second mutation or misleading audit', async () => {
    await withLaunchFixture('free', async (tx, fixture) => {
      await applyMutation(tx, fixture, 'restart');
      const before = await readSnapshot(tx, fixture);

      const [conflict] = await tx<{ rejected: boolean }[]>`SELECT public.commerce_mutate_product_launch(
        ${fixture.guildId}, ${fixture.ownerId}, ${fixture.runId}::uuid, 1, 'hide'
      ) IS NULL AS rejected`;

      expect(conflict?.rejected).toBe(true);
      expect(await readSnapshot(tx, fixture)).toEqual(before);
    });
  });

  it('does not stamp a receipt after the product snapshot changes', async () => {
    await withLaunchFixture('free', async (tx, fixture) => {
      const [old] = await tx<{ revision: string }[]>`SELECT updated_at::text AS revision FROM public.products WHERE id = ${fixture.productId}`;
      if (!old) throw new Error('Product revision fixture is missing');
      await tx`UPDATE public.products SET name = 'Revised launch configuration', updated_at = clock_timestamp()
        WHERE id = ${fixture.productId}`;
      const before = await readSnapshot(tx, fixture);

      await verifyRun(tx, fixture, old.revision);

      expect(await readSnapshot(tx, fixture)).toEqual(before);
    });
  });

  it('denies a caller who is not the current owner without changing the run', async () => {
    await withLaunchFixture('free', async (tx, fixture) => {
      const before = await readSnapshot(tx, fixture);

      await expect(tx.savepoint((savepoint) => savepoint`SELECT public.commerce_mutate_product_launch(
        ${fixture.guildId}, '900000000000000999', ${fixture.runId}::uuid, 1, 'remove'
      )`)).rejects.toMatchObject({ code: '42501' });

      expect(await readSnapshot(tx, fixture)).toEqual(before);
    });
  });

  it('exposes only audited entrypoints to service_role, never private audit helpers to API roles', async () => {
    await withLaunchFixture('free', async (tx) => {
      const [privileges] = await tx<{ service_allowed: boolean; anon_allowed: boolean; authenticated_allowed: boolean; helper_allowed: boolean }[]>`
        SELECT has_function_privilege('service_role', 'public.commerce_mutate_product_launch(text,text,uuid,integer,text,text,text,jsonb)', 'EXECUTE') AS service_allowed,
          has_function_privilege('anon', 'public.commerce_mutate_product_launch(text,text,uuid,integer,text,text,text,jsonb)', 'EXECUTE') AS anon_allowed,
          has_function_privilege('authenticated', 'public.commerce_mutate_product_launch(text,text,uuid,integer,text,text,text,jsonb)', 'EXECUTE') AS authenticated_allowed,
          has_function_privilege('service_role', 'public.commerce_record_launch_audit(public.commerce_product_launch_runs,text,text,jsonb)', 'EXECUTE') AS helper_allowed
      `;
      expect(privileges).toEqual({ service_allowed: true, anon_allowed: false, authenticated_allowed: false, helper_allowed: false });
    });
  });
});
