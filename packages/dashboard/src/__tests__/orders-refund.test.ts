import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn() }));
vi.mock('@/lib/paypal', () => ({
  getPayPalRuntimeConfig: vi.fn(),
  getPayPalToken: vi.fn(),
}));

import { POST } from '@/app/api/orders/[id]/refund/route';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { getPayPalRuntimeConfig, getPayPalToken } from '@/lib/paypal';
import {
  buildRequest,
  mockAuthSuccess,
  mockAuthUnauthorized,
  mockRateLimited,
  mockRateLimitPass,
} from './helpers';

const ORDER_ID = '123e4567-e89b-42d3-a456-426614174000';
const ATTEMPT_ID = '998e4567-e89b-42d3-a456-426614174111';
const GUILD_ID = 'guild-1';
const ACTOR_ID = '123456789';
const SECOND_ACTOR_ID = '987654321';
const VALID_PROVIDER_IDS = ['A', 'A.B_C-9', 'Z'.repeat(255)];
const INVALID_PROVIDER_IDS: Array<[string, string]> = [
  ['empty', ''],
  ['leading colon', ':REFUND'],
  ['leading slash', '/REFUND'],
  ['leading dot', '.REFUND'],
  ['leading underscore', '_REFUND'],
  ['leading hyphen', '-REFUND'],
  ['internal colon', 'REFUND:123'],
  ['internal slash', 'REFUND/123'],
  ['internal space', 'REFUND 123'],
  ['control character', 'REFUND\t123'],
  ['Unicode', 'RÉFUND-123'],
  ['overlong', 'R'.repeat(256)],
];

/** The route also reads the tenant-scoped PayPal policy before money work. */
const BOOKKEEPING_TABLES = ['orders', 'admin_changes', 'guild_config'];

type RpcResult = { data: unknown; error: null | { code?: string; message: string } };
type RefundSupabaseMock = {
  rpc: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
};

let mock: RefundSupabaseMock;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

const refundReq = (body: Record<string, unknown> = {}, orderId = ORDER_ID) =>
  buildRequest(`/api/orders/${orderId}/refund`, { method: 'POST', body });
const paramsFor = (id = ORDER_ID) => Promise.resolve({ id });

function attempt(overrides: Record<string, unknown> = {}) {
  return {
    order_id: ORDER_ID,
    attempt_id: ATTEMPT_ID,
    request_id: ATTEMPT_ID,
    status: 'prepared',
    provider_action: 'create',
    resource_type: 'capture',
    paypal_payment_id: 'CAPTURE-123',
    paypal_refund_id: null,
    refund_amount_cents: 1_000,
    currency: 'USD',
    reason: 'Admin refund',
    actor_id: ACTOR_ID,
    ...overrides,
  };
}

function stateAttempt(
  status: string,
  providerAction: string,
  overrides: Record<string, unknown> = {},
) {
  return attempt({
    status,
    provider_action: providerAction,
    paypal_refund_id: ['pending', 'provider_completed', 'completed'].includes(status)
      ? 'REFUND-123'
      : null,
    ...overrides,
  });
}

function localAttempt(status = 'prepared') {
  return attempt({
    status,
    provider_action: status === 'completed' ? 'none' : 'finalize',
    resource_type: null,
    paypal_payment_id: null,
    paypal_refund_id: null,
    refund_amount_cents: 0,
  });
}

function finalized(overrides: Record<string, unknown> = {}) {
  return {
    order_id: ORDER_ID,
    attempt_id: ATTEMPT_ID,
    status: 'completed',
    order_status: 'refunded',
    already_refunded: false,
    entitlements_changed: 1,
    licenses_changed: 1,
    sessions_changed: 1,
    paypal_refund_id: 'REFUND-123',
    ...overrides,
  };
}

function providerPayload(
  status = 'COMPLETED',
  overrides: Record<string, unknown> = {},
) {
  return {
    id: 'REFUND-123',
    status,
    amount: { value: '10.00', currency_code: 'USD' },
    ...overrides,
  };
}

