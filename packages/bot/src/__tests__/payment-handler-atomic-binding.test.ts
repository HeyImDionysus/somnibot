import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { handleBuyButton } from '../features/commerce/payment-handler.js';

const normalizedSource = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
  .replaceAll('\r\n', '\n');
const migration = normalizedSource('../../../supabase/migrations/20260804142000_atomic_paid_checkout_intent_binding.sql');
const recoveryMigration = normalizedSource('../../../supabase/migrations/20260804143000_paid_checkout_exposure_recovery.sql');
const noOrderRecoveryMigration = normalizedSource('../../../supabase/migrations/20260804144000_checkout_recovery_no_order_cleanup.sql');
const providerBindingMigration = normalizedSource('../../../supabase/migrations/20260817180000_paypal_checkout_provider_binding.sql');
const intentClaimMigration = normalizedSource('../../../supabase/migrations/20260818111500_checkout_intent_claim.sql');
const handlerSource = readFileSync(new URL('../features/commerce/payment-handler.ts', import.meta.url), 'utf8');
const observedAuditRows: Record<string, unknown>[] = [];

function interaction(customId = 'store:buy:prod-1') {
  return {
    id: 'interaction-1',
    customId,
    user: { id: '12345678901234567', username: 'Tester' },
    deferReply: vi.fn().mockResolvedValue({}),
    editReply: vi.fn().mockResolvedValue({}),
  } as any;
}

function makeSupabase(
  productType: 'one_time' | 'subscription',
  bothAtomicResponsesLost = false,
  reservationBlocked = false,
  intentBlocked = false,
) {
  const product = {
    id: '00000000-0000-4000-8000-000000000001', guild_id: 'guild-1', active: true,
    type: productType, price_cents: 500, name: 'VIP', delivery_type: 'access_pass',
    granted_role_ids: [], granted_channel_ids: [], currency: 'USD',
  };
  const plan = {
    id: '00000000-0000-4000-8000-000000000002', guild_id: product.guild_id,
    product_id: product.id, active: true, name: 'Monthly', price_cents: 500,
    currency: 'USD', interval_unit: 'MONTH', paypal_plan_id: 'P-LEGIT',
  };
  const rpcCalls: Array<[string, Record<string, unknown> | undefined]> = [];
  let atomicCalls = 0;
  const rpc = vi.fn(async (name: string, args?: Record<string, unknown>) => {
    rpcCalls.push([name, args]);
    if (name === 'commerce_claim_checkout_intent') {
      return intentBlocked
        ? {
            data: {
              disposition: 'blocked',
              checkout_token: '00000000-0000-4000-8000-000000000088',
              provider_id: null,
              order_id: null,
            },
            error: null,
          }
        : {
            data: {
              disposition: 'claimed',
              checkout_token: args?.p_checkout_token,
              provider_id: null,
              order_id: null,
            },
            error: null,
          };
    }
    if (name === 'commerce_select_checkout_plan') return { data: [plan], error: null };
    if (name === 'generate_order_number') return { data: 'ORD-1', error: null };
    if (name === 'commerce_create_and_bind_active_paid_checkout') {
      atomicCalls += 1;
      if (reservationBlocked) {
        return {
          data: null,
          error: {
            code: '23505',
            message: 'commerce_checkout_blocked: provider_checkout order 00000000-0000-4000-8000-000000000099',
          },
        };
      }
      if (bothAtomicResponsesLost || atomicCalls === 1) return { data: null, error: { code: '08006', message: 'connection closed after commit' } };
      const subscription = productType === 'subscription';
      return {
        data: {
          disposition: 'replay', id: '00000000-0000-4000-8000-000000000003',
          order_number: args?.p_order_number, customer_id: args?.p_customer_id,
          guild_id: args?.p_guild_id, product_id: args?.p_product_id, plan_id: args?.p_plan_id ?? null,
          paypal_order_id: subscription ? null : args?.p_provider_id,
          paypal_subscription_id: subscription ? args?.p_provider_id : null,
          amount_cents: args?.p_amount_cents, currency: args?.p_currency,
          status: 'pending', checkout_active: true, checkout_approval_url: args?.p_approval_url,
          delivery_type_snapshot: 'access_pass', granted_role_ids_snapshot: [],
          granted_channel_ids_snapshot: [], temporary_role_grants_snapshot: [],
          grant_snapshot_frozen_at: '2026-08-04T00:00:00.000Z',
        }, error: null,
      };
    }
    return { data: null, error: null };
  });
  let customerReads = 0;
  const from = vi.fn((table: string) => {
    let operation = 'read';
    const chain: any = {
      select: vi.fn(() => chain), eq: vi.fn(() => chain), in: vi.fn(() => chain), gt: vi.fn(() => chain),
      order: vi.fn(() => chain), limit: vi.fn(() => chain),
      insert: vi.fn(() => { operation = 'insert'; return chain; }),
      update: vi.fn(() => { operation = 'update'; return chain; }),
      upsert: vi.fn(async (rows: Record<string, unknown>[]) => {
        if (table === 'audit_logs') observedAuditRows.push(...rows);
        return { error: null };
      }),
      maybeSingle: vi.fn(async () => {
        if (table === 'products') return { data: product, error: null };
        if (table === 'customers') return { data: customerReads++ === 0 ? null : null, error: null };
        if (table === 'guild_config') return { data: null, error: null };
        if (table === 'commerce_checkout_intents' && operation === 'update') return { data: { token: 'checkout-token' }, error: null };
        return { data: null, error: null };
      }),
      single: vi.fn(async () => ({ data: { id: '00000000-0000-4000-8000-000000000004' }, error: null })),
      then: (resolve: Function) => resolve({ data: table === 'commerce_product_temp_role_config' ? [] : null, error: null }),
    };
    void operation;
    return chain;
  });
  return { supabase: { from, rpc } as any, rpcCalls };
}

