import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { getTestDbUrl } from './helpers.js';

const sql = postgres(getTestDbUrl(), { max: 4 });
const runId = randomUUID();
const guildId = `task-14-store-${runId}`;
const ownerId = `task-14-owner-${runId}`;
const customerId = randomUUID();
const productId = randomUUID();
const firstToken = randomUUID();
const secondToken = randomUUID();
const providerBinding = 'a'.repeat(64);
const migration = readFileSync(
  new URL('../../../../supabase/migrations/20260818111500_checkout_intent_claim.sql', import.meta.url),
  'utf8',
).replace(/^BEGIN;\s*/u, '').replace(/\s*COMMIT;\s*$/u, '');

type ClaimRow = {
  readonly result: {
    readonly disposition: 'claimed' | 'blocked';
    readonly checkout_token: string;
    readonly provider_id: string | null;
    readonly order_id: string | null;
  };
};

beforeAll(async () => {
  await sql.unsafe(migration);
  await sql`
    INSERT INTO public.guild (id, name, owner_discord_id)
    VALUES (${guildId}, 'Task 14 checkout race', ${ownerId})
  `;
  await sql`
    INSERT INTO public.customers (id, guild_id, discord_id, discord_username)
    VALUES (${customerId}, ${guildId}, ${ownerId}, 'Task14 Buyer')
  `;
  await sql`
    INSERT INTO public.products (
      id, guild_id, name, type, delivery_type, price_cents, currency
    ) VALUES (
      ${productId}, ${guildId}, 'Task 14 Product', 'one_time', 'file', 500, 'USD'
    )
  `;
});

afterAll(async () => {
  await sql`DELETE FROM public.commerce_checkout_intents WHERE guild_id = ${guildId}`;
  await sql`SELECT public.purge_guild_data(${guildId})`;
  await sql.end();
});

describe('commerce checkout intent claim', () => {
  it('serializes two concurrent confirmations before any provider or order mutation', async () => {
    const claim = (token: string) => sql<ClaimRow[]>`
      SELECT public.commerce_claim_checkout_intent(
        ${token}::UUID,
        ${guildId},
        ${customerId}::UUID,
        ${productId}::UUID,
        NULL,
        ${providerBinding}
      ) AS result
    `;

    const [first, second] = await Promise.all([claim(firstToken), claim(secondToken)]);
    const outcomes = [first[0]?.result.disposition, second[0]?.result.disposition].sort();
    const blocked = [first[0]?.result, second[0]?.result]
      .find((result) => result?.disposition === 'blocked');
    if (!blocked) throw new Error('concurrent checkout did not produce a blocked actor');
    const occurrenceKey = `commerce.checkout.race_refused:${blocked.checkout_token}`;
    await Promise.all([firstToken, secondToken].map((actorId) => sql`
      INSERT INTO public.audit_logs (
        guild_id, actor_type, actor_id, action, category,
        target_type, target_id, details, occurrence_key, success
      ) VALUES (
        ${guildId}, 'user', ${actorId}, 'commerce.checkout.race_refused', 'commerce',
        'checkout_intent', ${blocked.checkout_token},
        ${{ stage: 'checkout_intent_claim', product_id: productId }}::JSONB,
        ${occurrenceKey}, false
      )
      ON CONFLICT (guild_id, occurrence_key) DO NOTHING
    `));
    const active = await sql<{ readonly count: number }[]>`
      SELECT pg_catalog.count(*)::INTEGER AS count
        FROM public.commerce_checkout_intents
       WHERE guild_id = ${guildId}
         AND customer_id = ${customerId}::UUID
         AND product_id = ${productId}::UUID
         AND status IN ('pending', 'bound')
    `;
    const providerMutations = await sql<{ readonly count: number }[]>`
      SELECT pg_catalog.count(*)::INTEGER AS count
        FROM public.commerce_checkout_intents
       WHERE guild_id = ${guildId}
         AND (provider_id IS NOT NULL OR order_id IS NOT NULL)
    `;
    const loserAudits = await sql<{ readonly count: number }[]>`
      SELECT pg_catalog.count(*)::INTEGER AS count
        FROM public.audit_logs
       WHERE guild_id = ${guildId}
         AND occurrence_key = ${occurrenceKey}
         AND action = 'commerce.checkout.race_refused'
         AND success = false
    `;

    expect(outcomes).toEqual(['blocked', 'claimed']);
    expect(active[0]?.count).toBe(1);
    expect(providerMutations[0]?.count).toBe(0);
    expect(loserAudits[0]?.count).toBe(1);
  });
});
