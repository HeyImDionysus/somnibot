import { describe, expect, it, vi } from 'vitest';
import { requestOrderRefund } from '@/lib/api/order-refund-client';

function response(ok: boolean, status: number, body: unknown, jsonRejects = false) {
  return {
    ok,
    status,
    json: jsonRejects
      ? vi.fn().mockRejectedValue(new SyntaxError('invalid JSON'))
      : vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe('requestOrderRefund', () => {
  it('sends the explicit revocation contract with CSRF protection', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(true, 200, {
      success: true,
      status: 'completed',
    }));
    await expect(requestOrderRefund(
      'order/with separator',
      { 'X-CSRF-Token': 'csrf-token' },
      fetchMock,
    )).resolves.toEqual({ ok: true, status: 'completed', message: null });
    expect(fetchMock).toHaveBeenCalledWith('/api/orders/order%2Fwith%20separator/refund', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'X-CSRF-Token': 'csrf-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ revoke_entitlements: true }),
    });
  });

  it('returns an exact pending outcome only for HTTP 202 plus a clear message', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(true, 202, {
      success: true,
      status: 'pending',
      message: 'PayPal is still processing.',
    }));
    await expect(requestOrderRefund('order-1', {}, fetchMock)).resolves.toEqual({
      ok: true,
      status: 'pending',
      message: 'PayPal is still processing.',
    });
  });

  it.each([
    ['pending with 200', true, 200, { success: true, status: 'pending', message: 'wait' }],
    ['pending without message', true, 202, { success: true, status: 'pending' }],
    ['completed with 202', true, 202, { success: true, status: 'completed' }],
    ['completed with 201', true, 201, { success: true, status: 'completed' }],
    ['unknown success state', true, 200, { success: true, status: 'provider_completed' }],
    ['negative success body', true, 200, { success: false, status: 'completed' }],
    ['non-2xx success body', false, 500, { success: true, status: 'completed' }],
  ])('fails closed for %s', async (_label, ok, status, body) => {
    const fetchMock = vi.fn().mockResolvedValue(response(ok, status, body));
    const result = await requestOrderRefund('order-1', {}, fetchMock);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.httpStatus).toBe(status);
  });

  it.each([
    [409, 'not_refundable', 'ORDER_NOT_REFUNDABLE', 'Refund unavailable'],
    [422, 'failed', 'PROVIDER_FAILED', 'Access remains active'],
    [422, 'cancelled', 'PROVIDER_CANCELLED', 'Access remains active'],
    [500, 'provider_completed', 'LOCAL_FINALIZATION_PENDING', 'Cleanup pending'],
    [500, 'preparation_failed', 'REFUND_PREPARATION_FAILED', 'Unexpected failure'],
    [502, 'unconfirmed', 'PROVIDER_REQUEST_UNCONFIRMED', 'Retry safely'],
  ])('preserves a structured %i error for honest UI handling', async (
    httpStatus,
    status,
    code,
    error,
  ) => {
    const fetchMock = vi.fn().mockResolvedValue(response(false, httpStatus, {
      success: false,
      status,
      code,
      error,
    }));
    await expect(requestOrderRefund('order-1', {}, fetchMock)).resolves.toEqual({
      ok: false,
      httpStatus,
      status,
      code,
      error,
    });
  });

  it.each([
    ['missing error fields', false, 500, {}, false, 'Refund request failed (500).'],
    ['blank fields', false, 409, { status: ' ', code: ' ', error: ' ' }, false, 'Refund request failed (409).'],
    ['invalid JSON', false, 502, null, true, 'Refund request failed (502).'],
  ])('uses a safe fallback for %s', async (_label, ok, status, body, rejects, error) => {
    const fetchMock = vi.fn().mockResolvedValue(response(ok, status, body, rejects));
    await expect(requestOrderRefund('order-1', {}, fetchMock)).resolves.toEqual({
      ok: false,
      httpStatus: status,
      status: null,
      code: null,
      error,
    });
  });

  it('returns a retryable network result when no HTTP outcome is known', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'));
    await expect(requestOrderRefund('order-1', {}, fetchMock)).resolves.toEqual({
      ok: false,
      httpStatus: null,
      status: null,
      code: 'NETWORK_ERROR',
      error: 'Refund request could not reach the server. Please retry.',
    });
  });
});
