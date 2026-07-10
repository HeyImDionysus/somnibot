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
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
  SOMNI_PALETTE: { primary: 0x5865f2, success: 0x57f287, danger: 0xed4245 },
}));

vi.mock('discord.js', async () => {
  const actual = await vi.importActual('discord.js');
  return { ...actual };
});

vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));

import { handleBuyButton } from '../features/commerce/payment-handler.js';

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
function makeQueryEngine(tables: Record<string, any[]>) {
  const inserts: Record<string, any[]> = {};
  const supabase = {
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      const chain: any = {
        select: () => chain,
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
          (inserts[table] ??= []).push(obj);
          const inserted = { id: `${table}-new`, ...obj };
          const insChain: any = {
            select: () => insChain,
            single: () => Promise.resolve({ data: inserted, error: null }),
            then: (resolve: Function) => resolve({ data: inserted, error: null }),
          };
          return insChain;
        },
      };
      return chain;
    },
    rpc: vi.fn(async () => ({ data: 'ORD-TEST-1', error: null })),
  } as any;
  return { supabase, inserts };
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
});
