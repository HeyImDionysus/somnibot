import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn() }));

import { POST } from '@/app/api/action-queue/route';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import {
  buildRequest,
  mockAuthSuccess,
  mockRateLimitPass,
} from './helpers';

const GUILD_ID = 'guild-1';
const DLQ_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_DLQ_ID = '22222222-2222-4222-8222-222222222222';
const THIRD_DLQ_ID = '33333333-3333-4333-8333-333333333333';
const ACTION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

type DbResult = { data: unknown; error: null | { message: string } };
type QueryChain = Record<string, ReturnType<typeof vi.fn>> & PromiseLike<DbResult>;

function thenableQuery(result: DbResult): QueryChain {
  const chain = {} as QueryChain;
  for (const method of ['select', 'eq', 'in', 'or', 'limit']) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  chain.then = (onfulfilled, onrejected) => Promise.resolve(result).then(onfulfilled, onrejected);
  return chain;
}

function exactDlq(
  action = 'reconcile_entitlement_roles',
  overrides: Record<string, unknown> = {},
) {
  return {
    id: DLQ_ID,
    guild_id: GUILD_ID,
    original_id: ACTION_ID,
    action,
    payload: action === 'reconcile_entitlement_roles'
      ? {
        mode: 'ensure_live_request',
        customer_id: 'customer-1',
        old_discord_id: '11111111111111111',
        discord_id: '22222222222222222',
      }
      : { order_id: '33333333-3333-4333-8333-333333333333' },
    lane: 'commerce',
    retried: false,
    ...overrides,
  };
}

function makeSupabase(input: {
  rows?: unknown[];
  recovery?: DbResult;
  genericRecovery?: DbResult;
} = {}) {
  const fetch = thenableQuery({ data: input.rows ?? [exactDlq()], error: null });
  const from = vi.fn().mockImplementation((table: string) => {
    if (table === 'action_queue_dlq') return fetch;
    throw new Error(`Unexpected table ${table}`);
  });
  const rpc = vi.fn().mockImplementation(async (name: string) => {
    if (name === 'commerce_retry_role_delivery_dlq') {
      return input.recovery ?? {
        data: [{
          action_id: ACTION_ID,
          action_status: 'pending',
          disposition: 'reopened',
        }],
        error: null,
      };
    }
    if (name === 'bot_action_queue_retry_dlq') {
      return input.genericRecovery ?? {
        data: [{
          action_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          action_status: 'pending',
          disposition: 'requeued',
        }],
        error: null,
      };
    }
    throw new Error(`Unexpected RPC ${name}`);
  });
  return { from, rpc, fetch };
}

function request(ids = [DLQ_ID]) {
  return buildRequest('/api/action-queue', {
    method: 'POST',
    body: { action: 'retry', ids },
  }) as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimitPass(checkAdminRateLimit as ReturnType<typeof vi.fn>);
  mockAuthSuccess(requireGuildOwner as ReturnType<typeof vi.fn>, { guildId: GUILD_ID });
});

