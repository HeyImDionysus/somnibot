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
  vi.clearAllMocks();
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
  it('refuses to process when no webhook ID is configured', async () => {
    delete process.env.PAYPAL_WEBHOOK_ID;
    mockSavedPayPalSettings([]);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { verifyWebhookSignature } = await import('@/app/api/paypal/webhook/verify');
    const verified = await verifyWebhookSignature(
      new Request('http://localhost/api/paypal/webhook') as never,
      JSON.stringify({ id: 'EVT-1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: {} }),
    );

    expect(verified).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith('[Webhook] PAYPAL_WEBHOOK_ID is not configured — refusing to process');
    errorSpy.mockRestore();
  });
});
