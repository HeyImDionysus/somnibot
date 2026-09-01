import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { handleFreeClaimButton } from '../features/commerce/payment-handler.js';
import { mockButtonInteraction, mockGuild } from './helpers/discord-mocks.js';

const GUILD_ID = '123456789012345678';
const OWNER_ID = '234567890123456789';
const RUN_ID = '00000000-0000-4000-8000-000000000301';
const PRODUCT_ID = '00000000-0000-4000-8000-000000000302';
const CUSTOMER_ID = '00000000-0000-4000-8000-000000000303';
const ENTITLEMENT_ID = '00000000-0000-4000-8000-000000000304';
const FIRST_ATTEMPT = '2026-08-31T07:00:00.000Z';
const NEXT_ATTEMPT = '2026-08-31T08:00:00.000Z';

type RequestReceipt = {
  readonly path: string;
  readonly method: string;
  readonly body: Record<string, unknown>;
};

function freeClaimFixture(options: {
  readonly startedAt?: string;
  readonly launchError?: boolean;
  readonly launch?: boolean;
} = {}) {
  const requests: RequestReceipt[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const path = url.pathname.replace('/rest/v1/', '');
    const body = typeof init?.body === 'string'
      ? z.record(z.unknown()).parse(JSON.parse(init.body))
      : {};
    requests.push({ path, method: init?.method ?? 'GET', body });
    if (path === 'commerce_product_launch_runs') {
      return Response.json({ id: RUN_ID, verification_started_at: options.startedAt ?? FIRST_ATTEMPT });
    }
    if (path === 'products') {
      return Response.json({
        id: PRODUCT_ID, name: 'Sandbox free product', type: 'free', price_cents: 0,
        delivery_type: 'access_pass', granted_role_ids: [], granted_channel_ids: [],
      });
    }
    if (path === 'customers') return Response.json({ id: CUSTOMER_ID });
    if (path === 'guild_config') return Response.json({ free_claim_policy: 'one-claim' });
    if (path.startsWith('rpc/commerce_claim_free_product')) {
      if (options.launchError && path.endsWith('_for_launch')) {
        return Response.json({ code: '42501', message: 'launch attempt is stale' }, { status: 403 });
      }
      return Response.json([{ disposition: 'claimed', entitlement_id: ENTITLEMENT_ID }]);
    }
    if (path === 'commerce_free_claims') return Response.json([]);
    return Response.json({ message: `Unexpected fixture request: ${path}` }, { status: 500 });
  });
  const supabase = createClient('https://somnibot-fixture.invalid', 'fixture-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch },
  });
  const guild = Object.assign(mockGuild(), { id: GUILD_ID, ownerId: OWNER_ID });
  const interaction = mockButtonInteraction({
    customId: options.launch === false
      ? `store:claim:${PRODUCT_ID}`
      : `store:launch-claim:${RUN_ID}:${PRODUCT_ID}`,
    userId: OWNER_ID,
    guild,
  });
  return { interaction, supabase, requests };
}

describe('free launch persistence boundary', () => {
  it('submits the authorized run and attempt in the atomic claim instead of patching proof afterward', async () => {
    // Given an owner-authorized inactive Sandbox product.
    const fixture = freeClaimFixture();

    // When the owner claims the launch product.
    await handleFreeClaimButton(fixture.interaction, fixture.supabase, GUILD_ID);

    // Then persistence receives the exact launch identity in one RPC.
    const claims = fixture.requests.filter((request) => request.path.startsWith('rpc/'));
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      path: 'rpc/commerce_claim_free_product_for_launch',
      body: {
        p_guild_id: GUILD_ID, p_customer_id: CUSTOMER_ID, p_product_id: PRODUCT_ID,
        p_launch_run_id: RUN_ID, p_verification_started_at: FIRST_ATTEMPT,
      },
    });
    expect(fixture.requests.some((request) => request.path === 'commerce_free_claims')).toBe(false);
  });

  it('uses a new idempotency identity for a restarted verification attempt', async () => {
    // Given two attempts for the same owner, product, and durable launch run.
    const previous = freeClaimFixture({ startedAt: FIRST_ATTEMPT });
    const restarted = freeClaimFixture({ startedAt: NEXT_ATTEMPT });

    // When the same launch control is used in each attempt.
    await handleFreeClaimButton(previous.interaction, previous.supabase, GUILD_ID);
    await handleFreeClaimButton(restarted.interaction, restarted.supabase, GUILD_ID);

    // Then an old claim cannot be replayed as fresh proof.
    const previousClaim = previous.requests.find((request) => request.path.startsWith('rpc/'));
    const nextClaim = restarted.requests.find((request) => request.path.startsWith('rpc/'));
    expect(previousClaim?.body.p_request_id).toEqual(expect.any(String));
    expect(nextClaim?.body.p_request_id).toEqual(expect.any(String));
    expect(nextClaim?.body.p_request_id).not.toBe(previousClaim?.body.p_request_id);
  });

  it('does not report a grant when atomic launch persistence rejects the attempt', async () => {
    // Given a run restarted between authorization and persistence.
    const fixture = freeClaimFixture({ launchError: true });

    // When the database rejects that stale attempt.
    await handleFreeClaimButton(fixture.interaction, fixture.supabase, GUILD_ID);

    // Then the interaction reports failure without a separate proof write.
    expect(fixture.interaction.editReply).toHaveBeenCalledWith({
      content: '❌ This free claim could not be completed. Please try again later.',
    });
    expect(fixture.requests.some((request) => request.path === 'commerce_free_claims')).toBe(false);
  });

  it('preserves the ordinary active-product claim RPC', async () => {
    // Given a normal public free-product control.
    const fixture = freeClaimFixture({ launch: false });

    // When a customer claims it.
    await handleFreeClaimButton(fixture.interaction, fixture.supabase, GUILD_ID);

    // Then no launch exception is requested.
    const claim = fixture.requests.find((request) => request.path.startsWith('rpc/'));
    expect(claim?.path).toBe('rpc/commerce_claim_free_product');
    expect(claim?.body).not.toHaveProperty('p_launch_run_id');
    expect(claim?.body).not.toHaveProperty('p_verification_started_at');
  });
});