describe('POST /api/action-queue exact carrier retry', () => {
  it.each([
    'fulfill_purchase',
    'fulfill_subscription',
    'reconcile_entitlement_roles',
  ])('reopens %s through the same-carrier RPC without cloning', async (action) => {
    const mock = makeSupabase({ rows: [exactDlq(action)] });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mock);

    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      retried: 1,
      operatorHeld: 0,
      failed: 0,
    });
    expect(mock.rpc).toHaveBeenCalledOnce();
    expect(mock.rpc).toHaveBeenCalledWith('commerce_retry_role_delivery_dlq', {
      p_dlq_id: DLQ_ID,
      p_guild_id: GUILD_ID,
    });
    expect(mock.from).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['already pending', 'pending', 'already_active'],
    ['already processing', 'processing', 'already_active'],
    ['completed evidence', 'completed', 'completed_from_evidence'],
  ])('accepts exact %s convergence as a successful request', async (_label, status, disposition) => {
    const mock = makeSupabase({
      recovery: {
        data: [{ action_id: ACTION_ID, action_status: status, disposition }],
        error: null,
      },
    });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mock);

    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true, retried: 1 });
    expect(mock.from).toHaveBeenCalledTimes(1);
  });

  it('reports operator-held evidence as a failed retry outcome without cloning', async () => {
    const mock = makeSupabase({
      recovery: {
        data: [{
          action_id: ACTION_ID,
          action_status: 'failed',
          disposition: 'operator_held',
        }],
        error: null,
      },
    });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mock);

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      retried: 0,
      operatorHeld: 1,
      failed: 0,
    });
    expect(mock.from).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['null', null],
    ['bare object', { action_id: ACTION_ID, action_status: 'pending', disposition: 'reopened' }],
    ['empty array', []],
    ['multiple rows', [
      { action_id: ACTION_ID, action_status: 'pending', disposition: 'reopened' },
      { action_id: ACTION_ID, action_status: 'pending', disposition: 'reopened' },
    ]],
    ['mismatched id', [{
      action_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      action_status: 'pending',
      disposition: 'reopened',
    }]],
    ['coercible disposition', [{
      action_id: ACTION_ID,
      action_status: 'pending',
      disposition: { toString: () => 'reopened' },
    }]],
    ['invalid tuple', [{
      action_id: ACTION_ID,
      action_status: 'completed',
      disposition: 'reopened',
    }]],
  ])('fails closed for malformed RPC output: %s', async (_label, data) => {
    const mock = makeSupabase({ recovery: { data, error: null } });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mock);

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      retried: 0,
      operatorHeld: 0,
      failed: 1,
    });
    expect(mock.from).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the exact-carrier recovery RPC errors', async () => {
    const mock = makeSupabase({
      recovery: { data: null, error: { message: 'database unavailable' } },
    });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mock);

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      retried: 0,
      operatorHeld: 0,
      failed: 1,
    });
  });

  it('counts unavailable ids without revealing whether they belong to another guild', async () => {
    const mock = makeSupabase({ rows: [exactDlq()] });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mock);

    const response = await POST(request([DLQ_ID, SECOND_DLQ_ID]));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      retried: 1,
      operatorHeld: 0,
      failed: 1,
    });
  });

  it.each([
    ['missing', []],
    ['wrong guild', [exactDlq('send_notification', { guild_id: 'guild-2' })]],
  ])('returns the same opaque failure for a %s id', async (_label, rows) => {
    const mock = makeSupabase({ rows });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mock);

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      retried: 0,
      operatorHeld: 0,
      failed: 1,
    });
    expect(mock.rpc).not.toHaveBeenCalled();
  });

  it('rejects duplicate ids before creating a database client', async () => {
    const response = await POST(request([DLQ_ID, DLQ_ID]));

    expect(response.status).toBe(400);
    expect(createAdminSupabase).not.toHaveBeenCalled();
  });

  it('rejects an over-limit batch before creating a database client', async () => {
    const ids = Array.from(
      { length: 1001 },
      (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    );

    const response = await POST(request(ids));

    expect(response.status).toBe(400);
    expect(createAdminSupabase).not.toHaveBeenCalled();
  });
});

