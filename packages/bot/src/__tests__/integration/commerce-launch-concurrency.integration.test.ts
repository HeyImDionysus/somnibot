import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { expect, it } from 'vitest';
import { getTestDbUrl, requireSupabase } from './helpers.js';
import { claimLaunchFree, countLaunchEffects, seedLaunchFixture, type LaunchClaim } from './commerce-launch-fixtures.js';

function signal() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function outcome(operation: Promise<LaunchClaim[]>): Promise<
  { ok: true; claims: LaunchClaim[] } | { ok: false; error: unknown }
> {
  try {
    return { ok: true, claims: await operation };
  } catch (error) {
    return { ok: false, error };
  }
}

it('serializes two real database sessions into one committed free launch grant', async () => {
  await requireSupabase();
  const first = postgres(getTestDbUrl(), { max: 1, connect_timeout: 5 });
  const second = postgres(getTestDbUrl(), { max: 1, connect_timeout: 5 });
  const observer = postgres(getTestDbUrl(), { max: 1, connect_timeout: 5 });
  const release = signal();
  const ready = signal();
  let attempts: ReturnType<typeof outcome>[] = [];
  let fixtureGuildId: string | null = null;
  try {
    // Given committed, isolated fixture rows visible to two independent connections.
    await first`SET idle_in_transaction_session_timeout = '10s'`;
    await first`SET statement_timeout = '10s'`;
    await second`SET lock_timeout = '8s'`;
    await second`SET statement_timeout = '10s'`;
    await observer`SET statement_timeout = '5s'`;
    const fixture = await first.begin((tx) => seedLaunchFixture(tx, 'free'));
    fixtureGuildId = fixture.guildId;
    const [firstBackend] = await first<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    const [secondBackend] = await second<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    if (!firstBackend || !secondBackend) throw new Error('Concurrency test could not identify both database sessions');
    expect(firstBackend.pid).not.toBe(secondBackend.pid);
    const firstRequestId = randomUUID();
    const firstAttempt = outcome(first.begin(async (tx) => {
      await tx`SET LOCAL ROLE service_role`;
      const claims = await claimLaunchFree(tx, fixture, firstRequestId);
      ready.resolve();
      await release.promise;
      return claims;
    }));
    attempts = [firstAttempt];
    await Promise.race([ready.promise, firstAttempt.then((result) => {
      if (!result.ok) throw result.error;
    })]);

    // When the second request reaches the first transaction's real advisory lock.
    const secondAttempt = outcome(second.begin(async (tx) => {
      await tx`SET LOCAL ROLE service_role`;
      return claimLaunchFree(tx, fixture);
    }));
    attempts.push(secondAttempt);
    await expect.poll(async () => {
      const [waiting] = await observer<{ blocked: boolean }[]>`
        SELECT ${firstBackend.pid}::int = ANY(pg_blocking_pids(${secondBackend.pid}::int)) AS blocked
      `;
      return waiting?.blocked;
    }, { timeout: 4_000, interval: 25 }).toBe(true);
    release.resolve();
    const [one, two] = await Promise.all(attempts);
    if (!one?.ok || !two?.ok) throw new Error('Concurrent launch request failed', {
      cause: !one?.ok ? one?.error : !two?.ok ? two?.error : undefined,
    });

    // Then the committed winner is reused and the database contains exactly one grant.
    expect(one.claims[0]).toMatchObject({ request_id: firstRequestId, disposition: 'claimed' });
    expect(two.claims[0]).toMatchObject({ request_id: firstRequestId, disposition: 'already-claimed' });
    const counts = await first.begin((tx) => countLaunchEffects(tx, fixture.guildId));
    expect(counts).toEqual({ orders: 1, claims: 1, entitlements: 1, queue: 1 });
  } finally {
    release.resolve();
    await Promise.allSettled(attempts);
    try {
      if (fixtureGuildId !== null) {
        await first.begin(async (tx) => {
          await tx`SET LOCAL lock_timeout = '5s'`;
          await tx`DELETE FROM public.commerce_free_claims WHERE guild_id = ${fixtureGuildId}`;
          await tx`DELETE FROM public.entitlements WHERE guild_id = ${fixtureGuildId}`;
          await tx`DELETE FROM public.bot_action_queue WHERE guild_id = ${fixtureGuildId}`;
          await tx`DELETE FROM public.orders WHERE guild_id = ${fixtureGuildId}`;
          await tx`DELETE FROM public.commerce_product_launch_runs WHERE guild_id = ${fixtureGuildId}`;
          await tx`DELETE FROM public.products WHERE guild_id = ${fixtureGuildId}`;
          await tx`DELETE FROM public.customers WHERE guild_id = ${fixtureGuildId}`;
          // Immutable audit rows and their guild FK stay isolated until CI discards its database.
        });
      }
    } finally {
      await Promise.all([first.end({ timeout: 5 }), second.end({ timeout: 5 }), observer.end({ timeout: 5 })]);
    }
  }
});