function configureRpc(input: {
  prepare?: RpcResult;
  record?: RpcResult;
  finalize?: RpcResult;
} = {}) {
  const prepare = input.prepare ?? { data: attempt(), error: null };
  const record = input.record ?? {
    data: stateAttempt('provider_completed', 'finalize'),
    error: null,
  };
  const finalize = input.finalize ?? { data: finalized(), error: null };
  mock.rpc.mockImplementation(async (name: string) => {
    if (name === 'commerce_prepare_admin_refund') return prepare;
    if (name === 'commerce_record_admin_refund_outcome') return record;
    if (name === 'commerce_finalize_admin_refund') return finalize;
    throw new Error(`Unexpected RPC ${name}`);
  });
}

function mockProvider(payload: unknown = providerPayload(), ok = true, status = 201) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status,
    json: vi.fn().mockResolvedValue(payload),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function post(
  body: Record<string, unknown> = {},
  actorId = ACTOR_ID,
  orderId = ORDER_ID,
) {
  mockAuthSuccess(requireGuildOwner as ReturnType<typeof vi.fn>, {
    guildId: GUILD_ID,
    discordId: actorId,
  });
  return POST(refundReq(body, orderId), { params: paramsFor(orderId) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mock = { rpc: vi.fn(), from: vi.fn() };
  // Tenant PayPal policy is read before the attempt RPCs. Keep the harness
  // fail-closed (no policy row means the production default) while still
  // allowing the bookkeeping reads/writes exercised by the state machine.
  mock.from.mockImplementation((table: string) => {
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'order', 'limit']) {
      chain[method] = vi.fn(() => chain);
    }
    chain.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
    chain.insert = vi.fn(async () => ({ error: null }));
    return chain;
  });
  configureRpc();
  (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mock);
  (getPayPalRuntimeConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
    apiBase: 'https://api.sandbox.paypal.com',
  });
  (getPayPalToken as ReturnType<typeof vi.fn>).mockResolvedValue('paypal-token');
  mockRateLimitPass(checkAdminRateLimit as ReturnType<typeof vi.fn>);
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  // The refund STATE MACHINE still touches no table directly — every step goes
  // through the attempt-keyed RPCs, so no direct write can desynchronise the
  // order, its entitlements, its license keys or its device sessions from the
  // attempt record.
  //
  // The only `.from()` calls this route may make are the bookkeeping ones that
  // feed the Admin Changes page: a best-effort READ of the order before
  // finalization flips it (so the recorded before-state is the pre-refund one)
  // and the `admin_changes` row itself. Both swallow their own failures, which
  // is why a `from` that returns undefined here still lets the refund complete.
  // Anything else appearing in this list is a direct table write sneaking back
  // into the state machine.
  for (const [table] of mock.from.mock.calls) {
    expect(BOOKKEEPING_TABLES).toContain(table);
  }
  vi.unstubAllGlobals();
  consoleErrorSpy.mockRestore();
});

