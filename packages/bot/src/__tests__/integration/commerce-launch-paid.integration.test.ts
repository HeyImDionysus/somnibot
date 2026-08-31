import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  bindLaunchIntent, claimLaunchIntent, countLaunchEffects, persistLaunchPaid, withLaunchFixture,
  type LaunchFixture, type LaunchTransaction,
} from './commerce-launch-fixtures.js';

async function prepareAttempt(tx: LaunchTransaction, fixture: LaunchFixture) {
  const attempt = await claimLaunchIntent(tx, fixture);
  await bindLaunchIntent(tx, fixture, attempt.token);
  if (fixture.kind === 'one_time') {
    const [price] = await tx<{ amount: number; discount: number }[]>`
      SELECT (pricing->>'amount_cents')::int AS amount, (pricing->>'discount_cents')::int AS discount
      FROM (SELECT public.commerce_reserve_launch_checkout_pricing(
        ${attempt.token}::uuid, ${fixture.startedAt}::timestamptz
      ) AS pricing) AS reserved
    `;
    expect(price).toEqual({ amount: 500, discount: 0 });
  } else {
    const plans = await tx<{ id: string }[]>`SELECT id FROM public.commerce_select_launch_checkout_plan(
      ${attempt.token}::uuid, ${fixture.startedAt}::timestamptz
    )`;
    expect(plans.map((plan) => plan.id)).toEqual([fixture.planId]);
  }
  return attempt;
}