describe('POST /api/action-queue generic atomic retry', () => {
  it('reports retry only after the atomic RPC creates one replacement', async () => {
    const row = exactDlq('send_notification');
    const mock = makeSupabase({ rows: [row] });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mock);

    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      retried: 1,
      operatorHeld: 0,
      failed: 0,
    });
    expect(mock.rpc).toHaveBeenCalledOnce();
    expect(mock.rpc).toHaveBeenCalledWith('bot_action_queue_retry_dlq', {
      p_dlq_id: DLQ_ID,
      p_guild_id: GUILD_ID,
    });
    expect(mock.fetch.eq).toHaveBeenCalledWith('guild_id', GUILD_ID);
    expect(mock.fetch.in).toHaveBeenCalledWith('id', [DLQ_ID]);
    expect(mock.fetch.or).toHaveBeenCalledWith('retried.eq.false,retried.is.null');
    expect(mock.from).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['reopened', 'pending', 'reopened'],
    ['already active while pending', 'pending', 'already_active'],
    ['already active while processing', 'processing', 'already_active'],
    ['already completed', 'completed', 'already_completed'],
  ] as const)(
    'reports exact noncommerce carrier convergence: %s',
    async (_label, actionStatus, disposition) => {
      const mock = makeSupabase({
        rows: [exactDlq('revoke_roles')],
        genericRecovery: {
          data: [{
            action_id: ACTION_ID,
            action_status: actionStatus,
            disposition,
          }],
          error: null,
        },
      });
      (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mock);

      const response = await POST(request());

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        success: true,
        retried: 1,
        operatorHeld: 0,
        failed: 0,
      });
      expect(mock.rpc).toHaveBeenCalledWith('bot_action_queue_retry_dlq', {
        p_dlq_id: DLQ_ID,
        p_guild_id: GUILD_ID,
      });
    },
  );

  it.each([
    ['reopened but processing', 'processing', 'reopened'],
    ['already active but completed', 'completed', 'already_active'],
    ['already completed but pending', 'pending', 'already_completed'],
  ] as const)(
    'fails closed for mismatched noncommerce convergence evidence: %s',
    async (_label, actionStatus, disposition) => {
      const mock = makeSupabase({
        rows: [exactDlq('revoke_roles')],
        genericRecovery: {
          data: [{ action_id: ACTION_ID, action_status: actionStatus, disposition }],
          error: null,
        },
      });
      (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mock);

      const response = await POST(request());

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        success: false,
        retried: 0,
        operatorHeld: 0,
        failed: 1,
      });
    },
  );

  it.each(['already_retried', 'exact_carrier_required', 'invalid_carrier'])(
    'does not claim success for atomic no-op disposition %s',
    async (disposition) => {
      const mock = makeSupabase({
        rows: [exactDlq('send_notification')],
        genericRecovery: {
          data: [{ action_id: null, action_status: null, disposition }],
          error: null,
        },
      });
      (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mock);

      const response = await POST(request());

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        success: false,
        retried: 0,
        operatorHeld: 0,
        failed: 1,
      });
      expect(mock.from).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['null', null],
    ['bare object', {
      action_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      action_status: 'pending',
      disposition: 'requeued',
    }],
    ['empty array', []],
    ['multiple rows', [
      {
        action_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        action_status: 'pending',
        disposition: 'requeued',
      },
      { action_id: null, action_status: null, disposition: 'already_retried' },
    ]],
    ['requeue without id', [{
      action_id: null,
      action_status: 'pending',
      disposition: 'requeued',
    }]],
    ['no-op with carrier fields', [{
      action_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      action_status: 'pending',
      disposition: 'already_retried',
    }]],
    ['coercible disposition', [{
      action_id: null,
      action_status: null,
      disposition: { toString: () => 'already_retried' },
    }]],
  ])('fails closed for malformed generic RPC output: %s', async (_label, data) => {
    const mock = makeSupabase({
      rows: [exactDlq('send_notification')],
      genericRecovery: { data, error: null },
    });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mock);

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      retried: 0,
      operatorHeld: 0,
      failed: 1,
    });
  });

  it('fails closed when the atomic generic RPC errors', async () => {
    const mock = makeSupabase({
      rows: [exactDlq('send_notification')],
      genericRecovery: { data: null, error: { message: 'database unavailable' } },
    });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mock);

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      retried: 0,
      operatorHeld: 0,
      failed: 1,
    });
  });

  it('reports mixed-batch partial truth without hiding no-op or unavailable ids', async () => {
    const mock = makeSupabase({
      rows: [
        exactDlq(),
        exactDlq('send_notification', {
          id: SECOND_DLQ_ID,
          original_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        }),
      ],
      genericRecovery: {
        data: [{ action_id: null, action_status: null, disposition: 'already_retried' }],
        error: null,
      },
    });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mock);

    const response = await POST(request([DLQ_ID, SECOND_DLQ_ID, THIRD_DLQ_ID]));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      retried: 1,
      operatorHeld: 0,
      failed: 2,
    });
    expect(mock.rpc).toHaveBeenCalledTimes(2);
    expect(mock.rpc).toHaveBeenCalledWith('commerce_retry_role_delivery_dlq', {
      p_dlq_id: DLQ_ID,
      p_guild_id: GUILD_ID,
    });
    expect(mock.rpc).toHaveBeenCalledWith('bot_action_queue_retry_dlq', {
      p_dlq_id: SECOND_DLQ_ID,
      p_guild_id: GUILD_ID,
    });
  });
});
