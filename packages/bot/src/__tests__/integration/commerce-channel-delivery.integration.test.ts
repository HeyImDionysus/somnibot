import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { claimLaunchFree, withLaunchFixture, type LaunchFixture, type LaunchTransaction } from './commerce-launch-fixtures.js';

const CHANNELS = ['900000000000000201', '900000000000000202'];

async function channelDelivery(tx: LaunchTransaction, fixture: LaunchFixture) {
  await tx`UPDATE public.products SET granted_role_ids = '{}'::text[], granted_channel_ids = ${CHANNELS}::text[] WHERE id = ${fixture.productId}`;
  const [claim] = await claimLaunchFree(tx, fixture);
  if (!claim?.entitlement_id) throw new Error('Free channel claim did not create its entitlement');
  const [carrier] = await tx<{ id: string; claim_token: string }[]>`
    SELECT claimed.id, claimed.claim_token FROM public.bot_action_queue AS queue
    CROSS JOIN LATERAL public.bot_action_queue_claim(queue.id, 2) AS claimed
    WHERE queue.guild_id = ${fixture.guildId} AND queue.payload->>'order_id' = ${claim.order_id}
      AND queue.action = 'fulfill_purchase'
  `;
  if (!carrier) throw new Error('Free channel fulfillment carrier is missing');
  const [intent] = await tx<{ intent_id: string; mutation_token: string; outward_generation_id: string }[]>`
    SELECT * FROM public.commerce_begin_role_delivery_attempt(
      ${carrier.id}::uuid, ${carrier.claim_token}::uuid, ${claim.entitlement_id}::uuid,
      ${fixture.guildId}, ${fixture.customerId}::uuid, ${fixture.ownerId}, ${claim.order_id}::uuid,
      ${fixture.productId}::uuid, NULL::uuid, 'one_time', '{}'::text[]
    )
  `;
  if (!intent?.outward_generation_id) throw new Error('Free channel delivery generation is missing');
  await tx`SELECT * FROM public.commerce_finish_role_delivery_attempt(
    ${intent.intent_id}::uuid, ${intent.mutation_token}::uuid, 'live', NULL::text
  )`;
  return { actionId: carrier.id, claimToken: carrier.claim_token, orderId: claim.order_id,
    guildId: fixture.guildId, generationId: intent.outward_generation_id, intentId: intent.intent_id };
}

type ChannelDelivery = Awaited<ReturnType<typeof channelDelivery>>;

function confirm(tx: LaunchTransaction, delivery: ChannelDelivery, channels: readonly string[] = CHANNELS) {
  return tx<{ confirmed: boolean }[]>`SELECT public.commerce_confirm_channel_delivery(
    ${delivery.actionId}::uuid, ${delivery.claimToken}::uuid, ${delivery.orderId}::uuid,
    ${delivery.guildId}, ${delivery.generationId}::uuid, ${channels}::text[]
  ) AS confirmed`;
}

function proof(tx: LaunchTransaction, intentId: string) {
  return tx<{ channels: string[]; confirmed_at: string | null; generation_id: string; contract_kind: string }[]>`
    SELECT completed_channel_ids AS channels, channel_delivery_confirmed_at::text AS confirmed_at,
      outward_generation_id AS generation_id, contract_kind
    FROM public.commerce_role_delivery_intents WHERE id = ${intentId}
  `;
}

