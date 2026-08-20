/**
 * Tests for features/commerce/payment-handler.ts — handleBuyButton.
 * 200 uncovered statements at 20.6%.
 *
 * Includes the cross-guild plan injection regression suite: the subscription
 * checkout plan query must be guild-scoped, otherwise a zero-price active
 * plan row created by ANOTHER guild (carrying that guild's guild_id but this
 * guild's product_id) sorts first on price_cents ASC and hijacks checkout
 * with an attacker-chosen paypal_plan_id.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

vi.mock('discord.js', async () => {
  const actual = await vi.importActual('discord.js');
  return { ...actual };
});

vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));

import { handleBuyButton } from '../features/commerce/payment-handler.js';
import { invalidateBrandKitCache } from '../features/branding/brand-kit.js';

// The production path refuses to create a provider checkout unless its
// opaque checkout handle can be HMAC-signed.  Every test that reaches PayPal
// must therefore provide the same non-secret fixture key the durability suite
// uses; otherwise the handler correctly stops at "signing unavailable".
beforeEach(() => {
  process.env['PAYPAL_CLIENT_SECRET'] = 'test-signing-secret';
  process.env['PAYPAL_RECONCILE_SECRET'] = 'test-signing-secret';
});
afterEach(() => {
  delete process.env.PAYPAL_CLIENT_SECRET;
  delete process.env.PAYPAL_RECONCILE_SECRET;
});

function makeChain(data: any = null) {
  const chain: any = {};
  for (const m of ['from', 'select', 'insert', 'update', 'delete', 'eq', 'single', 'maybeSingle', 'order', 'limit', 'in', 'match']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn(() => Promise.resolve({ data, error: null }));
  chain.maybeSingle = vi.fn(() => Promise.resolve({ data, error: null }));
  chain.then = (resolve: Function) => resolve({ data, error: null });
  return chain;
}

function makeSupa() {
  return {
    from: vi.fn(() => makeChain()),
    rpc: vi.fn(async () => ({ data: null, error: null })),
  } as any;
}

describe('payment-handler', () => {
  it('handleBuyButton replies error when product not found', async () => {
    const interaction = {
      customId: 'store:buy:prod-1',
      user: { id: 'user-1', username: 'Tester' },
      deferReply: vi.fn().mockResolvedValue({}),
      editReply: vi.fn().mockResolvedValue({}),
    } as any;
    await handleBuyButton(interaction, makeSupa(), 'guild-1', 'https://api.paypal.com', 'client-id', 'secret', 'https://dashboard.com');
    expect(interaction.editReply).toHaveBeenCalled();
  });

  it('refuses checkout and alerts the owner when a granted role is undeliverable (round 28 P1)', async () => {
    // Save-time validation runs only on product EDITS: a granted role
    // deleted (or raised above the bot) after activation would let a buyer
    // PAY for a benefit the bot provably cannot deliver.
    const product = {
      id: 'prod-1',
      guild_id: 'guild-1',
      active: true,
      type: 'one_time',
      price_cents: 500,
      name: 'VIP Access',
      delivery_type: 'role',
      granted_role_ids: ['role-gone'],
      granted_channel_ids: [],
    };
    const alertsInserted: Array<Record<string, unknown>> = [];
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'products') return makeChain(product);
        if (table === 'alerts') {
          const c = makeChain();
          c.insert = vi.fn((row: Record<string, unknown>) => {
            alertsInserted.push(row);
            return makeChain();
          });
          return c;
        }
        return makeChain();
      }),
      rpc: vi.fn(async () => ({ data: null, error: null })),
    } as any;
    const guild = {
      id: 'guild-1',
      name: 'Cool Server',
      members: {
        me: {
          roles: { highest: { position: 5 } },
          permissions: { has: vi.fn(() => true) },
        },
      },
      roles: { cache: new Map() },
      channels: { cache: new Map() },
    };
    const interaction = { ...makeInteraction(), guild } as any;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await handleBuyButton(interaction, supabase, 'guild-1', 'https://api.paypal.com', 'client-id', 'secret', 'https://dashboard.com');

    // Refused BEFORE any PayPal call, with the owner alerted.
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    expect(alertsInserted.some((row) => row.alert_type === 'commerce_undeliverable_benefit')).toBe(true);
    const reply = interaction.editReply.mock.calls.at(-1)?.[0];
    expect(JSON.stringify(reply)).toContain('Temporarily Unavailable');
  });

  it('refuses checkout when a TEMPORARY role benefit is undeliverable (round 30 P1)', async () => {
    // Temporary roles live in commerce_product_temp_role_config, not
    // granted_role_ids — the round-28 guard missed them entirely.
    const product = {
      id: 'prod-1',
      guild_id: 'guild-1',
      active: true,
      type: 'one_time',
      price_cents: 500,
      name: 'Weekend VIP',
      delivery_type: 'role',
      granted_role_ids: [],
      granted_channel_ids: [],
    };
    const alertsInserted: Array<Record<string, unknown>> = [];
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'products') return makeChain(product);
        if (table === 'commerce_product_temp_role_config') {
          const c = makeChain();
          c.then = (resolve: Function) => resolve({
            data: [{ role_id: 'temp-role-gone' }],
            error: null,
          });
          return c;
        }
        if (table === 'alerts') {
          const c = makeChain();
          c.insert = vi.fn((row: Record<string, unknown>) => {
            alertsInserted.push(row);
            return makeChain();
          });
          return c;
        }
        return makeChain();
      }),
      rpc: vi.fn(async () => ({ data: null, error: null })),
    } as any;
    const guild = {
      id: 'guild-1',
      name: 'Cool Server',
      members: {
        me: {
          roles: { highest: { position: 5 } },
          permissions: { has: vi.fn(() => true) },
        },
      },
      roles: { cache: new Map() },
      channels: { cache: new Map() },
    };
    const interaction = { ...makeInteraction(), guild } as any;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await handleBuyButton(interaction, supabase, 'guild-1', 'https://api.paypal.com', 'client-id', 'secret', 'https://dashboard.com');

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    expect(alertsInserted.some((row) =>
      row.alert_type === 'commerce_undeliverable_benefit'
      && JSON.stringify(row).includes('temporary role'))).toBe(true);
    const reply = interaction.editReply.mock.calls.at(-1)?.[0];
    expect(JSON.stringify(reply)).toContain('Temporarily Unavailable');
  });

  it('lets checkout proceed past the guard when granted benefits are deliverable (round 28 P1)', async () => {
    const product = {
      id: 'prod-1',
      guild_id: 'guild-1',
      active: true,
      type: 'one_time',
      price_cents: 500,
      name: 'VIP Access',
      delivery_type: 'role',
      granted_role_ids: ['role-ok'],
      granted_channel_ids: [],
    };
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'products') return makeChain(product);
        // Terminate cleanly right after the guard: the buyer already owns an
        // active entitlement, so the handler replies and stops pre-PayPal.
        if (table === 'customers') return makeChain({ id: 'cust-1' });
        if (table === 'entitlements') return makeChain({ id: 'ent-1' });
        return makeChain();
      }),
      rpc: vi.fn(async () => ({ data: null, error: null })),
    } as any;
    const guild = {
      id: 'guild-1',
      name: 'Cool Server',
      members: {
        me: {
          roles: { highest: { position: 5 } },
          permissions: { has: vi.fn(() => true) },
        },
      },
      roles: {
        cache: new Map([
          ['role-ok', { id: 'role-ok', name: 'VIP', position: 2, managed: false }],
        ]),
      },
      channels: { cache: new Map() },
    };
    const interaction = { ...makeInteraction(), guild } as any;

    await handleBuyButton(interaction, supabase, 'guild-1', 'https://api.paypal.com', 'client-id', 'secret', 'https://dashboard.com');

    const reply = interaction.editReply.mock.calls.at(-1)?.[0];
    // The guard passed — the flow reached the already-purchased fence, not
    // the undeliverable refusal.
    expect(JSON.stringify(reply)).toContain('Already Purchased');
    expect(JSON.stringify(reply)).not.toContain('Temporarily Unavailable');
  });
});

/**
 * Behavioral mock: a tiny in-memory query engine so eq/in/order/limit/single
 * actually filter, sort, and slice seeded rows. This is what lets the suite
 * prove WHICH plan row checkout selects, instead of just asserting that some
 * chain method was called.
 */