describe('real database Sandbox paid launch persistence', () => {
  it.each(['one_time', 'subscription'] as const)('freezes and binds an inactive %s checkout with exact replay', async (kind) => {
    await withLaunchFixture(kind, async (tx, fixture) => {
      // Given a current owner-authorized attempt with verified Sandbox pricing.
      const attempt = await prepareAttempt(tx, fixture);

      // When persistence is retried after its first successful transaction result.
      const [created] = await persistLaunchPaid(tx, fixture, attempt);
      const [replayed] = await persistLaunchPaid(tx, fixture, attempt);

      // Then both responses identify the same frozen order and immutable launch binding.
      expect(created).toMatchObject({ disposition: 'created', frozen: true });
      expect(replayed).toEqual({ id: created?.id, disposition: 'replay', frozen: true });
      expect(await countLaunchEffects(tx, fixture.guildId)).toEqual({ orders: 1, claims: 0, entitlements: 0, queue: 0 });
      const [bound] = await tx<{ status: string; order_id: string; run_id: string; provider_id: string; active: boolean; roles: string[] }[]>`
        SELECT intent.status, intent.order_id, intent.launch_run_id AS run_id, intent.provider_id,
          product.active, paid_order.granted_role_ids_snapshot AS roles
        FROM public.commerce_checkout_intents AS intent
        JOIN public.products AS product ON product.id = intent.product_id
        JOIN public.orders AS paid_order ON paid_order.id = intent.order_id
        WHERE intent.token = ${attempt.token}
      `;
      expect(bound).toEqual({ status: 'bound', order_id: created?.id, run_id: fixture.runId,
        provider_id: attempt.providerId, active: false, roles: [fixture.roleId] });
    });
  });

  it('rejects live provider URLs without leaving provider or order bindings', async () => {
    await withLaunchFixture('one_time', async (tx, fixture) => {
      // Given a valid launch attempt whose returned provider URL is not Sandbox.
      const attempt = await prepareAttempt(tx, fixture);

      // When the authoritative persistence boundary receives the live URL.
      await expect(tx.savepoint((savepoint) => persistLaunchPaid(savepoint, fixture, {
        ...attempt, approvalUrl: 'https://www.paypal.com/checkoutnow?token=fixture',
      }))).rejects.toMatchObject({ code: '23514' });

      // Then no order exists and the intent remains unbound to a provider.
      expect(await countLaunchEffects(tx, fixture.guildId)).toEqual({ orders: 0, claims: 0, entitlements: 0, queue: 0 });
      const [intent] = await tx<{ status: string; provider_id: string | null; order_id: string | null }[]>`
        SELECT status, provider_id, order_id FROM public.commerce_checkout_intents WHERE token = ${attempt.token}
      `;
      expect(intent).toEqual({ status: 'pending', provider_id: null, order_id: null });
    });
  });

  it('rolls back provider binding when order insertion fails after that write', async () => {
    await withLaunchFixture('one_time', async (tx, fixture) => {
      // Given an unrelated manual order already owns the globally unique order number.
      const attempt = await prepareAttempt(tx, fixture);
      const collisionId = randomUUID();
      await tx`RESET ROLE`;
      await tx`INSERT INTO public.orders (id, order_number, guild_id, customer_id, amount_cents, source, status, checkout_active)
        VALUES (${collisionId}, ${attempt.orderNumber}, ${fixture.guildId}, ${fixture.customerId}, 0, 'manual', 'pending', false)`;
      await tx`SET LOCAL ROLE service_role`;

      // When provider identity is written and the subsequent order insert collides.
      await expect(tx.savepoint((savepoint) => persistLaunchPaid(savepoint, fixture, attempt))).rejects.toMatchObject({ code: '23505' });

      // Then the entire RPC rolls back, not just its failed INSERT statement.
      const [intent] = await tx<{ provider_id: string | null; order_id: string | null }[]>`
        SELECT provider_id, order_id FROM public.commerce_checkout_intents WHERE token = ${attempt.token}
      `;
      expect(intent).toEqual({ provider_id: null, order_id: null });
      expect(await countLaunchEffects(tx, fixture.guildId)).toEqual({ orders: 1, claims: 0, entitlements: 0, queue: 0 });
    });
  });

  it('rejects a restarted attempt and prevents refreshing the old checkout identity', async () => {
    await withLaunchFixture('one_time', async (tx, fixture) => {
      // Given an intent bound before verification was restarted.
      const attempt = await prepareAttempt(tx, fixture);
      const [restart] = await tx<{ started_at: string }[]>`
        UPDATE public.commerce_product_launch_runs SET verification_started_at = clock_timestamp()
        WHERE id = ${fixture.runId} RETURNING verification_started_at::text AS started_at
      `;
      if (!restart) throw new Error('Launch restart did not return its timestamp');

      // When either the stale timestamp or the new timestamp with the old intent is supplied.
      await expect(tx.savepoint((savepoint) => persistLaunchPaid(savepoint, fixture, attempt))).rejects.toMatchObject({ code: '42501' });
      await expect(tx.savepoint((savepoint) => persistLaunchPaid(savepoint, {
        ...fixture, startedAt: restart.started_at,
      }, attempt))).rejects.toMatchObject({ code: '42501' });
      await expect(tx.savepoint((savepoint) => savepoint`
        UPDATE public.commerce_checkout_intents SET created_at = clock_timestamp() WHERE token = ${attempt.token}
      `)).rejects.toMatchObject({ code: '23514' });
      await expect(tx.savepoint((savepoint) => savepoint`
        UPDATE public.commerce_checkout_intents SET launch_run_id = NULL WHERE token = ${attempt.token}
      `)).rejects.toMatchObject({ code: '23514' });

      // Then freshness cannot be forged and no order is created.
      expect(await countLaunchEffects(tx, fixture.guildId)).toEqual({ orders: 0, claims: 0, entitlements: 0, queue: 0 });
    });
  });

  it.each(['one_time', 'subscription'] as const)('preserves a bound %s checkout when its launch run is removed', async (kind) => {
    await withLaunchFixture(kind, async (tx, fixture) => {
      const attempt = await prepareAttempt(tx, fixture);
      await persistLaunchPaid(tx, fixture, attempt);
      const [before] = await tx<{ intent: string; order: string }[]>`
        SELECT (to_jsonb(intent) - 'launch_run_id')::text AS intent, to_jsonb(paid_order)::text AS "order"
        FROM public.commerce_checkout_intents AS intent
        JOIN public.orders AS paid_order ON paid_order.id = intent.order_id
        WHERE intent.token = ${attempt.token}
      `;
      if (!before) throw new Error('Bound launch checkout is missing');

      const removed = await tx`DELETE FROM public.commerce_product_launch_runs WHERE id = ${fixture.runId} RETURNING id`;

      expect(removed).toEqual([{ id: fixture.runId }]);
      const [after] = await tx<{ run_id: string | null; intent: string; order: string }[]>`
        SELECT intent.launch_run_id AS run_id, (to_jsonb(intent) - 'launch_run_id')::text AS intent,
          to_jsonb(paid_order)::text AS "order"
        FROM public.commerce_checkout_intents AS intent
        JOIN public.orders AS paid_order ON paid_order.id = intent.order_id
        WHERE intent.token = ${attempt.token}
      `;
      expect(after).toEqual({ run_id: null, ...before });
      expect(await countLaunchEffects(tx, fixture.guildId)).toEqual({ orders: 1, claims: 0, entitlements: 0, queue: 0 });
    });
  });

  it('preserves ordinary active-only pricing, plan selection and checkout creation', async () => {
    await withLaunchFixture('one_time', async (tx, fixture) => {
      // Given an inactive product, even a valid launch token cannot weaken ordinary RPCs.
      const attempt = await prepareAttempt(tx, fixture);

      // When ordinary checkout entrypoints are called directly.
      await expect(tx.savepoint((savepoint) => savepoint`SELECT public.commerce_reserve_checkout_pricing(${attempt.token}::uuid, NULL::text)`)).rejects.toThrow();
      await expect(tx.savepoint((savepoint) => savepoint`SELECT public.commerce_create_and_bind_active_paid_checkout(
        ${attempt.token}::uuid, ${attempt.orderNumber}, ${fixture.guildId}, ${fixture.customerId}::uuid,
        ${fixture.productId}::uuid, NULL::uuid, 'capture', ${attempt.providerId}, ${attempt.approvalUrl}, 500, 'USD'
      )`)).rejects.toThrow();
      const plans = await tx`SELECT * FROM public.commerce_select_checkout_plan(${fixture.guildId}, ${fixture.productId}::uuid)`;

      // Then no ordinary checkout or plan is admitted for the inactive product.
      expect(plans).toHaveLength(0);
      expect(await countLaunchEffects(tx, fixture.guildId)).toEqual({ orders: 0, claims: 0, entitlements: 0, queue: 0 });
    });
  });
});