describe('POST /api/orders/[id]/refund — attempt state machine', () => {
  it('returns 429 before authentication when rate limited', async () => {
    mockRateLimited(checkAdminRateLimit as ReturnType<typeof vi.fn>);
    const response = await POST(refundReq(), { params: paramsFor() });
    expect(response.status).toBe(429);
    expect(requireGuildOwner).not.toHaveBeenCalled();
    expect(mock.rpc).not.toHaveBeenCalled();
  });

  it('returns 401 before creating an admin client for a non-owner', async () => {
    mockAuthUnauthorized(requireGuildOwner as ReturnType<typeof vi.fn>);
    const response = await POST(refundReq(), { params: paramsFor() });
    expect(response.status).toBe(401);
    expect(createAdminSupabase).not.toHaveBeenCalled();
  });

  it('rejects a malformed order UUID before creating a client or attempting side effects', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await post({}, ACTOR_ID, 'not-an-order-uuid');

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      success: false,
      status: 'invalid_request',
      code: 'INVALID_ORDER_ID',
      error: 'Invalid order id format.',
    });
    expect(createAdminSupabase).not.toHaveBeenCalled();
    expect(mock.rpc).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getPayPalRuntimeConfig).not.toHaveBeenCalled();
    expect(getPayPalToken).not.toHaveBeenCalled();
  });

  it.each([
    ['overlong reason', { reason: 'x'.repeat(256) }],
    ['blank reason', { reason: '   ' }],
    ['false revocation promise', { revoke_entitlements: false }],
  ])('rejects %s before preparing an attempt', async (_label, body) => {
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(mock.rpc).not.toHaveBeenCalled();
  });

  it('distinguishes a permanent 23514 domain conflict from unexpected preparation errors', async () => {
    configureRpc({
      prepare: { data: null, error: { code: '23514', message: 'subscription unsupported' } },
    });
    const conflict = await post();
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      code: 'ORDER_NOT_REFUNDABLE',
      status: 'not_refundable',
    });

    configureRpc({
      prepare: { data: null, error: { code: 'P0001', message: 'unexpected runtime failure' } },
    });
    const unexpected = await post();
    expect(unexpected.status).toBe(500);
    await expect(unexpected.json()).resolves.toMatchObject({
      code: 'REFUND_PREPARATION_FAILED',
      status: 'preparation_failed',
    });
  });

  it.each<[string, unknown]>([
    ['missing row', null],
    ['wrong order', attempt({ order_id: 'other' })],
    ['blank actor', attempt({ actor_id: '' })],
    ['untrimmed actor', attempt({ actor_id: ' actor ' })],
    ['non-UUID attempt', attempt({ attempt_id: 'attempt-1', request_id: 'attempt-1' })],
    ['different request id', attempt({ request_id: '123e4567-e89b-42d3-a456-426614174999' })],
    ['unknown status', attempt({ status: 'running' })],
    ['unknown action', attempt({ provider_action: 'post' })],
    ['sale resource', attempt({ resource_type: 'sale' })],
    ['create without capture', attempt({ paypal_payment_id: null })],
    ['create with existing refund', attempt({ paypal_refund_id: 'REFUND-123' })],
    ['create with zero amount', attempt({ refund_amount_cents: 0 })],
    ['pending without refund id', stateAttempt('pending', 'poll', { paypal_refund_id: null })],
    ['pending with create action', stateAttempt('pending', 'create')],
    ['provider completed with poll action', stateAttempt('provider_completed', 'poll')],
    ['failed with finalize action', stateAttempt('failed', 'finalize')],
    ['completed with finalize action', stateAttempt('completed', 'finalize')],
    ['fractional cents', attempt({ refund_amount_cents: 1.5 })],
    ['lowercase currency', attempt({ currency: 'usd' })],
    ['untrimmed reason', attempt({ reason: ' reason ' })],
    ...INVALID_PROVIDER_IDS.flatMap(([label, id]) => [
      [`${label} capture id`, attempt({ paypal_payment_id: id })] as [string, unknown],
      [`${label} refund id`, stateAttempt('pending', 'poll', { paypal_refund_id: id })] as [string, unknown],
    ]),
  ])('fails closed on malformed preparation: %s', async (_label, data) => {
    configureRpc({ prepare: { data, error: null } });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const response = await post();
    expect(response.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mock.rpc).toHaveBeenCalledTimes(1);
  });

  it('creates a paid attempt, records COMPLETED, then finalizes locally', async () => {
    const fetchMock = mockProvider();
    const response = await post({ reason: 'Caller reason' });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, status: 'completed' });
    expect(mock.rpc).toHaveBeenNthCalledWith(1, 'commerce_prepare_admin_refund', {
      p_order_id: ORDER_ID,
      p_guild_id: GUILD_ID,
      p_actor_id: ACTOR_ID,
      p_reason: 'Caller reason',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api-m.sandbox.paypal.com/v2/payments/captures/CAPTURE-123/refund',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer paypal-token',
          'PayPal-Request-Id': ATTEMPT_ID,
          Prefer: 'return=representation',
        }),
        body: JSON.stringify({
          amount: { value: '10.00', currency_code: 'USD' },
          note_to_payer: 'Admin refund',
        }),
      }),
    );
    expect(mock.rpc).toHaveBeenNthCalledWith(2, 'commerce_record_admin_refund_outcome', {
      p_attempt_id: ATTEMPT_ID,
      p_guild_id: GUILD_ID,
      p_provider_status: 'COMPLETED',
      p_paypal_refund_id: 'REFUND-123',
      p_refund_amount_cents: 1_000,
      p_currency: 'USD',
    });
    expect(mock.rpc).toHaveBeenNthCalledWith(3, 'commerce_finalize_admin_refund', {
      p_attempt_id: ATTEMPT_ID,
      p_guild_id: GUILD_ID,
    });
  });

  it.each(VALID_PROVIDER_IDS)(
    'accepts canonical alphanumeric/dot/underscore/hyphen provider identity %s',
    async (providerId) => {
      configureRpc({
        prepare: {
          data: attempt({ paypal_payment_id: providerId }),
          error: null,
        },
        record: {
          data: stateAttempt('provider_completed', 'finalize', {
            paypal_payment_id: providerId,
            paypal_refund_id: providerId,
          }),
          error: null,
        },
        finalize: {
          data: finalized({ paypal_refund_id: providerId }),
          error: null,
        },
      });
      mockProvider(providerPayload('COMPLETED', { id: providerId }));

      const response = await post();

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ success: true, status: 'completed' });
    },
  );

  it('records PENDING and returns 202 without changing local access', async () => {
    configureRpc({
      record: { data: stateAttempt('pending', 'poll'), error: null },
    });
    mockProvider(providerPayload('PENDING'));
    const response = await post();
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      status: 'pending',
      code: 'REFUND_PENDING',
    });
    expect(mock.rpc).toHaveBeenCalledTimes(2);
  });

  it('polls a known pending refund by ID and never issues a second POST', async () => {
    configureRpc({
      prepare: { data: stateAttempt('pending', 'poll'), error: null },
      record: { data: stateAttempt('pending', 'poll'), error: null },
    });
    const fetchMock = mockProvider(providerPayload('PENDING'), true, 200);
    const response = await post();
    expect(response.status).toBe(202);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api-m.sandbox.paypal.com/v2/payments/refunds/REFUND-123',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty('body');
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty('PayPal-Request-Id');
  });

  it('polls PENDING to COMPLETED, records it, and finalizes', async () => {
    configureRpc({
      prepare: { data: stateAttempt('pending', 'poll'), error: null },
      record: { data: stateAttempt('provider_completed', 'finalize'), error: null },
    });
    const fetchMock = mockProvider(providerPayload('COMPLETED'), true, 200);
    const response = await post();
    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls[0][1].method).toBe('GET');
    expect(mock.rpc).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['pending', stateAttempt('pending', 'poll'), stateAttempt('pending', 'poll'), 202],
    ['provider-completed', stateAttempt('provider_completed', 'finalize'), null, 200],
  ])(
    'lets a current owner resume an original owner\'s frozen %s attempt',
    async (_label, prepared, recorded, expectedStatus) => {
      configureRpc({
        prepare: { data: prepared, error: null },
        ...(recorded ? { record: { data: recorded, error: null } } : {}),
      });
      const fetchMock = mockProvider(providerPayload('PENDING'), true, 200);

      const response = await post({}, SECOND_ACTOR_ID);

      expect(response.status).toBe(expectedStatus);
      expect(mock.rpc).toHaveBeenNthCalledWith(1, 'commerce_prepare_admin_refund', {
        p_order_id: ORDER_ID,
        p_guild_id: GUILD_ID,
        p_actor_id: SECOND_ACTOR_ID,
        p_reason: 'Admin refund',
      });
      if (prepared.status === 'pending') {
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][1].method).toBe('GET');
      } else {
        expect(fetchMock).not.toHaveBeenCalled();
      }
    },
  );

  it.each(['FAILED', 'CANCELLED'] as const)(
    'records an exact %s from a prepared POST with a null result and preserves access',
    async (status) => {
      configureRpc({
        record: {
          data: stateAttempt(status.toLowerCase(), 'none', { paypal_refund_id: null }),
          error: null,
        },
      });
      mockProvider({ status });
      const response = await post();
      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({
        success: false,
        status: status.toLowerCase(),
        code: status === 'FAILED' ? 'PROVIDER_FAILED' : 'PROVIDER_CANCELLED',
      });
      expect(mock.rpc).toHaveBeenNthCalledWith(2, 'commerce_record_admin_refund_outcome',
        expect.objectContaining({
          p_provider_status: status,
          p_paypal_refund_id: null,
          p_refund_amount_cents: null,
          p_currency: null,
        }));
      expect(mock.rpc).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['FAILED', 'CANCELLED'] as const)(
    'records an exact %s while polling only when the frozen refund ID matches',
    async (status) => {
      configureRpc({
        prepare: { data: stateAttempt('pending', 'poll'), error: null },
        record: {
          data: stateAttempt(status.toLowerCase(), 'none', { paypal_refund_id: 'REFUND-123' }),
          error: null,
        },
      });
      mockProvider(providerPayload(status), true, 200);
      const response = await post();
      expect(response.status).toBe(422);
      expect(mock.rpc).toHaveBeenCalledTimes(2);
    },
  );

  it('finalizes provider_completed without any provider request', async () => {
    configureRpc({
      prepare: { data: stateAttempt('provider_completed', 'finalize'), error: null },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const response = await post();
    expect(response.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mock.rpc).toHaveBeenCalledTimes(2);
  });

  it('finalizes a prepared local zero-value attempt without PayPal', async () => {
    configureRpc({
      prepare: { data: localAttempt(), error: null },
      finalize: { data: finalized({ paypal_refund_id: null }), error: null },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const response = await post();
    expect(response.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mock.rpc).toHaveBeenNthCalledWith(2, 'commerce_finalize_admin_refund', {
      p_attempt_id: ATTEMPT_ID,
      p_guild_id: GUILD_ID,
    });
  });

  it.each([
    ['paid', stateAttempt('completed', 'none')],
    ['local', localAttempt('completed')],
  ])('returns an exact completed %s replay without provider or finalizer calls', async (_label, data) => {
    configureRpc({ prepare: { data, error: null } });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const response = await post();
    expect(response.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mock.rpc).toHaveBeenCalledTimes(1);
  });

  it.each(['failed', 'cancelled'] as const)(
    'returns a durable terminal %s replay without provider or local effects',
    async (status) => {
      configureRpc({
        prepare: { data: stateAttempt(status, 'none'), error: null },
      });
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const response = await post();
      expect(response.status).toBe(422);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mock.rpc).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['blank token', null, 'token'],
    ['network failure', vi.fn().mockRejectedValue(new Error('offline')), 'fetch'],
    ['provider non-2xx', vi.fn().mockResolvedValue({ ok: false, status: 503 }), 'fetch'],
    ['invalid JSON', vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: vi.fn().mockRejectedValue(new SyntaxError('invalid')),
    }), 'fetch'],
  ])('keeps a prepared attempt retryable after %s', async (_label, behavior, kind) => {
    if (kind === 'token') {
      (getPayPalToken as ReturnType<typeof vi.fn>).mockResolvedValue(behavior);
      vi.stubGlobal('fetch', vi.fn());
    } else {
      vi.stubGlobal('fetch', behavior);
    }
    const response = await post();
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      code: 'PROVIDER_REQUEST_UNCONFIRMED',
    });
    expect(mock.rpc).toHaveBeenCalledTimes(1);
  });

  it.each<[string, unknown]>([
    ['unknown status', providerPayload('REFUNDED')],
    ['pending without id', providerPayload('PENDING', { id: undefined })],
    ['completed without amount', providerPayload('COMPLETED', { amount: undefined })],
    ['different amount', providerPayload('COMPLETED', { amount: { value: '9.99', currency_code: 'USD' } })],
    ['negative amount', providerPayload('COMPLETED', { amount: { value: '-10.00', currency_code: 'USD' } })],
    ['fractional sub-cent', providerPayload('COMPLETED', { amount: { value: '10.001', currency_code: 'USD' } })],
    ['wrong currency', providerPayload('COMPLETED', { amount: { value: '10.00', currency_code: 'EUR' } })],
    ['legacy sale shape', { id: 'REFUND-123', state: 'COMPLETED', amount: { total: '10.00', currency: 'USD' } }],
    ['terminal partial result', { id: 'REFUND-123', status: 'FAILED' }],
    ...INVALID_PROVIDER_IDS.map(([label, id]) => [
      `non-canonical provider id: ${label}`,
      providerPayload('COMPLETED', { id }),
    ] as [string, unknown]),
  ])('does not record malformed provider outcome: %s', async (_label, payload) => {
    mockProvider(payload);
    const response = await post();
    expect(response.status).toBe(502);
    expect(mock.rpc).toHaveBeenCalledTimes(1);
  });

  it('rejects a poll result whose refund ID differs from the frozen pending ID', async () => {
    configureRpc({ prepare: { data: stateAttempt('pending', 'poll'), error: null } });
    mockProvider(providerPayload('COMPLETED', { id: 'OTHER-REFUND' }), true, 200);
    const response = await post();
    expect(response.status).toBe(502);
    expect(mock.rpc).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['record error after completed', providerPayload('COMPLETED'), {
      data: null,
      error: { code: 'XX000', message: 'save failed' },
    }, 'LOCAL_FINALIZATION_PENDING'],
    ['record error after pending', providerPayload('PENDING'), {
      data: null,
      error: { code: 'XX000', message: 'save failed' },
    }, 'REFUND_STATE_SAVE_FAILED'],
    ['wrong attempt returned', providerPayload('COMPLETED'), {
      data: stateAttempt('provider_completed', 'finalize', {
        attempt_id: '123e4567-e89b-42d3-a456-426614174999',
        request_id: '123e4567-e89b-42d3-a456-426614174999',
      }),
      error: null,
    }, 'LOCAL_FINALIZATION_PENDING'],
    ['different frozen actor returned', providerPayload('COMPLETED'), {
      data: stateAttempt('provider_completed', 'finalize', { actor_id: SECOND_ACTOR_ID }),
      error: null,
    }, 'LOCAL_FINALIZATION_PENDING'],
    ['different terminal refund id after pending', providerPayload('PENDING'), {
      data: stateAttempt('failed', 'none', { paypal_refund_id: 'OTHER-REFUND' }),
      error: null,
    }, 'REFUND_STATE_SAVE_FAILED'],
    ['disallowed downgrade', providerPayload('COMPLETED'), {
      data: stateAttempt('pending', 'poll'),
      error: null,
    }, 'LOCAL_FINALIZATION_PENDING'],
  ])('fails closed on %s', async (_label, payload, record, code) => {
    configureRpc({ record: record as RpcResult });
    mockProvider(payload);
    const response = await post();
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ code });
    expect(mock.rpc).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['provider_completed', stateAttempt('provider_completed', 'finalize'), 3, 200],
    ['completed', stateAttempt('completed', 'none'), 2, 200],
    ['failed', stateAttempt('failed', 'none', { paypal_refund_id: 'REFUND-123' }), 2, 422],
    ['cancelled', stateAttempt('cancelled', 'none', { paypal_refund_id: 'REFUND-123' }), 2, 422],
  ])('accepts monotonic PENDING record successor %s', async (_label, recorded, calls, httpStatus) => {
    configureRpc({ record: { data: recorded, error: null } });
    mockProvider(providerPayload('PENDING'));
    const response = await post();
    expect(response.status).toBe(httpStatus);
    expect(mock.rpc).toHaveBeenCalledTimes(calls);
  });

  it.each(['failed', 'cancelled'] as const)(
    'accepts an authoritative null-tuple %s that wins a concurrent PENDING record',
    async (status) => {
      configureRpc({
        record: {
          data: stateAttempt(status, 'none', { paypal_refund_id: null }),
          error: null,
        },
      });
      mockProvider(providerPayload('PENDING'));

      const response = await post();

      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({
        status,
        code: status === 'failed' ? 'PROVIDER_FAILED' : 'PROVIDER_CANCELLED',
      });
      expect(mock.rpc).toHaveBeenCalledTimes(2);
    },
  );

  it('accepts a concurrent completed successor while recording COMPLETED', async () => {
    configureRpc({ record: { data: stateAttempt('completed', 'none'), error: null } });
    mockProvider(providerPayload('COMPLETED'));
    const response = await post();
    expect(response.status).toBe(200);
    expect(mock.rpc).toHaveBeenCalledTimes(2);
  });

  it('recovers a prepared replay after PayPal acceptance, local crash, and webhook-first terminalization', async () => {
    let prepareCalls = 0;
    mock.rpc.mockImplementation(async (name: string) => {
      if (name === 'commerce_prepare_admin_refund') {
        prepareCalls += 1;
        return { data: attempt({ reason: 'Frozen reason' }), error: null };
      }
      if (name === 'commerce_record_admin_refund_outcome') {
        return {
          data: stateAttempt('provider_completed', 'finalize', { reason: 'Frozen reason' }),
          error: null,
        };
      }
      if (name === 'commerce_finalize_admin_refund') {
        // The webhook has already applied the terminal payment evidence and
        // local cleanup may already have raced this request. Finalization must
        // accept only the exact zero-effect idempotent replay.
        return {
          data: finalized({
            already_refunded: true,
            entitlements_changed: 0,
            licenses_changed: 0,
            sessions_changed: 0,
          }),
          error: null,
        };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue(providerPayload('COMPLETED')),
      });
    vi.stubGlobal('fetch', fetchMock);

    const first = await post({ reason: 'First caller reason' });
    const second = await post({ reason: 'Changed caller reason' });
    expect(first.status).toBe(502);
    await expect(first.json()).resolves.toMatchObject({
      status: 'unconfirmed',
      code: 'PROVIDER_REQUEST_UNCONFIRMED',
    });
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toEqual({ success: true, status: 'completed' });
    expect(prepareCalls).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.headers['PayPal-Request-Id']).toBe(ATTEMPT_ID);
      expect(init.body).toBe(JSON.stringify({
        amount: { value: '10.00', currency_code: 'USD' },
        note_to_payer: 'Frozen reason',
      }));
    }
    expect(mock.rpc).toHaveBeenNthCalledWith(3, 'commerce_record_admin_refund_outcome', {
      p_attempt_id: ATTEMPT_ID,
      p_guild_id: GUILD_ID,
      p_provider_status: 'COMPLETED',
      p_paypal_refund_id: 'REFUND-123',
      p_refund_amount_cents: 1_000,
      p_currency: 'USD',
    });
    expect(mock.rpc).toHaveBeenNthCalledWith(4, 'commerce_finalize_admin_refund', {
      p_attempt_id: ATTEMPT_ID,
      p_guild_id: GUILD_ID,
    });
  });

  it.each([
    [
      'a non-ok PayPal replay response',
      { ok: false, status: 503, json: vi.fn() },
    ],
    [
      'a PayPal replay response whose amount identity differs from the frozen attempt',
      {
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue(providerPayload('COMPLETED', {
          amount: { value: '9.99', currency_code: 'USD' },
        })),
      },
    ],
  ])('keeps the prepared crash replay unconfirmed after %s', async (
    _label,
    providerResponse,
  ) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(providerResponse));

    const response = await post({ reason: 'Changed caller reason' });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      status: 'unconfirmed',
      code: 'PROVIDER_REQUEST_UNCONFIRMED',
    });
    expect(mock.rpc).toHaveBeenCalledTimes(1);
    expect(mock.rpc).toHaveBeenNthCalledWith(
      1,
      'commerce_prepare_admin_refund',
      expect.any(Object),
    );
  });

  it('returns provider_completed when local finalization fails after PayPal completion', async () => {
    configureRpc({
      finalize: { data: null, error: { code: 'XX000', message: 'temporary' } },
    });
    mockProvider();
    const response = await post();
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      status: 'provider_completed',
      code: 'LOCAL_FINALIZATION_PENDING',
    });
  });

  it.each([
    ['null result', null],
    ['wrong order', finalized({ order_id: 'other' })],
    ['wrong attempt', finalized({ attempt_id: '123e4567-e89b-42d3-a456-426614174999' })],
    ['wrong status', finalized({ status: 'provider_completed' })],
    ['wrong order status', finalized({ order_status: 'completed' })],
    ['missing replay marker', { ...finalized(), already_refunded: undefined }],
    ['missing counter', { ...finalized(), sessions_changed: undefined }],
    ['negative counter', finalized({ entitlements_changed: -1 })],
    ['fractional counter', finalized({ entitlements_changed: 1.5 })],
    ['replay with repeated effects', finalized({ already_refunded: true })],
    ['wrong refund ID', finalized({ paypal_refund_id: 'OTHER' })],
  ])('fails closed on malformed local finalization: %s', async (_label, data) => {
    configureRpc({ finalize: { data, error: null } });
    mockProvider();
    const response = await post();
    expect(response.status).toBe(500);
  });

  it('accepts an exact concurrent finalization replay with zero repeated effects', async () => {
    configureRpc({
      finalize: {
        data: finalized({
          already_refunded: true,
          entitlements_changed: 0,
          licenses_changed: 0,
          sessions_changed: 0,
        }),
        error: null,
      },
    });
    mockProvider();
    const response = await post();
    expect(response.status).toBe(200);
  });
});