function makeQueryEngine(
  tables: Record<string, any[]>,
  options: {
    orderInsertError?: string;
    orderInsertCode?: string;
    activeCheckoutResponseLossOnce?: boolean;
    malformedCheckoutField?: string;
    malformedCheckoutAttempts?: number;
    freezeError?: string;
    deactivationError?: string;
    deactivationErrorOnce?: string;
    checkoutInspectionError?: string;
    pricingResult?: {
      amount_cents: number;
      discount_cents: number;
      promotion_id: string | null;
      coupon_code: string | null;
    };
  } = {},
) {
  const inserts: Record<string, any[]> = {};
  let deactivationAttempts = 0;
  let activeCheckoutAttempts = 0;
  let claimedProductId: unknown;
  const rpc = vi.fn(async (name: string, args?: Record<string, unknown>) => {
    if (name === 'commerce_claim_checkout_intent') {
      claimedProductId = args?.p_product_id;
      return {
        data: {
          disposition: 'claimed',
          checkout_token: args?.p_checkout_token,
        },
        error: null,
      };
    }
    if (name === 'commerce_reserve_checkout_pricing') {
      const product = (tables.products ?? []).find((row) => row.id === claimedProductId);
      return {
        data: options.pricingResult ?? {
          amount_cents: product?.price_cents ?? 1000,
          discount_cents: 0,
          promotion_id: null,
          coupon_code: null,
        },
        error: null,
      };
    }
    // The production handler now uses the atomic RPC that creates the order
    // and binds the checkout intent in one transaction.  Keep the in-memory
    // engine's row shape identical to the SQL function so these tests exercise
    // the real reservation/exposure contract rather than falling through to
    // the generic RPC stub.
    if (name === 'commerce_create_and_bind_active_paid_checkout') {
      activeCheckoutAttempts += 1;
      if (options.orderInsertError) {
        return {
          data: null,
          error: {
            code: options.orderInsertCode,
            message: options.orderInsertError,
          },
        };
      }
      const providerKind = args?.p_provider_kind;
      const existing = (tables.orders ?? []).find((order) =>
        providerKind === 'capture'
          ? order.paypal_order_id === args?.p_provider_id
          : order.paypal_subscription_id === args?.p_provider_id,
      );
      const product = (tables.products ?? []).find(
        (row) => row.id === args?.p_product_id && row.guild_id === args?.p_guild_id,
      );
      const row = existing ?? {
        id: '12000000-0000-4000-8000-000000000001',
        order_number: args?.p_order_number,
        customer_id: args?.p_customer_id,
        guild_id: args?.p_guild_id,
        product_id: args?.p_product_id,
        plan_id: args?.p_plan_id ?? null,
        paypal_order_id: providerKind === 'capture' ? args?.p_provider_id : null,
        paypal_subscription_id:
          providerKind === 'subscription' ? args?.p_provider_id : null,
        amount_cents: args?.p_amount_cents,
        currency: args?.p_currency,
        status: 'pending',
        checkout_active: true,
        checkout_approval_url: args?.p_approval_url,
        promotion_id: options.pricingResult?.promotion_id ?? null,
        discount_cents: options.pricingResult?.discount_cents ?? 0,
        delivery_type_snapshot: product?.delivery_type ?? 'access_pass',
        granted_role_ids_snapshot: product?.granted_role_ids ?? [],
        granted_channel_ids_snapshot: product?.granted_channel_ids ?? [],
        temporary_role_grants_snapshot: [],
        grant_snapshot_frozen_at: '2026-07-11T00:00:00.000Z',
      };
      if (!existing) {
        (tables.orders ??= []).push(row);
        (inserts.orders ??= []).push(row);
      }
      if (options.activeCheckoutResponseLossOnce && activeCheckoutAttempts === 1) {
        return {
          data: null,
          error: { code: '08006', message: 'connection closed after commit' },
        };
      }
      const result = {
        disposition: existing ? 'replay' : 'created',
        ...row,
      };
      if (
        options.malformedCheckoutField
        && activeCheckoutAttempts <= (options.malformedCheckoutAttempts ?? 1)
      ) {
        const malformedValue =
          options.malformedCheckoutField === 'temporary_role_grants_snapshot'
            ? [{
                role_id: '123456789012345678',
                duration_seconds: 315_360_001,
              }]
            : options.malformedCheckoutField === 'grant_snapshot_frozen_at'
              ? ' 2026-07-11T00:00:00.000Z'
              : 'corrupt';
        (result as Record<string, unknown>)[options.malformedCheckoutField] = malformedValue;
      }
      return { data: result, error: null };
    }
    if (name === 'commerce_inspect_checkout_blocker') {
      if (options.checkoutInspectionError) {
        return { data: null, error: { message: options.checkoutInspectionError } };
      }
      const matchingOrders = [...(tables.orders ?? [])]
        .filter((order) =>
          order.guild_id === args?.p_guild_id
          && order.customer_id === args?.p_customer_id
          && order.product_id === args?.p_product_id,
        );
      const held = [...(tables.commerce_fulfillment_holds ?? [])]
        .find((hold) =>
          hold.guild_id === args?.p_guild_id
          && hold.customer_id === args?.p_customer_id
          && hold.product_id === args?.p_product_id,
        );
      if (held) {
        const order = matchingOrders.find((candidate) => candidate.id === held.order_id);
        return {
          data: {
            disposition: 'blocked',
            reason: 'paid_hold',
            order_id: held.order_id,
            order_number: order?.order_number ?? null,
            approval_url: null,
          },
          error: null,
        };
      }
      const providerCheckout = matchingOrders.find((order) =>
        order.status === 'pending'
        && (order.paypal_order_id || order.paypal_subscription_id)
        && !(tables.commerce_checkout_deactivation_proofs ?? []).some(
          (proof) => proof.order_id === order.id,
        ),
      );
      if (providerCheckout) {
        return {
          data: {
            disposition: 'blocked',
            reason: 'provider_checkout',
            order_id: providerCheckout.id,
            order_number: providerCheckout.order_number,
            approval_url: providerCheckout.checkout_approval_url ?? null,
          },
          error: null,
        };
      }
      const unresolvedPaid = matchingOrders.find((order) =>
        ['completed', 'pending_review'].includes(order.status)
        && (order.paypal_order_id || order.paypal_subscription_id)
        && !(tables.entitlements ?? []).some(
          (entitlement) => entitlement.order_id === order.id,
        ),
      );
      if (unresolvedPaid) {
        return {
          data: {
            disposition: 'blocked',
            reason: 'paid_fulfillment',
            order_id: unresolvedPaid.id,
            order_number: unresolvedPaid.order_number,
            approval_url: null,
          },
          error: null,
        };
      }
      return {
        data: {
          disposition: 'clear',
          reason: null,
          order_id: null,
          order_number: null,
          approval_url: null,
        },
        error: null,
      };
    }
    if (name === 'commerce_select_checkout_plan') {
      const candidates = [...(tables.plans ?? [])]
        .filter((plan) =>
          plan.guild_id === args?.p_guild_id
          && plan.product_id === args?.p_product_id
          && plan.active === true
          && typeof plan.paypal_plan_id === 'string'
          && plan.paypal_plan_id.trim().length > 0,
        )
        .sort((left, right) =>
          left.price_cents - right.price_cents
          || String(left.id).localeCompare(String(right.id)),
        );
      return { data: candidates.slice(0, 1), error: null };
    }
    if (name === 'commerce_freeze_order_grant_snapshot') {
      if (options.freezeError) {
        return { data: null, error: { message: options.freezeError } };
      }
      return {
        data: {
          order_id: args?.p_order_id,
          granted_role_ids_snapshot: [],
          granted_channel_ids_snapshot: [],
          temporary_role_grants_snapshot: [],
          grant_snapshot_frozen_at: '2026-07-11T00:00:00.000Z',
        },
        error: null,
      };
    }
    if (name === 'commerce_deactivate_pending_checkout') {
      deactivationAttempts += 1;
      const deactivationError = options.deactivationError
        ?? (deactivationAttempts === 1 ? options.deactivationErrorOnce : undefined);
      if (deactivationError) {
        return { data: null, error: { message: deactivationError } };
      }
      return {
        data: {
          order_id: args?.p_order_id,
          checkout_active: false,
          disposition: deactivationAttempts > 1 ? 'already_deactivated' : 'deactivated',
          proof_id: 'checkout-proof-1',
        },
        error: null,
      };
    }
    if (name === 'commerce_refresh_pending_checkout_approval_url') {
      return {
        data: {
          order_id: args?.p_order_id,
          checkout_approval_url: args?.p_new_approval_url,
          disposition: 'refreshed',
        },
        error: null,
      };
    }
    return { data: 'ORD-TEST-1', error: null };
  });
  const supabase = {
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      const chain: any = {
        select: () => chain,
        update: () => chain,
        eq: (col: string, val: any) => {
          rows = rows.filter((r) => r[col] === val);
          return chain;
        },
        in: (col: string, vals: any[]) => {
          rows = rows.filter((r) => vals.includes(r[col]));
          return chain;
        },
        order: (col: string, opts?: { ascending?: boolean }) => {
          const dir = opts?.ascending === false ? -1 : 1;
          rows.sort((a, b) => (a[col] > b[col] ? dir : a[col] < b[col] ? -dir : 0));
          return chain;
        },
        limit: (n: number) => {
          rows = rows.slice(0, n);
          return chain;
        },
        single: () =>
          Promise.resolve({
            data: rows[0] ?? null,
            error: rows[0] ? null : { message: 'no rows' },
          }),
        maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
        insert: (obj: any) => {
          if (table === 'orders' && options.orderInsertError) {
            const failedInsert: any = {
              select: () => failedInsert,
              single: () => Promise.resolve({
                data: null,
                error: {
                  code: options.orderInsertCode,
                  message: options.orderInsertError,
                },
              }),
            };
            return failedInsert;
          }
          (inserts[table] ??= []).push(obj);
          const inserted = { id: `${table}-new`, ...obj };
          const insChain: any = {
            select: () => insChain,
            single: () => Promise.resolve({ data: inserted, error: null }),
            then: (resolve: Function) => resolve({ data: inserted, error: null }),
          };
          return insChain;
        },
        then: (resolve: Function) => resolve({ data: rows, error: null }),
      };
      return chain;
    },
    rpc,
  } as any;
  return { supabase, inserts, rpc };
}

