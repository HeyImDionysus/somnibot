/**
 * Tests for shared PayPal utility module.
 *
 * Verifies token fetch with correct auth headers, error handling,
 * and timeout configuration.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));

import { createAdminSupabase } from '@/lib/supabase/admin';

const mockFetch = vi.fn();
const originalEnv = { ...process.env };

function mockSavedPayPalSettings(settings: { key: string; value: string }[]) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ data: settings }),
  };
  (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue({
    from: vi.fn().mockReturnValue(chain),
  });
  return chain;
}

beforeEach(() => {
  vi.resetAllMocks();
  process.env = { ...originalEnv };
  vi.stubGlobal('fetch', mockFetch);
  process.env.PAYPAL_API_BASE = 'https://api-m.sandbox.paypal.com';
  process.env.PAYPAL_CLIENT_ID = 'test-client-id';
  process.env.PAYPAL_CLIENT_SECRET = '<<mock>>';
  mockSavedPayPalSettings([]);
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('getPayPalToken', () => {
  it('fetches a token with correct credentials', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ access_token: 'tok_abc123' }),
    });

    const { getPayPalToken } = await import('@/lib/paypal');
    const token = await getPayPalToken();

    expect(token).toBe('tok_abc123');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('/v1/oauth2/token');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(opts.headers.Authorization).toMatch(/^Basic /);
    expect(opts.body).toBe('grant_type=client_credentials');
  });

  it('uses saved PayPal settings when env credentials are absent', async () => {
    delete process.env.PAYPAL_API_BASE;
    delete process.env.PAYPAL_CLIENT_ID;
    delete process.env.PAYPAL_CLIENT_SECRET;
    delete process.env.PAYPAL_SANDBOX;
    mockSavedPayPalSettings([
      { key: 'paypal_client_id', value: 'saved-client-id' },
      { key: 'paypal_client_secret', value: 'saved-client-secret' },
      { key: 'paypal_sandbox', value: 'false' },
    ]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ access_token: 'tok_saved' }),
    });

    const { getPayPalToken } = await import('@/lib/paypal');
    const token = await getPayPalToken();

    expect(token).toBe('tok_saved');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api-m.paypal.com/v1/oauth2/token',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: `Basic ${Buffer.from('saved-client-id:saved-client-secret').toString('base64')}`,
        }),
      }),
    );
  });

  it('returns null when response is not ok', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
    });

    const { getPayPalToken } = await import('@/lib/paypal');
    const token = await getPayPalToken();
    expect(token).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const { getPayPalToken } = await import('@/lib/paypal');
    const token = await getPayPalToken();
    expect(token).toBeNull();
  });
});

describe('getPayPalTokenResult', () => {
  it('classifies a 5xx from the token endpoint as retriable', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });

    const { getPayPalTokenResult } = await import('@/lib/paypal');
    const result = await getPayPalTokenResult();

    expect(result).toEqual({ ok: false, retriable: true, reason: 'token endpoint returned 503' });
  });

  it('classifies rejected credentials (401) as non-retriable', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });

    const { getPayPalTokenResult } = await import('@/lib/paypal');
    const result = await getPayPalTokenResult();

    expect(result).toEqual({ ok: false, retriable: false, reason: 'token endpoint returned 401' });
  });

  it('classifies a network error as retriable without leaking credentials', async () => {
    mockFetch.mockRejectedValueOnce(new Error('socket hang up'));

    const { getPayPalTokenResult } = await import('@/lib/paypal');
    const result = await getPayPalTokenResult();

    expect(result).toMatchObject({ ok: false, retriable: true });
    const reason = (result as { reason: string }).reason;
    expect(reason).toContain('socket hang up');
    expect(reason).not.toContain('<<mock>>');
  });

  it('classifies missing credentials as non-retriable without any fetch', async () => {
    delete process.env.PAYPAL_CLIENT_ID;
    delete process.env.PAYPAL_CLIENT_SECRET;
    mockSavedPayPalSettings([]);

    const { getPayPalTokenResult } = await import('@/lib/paypal');
    const result = await getPayPalTokenResult();

    expect(result).toMatchObject({ ok: false, retriable: false });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns the token on success', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ access_token: 'tok_result' }),
    });

    const { getPayPalTokenResult } = await import('@/lib/paypal');
    await expect(getPayPalTokenResult()).resolves.toEqual({ ok: true, token: 'tok_result' });
  });
});

describe('getSubscriptionAmount', () => {
  it('returns the exact provider plan, amount, and normalized currency', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ access_token: 'tok_subscription' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          plan_id: 'P-PROVIDER-PLAN-1',
          billing_info: {
            last_payment: { amount: { value: '10.25', currency_code: 'eur' } },
            next_billing_time: '2026-08-29T00:00:00.000Z',
          },
        }),
      });

    const { getSubscriptionAmount } = await import('@/lib/paypal');
    await expect(getSubscriptionAmount('I-SUBSCRIPTION-1')).resolves.toEqual({
      amountCents: 1_025,
      currency: 'EUR',
      planId: 'P-PROVIDER-PLAN-1',
      nextBillingTime: '2026-08-29T00:00:00.000Z',
    });
  });

  it.each(['10.00junk', '1.001'])(
    'rejects a non-exact provider amount of %s',
    async (value) => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ access_token: 'tok_subscription' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            plan_id: 'P-PROVIDER-PLAN-1',
            billing_info: {
              last_payment: { amount: { value, currency_code: 'USD' } },
            },
          }),
        });

      const { getSubscriptionAmount } = await import('@/lib/paypal');
      await expect(getSubscriptionAmount('I-SUBSCRIPTION-1')).resolves.toBeNull();
    },
  );
});

describe('PAYPAL_API_BASE', () => {
  it('exports the API base URL', async () => {
    const { PAYPAL_API_BASE } = await import('@/lib/paypal');
    expect(PAYPAL_API_BASE).toBe('https://api-m.sandbox.paypal.com');
  });
});

describe('getPayPalWebhookId', () => {
  it('loads the webhook ID from saved settings when env is absent', async () => {
    delete process.env.PAYPAL_WEBHOOK_ID;
    mockSavedPayPalSettings([
      { key: 'paypal_webhook_id', value: 'WH-SAVED' },
    ]);

    const { getPayPalWebhookId } = await import('@/lib/paypal');
    await expect(getPayPalWebhookId()).resolves.toBe('WH-SAVED');
  });
});

describe('verifyWebhookSignature', () => {
  it('rejects missing PayPal signature headers before config or token lookup', async () => {
    process.env.PAYPAL_WEBHOOK_ID = 'test-webhook-id';
    process.env.PAYPAL_WEBHOOK_URL = 'http://localhost/api/paypal/webhook';
    process.env.PAYPAL_SANDBOX = 'true';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { verifyWebhookSignature } = await import('@/app/api/paypal/webhook/verify');
    const verified = await verifyWebhookSignature(
      new Request('http://localhost/api/paypal/webhook') as never,
      JSON.stringify({ id: 'EVT-1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: {} }),
    );

    expect(verified).toEqual({ outcome: 'invalid' });
    expect(createAdminSupabase).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith('[Webhook] PayPal signature headers are missing — refusing to process');
    errorSpy.mockRestore();
  });

  it('refuses to process when no webhook ID is configured', async () => {
    delete process.env.PAYPAL_WEBHOOK_ID;
    mockSavedPayPalSettings([]);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { verifyWebhookSignature } = await import('@/app/api/paypal/webhook/verify');
    const verified = await verifyWebhookSignature(
      new Request('http://localhost/api/paypal/webhook', {
        headers: {
          'paypal-auth-algo': 'SHA256withRSA',
          'paypal-cert-url': 'https://example.com/cert',
          'paypal-transmission-id': 'transmission-1',
          'paypal-transmission-sig': 'sig-1',
          'paypal-transmission-time': new Date().toISOString(),
        },
      }) as never,
      JSON.stringify({ id: 'EVT-1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: {} }),
    );

    expect(verified).toEqual({ outcome: 'invalid' });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith('[Webhook] PAYPAL_WEBHOOK_ID is not configured — refusing to process');
    errorSpy.mockRestore();
  });
});
