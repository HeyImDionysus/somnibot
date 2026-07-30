import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn() }));

import { GET } from '@/app/api/orders/route';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import {
  buildRequest,
  createMockSupabase,
  mockAuthSuccess,
  mockRateLimitPass,
  registerTable,
} from './helpers';

const GUILD_ID = 'guild-a';
const PRODUCT_ID = '123e4567-e89b-42d3-a456-426614174100';
const CUSTOMER_ID = '123e4567-e89b-42d3-a456-426614174200';
const VALID_PROVIDER_IDS = ['A', 'A.B_C-9', 'Z'.repeat(255)];
const INVALID_PROVIDER_IDS: Array<[string, string]> = [
  ['empty', ''],
  ['leading colon', ':CAPTURE'],
  ['leading slash', '/CAPTURE'],
  ['leading dot', '.CAPTURE'],
  ['leading underscore', '_CAPTURE'],
  ['leading hyphen', '-CAPTURE'],
  ['internal colon', 'CAPTURE:123'],
  ['internal slash', 'CAPTURE/123'],
  ['internal space', 'CAPTURE 123'],
  ['control character', 'CAPTURE\t123'],
  ['Unicode', 'CÁPTURE-123'],
  ['overlong', 'C'.repeat(256)],
];
const INVALID_PAYPAL_ORDER_IDS: Array<[string, string]> = [
  ['empty', ''],
  ['whitespace-only', '   '],
  ['untrimmed', ' PAYPAL-ORDER-1 '],
  ['internal space', 'PAYPAL ORDER-1'],
  ['colon', 'PAYPAL:ORDER-1'],
  ['slash', 'PAYPAL/ORDER-1'],
  ['control character', 'PAYPAL\tORDER-1'],
  ['Unicode', 'PÁYPAL-ORDER-1'],
  ['overlong', 'O'.repeat(256)],
];
const COMMERCE_MIGRATION = path.resolve(
  __dirname,
  '../../../supabase/migrations/20260711030000_canonicalize_commerce_role_metadata.sql',
);
const ORDER_IDS = [
  '123e4567-e89b-42d3-a456-426614174001',
  '123e4567-e89b-42d3-a456-426614174002',
  '123e4567-e89b-42d3-a456-426614174003',
  '123e4567-e89b-42d3-a456-426614174004',
  '123e4567-e89b-42d3-a456-426614174005',
];

function operation(
  index: number,
  status: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    attempt_id: `223e4567-e89b-42d3-a456-42661417400${index}`,
    order_id: ORDER_IDS[index - 1],
    guild_id: GUILD_ID,
    status,
    provider_required: status !== 'completed',
    created_at: `2026-07-13T01:00:0${index}.000Z`,
    ...overrides,
  };
}

function orderRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    guild_id: GUILD_ID,
    customer_id: CUSTOMER_ID,
    product_id: PRODUCT_ID,
    plan_id: null,
    paypal_order_id: 'PAYPAL-ORDER-1',
    paypal_subscription_id: null,
    amount_cents: 1_000,
    currency: 'USD',
    source: 'purchase',
    status: 'completed',
    ...overrides,
  };
}

function payment(
  index: number,
  orderId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: `323e4567-e89b-42d3-a456-42661417400${index}`,
    order_id: orderId,
    customer_id: CUSTOMER_ID,
    guild_id: GUILD_ID,
    paypal_payment_id: `CAPTURE-${index}`,
    amount_cents: 1_000,
    currency: 'USD',
    status: 'completed',
    provider: 'paypal',
    paypal_resource_type: 'capture',
    ...overrides,
  };
}

