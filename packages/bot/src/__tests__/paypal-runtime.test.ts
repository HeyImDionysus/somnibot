import { describe, expect, it } from 'vitest';
import { resolveGuildPayPalRuntime } from '../services/paypal-runtime.js';

function supabaseFor(data: { paypal_environment?: unknown } | null, error: { message?: string } | null = null) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data, error }) }),
      }),
    }),
  } as never;
}

describe('resolveGuildPayPalRuntime', () => {
  it('defaults missing policy rows to sandbox', async () => {
    const runtime = await resolveGuildPayPalRuntime(
      supabaseFor(null),
      'guild-1',
      { PAYPAL_CLIENT_ID: 'sandbox-id', PAYPAL_CLIENT_SECRET: 'sandbox-secret', PAYPAL_SANDBOX: 'true' },
    );
    expect(runtime.environment).toBe('sandbox');
    expect(runtime.apiBase).toBe('https://api-m.sandbox.paypal.com');
    expect(runtime.configured).toBe(true);
  });

  it('selects live only for an explicit guild policy', async () => {
    const runtime = await resolveGuildPayPalRuntime(
      supabaseFor({ paypal_environment: 'live' }),
      'guild-1',
      { PAYPAL_CLIENT_ID: 'live-id', PAYPAL_CLIENT_SECRET: 'live-secret', PAYPAL_SANDBOX: 'false' },
    );
    expect(runtime.environment).toBe('live');
    expect(runtime.apiBase).toBe('https://api-m.paypal.com');
    expect(runtime.configured).toBe(true);
  });

  it('refuses a live call when only sandbox credentials are marked', async () => {
    const runtime = await resolveGuildPayPalRuntime(
      supabaseFor({ paypal_environment: 'live' }),
      'guild-1',
      { PAYPAL_CLIENT_ID: 'sandbox-id', PAYPAL_CLIENT_SECRET: 'sandbox-secret', PAYPAL_SANDBOX: 'true' },
    );
    expect(runtime.environment).toBe('live');
    expect(runtime.configured).toBe(false);
  });

  it('falls back to sandbox when the policy read fails', async () => {
    const runtime = await resolveGuildPayPalRuntime(
      supabaseFor({ paypal_environment: 'live' }, { message: 'database unavailable' }),
      'guild-1',
      { PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret', PAYPAL_SANDBOX: 'false' },
    );
    expect(runtime.environment).toBe('sandbox');
    expect(runtime.apiBase).toBe('https://api-m.sandbox.paypal.com');
  });
});
