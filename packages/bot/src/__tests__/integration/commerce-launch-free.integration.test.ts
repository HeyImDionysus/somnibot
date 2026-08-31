import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { claimLaunchFree, countLaunchEffects, withLaunchFixture } from './commerce-launch-fixtures.js';

describe('real database Sandbox free launch persistence', () => {
  it('atomically creates frozen fulfillment proof once for duplicate attempt requests', async () => {
    await withLaunchFixture('free', async (tx, fixture) => {
      // Given an inactive product and the current owner-authorized Sandbox attempt.
      const requestId = randomUUID();

      // When the same attempt submits the same and a different request identity.
      const [claim] = await claimLaunchFree(tx, fixture, requestId);
      const [replay] = await claimLaunchFree(tx, fixture, requestId);
      const [duplicate] = await claimLaunchFree(tx, fixture);

      // Then only one frozen order, entitlement, proof and queue item exist.
      expect(claim).toMatchObject({ request_id: requestId, order_id: requestId, disposition: 'claimed' });
      expect(replay).toMatchObject({ order_id: requestId, disposition: 'already-claimed' });
      expect(duplicate).toMatchObject({ order_id: requestId, disposition: 'already-claimed' });
      expect(await countLaunchEffects(tx, fixture.guildId)).toEqual({ orders: 1, claims: 1, entitlements: 1, queue: 1 });
      const [proof] = await tx<{ active: boolean; state: string; frozen: boolean; run_id: string; fresh: boolean; roles: string[] }[]>`
        SELECT product.active, claim_order.status AS state, claim_order.grant_snapshot_frozen_at IS NOT NULL AS frozen,
          proof.launch_run_id AS run_id, proof.created_at >= launch.verification_started_at AS fresh,
          claim_order.granted_role_ids_snapshot AS roles
        FROM public.commerce_free_claims AS proof
        JOIN public.orders AS claim_order ON claim_order.id = proof.order_id
        JOIN public.products AS product ON product.id = proof.product_id
        JOIN public.commerce_product_launch_runs AS launch ON launch.id = proof.launch_run_id
        WHERE proof.request_id = ${requestId}
      `;
      expect(proof).toEqual({ active: false, state: 'completed', frozen: true, run_id: fixture.runId, fresh: true, roles: [fixture.roleId] });
    });
  });

  it.each(['owner', 'environment', 'state', 'attempt'] as const)('rejects a mismatched %s without partial fulfillment', async (mismatch) => {
    await withLaunchFixture('free', async (tx, fixture) => {
      // Given authorization changes after a launch button was displayed.
      if (mismatch === 'owner') await tx`UPDATE public.guild SET owner_discord_id = '900000000000000999' WHERE id = ${fixture.guildId}`;
      if (mismatch === 'environment') await tx`UPDATE public.commerce_product_launch_runs SET environment = 'live' WHERE id = ${fixture.runId}`;
      if (mismatch === 'state') await tx`UPDATE public.commerce_product_launch_runs SET state = 'retired' WHERE id = ${fixture.runId}`;
      if (mismatch === 'attempt') await tx`UPDATE public.commerce_product_launch_runs SET verification_started_at = clock_timestamp() WHERE id = ${fixture.runId}`;

      // When the old request reaches the authoritative RPC.
      await expect(tx.savepoint((savepoint) => claimLaunchFree(savepoint, fixture))).rejects.toMatchObject({ code: '42501' });

      // Then the rejected transaction leaves no fulfillment or proof.
      expect(await countLaunchEffects(tx, fixture.guildId)).toEqual({ orders: 0, claims: 0, entitlements: 0, queue: 0 });
    });
  });

  it('requires new proof after restart and refuses to refresh or rebind old proof', async () => {
    await withLaunchFixture('free', async (tx, fixture) => {
      // Given a completed proof from an earlier verification attempt.
      const requestId = randomUUID();
      await claimLaunchFree(tx, fixture, requestId);
      const [restart] = await tx<{ started_at: string }[]>`
        UPDATE public.commerce_product_launch_runs SET verification_started_at = clock_timestamp()
        WHERE id = ${fixture.runId} RETURNING verification_started_at::text AS started_at
      `;
      if (!restart) throw new Error('Launch restart did not return its timestamp');
      const current = { ...fixture, startedAt: restart.started_at };

      // When an earlier identity or timestamp is reused.
      await expect(tx.savepoint((savepoint) => claimLaunchFree(savepoint, current, requestId))).rejects.toMatchObject({ code: '23514' });
      await expect(tx.savepoint(async (savepoint) => {
        await savepoint`RESET ROLE`;
        await savepoint`UPDATE public.commerce_free_claims SET created_at = clock_timestamp() WHERE request_id = ${requestId}`;
      })).rejects.toMatchObject({ code: '23514' });
      await expect(tx.savepoint(async (savepoint) => {
        await savepoint`RESET ROLE`;
        await savepoint`UPDATE public.commerce_free_claims SET launch_run_id = NULL WHERE request_id = ${requestId}`;
      })).rejects.toMatchObject({ code: '23514' });

      // Then a genuinely new request creates fresh proof without rewriting the old row.
      const [fresh] = await claimLaunchFree(tx, current);
      expect(fresh?.disposition).toBe('claimed');
      expect(fresh?.order_id).not.toBe(requestId);
      expect(await countLaunchEffects(tx, fixture.guildId)).toEqual({ orders: 2, claims: 2, entitlements: 2, queue: 2 });
    });
  });

  it('preserves completed orders and fulfillment when their launch run is removed', async () => {
    await withLaunchFixture('free', async (tx, fixture) => {
      const requestId = randomUUID();
      await claimLaunchFree(tx, fixture, requestId);
      const [before] = await tx<{ proof: string; order: string }[]>`
        SELECT (to_jsonb(proof) - 'launch_run_id')::text AS proof, to_jsonb(claim_order)::text AS "order"
        FROM public.commerce_free_claims AS proof
        JOIN public.orders AS claim_order ON claim_order.id = proof.order_id
        WHERE proof.request_id = ${requestId}
      `;
      if (!before) throw new Error('Completed launch proof is missing');

      const removed = await tx`DELETE FROM public.commerce_product_launch_runs WHERE id = ${fixture.runId} RETURNING id`;

      expect(removed).toEqual([{ id: fixture.runId }]);
      const [after] = await tx<{ run_id: string | null; proof: string; order: string }[]>`
        SELECT proof.launch_run_id AS run_id, (to_jsonb(proof) - 'launch_run_id')::text AS proof,
          to_jsonb(claim_order)::text AS "order"
        FROM public.commerce_free_claims AS proof
        JOIN public.orders AS claim_order ON claim_order.id = proof.order_id
        WHERE proof.request_id = ${requestId}
      `;
      expect(after).toEqual({ run_id: null, ...before });
      expect(await countLaunchEffects(tx, fixture.guildId)).toEqual({ orders: 1, claims: 1, entitlements: 1, queue: 1 });
    });
  });

  it('keeps ordinary free claims active-only and denies private admission helpers to API roles', async () => {
    await withLaunchFixture('free', async (tx, fixture) => {
      // Given the same inactive product without the dedicated launch entrypoint.
      await expect(tx.savepoint((savepoint) => savepoint`SELECT * FROM public.commerce_claim_free_product(
        ${randomUUID()}::uuid, ${fixture.guildId}, ${fixture.customerId}::uuid, ${fixture.productId}::uuid
      )`)).rejects.toThrow();

      // When database privileges for the private helper and public RPC are inspected.
      const [privileges] = await tx<{ private_allowed: boolean; service_allowed: boolean; anon_allowed: boolean; authenticated_allowed: boolean }[]>`
        SELECT has_function_privilege('service_role', 'public.commerce_order_is_sandbox_launch(uuid)', 'EXECUTE') AS private_allowed,
          has_function_privilege('service_role', 'public.commerce_claim_free_product_for_launch(uuid,text,uuid,uuid,uuid,timestamp with time zone)', 'EXECUTE') AS service_allowed,
          has_function_privilege('anon', 'public.commerce_claim_free_product_for_launch(uuid,text,uuid,uuid,uuid,timestamp with time zone)', 'EXECUTE') AS anon_allowed,
          has_function_privilege('authenticated', 'public.commerce_claim_free_product_for_launch(uuid,text,uuid,uuid,uuid,timestamp with time zone)', 'EXECUTE') AS authenticated_allowed
      `;

      // Then only the supported service-role entrypoint is available, with no side effects.
      expect(privileges).toEqual({ private_allowed: false, service_allowed: true, anon_allowed: false, authenticated_allowed: false });
      expect(await countLaunchEffects(tx, fixture.guildId)).toEqual({ orders: 0, claims: 0, entitlements: 0, queue: 0 });
    });
  });
});