function configureList(input: {
  orders?: unknown;
  operations?: unknown;
  products?: unknown;
  customers?: unknown;
  payments?: unknown;
}) {
  const supabase = createMockSupabase();
  const orders = registerTable(supabase, 'orders');
  const operations = registerTable(supabase, 'commerce_admin_refund_operations');
  const products = registerTable(supabase, 'products');
  const customers = registerTable(supabase, 'customers');
  const payments = registerTable(supabase, 'payments');
  orders.then = vi.fn().mockImplementation((resolve) => resolve({
    data: 'orders' in input ? input.orders : [],
    error: null,
    count: Array.isArray(input.orders) ? input.orders.length : 0,
  }));
  operations.range.mockResolvedValue({
    data: 'operations' in input ? input.operations : [],
    error: null,
  });
  products.limit.mockResolvedValue({
    data: 'products' in input ? input.products : [],
    error: null,
  });
  customers.limit.mockResolvedValue({
    data: 'customers' in input ? input.customers : [],
    error: null,
  });
  payments.range.mockResolvedValue({
    data: 'payments' in input ? input.payments : [],
    error: null,
  });
  (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(supabase);
  return { supabase, orders, operations, products, customers, payments };
}

describe('GET /api/orders durable refund projection', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockRateLimitPass(checkAdminRateLimit as ReturnType<typeof vi.fn>);
    mockAuthSuccess(requireGuildOwner as ReturnType<typeof vi.fn>, { guildId: GUILD_ID });
  });

  it('retains read-only service-role access to the durable refund projection', () => {
    const migration = readFileSync(COMMERCE_MIGRATION, 'utf8');

    expect(migration).toContain(
      'GRANT SELECT ON public.commerce_admin_refund_operations TO service_role;',
    );
    expect(migration).not.toMatch(
      /GRANT\s+(?:ALL|INSERT|UPDATE|DELETE)[^;]*commerce_admin_refund_operations[^;]*TO\s+service_role/i,
    );
  });

  it('hydrates the latest durable refund states without exposing operation internals', async () => {
    const orderRows = ORDER_IDS.map((id) => orderRow(id));
    const { orders, operations, products, customers, payments } = configureList({
      orders: orderRows,
      operations: [
        operation(5, 'prepared', { provider_required: false }),
        operation(4, 'cancelled'),
        operation(3, 'failed'),
        operation(2, 'provider_completed'),
        operation(1, 'pending'),
        operation(1, 'failed', {
          attempt_id: '223e4567-e89b-42d3-a456-426614174099',
          order_id: ORDER_IDS[4],
          created_at: '2026-07-12T23:59:59.000Z',
        }),
      ],
      products: [{ id: PRODUCT_ID, guild_id: GUILD_ID, name: 'Original Product' }],
      customers: [{
        id: CUSTOMER_ID,
        guild_id: GUILD_ID,
        discord_id: 'discord-a',
        discord_username: 'Owner A Customer',
      }],
      payments: [],
    });

    const response = await GET(buildRequest('/api/orders'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.map((row: Record<string, unknown>) => row.refund_state)).toEqual([
      'pending',
      'provider_completed',
      'failed',
      'failed',
      'retry',
    ]);
    expect(body.data.map((row: Record<string, unknown>) => row.refund_context)).toEqual([
      'provider',
      'provider',
      'provider',
      'provider',
      'local',
    ]);
    expect(body.data[0]).toMatchObject({ products: { name: 'Original Product' } });
    expect(body.data[0]).toMatchObject({
      customers: { discord_id: 'discord-a', discord_username: 'Owner A Customer' },
    });
    expect(body.data[0]).not.toHaveProperty('refund_attempt_id');
    expect(body.data[0]).not.toHaveProperty('refund_status');
    expect(orders.select).toHaveBeenCalledWith('*', { count: 'exact' });
    expect(operations.eq).toHaveBeenCalledWith('guild_id', GUILD_ID);
    expect(operations.in).toHaveBeenCalledWith('order_id', ORDER_IDS);
    expect(operations.order).toHaveBeenNthCalledWith(1, 'created_at', { ascending: false });
    expect(operations.order).toHaveBeenNthCalledWith(2, 'attempt_id', { ascending: false });
    expect(products.eq).toHaveBeenCalledWith('guild_id', GUILD_ID);
    expect(products.in).toHaveBeenCalledWith('id', [PRODUCT_ID]);
    expect(customers.eq).toHaveBeenCalledWith('guild_id', GUILD_ID);
    expect(customers.in).toHaveBeenCalledWith('id', [CUSTOMER_ID]);
    expect(payments.in).toHaveBeenCalledWith('order_id', ORDER_IDS);
  });

  it('does not leak a moved and renamed product from another guild', async () => {
    const { products } = configureList({
      orders: [orderRow(ORDER_IDS[0])],
      operations: [],
      // Return a hostile/misconfigured service-role result despite the filter;
      // the response projection must still reject its foreign provenance.
      products: [{ id: PRODUCT_ID, guild_id: 'guild-b', name: 'Guild B Secret Rename' }],
      customers: [],
      payments: [],
    });

    const response = await GET(buildRequest('/api/orders'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data[0].products).toBeNull();
    expect(JSON.stringify(body)).not.toContain('Guild B Secret Rename');
    expect(products.eq).toHaveBeenCalledWith('guild_id', GUILD_ID);
    expect(products.in).toHaveBeenCalledWith('id', [PRODUCT_ID]);
  });

  it.each([
    [
      'moved customer',
      {
        id: CUSTOMER_ID,
        guild_id: 'guild-b',
        discord_id: 'discord-b-secret',
        discord_username: 'Guild B Secret Identity',
      },
    ],
    [
      'corrupt customer identity',
      {
        id: CUSTOMER_ID,
        guild_id: GUILD_ID,
        discord_id: '',
        discord_username: 'Malformed Secret Identity',
      },
    ],
  ])('does not leak a %s through the service-role customer lookup', async (
    _label,
    customer,
  ) => {
    const { customers } = configureList({
      orders: [orderRow(ORDER_IDS[0])],
      operations: [],
      products: [],
      customers: [customer],
      payments: [payment(1, ORDER_IDS[0])],
    });

    const response = await GET(buildRequest('/api/orders'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data[0].customers).toBeNull();
    expect(JSON.stringify(body)).not.toContain(customer.discord_username);
    expect(customers.select).toHaveBeenCalledWith(
      'id, guild_id, discord_id, discord_username',
    );
    expect(customers.eq).toHaveBeenCalledWith('guild_id', GUILD_ID);
    expect(customers.in).toHaveBeenCalledWith('id', [CUSTOMER_ID]);
  });

  it.each(['manual', 'giveaway', 'automation', 'purchase'])(
    'does not offer a positive %s order without an exact capture row',
    async (source) => {
      configureList({
        orders: [orderRow(ORDER_IDS[0], {
          source,
          paypal_order_id: null,
        })],
        operations: [],
        products: [],
        customers: [],
        payments: [],
      });

      const response = await GET(buildRequest('/api/orders'));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.data[0].refund_context).toBeNull();
    },
  );

  it.each([
    ['legacy null source', null],
    ['purchase without PayPal order id', 'purchase'],
    ['manual order with authoritative capture', 'manual'],
  ])('uses the exact capture—not %s—as positive provider proof', async (
    _label,
    source,
  ) => {
    const exactCapture = payment(1, ORDER_IDS[0]);
    configureList({
      orders: [orderRow(ORDER_IDS[0], { source, paypal_order_id: null })],
      operations: [],
      products: [],
      customers: [],
      payments: [exactCapture],
    });

    const response = await GET(buildRequest('/api/orders'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data[0].refund_context).toBe('provider');
    expect(JSON.stringify(body)).not.toContain(exactCapture.paypal_payment_id);
    expect(JSON.stringify(body)).not.toContain(exactCapture.id);
  });

  it('preserves exact-capture provider eligibility for a legacy null PayPal order id', async () => {
    configureList({
      orders: [orderRow(ORDER_IDS[0], { paypal_order_id: null })],
      operations: [],
      products: [],
      customers: [],
      payments: [payment(1, ORDER_IDS[0])],
    });

    const response = await GET(buildRequest('/api/orders'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data[0].refund_context).toBe('provider');
  });

  it.each(INVALID_PAYPAL_ORDER_IDS)(
    'does not advertise provider eligibility for a non-canonical PayPal order id: %s',
    async (_label, paypalOrderId) => {
      configureList({
        orders: [orderRow(ORDER_IDS[0], { paypal_order_id: paypalOrderId })],
        operations: [],
        products: [],
        customers: [],
        payments: [payment(1, ORDER_IDS[0])],
      });

      const response = await GET(buildRequest('/api/orders'));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.data[0].refund_context).toBeNull();
    },
  );

  it.each(VALID_PROVIDER_IDS)(
    'preserves canonical capture identity %s for provider eligibility',
    async (providerId) => {
      configureList({
        orders: [orderRow(ORDER_IDS[0])],
        operations: [],
        products: [],
        customers: [],
        payments: [payment(1, ORDER_IDS[0], { paypal_payment_id: providerId })],
      });

      const response = await GET(buildRequest('/api/orders'));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.data[0].refund_context).toBe('provider');
    },
  );

  it.each([
    ['foreign guild child', [payment(1, ORDER_IDS[0], { guild_id: 'guild-b' })]],
    ['wrong customer child', [payment(1, ORDER_IDS[0], {
      customer_id: '123e4567-e89b-42d3-a456-426614174299',
    })]],
    ['wrong amount child', [payment(1, ORDER_IDS[0], { amount_cents: 999 })]],
    ['wrong currency child', [payment(1, ORDER_IDS[0], { currency: 'EUR' })]],
    ['non-PayPal child', [payment(1, ORDER_IDS[0], { provider: 'stripe' })]],
    ['non-capture child', [payment(1, ORDER_IDS[0], { paypal_resource_type: 'sale' })]],
    ...INVALID_PROVIDER_IDS.map(([label, id]) => [
      `non-canonical provider id: ${label}`,
      [payment(1, ORDER_IDS[0], { paypal_payment_id: id })],
    ]),
    ['already-refunded capture', [payment(1, ORDER_IDS[0], { status: 'refunded' })]],
    ['duplicate completed captures', [
      payment(1, ORDER_IDS[0]),
      payment(2, ORDER_IDS[0]),
    ]],
    ['reversed sibling capture', [
      payment(1, ORDER_IDS[0]),
      payment(2, ORDER_IDS[0], { status: 'reversed' }),
    ]],
  ])('fails provider eligibility closed for %s', async (_label, payments) => {
    configureList({
      orders: [orderRow(ORDER_IDS[0])],
      operations: [],
      products: [],
      customers: [],
      payments,
    });

    const response = await GET(buildRequest('/api/orders'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data[0].refund_context).toBeNull();
  });

  it.each(['manual', 'giveaway', 'automation'])(
    'offers a zero-value %s order only as a local refund',
    async (source) => {
      configureList({
        orders: [orderRow(ORDER_IDS[0], {
          amount_cents: 0,
          paypal_order_id: null,
          source,
        })],
        operations: [],
        products: [],
        customers: [],
        payments: [],
      });

      const response = await GET(buildRequest('/api/orders'));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.data[0].refund_context).toBe('local');
    },
  );

  it('does not advertise a zero-amount capture that prepare rejects as fully refunded', async () => {
    configureList({
      orders: [orderRow(ORDER_IDS[0], {
        amount_cents: 0,
        paypal_order_id: null,
        source: 'manual',
      })],
      operations: [],
      products: [],
      customers: [],
      payments: [payment(1, ORDER_IDS[0], { amount_cents: 0 })],
    });

    const response = await GET(buildRequest('/api/orders'));
    const body = await response.json();
    const migration = readFileSync(COMMERCE_MIGRATION, 'utf8');

    expect(response.status).toBe(200);
    expect(body.data[0].refund_context).toBeNull();
    expect(migration).toContain('OR v_refunded_cents >= v_order.amount_cents');
    expect(migration).toContain(
      "MESSAGE = 'commerce_prepare_admin_refund: prior terminal refund lacks a completed admin attempt'",
    );
  });

  it('never re-offers a refund after any retained completed attempt', async () => {
    configureList({
      orders: [orderRow(ORDER_IDS[0])],
      operations: [operation(1, 'completed', { provider_required: true })],
      products: [],
      customers: [],
      payments: [payment(1, ORDER_IDS[0])],
    });

    const response = await GET(buildRequest('/api/orders'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data[0].refund_state).toBeNull();
    expect(body.data[0].refund_context).toBeNull();
  });

  it.each([
    ['prepared provider recovery', [operation(1, 'prepared')], 'retry', 'provider'],
    ['pending provider recovery', [operation(1, 'pending')], 'pending', 'provider'],
    [
      'provider-completed recovery',
      [operation(1, 'provider_completed')],
      'provider_completed',
      'provider',
    ],
    ['failed provider attempt', [operation(1, 'failed')], 'failed', 'provider'],
    [
      'prepared local attempt',
      [operation(1, 'prepared', { provider_required: false })],
      'retry',
      'local',
    ],
    [
      'completed attempt',
      [operation(1, 'completed', { provider_required: true })],
      null,
      null,
    ],
    ['fresh refunded order', [], null, null],
  ])('hydrates refunded-order %s without inventing a fresh action', async (
    _label,
    operations,
    expectedState,
    expectedContext,
  ) => {
    configureList({
      orders: [orderRow(ORDER_IDS[0], { status: 'refunded' })],
      operations,
      products: [],
      customers: [],
      payments: [],
    });

    const response = await GET(buildRequest('/api/orders'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data[0].refund_state).toBe(expectedState);
    expect(body.data[0].refund_context).toBe(expectedContext);
  });

  it('preserves customer identity search without a mutable relation embed', async () => {
    const { orders, customers } = configureList({
      orders: [orderRow(ORDER_IDS[0])],
      operations: [],
      products: [],
      payments: [payment(1, ORDER_IDS[0])],
    });
    customers.limit
      .mockResolvedValueOnce({
        data: [{ id: CUSTOMER_ID, guild_id: GUILD_ID }],
        error: null,
      })
      .mockResolvedValueOnce({
        data: [{
          id: CUSTOMER_ID,
          guild_id: GUILD_ID,
          discord_id: 'discord-a',
          discord_username: 'Owner A Customer',
        }],
        error: null,
      });

    const response = await GET(buildRequest('/api/orders', {
      searchParams: { search: 'Owner A' },
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data[0].customers.discord_username).toBe('Owner A Customer');
    expect(orders.select).toHaveBeenCalledWith('*', { count: 'exact' });
    expect(orders.or).toHaveBeenCalledWith(
      `order_number.ilike.%Owner A%,customer_id.in.(${CUSTOMER_ID})`,
    );
    expect(customers.select).toHaveBeenNthCalledWith(1, 'id, guild_id');
    expect(customers.select).toHaveBeenNthCalledWith(
      2,
      'id, guild_id, discord_id, discord_username',
    );
    expect(customers.eq).toHaveBeenNthCalledWith(1, 'guild_id', GUILD_ID);
    expect(customers.eq).toHaveBeenNthCalledWith(2, 'guild_id', GUILD_ID);
    expect(customers.in).toHaveBeenCalledWith('id', [CUSTOMER_ID]);
  });

  it.each([
    ['unknown status', operation(1, 'creating')],
    ['foreign guild', operation(1, 'pending', { guild_id: 'guild-b' })],
    ['unrequested order', operation(1, 'pending', {
      order_id: '123e4567-e89b-42d3-a456-426614174999',
    })],
    ['missing rows', null],
  ])('fails the whole list closed for malformed refund projection: %s', async (
    _label,
    malformedOperation,
  ) => {
    const { products } = configureList({
      orders: [orderRow(ORDER_IDS[0])],
      operations: malformedOperation === null ? null : [malformedOperation],
      products: [{ id: PRODUCT_ID, guild_id: GUILD_ID, name: 'Must Not Be Returned' }],
      customers: [],
      payments: [],
    });

    const response = await GET(buildRequest('/api/orders'));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'Order refund state could not be loaded',
    });
    expect(products.select).not.toHaveBeenCalled();
  });
});
