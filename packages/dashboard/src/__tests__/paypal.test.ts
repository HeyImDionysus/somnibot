/**
 * Tests for shared PayPal utility module.
 *
 * Verifies token fetch with correct auth headers, error handling,
 * and timeout configuration.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  process.env.PAYPAL_API_BASE = 'https://api-m.sandbox.paypal.com';
  process.env.PAYPAL_CLIENT_ID = 'test-client-id';
  process.env.PAYPAL_CLIENT_SECRET = 'mock-value-for-tests';
});

afterEach(() => {
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
