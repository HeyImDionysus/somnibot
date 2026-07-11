/**
 * Tests for POST /api/orders/[id]/refund — commerce critical path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn() }));
vi.mock('@/lib/paypal', () => ({
  getPayPalRuntimeConfig: vi.fn().mockResolvedValue({
    apiBase: 'https://api.sandbox.paypal.com',
  }),
  getPayPalToken: vi.fn(),
  PAYPAL_API_BASE: 'https://api.sandbox.paypal.com',
}));

import { POST } from '@/app/api/orders/[id]/refund/route';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { getPayPalToken } from '@/lib/paypal';

import {
  createMockSupabase,
  buildRequest,
  mockAuthSuccess,
  mockAuthUnauthorized,
  mockRateLimited,
  mockRateLimitPass,
  registerTable,
} from './helpers';

const mock = createMockSupabase();
const refundReq = (body: Record<string, unknown> = {}) =>
  buildRequest('/api/orders/order-123/refund', { method: 'POST', body });
const params = Promise.resolve({ id: 'order-123' });
const consoleErrorSpies: Array<{ mockRestore: () => void }> = [];

function silenceConsoleError() {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  consoleErrorSpies.push(spy);
  return spy;
}

beforeEach(() => {
  vi.clearAllMocks();
  (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mock);
  mockRateLimitPass(checkAdminRateLimit as ReturnType<typeof vi.fn>);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const spy of consoleErrorSpies.splice(0)) spy.mockRestore();
});

describe('POST /api/orders/[id]/refund', () => {
  it('returns 429 when rate limited', async () => {
    mockRateLimited(checkAdminRateLimit as ReturnType<typeof vi.fn>);

    const res = await POST(refundReq(), { params });
    expect(res.status).toBe(429);
    expect(checkAdminRateLimit).toHaveBeenCalledWith(expect.anything(), 'write');
  });

  it('returns 401 when not authenticated', async () => {
    mockAuthUnauthorized(requireGuildOwner as ReturnType<typeof vi.fn>);

    const res = await POST(refundReq(), { params });
    expect(res.status).toBe(401);
  });

  it('returns 404 when order not found', async () => {
    mockAuthSuccess(requireGuildOwner as ReturnType<typeof vi.fn>);
    mock._query.single.mockResolvedValue({ data: null });

    const res = await POST(refundReq({ reason: 'test' }), { params });
    expect(res.status).toBe(404);
  });

  it('returns 400 when order already refunded', async () => {
    mockAuthSuccess(requireGuildOwner as ReturnType<typeof vi.fn>);
    mock._query.single.mockResolvedValue({
      data: { id: 'order-123', status: 'refunded', guild_id: 'guild-123', payments: [] },
    });

    const res = await POST(refundReq({ reason: 'dup' }), { params });
    expect(res.status).toBe(400);
  });

  it('relies on the entitlement trigger instead of inserting a legacy role queue row', async () => {
    mockAuthSuccess(requireGuildOwner as ReturnType<typeof vi.fn>, { guildId: 'guild-1' });
    mock._query.single.mockResolvedValue({
      data: {
        id: 'order-123',
        status: 'completed',
        guild_id: 'guild-1',
        amount_cents: 1_000,
        payments: [],
      },
    });

    const res = await POST(refundReq({ reason: 'requested' }), { params });

    expect(res.status).toBe(200);
    expect(mock.from).not.toHaveBeenCalledWith('bot_action_queue');
    expect(mock._query.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'expired' }),
    );
  });

  it('fails closed before changing the order or license keys when entitlement revocation fails', async () => {
    mockAuthSuccess(requireGuildOwner as ReturnType<typeof vi.fn>, { guildId: 'guild-1' });
    const orders = registerTable(mock, 'orders');
    const entitlements = registerTable(mock, 'entitlements');
    const licenseKeys = registerTable(mock, 'license_keys');
    const auditLogs = registerTable(mock, 'audit_logs');
    orders.single.mockResolvedValue({
      data: {
        id: 'order-123',
        status: 'completed',
        guild_id: 'guild-1',
        amount_cents: 1_000,
        payments: [],
      },
      error: null,
    });
    entitlements.select.mockResolvedValue({
      data: null,
      error: { message: 'trigger rejected revocation' },
    });
    const consoleError = silenceConsoleError();

    const res = await POST(refundReq({ reason: 'requested' }), { params });

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      success: false,
      error: 'Refund could not be finalized. Please retry.',
    });
    expect(consoleError).toHaveBeenCalledWith(
      '[Commerce] Failed to persist entitlement revocation for refund:',
      expect.objectContaining({
        orderId: 'order-123',
        guildId: 'guild-1',
        error: 'trigger rejected revocation',
      }),
    );
    expect(orders.update).not.toHaveBeenCalled();
    expect(licenseKeys.update).not.toHaveBeenCalled();
    expect(auditLogs.insert).not.toHaveBeenCalled();
  });

  it('reports a failed terminal order write without continuing to license revocation', async () => {
    mockAuthSuccess(requireGuildOwner as ReturnType<typeof vi.fn>, { guildId: 'guild-1' });
    const orders = registerTable(mock, 'orders');
    const entitlements = registerTable(mock, 'entitlements');
    const licenseKeys = registerTable(mock, 'license_keys');
    const auditLogs = registerTable(mock, 'audit_logs');
    orders.single.mockResolvedValue({
      data: {
        id: 'order-123',
        status: 'completed',
        guild_id: 'guild-1',
        amount_cents: 1_000,
        payments: [],
      },
      error: null,
    });
    orders.eq
      .mockReturnValueOnce(orders)
      .mockReturnValueOnce(orders)
      .mockReturnValueOnce(orders)
      .mockResolvedValueOnce({ data: null, error: { message: 'order update failed' } });
    entitlements.select.mockResolvedValue({
      data: [{ id: 'entitlement-1' }],
      error: null,
    });
    const consoleError = silenceConsoleError();

    const res = await POST(refundReq({ reason: 'requested' }), { params });

    expect(res.status).toBe(500);
    expect(consoleError).toHaveBeenCalledWith(
      '[Commerce] Failed to persist refunded order status:',
      expect.objectContaining({
        orderId: 'order-123',
        guildId: 'guild-1',
        error: 'order update failed',
      }),
    );
    expect(entitlements.update.mock.invocationCallOrder[0]).toBeLessThan(
      orders.update.mock.invocationCallOrder[0],
    );
    expect(licenseKeys.update).not.toHaveBeenCalled();
    expect(auditLogs.insert).not.toHaveBeenCalled();
  });

  it('uses one stable PayPal idempotency key while retrying a failed local revocation', async () => {
    mockAuthSuccess(requireGuildOwner as ReturnType<typeof vi.fn>, { guildId: 'guild-1' });
    const orderId = '123e4567-e89b-12d3-a456-426614174000';
    const refundParams = Promise.resolve({ id: orderId });
    const orders = registerTable(mock, 'orders');
    const entitlements = registerTable(mock, 'entitlements');
    const licenseKeys = registerTable(mock, 'license_keys');
    orders.single.mockResolvedValue({
      data: {
        id: orderId,
        status: 'completed',
        guild_id: 'guild-1',
        amount_cents: 1_000,
        payments: [{ paypal_payment_id: 'CAPTURE-123' }],
      },
      error: null,
    });
    entitlements.select
      .mockResolvedValueOnce({
        data: null,
        error: { message: 'temporary trigger failure' },
      })
      .mockResolvedValueOnce({
        data: [{ id: 'entitlement-1' }],
        error: null,
      });
    (getPayPalToken as ReturnType<typeof vi.fn>).mockResolvedValue('paypal-token');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    silenceConsoleError();

    const first = await POST(refundReq({ reason: 'requested' }), { params: refundParams });
    const second = await POST(refundReq({ reason: 'requested' }), { params: refundParams });

    expect(first.status).toBe(500);
    expect(second.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toEqual(expect.objectContaining({
        headers: expect.objectContaining({ 'PayPal-Request-Id': orderId }),
      }));
    }
    expect(fetchMock.mock.invocationCallOrder[1]).toBeLessThan(
      entitlements.update.mock.invocationCallOrder[1],
    );
    expect(entitlements.update.mock.invocationCallOrder[1]).toBeLessThan(
      orders.update.mock.invocationCallOrder[0],
    );
    expect(orders.update.mock.invocationCallOrder[0]).toBeLessThan(
      licenseKeys.update.mock.invocationCallOrder[0],
    );
    expect(orders.update).toHaveBeenCalledTimes(1);
    expect(licenseKeys.update).toHaveBeenCalledTimes(1);
  });
});
