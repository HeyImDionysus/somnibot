import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { expect } from 'vitest';
import { getTestDbUrl, requireSupabase } from './helpers.js';

export type LaunchTransaction = postgres.TransactionSql;
export type LaunchKind = 'free' | 'one_time' | 'subscription';
export type LaunchFixture = {
  guildId: string;
  ownerId: string;
  customerId: string;
  productId: string;
  runId: string;
  planId: string;
  roleId: string;
  kind: LaunchKind;
  startedAt: string;
};
export type LaunchClaim = {
  request_id: string;
  order_id: string;
  entitlement_id: string | null;
  disposition: string;
};
export type PaidLaunchAttempt = {
  token: string;
  orderNumber: string;
  providerId: string;
  approvalUrl: string;
};

export async function seedLaunchFixture(tx: LaunchTransaction, kind: LaunchKind): Promise<LaunchFixture> {
  const id = randomUUID();
  const fixture = {
    guildId: `test-sandbox-launch-${id}`,
    ownerId: (900_000_000_000_000_000n + BigInt(`0x${id.replaceAll('-', '').slice(0, 13)}`)).toString(),
    customerId: randomUUID(), productId: randomUUID(), runId: randomUUID(), planId: randomUUID(),
    roleId: '900000000000000101', kind,
  };
  await tx`INSERT INTO public.guild (id, name, owner_discord_id)
    VALUES (${fixture.guildId}, 'Sandbox launch integration fixture', ${fixture.ownerId})`;
  await tx`INSERT INTO public.customers (id, guild_id, discord_id, discord_username)
    VALUES (${fixture.customerId}, ${fixture.guildId}, ${fixture.ownerId}, 'launch-fixture-owner')`;
  await tx`INSERT INTO public.products (
      id, guild_id, name, type, delivery_type, price_cents, currency, active, granted_role_ids
    ) VALUES (
      ${fixture.productId}, ${fixture.guildId}, 'Inactive launch fixture', ${kind},
      'access_pass', ${kind === 'free' ? 0 : 500}, 'USD', false, ARRAY[${fixture.roleId}]::text[]
    )`;
  if (kind === 'subscription') {
    await tx`INSERT INTO public.plans (
      id, guild_id, product_id, name, paypal_plan_id, interval_unit, price_cents, currency, active
    ) VALUES (
      ${fixture.planId}, ${fixture.guildId}, ${fixture.productId}, 'Sandbox fixture plan',
      ${`P-${id}`}, 'MONTH', 500, 'USD', true
    )`;
  }
  const [run] = await tx<{ started_at: string }[]>`
    INSERT INTO public.commerce_product_launch_runs (
      id, guild_id, product_id, created_by, updated_by, state, environment, verification_started_at
    ) VALUES (
      ${fixture.runId}, ${fixture.guildId}, ${fixture.productId}, ${fixture.ownerId}, ${fixture.ownerId},
      'sandbox_verifying', 'sandbox', transaction_timestamp() - interval '1 second'
    ) RETURNING verification_started_at::text AS started_at
  `;
  if (!run) throw new Error('Launch fixture did not return its exact verification timestamp');
  return { ...fixture, startedAt: run.started_at };
}

export async function withLaunchFixture(
  kind: LaunchKind,
  verify: (tx: LaunchTransaction, fixture: LaunchFixture) => Promise<void>,
): Promise<void> {
  await requireSupabase();
  const sql = postgres(getTestDbUrl(), { max: 1, connect_timeout: 5 });
  const rollback = new Error('rollback completed launch fixture');
  try {
    await sql.begin(async (tx) => {
      await tx`SET LOCAL statement_timeout = '10s'`;
      await tx`SET LOCAL lock_timeout = '5s'`;
      await tx`SET LOCAL idle_in_transaction_session_timeout = '15s'`;
      const fixture = await seedLaunchFixture(tx, kind);
      await tx`SET LOCAL ROLE service_role`;
      await verify(tx, fixture);
      // Keep append-only proof/audit contracts intact while leaving no test data.
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export function claimLaunchFree(tx: LaunchTransaction, fixture: LaunchFixture, requestId = randomUUID()) {
  return tx<LaunchClaim[]>`SELECT * FROM public.commerce_claim_free_product_for_launch(
    ${requestId}::uuid, ${fixture.guildId}, ${fixture.customerId}::uuid, ${fixture.productId}::uuid,
    ${fixture.runId}::uuid, ${fixture.startedAt}::timestamptz
  )`;
}

export async function claimLaunchIntent(tx: LaunchTransaction, fixture: LaunchFixture): Promise<PaidLaunchAttempt> {
  const token = randomUUID();
  const [claim] = await tx<{ disposition: string }[]>`
    SELECT public.commerce_claim_checkout_intent(
      ${token}::uuid, ${fixture.guildId}, ${fixture.customerId}::uuid, ${fixture.productId}::uuid,
      NULL::text, ${'a'.repeat(64)}
    )->>'disposition' AS disposition
  `;
  expect(claim?.disposition).toBe('claimed');
  return {
    token, orderNumber: `LAUNCH-${token}`, providerId: `PROVIDER-${token}`,
    approvalUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${token}`,
  };
}

export async function bindLaunchIntent(tx: LaunchTransaction, fixture: LaunchFixture, token: string): Promise<void> {
  const [result] = await tx<{ bound: boolean }[]>`SELECT public.commerce_bind_checkout_launch(
    ${token}::uuid, ${fixture.guildId}, ${fixture.customerId}::uuid, ${fixture.productId}::uuid,
    ${fixture.runId}::uuid, ${fixture.startedAt}::timestamptz
  ) AS bound`;
  expect(result?.bound).toBe(true);
}

export function persistLaunchPaid(tx: LaunchTransaction, fixture: LaunchFixture, attempt: PaidLaunchAttempt) {
  return tx<{ id: string; disposition: string; frozen: boolean }[]>`
    SELECT result->>'id' AS id, result->>'disposition' AS disposition,
      (result->>'grant_snapshot_frozen_at') IS NOT NULL AS frozen
    FROM (SELECT public.commerce_create_and_bind_launch_paid_checkout(
      ${attempt.token}::uuid, ${attempt.orderNumber}, ${fixture.guildId}, ${fixture.customerId}::uuid,
      ${fixture.productId}::uuid, ${fixture.kind === 'subscription' ? fixture.planId : null}::uuid,
      ${fixture.kind === 'subscription' ? 'subscription' : 'capture'}, ${attempt.providerId},
      ${attempt.approvalUrl}, 500, 'USD', ${fixture.startedAt}::timestamptz
    ) AS result) AS checkout
  `;
}

export async function countLaunchEffects(tx: LaunchTransaction, guildId: string) {
  const [counts] = await tx<{
    orders: number; claims: number; entitlements: number; queue: number;
  }[]>`SELECT
    (SELECT count(*)::int FROM public.orders WHERE guild_id = ${guildId}) AS orders,
    (SELECT count(*)::int FROM public.commerce_free_claims WHERE guild_id = ${guildId}) AS claims,
    (SELECT count(*)::int FROM public.entitlements WHERE guild_id = ${guildId}) AS entitlements,
    (SELECT count(*)::int FROM public.bot_action_queue WHERE guild_id = ${guildId}) AS queue`;
  if (!counts) throw new Error('Launch effect counts were unavailable');
  return counts;
}
