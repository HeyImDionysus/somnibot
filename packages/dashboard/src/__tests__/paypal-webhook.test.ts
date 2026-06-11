/**
 * Tests for POST /api/paypal/webhook — PayPal webhook handler.
 * V7 Audit §13.P2a: Critical payment path coverage.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { replaySecret } = vi.hoisted(() => {
  const secret = 'test-webhook-replay-secret';
  process.env.NEXTAUTH_SECRET = 'test-secret-for-webhook-tests';
  process.env.WEBHOOK_REPLAY_SECRET = secret;
  process.env.PAYPAL_WEBHOOK_ID = 'test-webhook-id';
  return { replaySecret: secret };
});

// Mock dependencies before importing route
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/paypal', () => ({
  getPayPalRuntimeConfig: vi.fn().mockResolvedValue({
    apiBase: 'https://api-m.sandbox.paypal.com',
    webhookId: 'test-webhook-id',
  }),
  getPayPalToken: vi.fn().mockResolvedValue('test-token'),
  getPayPalWebhookId: vi.fn().mockResolvedValue('test-webhook-id'),
  PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
}));
vi.mock('@/lib/api/rate-limit', () => ({
  rateLimits: {
    paypalWebhook: vi.fn().mockResolvedValue({ limited: false, remaining: 1, retryAfterMs: 0 }),
  },
}));

import { POST } from '@/app/api/paypal/webhook/route';
import { createAdminSupabase } from '@/lib/supabase/admin';

const mockFrom = vi.fn();
const mockRpc = vi.fn();
const mockSupabase = { from: mockFrom, rpc: mockRpc };

function mockUpsertSuccess() {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: null }),
    single: vi.fn().mockResolvedValue({ data: null }),
    insert: vi.fn().mockResolvedValue({ error: null }),
    upsert: vi.fn().mockResolvedValue({ data: [{ event_id: 'EVT-1' }], error: null }),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
  };
  mockFrom.mockReturnValue(chain);
  return chain;
}

function makeWebhookRequest(body: unknown, headers?: Record<string, string>) {
  return new Request('http://localhost/api/paypal/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(headers ?? {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function makeReplayRequest(body: unknown) {
  return makeWebhookRequest(body, { 'x-replay-secret': replaySecret });
}

beforeEach(() => {
  vi.clearAllMocks();
  (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mockSupabase);
});

describe('POST /api/paypal/webhook', () => {
  it('returns 400 for invalid JSON', async () => {
    const req = new Request('http://localhost/api/paypal/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-replay-secret': replaySecret,
      },
      body: 'not-json{{{',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/JSON/i);
  });

  it('returns 400 for missing event_type (Zod validation)', async () => {
    const req = makeReplayRequest({ resource: {}, id: 'EVT-1' });
    const res = await POST(req as never);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/payload/i);
  });

  it('returns 400 for missing resource (Zod validation)', async () => {
    const req = makeReplayRequest({ event_type: 'PAYMENT.CAPTURE.COMPLETED' });
    const res = await POST(req as never);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/payload/i);
  });

  it('accepts valid replay with correct secret', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockUpsertSuccess();

    const req = makeReplayRequest({
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: {
        id: 'CAP-123',
        custom_id: JSON.stringify({
          customer_id: 'customer-1',
          product_id: 'product-1',
          guild_id: 'guild-1',
          discord_id: 'discord-1',
        }),
        amount: { value: '10.00', currency_code: 'USD' },
      },
      id: 'EVT-REPLAY-1',
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expect(logSpy).toHaveBeenCalledWith('[Webhook] No pending order found for payment');
    logSpy.mockRestore();
  });

  it('rejects replay with wrong secret', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // No replay secret, no PayPal signature headers → should fail signature check
    // We mock fetch globally for the PayPal verification call to return failure
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ verification_status: 'FAILURE' }), { status: 200 }),
    );

    try {
      const req = makeWebhookRequest(
        {
          event_type: 'PAYMENT.CAPTURE.COMPLETED',
          resource: { id: 'CAP-123' },
          id: 'EVT-2',
        },
        {
          'paypal-auth-algo': 'SHA256withRSA',
          'paypal-cert-url': 'https://example.com/cert',
          'paypal-transmission-id': 'trans-1',
          'paypal-transmission-sig': 'bad-sig',
          'paypal-transmission-time': new Date().toISOString(),
        },
      );

      const res = await POST(req as never);
      expect(res.status).toBe(401);
      expect(errorSpy).toHaveBeenCalledWith('[Webhook] Signature verification failed');
    } finally {
      global.fetch = originalFetch;
      errorSpy.mockRestore();
    }
  });

  it('processes unhandled event types gracefully via replay', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockUpsertSuccess();

    const req = makeReplayRequest({
      event_type: 'BILLING.SUBSCRIPTION.UNKNOWN_EVENT',
      resource: { id: 'SUB-123' },
      id: 'EVT-UNKNOWN',
    });

    const res = await POST(req as never);
    // Should not crash — handled by default switch case
    expect(res.status).toBe(200);
    expect(logSpy).toHaveBeenCalledWith('[Webhook] Unhandled event: BILLING.SUBSCRIPTION.UNKNOWN_EVENT');
    logSpy.mockRestore();
  });
});