describe('real database channel-delivery confirmation', () => {
  it('preserves exact free channel proof across duplicate acknowledgments and reversal', async () => {
    await withLaunchFixture('free', async (tx, fixture) => {
      // Given a real free claim with only channel grants and a confirmed role generation.
      const delivery = await channelDelivery(tx, fixture);
      expect(await proof(tx, delivery.intentId)).toEqual([{ channels: [], confirmed_at: null, generation_id: delivery.generationId, contract_kind: 'paid' }]);
      // When acknowledged channel delivery is persisted and the same call is replayed.
      expect(await confirm(tx, delivery)).toEqual([{ confirmed: true }]);
      const original = await proof(tx, delivery.intentId);
      expect(original[0]?.channels).toEqual(CHANNELS);
      expect(original[0]?.confirmed_at).toEqual(expect.any(String));
      expect(await confirm(tx, delivery)).toEqual([{ confirmed: true }]);
      // Then replay and a terminal order cannot rewrite historical acknowledgment.
      expect(await proof(tx, delivery.intentId)).toEqual(original);
      await tx`UPDATE public.orders SET status = 'refunded' WHERE id = ${delivery.orderId}`;
      expect(await proof(tx, delivery.intentId)).toEqual(original);
      await expect(tx.savepoint((savepoint) => confirm(savepoint, delivery))).rejects.toMatchObject({ code: '42501' });
    });
  });

  it.each(['claim', 'generation', 'order', 'guild', 'partial', 'wrong-channel', 'empty'] as const)('rejects %s mismatch without adding proof', async (mismatch) => {
    await withLaunchFixture('free', async (tx, fixture) => {
      // Given a real carrier whose identity and frozen channel vector cannot be substituted.
      const delivery = await channelDelivery(tx, fixture);
      const changed = { ...delivery,
        claimToken: mismatch === 'claim' ? randomUUID() : delivery.claimToken,
        generationId: mismatch === 'generation' ? randomUUID() : delivery.generationId,
        orderId: mismatch === 'order' ? randomUUID() : delivery.orderId,
        guildId: mismatch === 'guild' ? 'other-guild' : delivery.guildId };
      const channels = mismatch === 'partial' ? CHANNELS.slice(0, 1)
        : mismatch === 'wrong-channel' ? ['900000000000000299'] : mismatch === 'empty' ? [] : CHANNELS;
      // When the forged acknowledgment reaches the RPC.
      await expect(tx.savepoint((savepoint) => confirm(savepoint, changed, channels))).rejects.toMatchObject({ code: mismatch === 'empty' ? '23514' : '42501' });
      // Then no channel outcome has been manufactured.
      expect((await proof(tx, delivery.intentId))[0]?.confirmed_at).toBeNull();
      expect((await proof(tx, delivery.intentId))[0]?.channels).toEqual([]);
    });
  });

  it('denies raw API-role confirmation writes and prevents generation or timestamp replacement', async () => {
    await withLaunchFixture('free', async (tx, fixture) => {
      // Given an unconfirmed generation and the service-role caller.
      const delivery = await channelDelivery(tx, fixture);
      await expect(tx.savepoint((savepoint) => savepoint`
        UPDATE public.commerce_role_delivery_intents SET completed_channel_ids = ${CHANNELS}::text[], channel_delivery_confirmed_at = clock_timestamp()
        WHERE id = ${delivery.intentId}
      `)).rejects.toMatchObject({ code: '42501' });
      // When the permitted RPC records the acknowledgment.
      await confirm(tx, delivery);
      const original = await proof(tx, delivery.intentId);
      // Then even owner SQL cannot move proof onto another generation or refresh it.
      await expect(tx.savepoint(async (savepoint) => {
        await savepoint`RESET ROLE`;
        await savepoint`UPDATE public.commerce_role_delivery_intents SET outward_generation_id = ${randomUUID()}::uuid WHERE id = ${delivery.intentId}`;
      })).rejects.toMatchObject({ code: '42501' });
      await expect(tx.savepoint(async (savepoint) => {
        await savepoint`RESET ROLE`;
        await savepoint`UPDATE public.commerce_role_delivery_intents SET channel_delivery_confirmed_at = clock_timestamp() WHERE id = ${delivery.intentId}`;
      })).rejects.toMatchObject({ code: '42501' });
      expect(await proof(tx, delivery.intentId)).toEqual(original);
      const [privileges] = await tx<{ service: boolean; anon: boolean; authenticated: boolean }[]>`
        SELECT has_function_privilege('service_role', 'public.commerce_confirm_channel_delivery(uuid,uuid,uuid,text,uuid,text[])', 'EXECUTE') AS service,
          has_function_privilege('anon', 'public.commerce_confirm_channel_delivery(uuid,uuid,uuid,text,uuid,text[])', 'EXECUTE') AS anon,
          has_function_privilege('authenticated', 'public.commerce_confirm_channel_delivery(uuid,uuid,uuid,text,uuid,text[])', 'EXECUTE') AS authenticated
      `;
      expect(privileges).toEqual({ service: true, anon: false, authenticated: false });
    });
  });

  it.each(['generation', 'channels'] as const)('rejects a null %s without manufacturing confirmation', async (field) => {
    await withLaunchFixture('free', async (tx, fixture) => {
      const delivery = await channelDelivery(tx, fixture);
      await expect(tx.savepoint((savepoint) => savepoint`
        SELECT public.commerce_confirm_channel_delivery(
          ${delivery.actionId}::uuid, ${delivery.claimToken}::uuid, ${delivery.orderId}::uuid,
          ${delivery.guildId}, ${field === 'generation' ? null : delivery.generationId}::uuid,
          ${field === 'channels' ? null : CHANNELS}::text[]
        )
      `)).rejects.toMatchObject({ code: '23514' });
      expect((await proof(tx, delivery.intentId))[0]?.confirmed_at).toBeNull();
    });
  });
});