function paypalFetch() {
  return vi.fn(async (url: unknown) => {
    const target = String(url);
    if (target.includes('/v1/oauth2/token')) return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
    if (target.includes('/v1/billing/subscriptions')) return new Response(JSON.stringify({ id: 'SUB-1', links: [{ rel: 'approve', href: 'https://www.sandbox.paypal.com/approve' }] }), { status: 200 });
    return new Response(JSON.stringify({ id: 'ORDER-1', links: [{ rel: 'approve', href: 'https://www.sandbox.paypal.com/approve' }] }), { status: 200 });
  });
}

beforeEach(() => {
  process.env['PAYPAL_CLIENT_SECRET'] = 'test-signing-secret';
  observedAuditRows.length = 0;
});
afterEach(() => { delete process.env.PAYPAL_CLIENT_SECRET; vi.restoreAllMocks(); });

describe('atomic paid checkout intent binding', () => {
  it('uses the atomic RPC and replays a committed response loss for one-time and subscription paths', async () => {
    for (const productType of ['one_time', 'subscription'] as const) {
      const { supabase, rpcCalls } = makeSupabase(productType);
      vi.stubGlobal('fetch', paypalFetch());
      await handleBuyButton(interaction(), supabase, 'guild-1', 'https://api.paypal.example', 'id', 'secret', 'https://dashboard.example');
      const atomic = rpcCalls.filter(([name]) => name === 'commerce_create_and_bind_active_paid_checkout');
      expect(atomic).toHaveLength(2);
      expect(atomic[0][1]).toMatchObject({ p_checkout_token: expect.any(String), p_guild_id: 'guild-1' });
      expect(rpcCalls.some(([name]) => name === 'commerce_mark_paid_checkout_exposed')).toBe(true);
      expect(rpcCalls.some(([name]) => name === 'commerce_reap_unexposed_paid_checkout')).toBe(false);
      expect(rpcCalls.some(([name]) => name === 'commerce_create_active_paid_checkout')).toBe(false);
      expect(rpcCalls.some(([name]) => name === 'commerce_deactivate_pending_checkout')).toBe(false);
    }
  });

  it('reaps a committed but provably unexposed checkout when both RPC responses are lost', async () => {
    const { supabase, rpcCalls } = makeSupabase('one_time', true);
    vi.stubGlobal('fetch', paypalFetch());
    await handleBuyButton(interaction(), supabase, 'guild-1', 'https://api.paypal.example', 'id', 'secret', 'https://dashboard.example');
    expect(rpcCalls.filter(([name]) => name === 'commerce_create_and_bind_active_paid_checkout')).toHaveLength(2);
    expect(rpcCalls.some(([name]) => name === 'commerce_reap_unexposed_paid_checkout')).toBe(true);
    expect(rpcCalls.some(([name]) => name === 'commerce_mark_paid_checkout_exposed')).toBe(false);
    expect(observedAuditRows).toEqual([expect.objectContaining({
      action: 'commerce.checkout.record_failed',
      occurrence_key: expect.stringMatching(/^commerce\.checkout\.record_failed:/),
      success: false,
    })]);
  });

  it('audits provider dependency failure against the persisted checkout intent', async () => {
    const { supabase } = makeSupabase('one_time');
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      if (String(url).includes('/v1/oauth2/token')) {
        return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
      }
      throw new Error('provider unavailable');
    }));

    await handleBuyButton(interaction(), supabase, 'guild-1', 'https://api.paypal.example', 'id', 'secret', 'https://dashboard.example');

    expect(observedAuditRows).toEqual([expect.objectContaining({
      action: 'commerce.checkout.dependency_failed',
      target_type: 'capture',
      occurrence_key: expect.stringMatching(/^commerce\.checkout\.dependency_failed:/),
      success: false,
    })]);
  });

  it('audits the concurrent intent loser once before creating a second provider checkout', async () => {
    const { supabase, rpcCalls } = makeSupabase('one_time', false, false, true);
    const fetch = paypalFetch();
    vi.stubGlobal('fetch', fetch);

    await handleBuyButton(interaction(), supabase, 'guild-1', 'https://api.paypal.example', 'id', 'secret', 'https://dashboard.example');

    expect(rpcCalls.filter(([name]) => name === 'commerce_create_and_bind_active_paid_checkout')).toHaveLength(0);
    expect(rpcCalls.some(([name]) => name === 'commerce_mark_paid_checkout_exposed')).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(observedAuditRows).toEqual([expect.objectContaining({
      action: 'commerce.checkout.race_refused',
      target_type: 'checkout_intent',
      target_id: '00000000-0000-4000-8000-000000000088',
      occurrence_key: 'commerce.checkout.race_refused:00000000-0000-4000-8000-000000000088',
      success: false,
    })]);
  });

  it('ships service-role-only locking, exact identity checks, and a rollback-on-zero-row contract', () => {
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain("SET search_path = ''");
    expect(migration).toContain('FOR UPDATE');
    expect(migration).toContain("status NOT IN ('pending', 'bound')");
    expect(migration).toContain('expires_at <= pg_catalog.clock_timestamp()');
    expect(migration).toContain('GET DIAGNOSTICS v_updated = ROW_COUNT');
    expect(migration).toContain("IF v_updated <> 1 THEN");
    expect(migration).toContain("MESSAGE =\n      'commerce_create_and_bind_active_paid_checkout: checkout intent binding failed'");
    expect(migration).toContain('REVOKE ALL ON FUNCTION');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION');
    expect(migration).toContain(') TO service_role;');
    expect(recoveryMigration).toContain('approval_exposed_at');
    expect(recoveryMigration).toContain('commerce_mark_paid_checkout_exposed');
    expect(recoveryMigration).toContain('commerce_reap_unexposed_paid_checkout');
    expect(recoveryMigration).toContain('commerce_reap_unexposed_paid_checkouts_for_product');
    expect(recoveryMigration).toContain("'approval_link_not_exposed'");
    expect(recoveryMigration).toContain("'disposition', 'exposed'");
    expect(noOrderRecoveryMigration).toContain("'cancelled_no_order'");
    expect(noOrderRecoveryMigration).toContain("status IN ('pending', 'bound')");
    expect(noOrderRecoveryMigration).toContain("created_at <= pg_catalog.clock_timestamp() - INTERVAL '60 seconds'");
    expect(noOrderRecoveryMigration).toContain('linked order missing');
    expect(noOrderRecoveryMigration).toContain('linked order identity mismatch');
    expect(noOrderRecoveryMigration).toContain('REVOKE ALL ON FUNCTION');
    expect(providerBindingMigration).toContain('provider_binding');
    expect(providerBindingMigration).toContain('uniq_commerce_checkout_intents_bound_order');
    expect(providerBindingMigration).toContain('commerce_refresh_pending_checkout_approval_url');
    expect(providerBindingMigration).toContain('FOR UPDATE');
    expect(providerBindingMigration).toContain("SET search_path = ''");
    expect(providerBindingMigration).toContain('REVOKE ALL ON FUNCTION');
    expect(providerBindingMigration).toContain('TO service_role');
    expect(intentClaimMigration).toContain('commerce_claim_checkout_intent');
    expect(intentClaimMigration).toContain('pg_advisory_xact_lock');
    expect(intentClaimMigration).toContain("status IN ('pending', 'bound')");
    expect(intentClaimMigration).toContain("'disposition', 'blocked'");
    expect(intentClaimMigration).toContain("'disposition', 'claimed'");
    expect(handlerSource).toContain("'commerce_claim_checkout_intent'");
    expect(handlerSource).toContain("'commerce_reap_unexposed_paid_checkouts_for_product'");
    expect(handlerSource).not.toContain("update({ provider_id:");
    expect(handlerSource).not.toContain("update({ plan_id:");
    expect(handlerSource).toContain('inFlight = await inspectInFlightCheckout');
    expect(handlerSource).toContain("repeatPurchasePolicy !== 'unique' && inFlight.reason === 'active_entitlement'");
    expect(handlerSource).toContain("inFlight.reason === 'provider_checkout'");
    expect(handlerSource.indexOf("'commerce_reap_unexposed_paid_checkouts_for_product'")).toBeLessThan(
      handlerSource.indexOf('inFlight = await inspectInFlightCheckout'),
    );
  });
});
