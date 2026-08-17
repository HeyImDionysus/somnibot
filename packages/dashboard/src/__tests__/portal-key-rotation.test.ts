/**
 * Customer key rotation is one atomic database operation: revoke the old
 * hash, persist the successor hash, and stage the only plaintext copy in the
 * protected receipt carrier. HTTP responses and logs never expose that key.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/rate-limit', () => ({
  rateLimits: { portalRotate: vi.fn().mockResolvedValue({ limited: false }) },
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/portal/licenses/[id]/rotate/route';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { rateLimits } from '@/lib/api/rate-limit';

const KEY_ID = '11111111-1111-4111-8111-111111111111';
const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222';
const PRODUCT_ID = '33333333-3333-4333-8333-333333333333';
const ORDER_ID = '44444444-4444-4444-8444-444444444444';
const SUCCESSOR_ID = '55555555-5555-4555-8555-555555555555';
const ACTION_ID = '66666666-6666-4666-8666-666666666666';
const GUILD_ID = '222222222222222222';
const DISCORD_ID = '333333333333333333';

const LICENCE = {
  id: KEY_ID,
  status: 'active',
  customer_id: CUSTOMER_ID,
  guild_id: GUILD_ID,
  product_id: PRODUCT_ID,
  bound_discord_id: DISCORD_ID,
  order_id: ORDER_ID,
  orders: {
    order_number: 'ORD-001',
    amount_cents: 999,
    currency: 'USD',
    entitlements: [{
      id: '77777777-7777-4777-8777-777777777777',
      status: 'active',
      type: 'one_time',
      license_key_id: KEY_ID,
      order_id: ORDER_ID,
      customer_id: CUSTOMER_ID,
      guild_id: GUILD_ID,
      product_id: PRODUCT_ID,
    }],
  },
  products: { name: 'VIP Pass' },
};

type RpcResponse = {
  data: Record<string, unknown> | null;
  error: { message: string } | null;
};

function exactRotationResult(
  args: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return {
    status: 'rotated',
    old_key_id: KEY_ID,
    new_key_id: SUCCESSOR_ID,
    action_id: ACTION_ID,
    action_status: 'pending',
    guild_id: GUILD_ID,
    customer_id: CUSTOMER_ID,
    product_id: PRODUCT_ID,
    order_id: ORDER_ID,
    discord_id: DISCORD_ID,
    new_key_suffix: args.p_new_key_suffix,
    license_key_id: SUCCESSOR_ID,
    order_number: LICENCE.orders.order_number,
    product_name: LICENCE.products.name,
    amount_cents: LICENCE.orders.amount_cents,
    currency: LICENCE.orders.currency,
    delivery: 'queued',
    ...overrides,
  };
}

function mockDb(opts: {
  portal?: { customer_id: string; guild_id: string } | null;
  licence?: Record<string, unknown> | null;
  rpcImpl?: (
    name: string,
    args: Record<string, unknown>,
    call: number,
  ) => RpcResponse | Promise<RpcResponse>;
} = {}) {
  const rpcCalls: Array<[string, Record<string, unknown>]> = [];
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];

  const from = vi.fn((table: string) => {
    const chain: Record<string, any> = {};
    for (const method of ['select', 'eq', 'gt']) {
      chain[method] = vi.fn(() => chain);
    }
    chain.single = vi.fn(async () => ({
      data: table === 'portal_sessions'
        ? (opts.portal === undefined
            ? { customer_id: CUSTOMER_ID, guild_id: GUILD_ID }
            : opts.portal)
        : null,
      error: null,
    }));
    chain.maybeSingle = vi.fn(async () => ({
      data: table === 'license_keys'
        ? (opts.licence === undefined ? LICENCE : opts.licence)
        : null,
      error: null,
    }));
    chain.insert = vi.fn(async (row: Record<string, unknown>) => {
      inserts.push({ table, row });
      return { error: null };
    });
    return chain;
  });

  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    rpcCalls.push([name, args]);
    return opts.rpcImpl
      ? opts.rpcImpl(name, args, rpcCalls.length)
      : { data: exactRotationResult(args), error: null };
  });

  vi.mocked(createAdminSupabase).mockReturnValue({ from, rpc } as never);
  return { inserts, rpcCalls };
}

const req = (token?: string) =>
  new NextRequest(`http://x/api/portal/licenses/${KEY_ID}/rotate`, {
    method: 'POST',
    ...(token ? { headers: { 'x-portal-token': token } } : {}),
  });
const params = (id = KEY_ID) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
    vi.resetAllMocks();
  vi.mocked(rateLimits.portalRotate).mockResolvedValue({ limited: false } as never);
});

describe('access control and recovery routing', () => {
  it('refuses missing auth, expired sessions, rate limits, and foreign licences', async () => {
    mockDb();
    expect((await POST(req(), params())).status).toBe(401);

    mockDb({ portal: null });
    expect((await POST(req('token'), params())).status).toBe(401);

    mockDb();
    vi.mocked(rateLimits.portalRotate).mockResolvedValueOnce({ limited: true } as never);
    expect((await POST(req('token'), params())).status).toBe(429);

    const foreign = mockDb({ licence: null });
    expect((await POST(req('token'), params())).status).toBe(404);
    expect(foreign.rpcCalls).toHaveLength(0);
  });

  it('routes a revoked predecessor through the atomic RPC for response-loss recovery', async () => {
    const db = mockDb({
      licence: {
        ...LICENCE,
        status: 'revoked',
        revocation_reason: 'rotated',
        rotated_to_key_id: SUCCESSOR_ID,
        orders: {
          ...LICENCE.orders,
          entitlements: [{
            ...LICENCE.orders.entitlements[0],
            license_key_id: SUCCESSOR_ID,
          }],
        },
      },
      rpcImpl: async () => ({
        data: { status: 'not_rotatable' },
        error: null,
      }),
    });

    expect((await POST(req('token'), params())).status).toBe(409);
    expect(db.rpcCalls).toHaveLength(1);
    expect(db.rpcCalls[0]![0]).toBe('commerce_rotate_license_and_stage_receipt');
  });

  it('rejects an object-shaped disabled rotation policy', async () => {
    const db = mockDb({
      licence: {
        ...LICENCE,
        products: {
          name: 'VIP Pass',
          product_license_config: { rotation_policy: 'disabled', key_prefix: 'SMNI' },
        },
      },
    });

    expect((await POST(req('token'), params())).status).toBe(403);
    expect(db.rpcCalls).toHaveLength(0);
  });

  it('rejects rotation when the linked entitlement is terminal', async () => {
    const db = mockDb({
      licence: {
        ...LICENCE,
        orders: {
          ...LICENCE.orders,
          entitlements: [{ ...LICENCE.orders.entitlements[0], status: 'cancelled' }],
        },
      },
    });

    expect((await POST(req('token'), params())).status).toBe(409);
    expect(db.rpcCalls).toHaveLength(0);
  });

  it('rejects rotation when active access is not linked to the predecessor key', async () => {
    const db = mockDb({
      licence: {
        ...LICENCE,
        orders: {
          ...LICENCE.orders,
          entitlements: [{ ...LICENCE.orders.entitlements[0], license_key_id: null }],
        },
      },
    });

    expect((await POST(req('token'), params())).status).toBe(409);
    expect(db.rpcCalls).toHaveLength(0);
  });

  it('maps the transaction-time entitlement guard to a terminal-access conflict', async () => {
    const db = mockDb({
      rpcImpl: async () => ({
        data: null,
        error: { message: 'license_rotate_key_without_receipt_stage: entitlement is not usable' },
      }),
    });

    expect((await POST(req('token'), params())).status).toBe(409);
    expect(db.rpcCalls).toHaveLength(1);
  });
});

describe('atomic secret carrier', () => {
  it('uses one atomic RPC and never returns the plaintext', async () => {
    const db = mockDb();
    const response = await POST(req('token'), params());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(db.rpcCalls).toHaveLength(1);
    const [name, args] = db.rpcCalls[0]!;
    expect(name).toBe('commerce_rotate_license_and_stage_receipt');
    expect(args).toMatchObject({
      p_license_key_id: KEY_ID,
      p_guild_id: GUILD_ID,
      p_customer_id: CUSTOMER_ID,
      p_product_id: PRODUCT_ID,
      p_order_id: ORDER_ID,
      p_discord_id: DISCORD_ID,
      p_new_key_prefix: 'SMNI',
      p_actor_discord_id: DISCORD_ID,
    });
    expect(String(args.p_new_key_plaintext)).toMatch(
      /^SMNI-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/,
    );
    expect(args.p_new_key_suffix).toBe(
      String(args.p_new_key_plaintext).slice(-4),
    );
    expect(body.newKeySuffix).toBe(args.p_new_key_suffix);
    expect(JSON.stringify(body)).not.toContain(String(args.p_new_key_plaintext));
    expect(db.inserts).toEqual([]);
  });

  it('generates distinct, transcription-safe plaintext carriers', async () => {
    const first = mockDb();
    await POST(req('token'), params());
    const second = mockDb();
    await POST(req('token'), params());

    const firstKey = String(first.rpcCalls[0]![1].p_new_key_plaintext);
    const secondKey = String(second.rpcCalls[0]![1].p_new_key_plaintext);
    expect(firstKey).not.toBe(secondKey);
    expect(firstKey.slice(5)).not.toMatch(/[O0IL1S5Z2B8U]/);
    expect(secondKey.slice(5)).not.toMatch(/[O0IL1S5Z2B8U]/);
  });

  it('rejects a fresh response whose suffix is not the submitted successor', async () => {
    mockDb({
      rpcImpl: async (_name, args) => ({
        data: exactRotationResult(args, { new_key_suffix: 'ACDE' }),
        error: null,
      }),
    });

    expect((await POST(req('token'), params())).status).toBe(500);
  });
});

describe('response loss and replay', () => {
  it('retries the exact atomic call once after a lost commit response', async () => {
    const db = mockDb({
      rpcImpl: async (_name, args, call) => call === 1
        ? { data: null, error: { message: 'connection closed after commit' } }
        : {
            data: exactRotationResult(args, {
              status: 'already_rotated',
              action_status: 'pending',
            }),
            error: null,
          },
    });

    const response = await POST(req('token'), params());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.alreadyRotated).toBe(true);
    expect(db.rpcCalls).toHaveLength(2);
    expect(db.rpcCalls[1]).toEqual(db.rpcCalls[0]);
    expect(db.inserts).toEqual([]);
  });

  it('reports an exact failed replay as held rather than claiming delivery', async () => {
    mockDb({
      rpcImpl: async (_name, args) => ({
        data: exactRotationResult(args, {
          status: 'already_rotated',
          action_status: 'failed',
        }),
        error: null,
      }),
    });

    const response = await POST(req('token'), params());
    const body = await response.json();
    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      alreadyRotated: true,
      delivery: 'held',
    });
  });

  it('surfaces durable held evidence and repeated RPC errors', async () => {
    mockDb({
      rpcImpl: async () => ({ data: { status: 'held' }, error: null }),
    });
    expect((await POST(req('token'), params())).status).toBe(409);

    const failed = mockDb({
      rpcImpl: async () => ({
        data: null,
        error: { message: 'deadlock detected' },
      }),
    });
    expect((await POST(req('token'), params())).status).toBeGreaterThanOrEqual(400);
    expect(failed.rpcCalls).toHaveLength(2);
  });
});
