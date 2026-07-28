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
    freezeError?: string;
    deactivationError?: string;
    deactivationErrorOnce?: string;
    checkoutInspectionError?: string;
  } = {},
) {
  const inserts: Record<string, any[]> = {};
  let deactivationAttempts = 0;
  const rpc = vi.fn(async (name: string, args?: Record<string, unknown>) => {
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
          links: [{ rel: 'approve', href: 'https://paypal.example/approve' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (u.includes('/v2/checkout/orders')) {
      return new Response(
        JSON.stringify({
          id: 'PAYPAL-ORDER-1',
          links: [{ rel: 'approve', href: 'https://paypal.example/approve-order' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response('unexpected fetch', { status: 500 });
  });
}

function makeInteraction() {
  return {
    customId: 'store:buy:prod-1',
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
    expect(JSON.parse(payload.custom_id).plan_id).toBe('plan-legit');

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
    (rpc as any).mockImplementation(async (name: string) => {
      if (name === 'commerce_inspect_checkout_blocker') {
        return {
          data: {
            disposition: 'clear',
            reason: null,
            order_id: null,
            order_number: null,
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
    'persists and freezes the exact %s order before exposing an approval link',
    async (type) => {
      const { supabase, rpc, interaction } = setup(type);

      await handleBuyButton(
        interaction, supabase, VICTIM_GUILD,
        'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
      );

      expect(rpc).toHaveBeenCalledWith('commerce_freeze_order_grant_snapshot', {
        p_order_id: 'orders-new',
        p_guild_id: VICTIM_GUILD,
        p_customer_id: 'cust-1',
        p_product_id: 'prod-1',
      });
      expect(
        rpc.mock.calls.some(([name]) => name === 'commerce_deactivate_pending_checkout'),
      ).toBe(false);
      expect(interaction.editReply).toHaveBeenLastCalledWith(
        expect.objectContaining({ components: expect.any(Array) }),
      );
      const freezeCallOrder = rpc.mock.invocationCallOrder[
        rpc.mock.calls.findIndex(([name]) => name === 'commerce_freeze_order_grant_snapshot')
      ];
      expect(freezeCallOrder).toBeLessThan(interaction.editReply.mock.invocationCallOrder.at(-1)!);
    },
  );

  it.each(['one_time', 'subscription'] as const)(
    'does not expose a %s approval link when the local order insert fails',
    async (type) => {
      const { supabase, rpc, interaction } = setup(type, { orderInsertError: 'database unavailable' });

      await handleBuyButton(
        interaction, supabase, VICTIM_GUILD,
        'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
      );

      expect(rpc.mock.calls.some(([name]) => name === 'commerce_freeze_order_grant_snapshot')).toBe(false);
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
    'does not expose a %s approval link when snapshot freeze fails',
    async (type) => {
      const { supabase, rpc, interaction } = setup(type, { freezeError: 'sale contract changed' });

      await handleBuyButton(
        interaction, supabase, VICTIM_GUILD,
        'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
      );

      expect(rpc.mock.calls.some(([name]) => name === 'commerce_freeze_order_grant_snapshot')).toBe(true);
      expect(rpc).toHaveBeenCalledWith('commerce_deactivate_pending_checkout', {
        p_order_id: 'orders-new',
        p_guild_id: VICTIM_GUILD,
        p_customer_id: 'cust-1',
        p_product_id: 'prod-1',
        p_provider_kind: type === 'one_time' ? 'capture' : 'subscription',
        p_provider_id: type === 'one_time' ? 'PAYPAL-ORDER-1' : 'SUB-1',
        p_proof_kind: 'approval_link_not_exposed',
        p_proof_reference: 'payment-handler:snapshot-freeze-failed:orders-new',
      });
      expect(interaction.editReply).toHaveBeenLastCalledWith({
        content: expect.stringContaining('configuration changed'),
      });
      expect(
        interaction.editReply.mock.calls.some(
          (call: Array<{ components?: unknown }>) => Array.isArray(call[0]?.components),
        ),
      ).toBe(false);
    },
  );

  it.each(['one_time', 'subscription'] as const)(
    'does not claim an unexposed %s checkout was cleaned up when proof is unconfirmed',
    async (type) => {
      const { supabase, rpc, interaction } = setup(type, {
        freezeError: 'sale contract changed',
        deactivationError: 'database unavailable',
      });

      await handleBuyButton(
        interaction, supabase, VICTIM_GUILD,
        'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
      );

      expect(interaction.editReply).toHaveBeenLastCalledWith({
        content: expect.stringContaining('cleanup could not be confirmed'),
      });
      expect(
        rpc.mock.calls.filter(([name]) => name === 'commerce_deactivate_pending_checkout'),
      ).toHaveLength(2);
      expect(
        interaction.editReply.mock.calls.some(
          (call: Array<{ components?: unknown }>) => Array.isArray(call[0]?.components),
        ),
      ).toBe(false);
    },
  );

  it.each(['one_time', 'subscription'] as const)(
    'replays the exact unexposed %s proof after an ambiguous first response',
    async (type) => {
      const { supabase, rpc, interaction } = setup(type, {
        freezeError: 'sale contract changed',
        deactivationErrorOnce: 'connection reset after commit',
      });

      await handleBuyButton(
        interaction, supabase, VICTIM_GUILD,
        'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
      );

      const deactivationCalls = rpc.mock.calls.filter(
        ([name]) => name === 'commerce_deactivate_pending_checkout',
      );
      expect(deactivationCalls).toHaveLength(2);
      expect(deactivationCalls[1]?.[1]).toEqual(deactivationCalls[0]?.[1]);
      expect(interaction.editReply).toHaveBeenLastCalledWith({
        content: expect.stringContaining('please try again'),
      });
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
    const engine = makeQueryEngine({
      products: [oneTimeProduct],
      customers: [customer],
      entitlements: [],
      orders,
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

  it('keeps an extended-window one-time approval link blocked after six hours', async () => {
    const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const { supabase, inserts, fetchMock, interaction } = setup([
      pendingOrder({ created_at: fortyEightHoursAgo, paypal_order_id: 'PAYPAL-EXTENDED' }),
    ]);

    await handleBuyButton(
      interaction, supabase, VICTIM_GUILD,
      'https://api.paypal.example', 'client-id', 'secret', 'https://dashboard.example',
    );

    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/v2/checkout/orders'))).toBe(false);
    expect(inserts.orders ?? []).toHaveLength(0);
    expect(lastEmbedText(interaction)).toContain('ORD-LIVE-1');
  });

  it('keeps an old subscription approval link blocked without inventing a local expiry', async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
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
        }),
      ],
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
    ).toBe(false);
    expect(engine.inserts.orders ?? []).toHaveLength(0);
    expect(lastEmbedText(interaction)).toContain('ORD-LIVE-1');
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