function makePayPalFetch() {
  return vi.fn(async (url: unknown, _init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/v1/oauth2/token')) {
      return new Response(
        JSON.stringify({ access_token: 'tok', token_type: 'Bearer', expires_in: 3600 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (u.includes('/v1/billing/subscriptions')) {
      return new Response(
        JSON.stringify({
          id: 'SUB-1',
          links: [{ rel: 'approve', href: 'https://www.sandbox.paypal.com/approve' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (u.includes('/v2/checkout/orders')) {
      return new Response(
        JSON.stringify({
          id: 'PAYPAL-ORDER-1',
          links: [{ rel: 'approve', href: 'https://www.sandbox.paypal.com/approve-order' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response('unexpected fetch', { status: 500 });
  });
}

function makeInteraction(customId = 'store:buy:prod-1') {
  return {
    customId,
    user: { id: 'user-1', username: 'Tester' },
    deferReply: vi.fn().mockResolvedValue({}),
    editReply: vi.fn().mockResolvedValue({}),
  } as any;
}

const VICTIM_GUILD = 'guild-1';
const ATTACKER_GUILD = 'guild-attacker';

const subscriptionProduct = {
  id: 'prod-1',
  guild_id: VICTIM_GUILD,
  name: 'Premium Sub',
  type: 'subscription',
  active: true,
  price_cents: 500,
  currency: 'USD',
};

const oneTimeProduct = {
  ...subscriptionProduct,
  name: 'Permanent Access',
  type: 'one_time',
  price_cents: 1_000,
};

/** Attacker-owned row: victim's product_id, attacker's guild_id, $0 so it
 * sorts FIRST on price_cents ASC, and an attacker-controlled PayPal plan. */
const crossGuildPlan = {
  id: 'plan-evil',
  guild_id: ATTACKER_GUILD,
  product_id: 'prod-1',
  active: true,
  price_cents: 0,
  paypal_plan_id: 'P-EVIL',
  name: 'Evil Free',
  currency: 'USD',
  interval_unit: 'MONTH',
};

const legitPlan = {
  id: 'plan-legit',
  guild_id: VICTIM_GUILD,
  product_id: 'prod-1',
  active: true,
  price_cents: 500,
  paypal_plan_id: 'P-LEGIT',
  name: 'Monthly',
  currency: 'USD',
  interval_unit: 'MONTH',
};

describe('handleBuyButton — cross-guild plan injection (subscription checkout)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('never selects another guild\'s plan even when it is the cheapest active one', async () => {
    const { supabase, inserts } = makeQueryEngine({
      products: [subscriptionProduct],
      customers: [{ id: 'cust-1', guild_id: VICTIM_GUILD, discord_id: 'user-1' }],
      entitlements: [],
      plans: [crossGuildPlan, legitPlan],
      orders: [],
    });
    const fetchMock = makePayPalFetch();
    vi.stubGlobal('fetch', fetchMock);
    const interaction = makeInteraction();

    await handleBuyButton(
      interaction, supabase, VICTIM_GUILD,
      'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
    );

    const subCall = fetchMock.mock.calls.find(([u]) => String(u).includes('/v1/billing/subscriptions'));
    expect(subCall).toBeDefined();
    const payload = JSON.parse((subCall![1] as RequestInit).body as string);
    // The victim guild's own plan must be billed — not the attacker's $0 plan.
    expect(payload.plan_id).toBe('P-LEGIT');
    // PayPal now receives only the opaque signed checkout handle; plan/guild
    // identity stays in the service-role ledger.  The selected plan is proven
    // by the provider plan id and the atomic order snapshot below.
    expect(payload.custom_id).toMatch(/^v2:[^.]+\.[^.]+$/);

    // The pending order must reference the guild-owned plan too.
    expect(inserts.orders).toHaveLength(1);
    expect(inserts.orders[0]).toMatchObject({
      guild_id: VICTIM_GUILD,
      product_id: 'prod-1',
      plan_id: 'plan-legit',
      amount_cents: 500,
    });
  });

  it('reports no plan available when the only active plans belong to another guild', async () => {
    const { supabase, inserts } = makeQueryEngine({
      products: [subscriptionProduct],
      customers: [{ id: 'cust-1', guild_id: VICTIM_GUILD, discord_id: 'user-1' }],
      entitlements: [],
      plans: [crossGuildPlan],
      orders: [],
    });
    const fetchMock = makePayPalFetch();
    vi.stubGlobal('fetch', fetchMock);
    const interaction = makeInteraction();

    await handleBuyButton(
      interaction, supabase, VICTIM_GUILD,
      'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
    );

    // No subscription may be created against the attacker's paypal_plan_id.
    const subCall = fetchMock.mock.calls.find(([u]) => String(u).includes('/v1/billing/subscriptions'));
    expect(subCall).toBeUndefined();
    expect(inserts.orders ?? []).toHaveLength(0);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('No active subscription plan') }),
    );
  });

  it('skips cheaper null and blank PayPal IDs and selects the first chargeable plan', async () => {
    const { supabase, inserts, rpc } = makeQueryEngine({
      products: [subscriptionProduct],
      customers: [{ id: 'cust-1', guild_id: VICTIM_GUILD, discord_id: 'user-1' }],
      entitlements: [],
      plans: [
        { ...legitPlan, id: 'plan-null', price_cents: 0, paypal_plan_id: null },
        { ...legitPlan, id: 'plan-blank', price_cents: 1, paypal_plan_id: '   ' },
        legitPlan,
      ],
      orders: [],
    });
    const fetchMock = makePayPalFetch();
    vi.stubGlobal('fetch', fetchMock);

    await handleBuyButton(
      makeInteraction(), supabase, VICTIM_GUILD,
      'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
    );

    expect(rpc).toHaveBeenCalledWith('commerce_select_checkout_plan', {
      p_guild_id: VICTIM_GUILD,
      p_product_id: 'prod-1',
    });
    const subCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/v1/billing/subscriptions'));
    const payload = JSON.parse((subCall![1] as RequestInit).body as string);
    expect(payload.plan_id).toBe('P-LEGIT');
    expect(inserts.orders[0]?.plan_id).toBe('plan-legit');
  });

  it('keeps a zero-price PayPal-backed plan chargeable and selects it', async () => {
    const zeroPricePlan = {
      ...legitPlan,
      id: 'plan-zero',
      price_cents: 0,
      paypal_plan_id: 'P-ZERO',
      name: 'Provider-Priced Plan',
    };
    const { supabase, inserts } = makeQueryEngine({
      products: [subscriptionProduct],
      customers: [{ id: 'cust-1', guild_id: VICTIM_GUILD, discord_id: 'user-1' }],
      entitlements: [],
      plans: [legitPlan, zeroPricePlan],
      orders: [],
    });
    const fetchMock = makePayPalFetch();
    vi.stubGlobal('fetch', fetchMock);

    await handleBuyButton(
      makeInteraction(), supabase, VICTIM_GUILD,
      'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
    );

    const subCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/v1/billing/subscriptions'));
    const payload = JSON.parse((subCall![1] as RequestInit).body as string);
    expect(payload.plan_id).toBe('P-ZERO');
    expect(inserts.orders[0]).toMatchObject({ plan_id: 'plan-zero', amount_cents: 0 });
  });

  it('breaks equal-price plan ties by ascending plan ID', async () => {
    const lowerIdPlan = {
      ...legitPlan,
      id: '00000000-0000-0000-0000-000000000001',
      paypal_plan_id: 'P-LOW-ID',
    };
    const higherIdPlan = {
      ...legitPlan,
      id: '00000000-0000-0000-0000-000000000002',
      paypal_plan_id: 'P-HIGH-ID',
    };
    const { supabase, inserts } = makeQueryEngine({
      products: [subscriptionProduct],
      customers: [{ id: 'cust-1', guild_id: VICTIM_GUILD, discord_id: 'user-1' }],
      entitlements: [],
      plans: [higherIdPlan, lowerIdPlan],
      orders: [],
    });
    const fetchMock = makePayPalFetch();
    vi.stubGlobal('fetch', fetchMock);

    await handleBuyButton(
      makeInteraction(), supabase, VICTIM_GUILD,
      'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
    );

    const subCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/v1/billing/subscriptions'));
    const payload = JSON.parse((subCall![1] as RequestInit).body as string);
    expect(payload.plan_id).toBe('P-LOW-ID');
    expect(inserts.orders[0]?.plan_id).toBe(lowerIdPlan.id);
  });

  it('fails loudly when the authoritative checkout selector is unavailable', async () => {
    const { supabase, inserts, rpc } = makeQueryEngine({
      products: [subscriptionProduct],
      customers: [{ id: 'cust-1', guild_id: VICTIM_GUILD, discord_id: 'user-1' }],
      entitlements: [],
      plans: [legitPlan],
      orders: [],
    });
    (rpc as any).mockImplementation(async (name: string, args?: Record<string, unknown>) => {
      if (name === 'commerce_inspect_checkout_blocker') {
        return {
          data: {
            disposition: 'clear',
            reason: null,
            order_id: null,
            order_number: null,
            approval_url: null,
          },
          error: null,
        };
      }
      if (name === 'commerce_claim_checkout_intent') {
        return {
          data: {
            disposition: 'claimed',
            checkout_token: args?.p_checkout_token,
          },
          error: null,
        };
      }
      return name === 'commerce_select_checkout_plan'
        ? { data: null, error: { message: 'database unavailable' } }
        : { data: 'ORD-TEST-1', error: null };
    });
    const fetchMock = makePayPalFetch();
    vi.stubGlobal('fetch', fetchMock);
    const interaction = makeInteraction();

    await handleBuyButton(
      interaction, supabase, VICTIM_GUILD,
      'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
    );

    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/v1/billing/subscriptions'))).toBe(false);
    expect(inserts.orders ?? []).toHaveLength(0);
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: expect.stringContaining('plan verification failed'),
    });
  });
});

describe('handleBuyButton — durable checkout snapshot boundary', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function setup(
    type: 'one_time' | 'subscription',
    options: {
      orderInsertError?: string;
      orderInsertCode?: string;
      freezeError?: string;
      deactivationError?: string;
      deactivationErrorOnce?: string;
      activeCheckoutResponseLossOnce?: boolean;
      malformedCheckoutField?: string;
      malformedCheckoutAttempts?: number;
      pricingResult?: {
        amount_cents: number;
        discount_cents: number;
        promotion_id: string | null;
        coupon_code: string | null;
      };
    } = {},
  ) {
    const product = type === 'one_time' ? oneTimeProduct : subscriptionProduct;
    const engine = makeQueryEngine({
      products: [product],
      customers: [{ id: 'cust-1', guild_id: VICTIM_GUILD, discord_id: 'user-1' }],
      entitlements: [],
      plans: type === 'subscription' ? [legitPlan] : [],
      orders: [],
    }, options);
    vi.stubGlobal('fetch', makePayPalFetch());
    return { ...engine, interaction: makeInteraction() };
  }

  it.each(['one_time', 'subscription'] as const)(
    'atomically creates and freezes the exact %s checkout before exposing an approval link',
    async (type) => {
      const { supabase, rpc, interaction } = setup(type);

      await handleBuyButton(
        interaction, supabase, VICTIM_GUILD,
        'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
      );

      expect(rpc).toHaveBeenCalledWith('commerce_create_and_bind_active_paid_checkout', {
        p_checkout_token: expect.any(String),
        p_order_number: 'ORD-TEST-1',
        p_guild_id: VICTIM_GUILD,
        p_customer_id: 'cust-1',
        p_product_id: 'prod-1',
        p_plan_id: type === 'one_time' ? null : 'plan-legit',
        p_provider_kind: type === 'one_time' ? 'capture' : 'subscription',
        p_provider_id: type === 'one_time' ? 'PAYPAL-ORDER-1' : 'SUB-1',
        p_approval_url: type === 'one_time'
          ? 'https://www.sandbox.paypal.com/approve-order'
          : 'https://www.sandbox.paypal.com/approve',
        p_amount_cents: type === 'one_time' ? 1_000 : 500,
        p_currency: 'USD',
      });
      expect(
        rpc.mock.calls.some(([name]) => name === 'commerce_freeze_order_grant_snapshot'),
      ).toBe(false);
      expect(
        rpc.mock.calls.some(([name]) => name === 'commerce_deactivate_pending_checkout'),
      ).toBe(false);
      expect(interaction.editReply).toHaveBeenLastCalledWith(
        expect.objectContaining({ components: expect.any(Array) }),
      );
      const reservationCallOrder = rpc.mock.invocationCallOrder[
        rpc.mock.calls.findIndex(([name]) => name === 'commerce_create_and_bind_active_paid_checkout')
      ];
      expect(reservationCallOrder).toBeLessThan(
        interaction.editReply.mock.invocationCallOrder.at(-1)!,
      );
    },
  );

  it('uses the atomically reserved coupon price for PayPal and the order', async () => {
    const { supabase, rpc } = setup('one_time', {
      pricingResult: {
        amount_cents: 750,
        discount_cents: 250,
        promotion_id: '00000000-0000-4000-8000-0000000000f1',
        coupon_code: 'SAVE25',
      },
    });
    const interaction = makeInteraction('store:buy:prod-1:SAVE25');

    await handleBuyButton(
      interaction, supabase, VICTIM_GUILD,
      'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
    );

    expect(rpc).toHaveBeenCalledWith('commerce_reserve_checkout_pricing', {
      p_checkout_token: expect.any(String),
      p_coupon_code: 'SAVE25',
    });
    expect(rpc).toHaveBeenCalledWith(
      'commerce_create_and_bind_active_paid_checkout',
      expect.objectContaining({ p_amount_cents: 750 }),
    );
    expect(JSON.stringify(interaction.editReply.mock.calls.at(-1)?.[0])).toContain('SAVE25');
    expect(JSON.stringify(interaction.editReply.mock.calls.at(-1)?.[0])).toContain('$2.50');
  });

  it.each(['one_time', 'subscription'] as const)(
    'does not expose a %s approval link when the atomic reservation fails',
    async (type) => {
      const { supabase, rpc, interaction } = setup(type, { orderInsertError: 'database unavailable' });

      await handleBuyButton(
        interaction, supabase, VICTIM_GUILD,
        'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
      );

      expect(
        rpc.mock.calls.some(([name]) => name === 'commerce_create_and_bind_active_paid_checkout'),
      ).toBe(true);
      expect(interaction.editReply).toHaveBeenLastCalledWith({
        content: expect.stringContaining('could not be safely recorded'),
      });
      expect(
        interaction.editReply.mock.calls.some(
          (call: Array<{ components?: unknown }>) => Array.isArray(call[0]?.components),
        ),
      ).toBe(false);
    },
  );

  it.each(['one_time', 'subscription'] as const)(
    'recovers an exact committed %s reservation after the first RPC response is lost',
    async (type) => {
      const { supabase, rpc, interaction, inserts } = setup(type, {
        activeCheckoutResponseLossOnce: true,
      });

      await handleBuyButton(
        interaction, supabase, VICTIM_GUILD,
        'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
      );

      const reservationCalls = rpc.mock.calls.filter(
      ([name]) => name === 'commerce_create_and_bind_active_paid_checkout',
      );
      expect(reservationCalls).toHaveLength(2);
      expect(reservationCalls[1]?.[1]).toEqual(reservationCalls[0]?.[1]);
      expect(inserts.orders).toHaveLength(1);
      expect(interaction.editReply).toHaveBeenLastCalledWith(
        expect.objectContaining({ components: expect.any(Array) }),
      );
    },
  );

  it.each([
    'disposition',
    'id',
    'order_number',
    'customer_id',
    'guild_id',
    'product_id',
    'plan_id',
    'paypal_order_id',
    'paypal_subscription_id',
    'amount_cents',
    'currency',
    'checkout_active',
    'status',
    'delivery_type_snapshot',
    'granted_role_ids_snapshot',
    'granted_channel_ids_snapshot',
    'temporary_role_grants_snapshot',
    'grant_snapshot_frozen_at',
  ])('replays the exact reservation before exposing a link after malformed atomic %s evidence', async (field) => {
    const { supabase, interaction, rpc, inserts } = setup('one_time', {
      malformedCheckoutField: field,
    });

    await handleBuyButton(
      interaction, supabase, VICTIM_GUILD,
      'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
    );

    const reservationCalls = rpc.mock.calls.filter(
      ([name]) => name === 'commerce_create_and_bind_active_paid_checkout',
    );
    expect(reservationCalls).toHaveLength(2);
    expect(reservationCalls[1]?.[1]).toEqual(reservationCalls[0]?.[1]);
    expect(inserts.orders).toHaveLength(1);
    expect(inserts.orders[0]?.checkout_active).toBe(true);
    expect(interaction.editReply).toHaveBeenLastCalledWith(
      expect.objectContaining({ components: expect.any(Array) }),
    );
  });

  it.each(['one_time', 'subscription'] as const)(
    'canonicalizes lowercase legacy %s currency before the provider/reservation boundary',
    async (type) => {
      const product = {
        ...(type === 'one_time' ? oneTimeProduct : subscriptionProduct),
        currency: 'usd',
      };
      const plan = { ...legitPlan, currency: 'eur' };
      const engine = makeQueryEngine({
        products: [product],
        customers: [{ id: 'cust-1', guild_id: VICTIM_GUILD, discord_id: 'user-1' }],
        entitlements: [],
        plans: type === 'subscription' ? [plan] : [],
        orders: [],
      });
      const fetchMock = makePayPalFetch();
      vi.stubGlobal('fetch', fetchMock);

      await handleBuyButton(
        makeInteraction(), engine.supabase, VICTIM_GUILD,
        'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
      );

      expect(engine.rpc).toHaveBeenCalledWith(
        'commerce_create_and_bind_active_paid_checkout',
        expect.objectContaining({
          p_currency: type === 'one_time' ? 'USD' : 'EUR',
        }),
      );
      if (type === 'one_time') {
        const providerCall = fetchMock.mock.calls.find(
          ([url]) => String(url).includes('/v2/checkout/orders'),
        );
        const providerBody = JSON.parse((providerCall![1] as RequestInit).body as string);
        expect(providerBody.purchase_units[0].amount.currency_code).toBe('USD');
      }
    },
  );

  it.each(['one_time', 'subscription'] as const)(
    'allows a later %s checkout after durable unexposed-link proof',
    async (type) => {
      const product = type === 'one_time' ? oneTimeProduct : subscriptionProduct;
      const previousOrder = {
        id: 'order-unexposed',
        order_number: 'ORD-UNEXPOSED',
        customer_id: 'cust-1',
        guild_id: VICTIM_GUILD,
        product_id: 'prod-1',
        plan_id: type === 'one_time' ? null : 'plan-legit',
        paypal_order_id: type === 'one_time' ? 'PAYPAL-UNEXPOSED' : null,
        paypal_subscription_id: type === 'subscription' ? 'SUB-UNEXPOSED' : null,
        amount_cents: type === 'one_time' ? 1_000 : 500,
        currency: 'USD',
        status: 'pending',
        checkout_active: false,
      };
      const engine = makeQueryEngine({
        products: [product],
        customers: [{ id: 'cust-1', guild_id: VICTIM_GUILD, discord_id: 'user-1' }],
        entitlements: [],
        plans: type === 'subscription' ? [legitPlan] : [],
        orders: [previousOrder],
        commerce_checkout_deactivation_proofs: [{
          order_id: previousOrder.id,
          proof_kind: 'approval_link_not_exposed',
        }],
      });
      vi.stubGlobal('fetch', makePayPalFetch());
      const interaction = makeInteraction();

      await handleBuyButton(
        interaction, engine.supabase, VICTIM_GUILD,
        'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
      );

      expect(engine.inserts.orders).toHaveLength(1);
      expect(interaction.editReply).toHaveBeenLastCalledWith(
        expect.objectContaining({ components: expect.any(Array) }),
      );
    },
  );
});

describe('handleBuyButton — white-label PayPal checkout brand', () => {
  beforeEach(() => {
    // Every suite in this file resolves the same guild id, and the brand kit
    // resolver caches per guild (30s TTL). Without this, an earlier suite's
    // brand-less row would answer these cases.
    invalidateBrandKitCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the owner store_brand_name as the PayPal one-time checkout brand', async () => {
    const { supabase } = makeQueryEngine({
      products: [oneTimeProduct],
      customers: [{ id: 'cust-1', guild_id: VICTIM_GUILD, discord_id: 'user-1' }],
      entitlements: [],
      guild_config: [{ guild_id: VICTIM_GUILD, store_brand_name: 'Acme Emporium', store_show_powered_by: true }],
      orders: [],
    });
    const fetchMock = makePayPalFetch();
    vi.stubGlobal('fetch', fetchMock);

    await handleBuyButton(
      makeInteraction(), supabase, VICTIM_GUILD,
      'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
    );

    const orderCall = fetchMock.mock.calls.find(([u]) => String(u).includes('/v2/checkout/orders'));
    expect(orderCall).toBeDefined();
    const payload = JSON.parse((orderCall![1] as RequestInit).body as string);
    expect(payload.application_context.brand_name).toBe('Acme Emporium');
  });

  it('falls back to the guild name when no owner brand is configured', async () => {
    const { supabase } = makeQueryEngine({
      products: [oneTimeProduct],
      customers: [{ id: 'cust-1', guild_id: VICTIM_GUILD, discord_id: 'user-1' }],
      entitlements: [],
      orders: [],
    });
    const fetchMock = makePayPalFetch();
    vi.stubGlobal('fetch', fetchMock);
    const interaction = { ...makeInteraction(), guild: { name: 'Cool Server' } };

    await handleBuyButton(
      interaction as any, supabase, VICTIM_GUILD,
      'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
    );

    const orderCall = fetchMock.mock.calls.find(([u]) => String(u).includes('/v2/checkout/orders'));
    const payload = JSON.parse((orderCall![1] as RequestInit).body as string);
    expect(payload.application_context.brand_name).toBe('Cool Server');
  });
});

describe('handleBuyButton — licence-key deliverability guard (Finding 6)', () => {
  beforeEach(() => {
    invalidateBrandKitCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const licenceProduct = {
    ...oneTimeProduct,
    id: 'prod-1',
    name: 'Licensed App',
    delivery_type: 'license_key',
  };

  function setupLicence(tables: Record<string, unknown[]>) {
    const engine = makeQueryEngine({
      products: [licenceProduct],
      customers: [{ id: 'cust-1', guild_id: VICTIM_GUILD, discord_id: 'user-1' }],
      entitlements: [],
      orders: [],
      ...tables,
    });
    const fetchMock = makePayPalFetch();
    vi.stubGlobal('fetch', fetchMock);
    return { ...engine, fetchMock, interaction: makeInteraction() };
  }

  it('refuses checkout — no PayPal order, no local order — when licence config is missing', async () => {
    const { supabase, inserts, fetchMock, interaction } = setupLicence({
      product_license_config: [],
    });

    await handleBuyButton(
      interaction, supabase, VICTIM_GUILD,
      'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
    );

    // The money path must never be entered for an undeliverable product.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/v2/checkout/orders'))).toBe(false);
    expect(inserts.orders ?? []).toHaveLength(0);
    // …and the buyer is told plainly, with no approval-link component.
    expect(
      interaction.editReply.mock.calls.some(
        (call: Array<{ components?: unknown }>) => Array.isArray(call[0]?.components),
      ),
    ).toBe(false);
    const embed = interaction.editReply.mock.calls.at(-1)![0].embeds[0];
    expect(JSON.stringify(embed)).toContain('not ready to be delivered');
  });

  it('allows checkout when the licence config row exists', async () => {
    const { supabase, inserts, fetchMock, interaction } = setupLicence({
      product_license_config: [{ product_id: 'prod-1' }],
    });

    await handleBuyButton(
      interaction, supabase, VICTIM_GUILD,
      'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
    );

    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/v2/checkout/orders'))).toBe(true);
    expect(inserts.orders ?? []).toHaveLength(1);
    expect(interaction.editReply).toHaveBeenLastCalledWith(
      expect.objectContaining({ components: expect.any(Array) }),
    );
  });

  it('does not gate non-licence delivery types on licence config', async () => {
    const engine = makeQueryEngine({
      products: [{ ...oneTimeProduct, delivery_type: 'file' }],
      customers: [{ id: 'cust-1', guild_id: VICTIM_GUILD, discord_id: 'user-1' }],
      entitlements: [],
      orders: [],
      product_license_config: [],
    });
    vi.stubGlobal('fetch', makePayPalFetch());
    const interaction = makeInteraction();

    await handleBuyButton(
      interaction, engine.supabase, VICTIM_GUILD,
      'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
    );

    expect(engine.inserts.orders ?? []).toHaveLength(1);
  });
});

describe('handleBuyButton — post-checkout destinations (Finding 7)', () => {
  beforeEach(() => {
    invalidateBrandKitCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function contextOf(fetchMock: ReturnType<typeof makePayPalFetch>, endpoint: string) {
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes(endpoint));
    expect(call).toBeDefined();
    return JSON.parse((call![1] as RequestInit).body as string).application_context;
  }

  it.each([
    ['one_time', '/v2/checkout/orders'],
    ['subscription', '/v1/billing/subscriptions'],
  ] as const)(
    'sends the %s buyer to the public portal confirmation, never the admin store',
    async (type, endpoint) => {
      const { supabase } = makeQueryEngine({
        products: [type === 'one_time' ? oneTimeProduct : subscriptionProduct],
        customers: [{ id: 'cust-1', guild_id: VICTIM_GUILD, discord_id: 'user-1' }],
        entitlements: [],
        plans: type === 'subscription' ? [legitPlan] : [],
        orders: [],
      });
      const fetchMock = makePayPalFetch();
      vi.stubGlobal('fetch', fetchMock);

      await handleBuyButton(
        makeInteraction(), supabase, VICTIM_GUILD,
        'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
      );

      const context = contextOf(fetchMock, endpoint);
      expect(context.return_url).toBe(
        `https://dashboard.example/portal/order-complete?guild=${VICTIM_GUILD}`,
      );
      expect(context.cancel_url).toBe(
        `https://dashboard.example/portal/order-cancelled?guild=${VICTIM_GUILD}`,
      );
      // `/store` is an admin route behind the middleware's login redirect, and
      // nothing ever read these params.
      expect(context.return_url).not.toContain('/store');
      expect(context.cancel_url).not.toContain('/store');
      expect(context.return_url).not.toContain('order_complete=true');
      expect(context.cancel_url).not.toContain('order_cancelled=true');
    },
  );

  it('url-encodes the guild id it hands to the confirmation page', async () => {
    const oddGuild = 'guild/with?chars';
    const { supabase } = makeQueryEngine({
      products: [{ ...oneTimeProduct, guild_id: oddGuild }],
      customers: [{ id: 'cust-1', guild_id: oddGuild, discord_id: 'user-1' }],
      entitlements: [],
      orders: [],
    });
    const fetchMock = makePayPalFetch();
    vi.stubGlobal('fetch', fetchMock);

    await handleBuyButton(
      makeInteraction(), supabase, oddGuild,
      'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
    );

    const context = contextOf(fetchMock, '/v2/checkout/orders');
    expect(context.return_url).toBe(
      `https://dashboard.example/portal/order-complete?guild=${encodeURIComponent(oddGuild)}`,
    );
  });
});

describe('handleBuyButton — one live checkout per product (Finding 10)', () => {
  beforeEach(() => {
    invalidateBrandKitCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const customer = { id: 'cust-1', guild_id: VICTIM_GUILD, discord_id: 'user-1' };
  const providerBinding = createHash('sha256')
    .update('https://api.paypal.example\0client-id')
    .digest('hex');

  function boundCheckoutIntent(
    orderId = 'order-live',
    overrides: Record<string, unknown> = {},
  ) {
    return {
      token: '00000000-0000-4000-8000-000000000099',
      order_id: orderId,
      status: 'bound',
      provider_binding: providerBinding,
      ...overrides,
    };
  }

  function pendingOrder(overrides: Record<string, unknown> = {}) {
    return {
      id: 'order-live',
      order_number: 'ORD-LIVE-1',
      guild_id: VICTIM_GUILD,
      customer_id: 'cust-1',
      product_id: 'prod-1',
      paypal_order_id: 'PAYPAL-LIVE-1',
      paypal_subscription_id: null,
      status: 'pending',
      checkout_active: true,
      created_at: new Date().toISOString(),
      ...overrides,
    };
  }

  function setup(
    orders: Record<string, unknown>[],
    options: {
      orderInsertError?: string;
      orderInsertCode?: string;
      checkoutInspectionError?: string;
    } = {},
    extraTables: Record<string, unknown[]> = {},
  ) {
    const boundIntents = orders
      .filter((order) => typeof order.checkout_approval_url === 'string')
      .map((order) => boundCheckoutIntent(String(order.id)));
    const engine = makeQueryEngine({
      products: [oneTimeProduct],
      customers: [customer],
      entitlements: [],
      orders,
      commerce_checkout_intents: boundIntents,
      ...extraTables,
    }, options);
    const fetchMock = makePayPalFetch();
    vi.stubGlobal('fetch', fetchMock);
    return { ...engine, fetchMock, interaction: makeInteraction() };
  }

  function lastEmbedText(interaction: { editReply: { mock: { calls: any[] } } }) {
    return JSON.stringify(interaction.editReply.mock.calls.at(-1)![0]);
  }

  it('refuses a second checkout while one is still in flight — no PayPal order at all', async () => {
    const { supabase, inserts, fetchMock, interaction } = setup([pendingOrder()]);

    await handleBuyButton(
      interaction, supabase, VICTIM_GUILD,
      'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
    );

    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/v2/checkout/orders'))).toBe(false);
    expect(inserts.orders ?? []).toHaveLength(0);
    expect(lastEmbedText(interaction)).toContain('ORD-LIVE-1');
    expect(lastEmbedText(interaction)).toContain('charged twice');
  });

  it('accepts an HTTP PayPal provider only on the loopback test surface', async () => {
    const apiBase = 'http://127.0.0.1:9999';
    const approvalUrl = 'https://www.sandbox.paypal.com/checkoutnow?token=PAYPAL-LOCAL';
    const localBinding = createHash('sha256')
      .update(`${apiBase}\0client-id`)
      .digest('hex');
    const { supabase, interaction } = setup(
      [pendingOrder({
        paypal_order_id: 'PAYPAL-LOCAL',
        checkout_approval_url: approvalUrl,
      })],
      {},
      {
        commerce_checkout_intents: [boundCheckoutIntent('order-live', {
          provider_binding: localBinding,
        })],
      },
    );
    const providerFetch = makePayPalFetch();
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url) === `${apiBase}/v2/checkout/orders/PAYPAL-LOCAL`) {
        return new Response(JSON.stringify({
          id: 'PAYPAL-LOCAL',
          status: 'CREATED',
          links: [{ rel: 'approve', href: approvalUrl }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return providerFetch(url, init);
    });
    vi.stubGlobal('fetch', fetchMock);

    await handleBuyButton(
      interaction, supabase, VICTIM_GUILD,
      apiBase, 'client-id', 'secret', 'https://dashboard.example',
    );

    expect(fetchMock).toHaveBeenCalledWith(
      `${apiBase}/v2/checkout/orders/PAYPAL-LOCAL`,
      expect.objectContaining({ method: 'GET' }),
    );
    expect(lastEmbedText(interaction)).toContain('Resume Purchase');
  });

  it('rejects an HTTP PayPal provider on a remote host', async () => {
    const { supabase, fetchMock, interaction } = setup([]);

    await handleBuyButton(
      interaction, supabase, VICTIM_GUILD,
      'http://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(lastEmbedText(interaction)).toContain('temporarily unavailable');
  });

  it('recovers the durable approval URL after the original Discord reply was lost', async () => {
    const approvalUrl = 'https://www.sandbox.paypal.com/checkoutnow?token=PAYPAL-LIVE-1';
    const { supabase, inserts, interaction } = setup([
      pendingOrder({ checkout_approval_url: approvalUrl }),
    ]);
    const providerFetch = makePayPalFetch();
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (
        String(url).endsWith('/v2/checkout/orders/PAYPAL-LIVE-1')
        && init?.method === 'GET'
      ) {
        return new Response(JSON.stringify({
          id: 'PAYPAL-LIVE-1',
          status: 'CREATED',
          links: [{ rel: 'approve', href: approvalUrl }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return providerFetch(url, init);
    });
    vi.stubGlobal('fetch', fetchMock);

    await handleBuyButton(
      interaction, supabase, VICTIM_GUILD,
      'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.paypal.example/v2/checkout/orders/PAYPAL-LIVE-1',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(inserts.orders ?? []).toHaveLength(0);
    expect(lastEmbedText(interaction)).toContain(approvalUrl);
    expect(lastEmbedText(interaction)).toContain('no second checkout was created');
  });

  it('does not pretend a new coupon applies to an existing differently priced checkout', async () => {
    const approvalUrl = 'https://www.sandbox.paypal.com/checkoutnow?token=PAYPAL-LIVE-1';
    const { supabase, fetchMock } = setup([
      pendingOrder({ checkout_approval_url: approvalUrl }),
    ]);
    const interaction = makeInteraction('store:buy:prod-1:SAVE25');

    await handleBuyButton(
      interaction, supabase, VICTIM_GUILD,
      'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
    );

    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/v2/checkout/orders/PAYPAL-LIVE-1'))).toBe(false);
    expect(lastEmbedText(interaction)).toContain('different pricing');
    expect(lastEmbedText(interaction)).toContain('will not create a second charge');
  });

  it('resumes a subscription only after PayPal confirms the exact approval URL', async () => {
    const approvalUrl = 'https://www.sandbox.paypal.com/billing/subscriptions?ba_token=LIVE';
    const engine = makeQueryEngine({
      products: [subscriptionProduct],
      customers: [customer],
      entitlements: [],
      plans: [legitPlan],
      orders: [pendingOrder({
        paypal_order_id: null,
        paypal_subscription_id: 'I-LIVE-SUBSCRIPTION',
        checkout_approval_url: approvalUrl,
      })],
      commerce_checkout_intents: [boundCheckoutIntent()],
    });
    const providerFetch = makePayPalFetch();
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (
        String(url).endsWith('/v1/billing/subscriptions/I-LIVE-SUBSCRIPTION')
        && init?.method === 'GET'
      ) {
        return new Response(JSON.stringify({
          id: 'I-LIVE-SUBSCRIPTION',
          status: 'APPROVAL_PENDING',
          links: [{ rel: 'approve', href: approvalUrl }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return providerFetch(url, init);
    });
    vi.stubGlobal('fetch', fetchMock);
    const interaction = makeInteraction();

    await handleBuyButton(
      interaction, engine.supabase, VICTIM_GUILD,
      'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.paypal.example/v1/billing/subscriptions/I-LIVE-SUBSCRIPTION',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).endsWith('/v1/billing/subscriptions') && init?.method === 'POST'
    )).toBe(false);
    expect(lastEmbedText(interaction)).toContain(approvalUrl);
    expect(lastEmbedText(interaction)).toContain('PayPal confirmed');
  });

  it('uses the provider identity on the pending order after the product billing type changes', async () => {
    const approvalUrl = 'https://www.sandbox.paypal.com/billing/subscriptions?ba_token=LIVE';
    const { supabase, interaction } = setup([
      pendingOrder({
        paypal_order_id: null,
        paypal_subscription_id: 'I-LIVE-SUBSCRIPTION',
        checkout_approval_url: approvalUrl,
      }),
    ]);
    const providerFetch = makePayPalFetch();
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (
        String(url).endsWith('/v1/billing/subscriptions/I-LIVE-SUBSCRIPTION')
        && init?.method === 'GET'
      ) {
        return new Response(JSON.stringify({
          id: 'I-LIVE-SUBSCRIPTION',
          status: 'APPROVAL_PENDING',
          links: [{ rel: 'approve', href: approvalUrl }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return providerFetch(url, init);
    });
    vi.stubGlobal('fetch', fetchMock);

    await handleBuyButton(
      interaction, supabase, VICTIM_GUILD,
      'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.paypal.example/v1/billing/subscriptions/I-LIVE-SUBSCRIPTION',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetchMock.mock.calls.some(([url]) =>
      String(url).includes('/v2/checkout/orders/I-LIVE-SUBSCRIPTION')
    )).toBe(false);
    expect(lastEmbedText(interaction)).toContain('Resume Subscription');
  });

  it('persists a changed payer-action URL before exposing it', async () => {
    const approvalUrl = 'https://www.sandbox.paypal.com/checkoutnow?token=PAYPAL-LIVE-1';
    const payerActionUrl = `${approvalUrl}&flow=3ds`;
    const { supabase, rpc, interaction } = setup([
      pendingOrder({ checkout_approval_url: approvalUrl }),
    ]);
    const providerFetch = makePayPalFetch();
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (
        String(url).endsWith('/v2/checkout/orders/PAYPAL-LIVE-1')
        && init?.method === 'GET'
      ) {
        return new Response(JSON.stringify({
          id: 'PAYPAL-LIVE-1',
          status: 'PAYER_ACTION_REQUIRED',
          links: [{ rel: 'payer-action', href: payerActionUrl }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return providerFetch(url, init);
    });
    vi.stubGlobal('fetch', fetchMock);

    await handleBuyButton(
      interaction, supabase, VICTIM_GUILD,
      'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
    );

    expect(rpc).toHaveBeenCalledWith('commerce_refresh_pending_checkout_approval_url', {
      p_order_id: 'order-live',
      p_guild_id: VICTIM_GUILD,
      p_customer_id: 'cust-1',
      p_product_id: 'prod-1',
      p_provider_kind: 'capture',
      p_provider_id: 'PAYPAL-LIVE-1',
      p_provider_binding: providerBinding,
      p_old_approval_url: approvalUrl,
      p_new_approval_url: payerActionUrl,
    });
    expect(lastEmbedText(interaction)).toContain(payerActionUrl);
    expect(lastEmbedText(interaction)).not.toContain(`${approvalUrl}\"`);
  });

  it('fails closed on a transient PayPal lookup error instead of risking a second charge', async () => {
    const approvalUrl = 'https://www.sandbox.paypal.com/checkoutnow?token=PAYPAL-LIVE-1';
    const { supabase, rpc, interaction } = setup([
      pendingOrder({ checkout_approval_url: approvalUrl }),
    ]);
    const providerFetch = makePayPalFetch();
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (
        String(url).endsWith('/v2/checkout/orders/PAYPAL-LIVE-1')
        && init?.method === 'GET'
      ) {
        return new Response(JSON.stringify({ name: 'INTERNAL_SERVER_ERROR' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return providerFetch(url, init);
    });
    vi.stubGlobal('fetch', fetchMock);

    await handleBuyButton(
      interaction, supabase, VICTIM_GUILD,
      'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
    );

    expect(rpc.mock.calls.some(([name]) => name === 'commerce_deactivate_pending_checkout')).toBe(false);
    expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).endsWith('/v2/checkout/orders') && init?.method === 'POST'
    )).toBe(false);
    expect(lastEmbedText(interaction)).toContain('temporarily unavailable');
    expect(lastEmbedText(interaction)).toContain('not been charged');
  });

  it('does not create a second checkout after PayPal says the first was approved', async () => {
    const approvalUrl = 'https://www.sandbox.paypal.com/checkoutnow?token=PAYPAL-LIVE-1';
    const { supabase, rpc, interaction } = setup([
      pendingOrder({ checkout_approval_url: approvalUrl }),
    ]);
    const providerFetch = makePayPalFetch();
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (
        String(url).endsWith('/v2/checkout/orders/PAYPAL-LIVE-1')
        && init?.method === 'GET'
      ) {
        return new Response(JSON.stringify({ id: 'PAYPAL-LIVE-1', status: 'APPROVED' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return providerFetch(url, init);
    });
    vi.stubGlobal('fetch', fetchMock);

    await handleBuyButton(
      interaction, supabase, VICTIM_GUILD,
      'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
    );

    expect(rpc.mock.calls.some(([name]) => name === 'commerce_deactivate_pending_checkout')).toBe(false);
    expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).endsWith('/v2/checkout/orders') && init?.method === 'POST'
    )).toBe(false);
    expect(lastEmbedText(interaction)).toContain('Payment Already Processing');
    expect(lastEmbedText(interaction)).toContain('will not create a second charge');
  });

  it('deactivates a provider-expired one-time checkout and creates a fresh approval link', async () => {
    const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const staleApprovalUrl = 'https://www.sandbox.paypal.com/checkoutnow?token=PAYPAL-EXTENDED';
    const { supabase, rpc, interaction } = setup([
      pendingOrder({
        created_at: fortyEightHoursAgo,
        paypal_order_id: 'PAYPAL-EXTENDED',
        checkout_approval_url: staleApprovalUrl,
      }),
    ]);
    const providerFetch = makePayPalFetch();
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (
        String(url).endsWith('/v2/checkout/orders/PAYPAL-EXTENDED')
        && init?.method === 'GET'
      ) {
        return new Response(JSON.stringify({ name: 'RESOURCE_NOT_FOUND' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return providerFetch(url, init);
    });
    vi.stubGlobal('fetch', fetchMock);

    await handleBuyButton(
      interaction, supabase, VICTIM_GUILD,
      'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
    );

    expect(rpc).toHaveBeenCalledWith('commerce_deactivate_pending_checkout', {
      p_order_id: 'order-live',
      p_guild_id: VICTIM_GUILD,
      p_customer_id: 'cust-1',
      p_product_id: 'prod-1',
      p_provider_kind: 'capture',
      p_provider_id: 'PAYPAL-EXTENDED',
      p_proof_kind: 'provider_expired',
      p_proof_reference: 'paypal-order-get:404',
    });
    expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).endsWith('/v2/checkout/orders') && init?.method === 'POST'
    )).toBe(true);
    expect(lastEmbedText(interaction)).toContain('https://www.sandbox.paypal.com/approve-order');
    expect(lastEmbedText(interaction)).not.toContain(staleApprovalUrl);
  });

  it('fails closed on an account-scoped 404 when the checkout has no matching provider binding', async () => {
    const staleApprovalUrl = 'https://www.sandbox.paypal.com/checkoutnow?token=PAYPAL-OTHER-ACCOUNT';
    const { supabase, rpc, interaction } = setup(
      [pendingOrder({
        paypal_order_id: 'PAYPAL-OTHER-ACCOUNT',
        checkout_approval_url: staleApprovalUrl,
      })],
      {},
      {
        commerce_checkout_intents: [boundCheckoutIntent('order-live', {
          provider_binding: '0'.repeat(64),
        })],
      },
    );
    const providerFetch = makePayPalFetch();
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (
        String(url).endsWith('/v2/checkout/orders/PAYPAL-OTHER-ACCOUNT')
        && init?.method === 'GET'
      ) {
        return new Response(JSON.stringify({ name: 'RESOURCE_NOT_FOUND' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return providerFetch(url, init);
    });
    vi.stubGlobal('fetch', fetchMock);

    await handleBuyButton(
      interaction, supabase, VICTIM_GUILD,
      'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
    );

    expect(rpc.mock.calls.some(([name]) => name === 'commerce_deactivate_pending_checkout')).toBe(false);
    expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).endsWith('/v2/checkout/orders') && init?.method === 'POST'
    )).toBe(false);
    expect(lastEmbedText(interaction)).toContain('temporarily unavailable');
  });

  it('fails closed when a subscription lookup returns 404 because prior charges cannot be disproved', async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const staleApprovalUrl = 'https://www.sandbox.paypal.com/billing/subscriptions?ba_token=OLD';
    const engine = makeQueryEngine({
      products: [subscriptionProduct],
      customers: [customer],
      entitlements: [],
      plans: [legitPlan],
      orders: [
        pendingOrder({
          created_at: eightDaysAgo,
          paypal_order_id: null,
          paypal_subscription_id: 'I-OLD-STILL-PAYABLE',
          checkout_approval_url: staleApprovalUrl,
        }),
      ],
      commerce_checkout_intents: [boundCheckoutIntent()],
    });
    const providerFetch = makePayPalFetch();
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (
        String(url).endsWith('/v1/billing/subscriptions/I-OLD-STILL-PAYABLE')
        && init?.method === 'GET'
      ) {
        return new Response(JSON.stringify({ name: 'RESOURCE_NOT_FOUND' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return providerFetch(url, init);
    });
    vi.stubGlobal('fetch', fetchMock);
    const interaction = makeInteraction();

    await handleBuyButton(
      interaction, engine.supabase, VICTIM_GUILD,
      'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
    );

    expect(engine.rpc.mock.calls.some(([name]) =>
      name === 'commerce_deactivate_pending_checkout'
    )).toBe(false);
    expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).endsWith('/v1/billing/subscriptions') && init?.method === 'POST'
    )).toBe(false);
    expect(lastEmbedText(interaction)).toContain('temporarily unavailable');
  });

  it('does not retire a cancelled subscription that has any payment history', async () => {
    const staleApprovalUrl = 'https://www.sandbox.paypal.com/billing/subscriptions?ba_token=PAID';
    const engine = makeQueryEngine({
      products: [subscriptionProduct],
      customers: [customer],
      entitlements: [],
      plans: [legitPlan],
      orders: [pendingOrder({
        paypal_order_id: null,
        paypal_subscription_id: 'I-CANCELLED-PAID',
        checkout_approval_url: staleApprovalUrl,
      })],
      commerce_checkout_intents: [boundCheckoutIntent()],
    });
    const providerFetch = makePayPalFetch();
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith('/v1/billing/subscriptions/I-CANCELLED-PAID')) {
        return new Response(JSON.stringify({ id: 'I-CANCELLED-PAID', status: 'CANCELLED' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (target.includes('/v1/billing/subscriptions/I-CANCELLED-PAID/transactions?')) {
        return new Response(JSON.stringify({
          transactions: [{ id: 'SALE-1', status: 'COMPLETED' }],
          total_items: 1,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return providerFetch(url, init);
    });
    vi.stubGlobal('fetch', fetchMock);
    const interaction = makeInteraction();

    await handleBuyButton(
      interaction, engine.supabase, VICTIM_GUILD,
      'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
    );

    expect(engine.rpc.mock.calls.some(([name]) => name === 'commerce_deactivate_pending_checkout')).toBe(false);
    expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).endsWith('/v1/billing/subscriptions') && init?.method === 'POST'
    )).toBe(false);
    expect(lastEmbedText(interaction)).toContain('Payment Already Processing');
  });

  it('retires a cancelled subscription whose only transaction attempts were declined', async () => {
    const staleApprovalUrl = 'https://www.sandbox.paypal.com/billing/subscriptions?ba_token=DECLINED';
    const engine = makeQueryEngine({
      products: [subscriptionProduct],
      customers: [customer],
      entitlements: [],
      plans: [legitPlan],
      orders: [pendingOrder({
        paypal_order_id: null,
        paypal_subscription_id: 'I-CANCELLED-DECLINED',
        checkout_approval_url: staleApprovalUrl,
      })],
      commerce_checkout_intents: [boundCheckoutIntent()],
    });
    const providerFetch = makePayPalFetch();
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith('/v1/billing/subscriptions/I-CANCELLED-DECLINED')) {
        return new Response(JSON.stringify({
          id: 'I-CANCELLED-DECLINED',
          status: 'CANCELLED',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (target.includes('/v1/billing/subscriptions/I-CANCELLED-DECLINED/transactions?')) {
        return new Response(JSON.stringify({
          transactions: [{ id: 'ATTEMPT-1', status: 'DECLINED' }],
          total_items: 1,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return providerFetch(url, init);
    });
    vi.stubGlobal('fetch', fetchMock);
    const interaction = makeInteraction();

    await handleBuyButton(
      interaction, engine.supabase, VICTIM_GUILD,
      'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
    );

    expect(engine.rpc).toHaveBeenCalledWith(
      'commerce_deactivate_pending_checkout',
      expect.objectContaining({
        p_order_id: 'order-live',
        p_provider_id: 'I-CANCELLED-DECLINED',
        p_proof_kind: 'provider_cancelled',
      }),
    );
    expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).endsWith('/v1/billing/subscriptions') && init?.method === 'POST'
    )).toBe(true);
  });

  it('fails closed on an undocumented subscription transaction status', async () => {
    const staleApprovalUrl = 'https://www.sandbox.paypal.com/billing/subscriptions?ba_token=UNKNOWN';
    const engine = makeQueryEngine({
      products: [subscriptionProduct],
      customers: [customer],
      entitlements: [],
      plans: [legitPlan],
      orders: [pendingOrder({
        paypal_order_id: null,
        paypal_subscription_id: 'I-CANCELLED-UNKNOWN',
        checkout_approval_url: staleApprovalUrl,
      })],
      commerce_checkout_intents: [boundCheckoutIntent()],
    });
    const providerFetch = makePayPalFetch();
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith('/v1/billing/subscriptions/I-CANCELLED-UNKNOWN')) {
        return new Response(JSON.stringify({
          id: 'I-CANCELLED-UNKNOWN',
          status: 'CANCELLED',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (target.includes('/v1/billing/subscriptions/I-CANCELLED-UNKNOWN/transactions?')) {
        return new Response(JSON.stringify({
          transactions: [{ id: 'ATTEMPT-1', status: 'UNKNOWN' }],
          total_items: 1,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return providerFetch(url, init);
    });
    vi.stubGlobal('fetch', fetchMock);
    const interaction = makeInteraction();

    await handleBuyButton(
      interaction, engine.supabase, VICTIM_GUILD,
      'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
    );

    expect(engine.rpc.mock.calls.some(([name]) =>
      name === 'commerce_deactivate_pending_checkout'
    )).toBe(false);
    expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).endsWith('/v1/billing/subscriptions') && init?.method === 'POST'
    )).toBe(false);
    expect(lastEmbedText(interaction)).toContain('temporarily unavailable');
  });

  it('retires a cancelled subscription only after PayPal proves it has no transactions', async () => {
    const staleApprovalUrl = 'https://www.sandbox.paypal.com/billing/subscriptions?ba_token=UNPAID';
    const engine = makeQueryEngine({
      products: [subscriptionProduct],
      customers: [customer],
      entitlements: [],
      plans: [legitPlan],
      orders: [pendingOrder({
        paypal_order_id: null,
        paypal_subscription_id: 'I-CANCELLED-UNPAID',
        checkout_approval_url: staleApprovalUrl,
      })],
      commerce_checkout_intents: [boundCheckoutIntent()],
    });
    const providerFetch = makePayPalFetch();
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith('/v1/billing/subscriptions/I-CANCELLED-UNPAID')) {
        return new Response(JSON.stringify({ id: 'I-CANCELLED-UNPAID', status: 'CANCELLED' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (target.includes('/v1/billing/subscriptions/I-CANCELLED-UNPAID/transactions?')) {
        return new Response(JSON.stringify({ transactions: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return providerFetch(url, init);
    });
    vi.stubGlobal('fetch', fetchMock);
    const interaction = makeInteraction();

    await handleBuyButton(
      interaction, engine.supabase, VICTIM_GUILD,
      'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
    );

    expect(engine.rpc).toHaveBeenCalledWith('commerce_deactivate_pending_checkout', {
      p_order_id: 'order-live',
      p_guild_id: VICTIM_GUILD,
      p_customer_id: 'cust-1',
      p_product_id: 'prod-1',
      p_provider_kind: 'subscription',
      p_provider_id: 'I-CANCELLED-UNPAID',
      p_proof_kind: 'provider_cancelled',
      p_proof_reference: 'paypal-subscription-transactions:CANCELLED:0',
    });
    expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).endsWith('/v1/billing/subscriptions') && init?.method === 'POST'
    )).toBe(true);
  });

  it('verifies old subscription history in PayPal-compliant windows and accepts omitted empty lists', async () => {
    const seventyFiveDaysAgo = new Date(Date.now() - 75 * 24 * 60 * 60 * 1000).toISOString();
    const staleApprovalUrl = 'https://www.sandbox.paypal.com/billing/subscriptions?ba_token=OLD-UNPAID';
    const engine = makeQueryEngine({
      products: [subscriptionProduct],
      customers: [customer],
      entitlements: [],
      plans: [legitPlan],
      orders: [pendingOrder({
        created_at: seventyFiveDaysAgo,
        paypal_order_id: null,
        paypal_subscription_id: 'I-CANCELLED-OLD-UNPAID',
        checkout_approval_url: staleApprovalUrl,
      })],
      commerce_checkout_intents: [boundCheckoutIntent()],
    });
    const transactionUrls: URL[] = [];
    const providerFetch = makePayPalFetch();
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith('/v1/billing/subscriptions/I-CANCELLED-OLD-UNPAID')) {
        return new Response(JSON.stringify({
          id: 'I-CANCELLED-OLD-UNPAID',
          status: 'CANCELLED',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (target.includes('/v1/billing/subscriptions/I-CANCELLED-OLD-UNPAID/transactions?')) {
        transactionUrls.push(new URL(target));
        return new Response(JSON.stringify({ total_items: 0 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return providerFetch(url, init);
    });
    vi.stubGlobal('fetch', fetchMock);
    const interaction = makeInteraction();

    await handleBuyButton(
      interaction, engine.supabase, VICTIM_GUILD,
      'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
    );

    expect(transactionUrls).toHaveLength(3);
    for (const url of transactionUrls) {
      const start = Date.parse(url.searchParams.get('start_time') ?? '');
      const end = Date.parse(url.searchParams.get('end_time') ?? '');
      expect(end - start).toBeLessThanOrEqual(31 * 24 * 60 * 60 * 1000);
    }
    expect(engine.rpc).toHaveBeenCalledWith(
      'commerce_deactivate_pending_checkout',
      expect.objectContaining({
        p_order_id: 'order-live',
        p_provider_id: 'I-CANCELLED-OLD-UNPAID',
      }),
    );
  });

  it('blocks a completed unknown-delivery hold before requesting a PayPal token', async () => {
    const heldOrder = pendingOrder({
      status: 'completed',
      checkout_active: false,
      order_number: 'ORD-HELD-1',
    });
    const { supabase, fetchMock, interaction } = setup(
      [heldOrder],
      {},
      {
        commerce_fulfillment_holds: [{
          order_id: heldOrder.id,
          guild_id: VICTIM_GUILD,
          customer_id: customer.id,
          product_id: 'prod-1',
          hold_reason: 'unknown_delivery_contract',
        }],
        // Alert resolution alone is deliberately not refund/delivery proof.
        alerts: [{
          alert_type: 'commerce_unknown_delivery_contract',
          resolved: true,
        }],
      },
    );

    await handleBuyButton(
      interaction, supabase, VICTIM_GUILD,
      'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(lastEmbedText(interaction)).toContain('Previous Payment Needs Review');
    expect(lastEmbedText(interaction)).toContain('ORD-HELD-1');
  });

  it('blocks a completed paid order before claim/entitlement resolution', async () => {
    const unresolvedOrder = pendingOrder({
      status: 'completed',
      checkout_active: false,
      order_number: 'ORD-CAPTURE-GAP',
    });
    const { supabase, fetchMock, interaction } = setup([unresolvedOrder]);

    await handleBuyButton(
      interaction, supabase, VICTIM_GUILD,
      'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(lastEmbedText(interaction)).toContain('Previous Payment Needs Review');
    expect(lastEmbedText(interaction)).toContain('ORD-CAPTURE-GAP');
  });

  it('treats an unreadable checkout history as blocking, never as clear', async () => {
    const { supabase, interaction } = setup([], {
      checkoutInspectionError: 'connection reset',
    });

    await handleBuyButton(
      interaction, supabase, VICTIM_GUILD,
      'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
    );

    expect(interaction.editReply).toHaveBeenLastCalledWith({
      content: expect.stringContaining('You have not been charged'),
    });
  });

  it('never exposes an approval link when the pending-checkout unique index rejects the insert', async () => {
    // The true double-click: both clicks read "clear", the database decides.
    const { supabase, interaction } = setup([], {
      orderInsertError: 'duplicate key value violates unique constraint "uniq_orders_pending_one_time_checkout"',
    });

    await handleBuyButton(
      interaction, supabase, VICTIM_GUILD,
      'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
    );

    expect(
      interaction.editReply.mock.calls.some(
        (call: Array<{ components?: unknown }>) => Array.isArray(call[0]?.components),
      ),
    ).toBe(false);
    expect(lastEmbedText(interaction)).toContain('Checkout Already In Progress');
  });

  it.each(['paid_hold', 'paid_fulfillment'] as const)(
    'shows review guidance when the reservation trigger finds %s',
    async (reason) => {
      const { supabase, interaction } = setup([], {
        orderInsertError: `commerce_checkout_blocked: ${reason} order ORD-HELD-RACE`,
      });

      await handleBuyButton(
        interaction, supabase, VICTIM_GUILD,
        'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
      );

      expect(
        interaction.editReply.mock.calls.some(
          (call: Array<{ components?: unknown }>) => Array.isArray(call[0]?.components),
        ),
      ).toBe(false);
      expect(lastEmbedText(interaction)).toContain('Previous Payment Needs Review');
      expect(lastEmbedText(interaction)).toContain('ORD-HELD-RACE');
    },
  );

  it('shows already-purchased guidance when the reservation trigger finds an entitlement race', async () => {
    const { supabase, interaction } = setup([], {
      orderInsertError:
        'commerce_checkout_blocked: active_entitlement order ORD-ENTITLEMENT-RACE',
    });

    await handleBuyButton(
      interaction, supabase, VICTIM_GUILD,
      'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
    );

    expect(lastEmbedText(interaction)).toContain('Already Purchased');
    expect(lastEmbedText(interaction)).not.toContain('Checkout Already In Progress');
  });

  it('does not misclassify an unrelated 23505 as another usable checkout', async () => {
    const { supabase, interaction } = setup([], {
      orderInsertCode: '23505',
      orderInsertError: 'duplicate key value violates unique constraint "orders_order_number_key"',
    });

    await handleBuyButton(
      interaction, supabase, VICTIM_GUILD,
      'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
    );

    expect(lastEmbedText(interaction)).toContain('could not be safely recorded');
    expect(lastEmbedText(interaction)).not.toContain('Checkout Already In Progress');
  });

  it('serializes a concurrent subscription insert and never exposes the losing approval link', async () => {
    const engine = makeQueryEngine({
      products: [subscriptionProduct],
      customers: [customer],
      entitlements: [],
      plans: [legitPlan],
      orders: [],
    }, {
      orderInsertError:
        'duplicate key value violates unique constraint "uniq_orders_pending_one_time_checkout"',
    });
    const fetchMock = makePayPalFetch();
    vi.stubGlobal('fetch', fetchMock);
    const interaction = makeInteraction();

    await handleBuyButton(
      interaction, engine.supabase, VICTIM_GUILD,
      'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
    );

    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes('/v1/billing/subscriptions')),
    ).toBe(true);
    expect(
      interaction.editReply.mock.calls.some(
        (call: Array<{ components?: unknown }>) => Array.isArray(call[0]?.components),
      ),
    ).toBe(false);
    expect(lastEmbedText(interaction)).toContain('Checkout Already In Progress');
    expect(lastEmbedText(interaction)).toContain('two paid subscriptions');
  });

  it('does not block a different product', async () => {
    const { supabase, inserts, interaction } = setup([
      pendingOrder({ product_id: 'prod-other' }),
    ]);

    await handleBuyButton(
      interaction, supabase, VICTIM_GUILD,
      'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
    );

    expect(inserts.orders ?? []).toHaveLength(1);
  });

  it('does not block a different customer', async () => {
    const { supabase, inserts, interaction } = setup([
      pendingOrder({ customer_id: 'cust-other' }),
    ]);

    await handleBuyButton(
      interaction, supabase, VICTIM_GUILD,
      'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
    );

    expect(inserts.orders ?? []).toHaveLength(1);
  });
});
