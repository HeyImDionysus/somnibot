/**
 * Tests for PayPal webhook signature verification resilience.
 *
 * W2 hardening: verification infrastructure failures (token fetch / verify
 * API timeout or 5xx) must be distinguished from an actually-invalid
 * signature. Infrastructure failures are retried 1-2 times inside a bounded
 * budget and, if still failing, the route responds 503 so PayPal redelivers
 * the webhook — instead of the previous behavior of responding 401, which
 * mislabeled an outage as a security rejection and risked losing real paid
 * orders. Repeated infra failures raise a deduped operator alert.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.hoisted(() => {
  process.env.NEXTAUTH_SECRET = 'test-secret-verify-resilience';
  process.env.WEBHOOK_REPLAY_SECRET = 'test-verify-resilience-replay-secret';
  process.env.PAYPAL_WEBHOOK_ID = 'test-webhook-id';
});

vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/rate-limit', () => ({
  rateLimits: {
    paypalWebhook: vi.fn().mockResolvedValue({ limited: false, remaining: 1, retryAfterMs: 0 }),
  },
}));

import {
  verifyWebhookSignature,
  raisePayPalVerifyUnavailableAlert,
} from '@/app/api/paypal/webhook/verify';
import { POST } from '@/app/api/paypal/webhook/route';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { createMockSupabase, registerTable } from './helpers';

const originalEnv = { ...process.env };
const mockFetch = vi.fn();

const WEBHOOK_BODY = JSON.stringify({
  id: 'EVT-RESILIENCE-1',
  event_type: 'PAYMENT.CAPTURE.COMPLETED',
  resource: { id: 'CAP-1' },
});

/** Fast backoff so retry tests don't sleep for real. */
const FAST = { backoffMs: [1, 1] as const };

function signedRequest(rawBody: string = WEBHOOK_BODY) {
  return new Request('http://localhost/api/paypal/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-cert-url': 'https://example.com/cert',
      'paypal-transmission-id': 'trans-1',
      'paypal-transmission-sig': 'sig-1',
      'paypal-transmission-time': new Date().toISOString(),
    },
    body: rawBody,
  });
}

/**
 * Script the global fetch stub: successive calls to the PayPal token
 * endpoint / verify endpoint consume the given factories (the last one
 * repeats). A factory may throw to simulate a network error / timeout.
 */
function fetchScript(
  tokenResponses: Array<() => Response>,
  verifyResponses: Array<() => Response>,
) {
  let tokenCalls = 0;
  let verifyCalls = 0;
  mockFetch.mockImplementation(async (url: unknown) => {
    const target = String(url);
    if (target.includes('/v1/oauth2/token')) {
      const factory = tokenResponses[Math.min(tokenCalls++, tokenResponses.length - 1)];
      return factory();
    }
    if (target.includes('/v1/notifications/verify-webhook-signature')) {
      const factory = verifyResponses[Math.min(verifyCalls++, verifyResponses.length - 1)];
      return factory();
    }
    throw new Error(`Unexpected fetch call: ${target}`);
  });
  return {
    tokenCalls: () => tokenCalls,
    verifyCalls: () => verifyCalls,
  };
}

const tokenOk = () =>
  new Response(JSON.stringify({ access_token: 'tok-1' }), { status: 200 });
const status = (code: number) => () => new Response('{}', { status: code });
const verifySuccess = () =>
  new Response(JSON.stringify({ verification_status: 'SUCCESS' }), { status: 200 });
const verifyFailure = () =>
  new Response(JSON.stringify({ verification_status: 'FAILURE' }), { status: 200 });
const networkError = (): Response => {
  throw new Error('socket hang up');
};

let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...originalEnv };
  // Fully env-sourced PayPal config so no Supabase read happens in config load.
  process.env.PAYPAL_API_BASE = 'https://api-m.sandbox.paypal.com';
  process.env.PAYPAL_SANDBOX = 'true';
  process.env.PAYPAL_CLIENT_ID = 'test-client-id';
  process.env.PAYPAL_CLIENT_SECRET = 'test-client-secret';
  process.env.PAYPAL_WEBHOOK_ID = 'test-webhook-id';
  process.env.PAYPAL_WEBHOOK_URL = 'http://localhost/api/paypal/webhook';
  vi.stubGlobal('fetch', mockFetch);
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...originalEnv };
  warnSpy.mockRestore();
  errorSpy.mockRestore();
  vi.unstubAllGlobals();
});

describe('verifyWebhookSignature — outcome classification', () => {
  it('returns verified when token and verify API succeed first try', async () => {
    const calls = fetchScript([tokenOk], [verifySuccess]);

    const result = await verifyWebhookSignature(signedRequest() as never, WEBHOOK_BODY, FAST);

    expect(result).toEqual({ outcome: 'verified' });
    expect(calls.tokenCalls()).toBe(1);
    expect(calls.verifyCalls()).toBe(1);
  });

  it('returns invalid without retrying when PayPal rejects the signature', async () => {
    const calls = fetchScript([tokenOk], [verifyFailure]);

    const result = await verifyWebhookSignature(signedRequest() as never, WEBHOOK_BODY, FAST);

    expect(result).toEqual({ outcome: 'invalid' });
    expect(calls.tokenCalls()).toBe(1);
    expect(calls.verifyCalls()).toBe(1);
  });

  it('returns invalid without retrying on a non-transient verify API 400', async () => {
    const calls = fetchScript([tokenOk], [status(400)]);

    const result = await verifyWebhookSignature(signedRequest() as never, WEBHOOK_BODY, FAST);

    expect(result).toEqual({ outcome: 'invalid' });
    expect(calls.verifyCalls()).toBe(1);
  });

  it('retries a transient verify API 503 and verifies on the next attempt', async () => {
    const calls = fetchScript([tokenOk], [status(503), verifySuccess]);

    const result = await verifyWebhookSignature(signedRequest() as never, WEBHOOK_BODY, FAST);

    expect(result).toEqual({ outcome: 'verified' });
    // Token is reused across attempts — only the failing verify call repeats.
    expect(calls.tokenCalls()).toBe(1);
    expect(calls.verifyCalls()).toBe(2);
  });

  it('refreshes the token and retries when the verify API rejects it with 401', async () => {
    const calls = fetchScript([tokenOk, tokenOk], [status(401), verifySuccess]);

    const result = await verifyWebhookSignature(signedRequest() as never, WEBHOOK_BODY, FAST);

    expect(result).toEqual({ outcome: 'verified' });
    expect(calls.tokenCalls()).toBe(2);
    expect(calls.verifyCalls()).toBe(2);
  });

  it('returns unavailable when the verify API keeps failing with network errors', async () => {
    const calls = fetchScript([tokenOk], [networkError]);

    const result = await verifyWebhookSignature(signedRequest() as never, WEBHOOK_BODY, FAST);

    expect(result).toMatchObject({ outcome: 'unavailable' });
    expect((result as { reason: string }).reason).toContain('socket hang up');
    // 1 initial attempt + 2 bounded retries
    expect(calls.verifyCalls()).toBe(3);
  });

  it('returns unavailable when the token endpoint keeps returning 5xx', async () => {
    const calls = fetchScript([status(503)], [verifySuccess]);

    const result = await verifyWebhookSignature(signedRequest() as never, WEBHOOK_BODY, FAST);

    expect(result).toMatchObject({ outcome: 'unavailable' });
    expect((result as { reason: string }).reason).toContain('503');
    expect(calls.tokenCalls()).toBe(3);
    expect(calls.verifyCalls()).toBe(0);
  });

  it('returns invalid without retrying when PayPal rejects the client credentials', async () => {
    const calls = fetchScript([status(401)], [verifySuccess]);

    const result = await verifyWebhookSignature(signedRequest() as never, WEBHOOK_BODY, FAST);

    expect(result).toEqual({ outcome: 'invalid' });
    expect(calls.tokenCalls()).toBe(1);
    expect(calls.verifyCalls()).toBe(0);
  });

  it('returns invalid without any fetch when credentials are not configured', async () => {
    delete process.env.PAYPAL_CLIENT_ID;
    delete process.env.PAYPAL_CLIENT_SECRET;
    // Config falls back to (mocked) saved settings — none configured.
    const admin = createMockSupabase();
    registerTable(admin, 'instance_settings').limit.mockResolvedValue({ data: [], error: null });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(admin);
    fetchScript([tokenOk], [verifySuccess]);

    const result = await verifyWebhookSignature(signedRequest() as never, WEBHOOK_BODY, FAST);

    expect(result).toEqual({ outcome: 'invalid' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns invalid for a non-JSON body without calling PayPal', async () => {
    fetchScript([tokenOk], [verifySuccess]);

    const result = await verifyWebhookSignature(
      signedRequest('not-json{{{') as never,
      'not-json{{{',
      FAST,
    );

    expect(result).toEqual({ outcome: 'invalid' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('stops retrying when the remaining time budget cannot fit another attempt', async () => {
    const calls = fetchScript([networkError], [verifySuccess]);

    const result = await verifyWebhookSignature(signedRequest() as never, WEBHOOK_BODY, {
      budgetMs: 50,
      backoffMs: [5_000, 5_000],
    });

    expect(result).toMatchObject({ outcome: 'unavailable' });
    // No room for backoff + a useful attempt → exactly one attempt was made.
    expect(calls.tokenCalls()).toBe(1);
  });
});

describe('raisePayPalVerifyUnavailableAlert', () => {
  function setupAlertMocks(guildId: string) {
    process.env.DISCORD_GUILD_ID = guildId;
    const mock = createMockSupabase();
    const alertsQuery = registerTable(mock, 'alerts');
    // Terminal `.select('id')` of the refresh UPDATE chain. Default: no
    // existing unresolved alert (0 rows updated) → falls through to INSERT.
    alertsQuery.select.mockResolvedValue({ data: [], error: null });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mock);
    return { mock, alertsQuery };
  }

  it('inserts a deduped operator alert when none is unresolved', async () => {
    const { mock, alertsQuery } = setupAlertMocks('guild-alert-insert');

    await raisePayPalVerifyUnavailableAlert(mock as never, 'verify API returned 503');

    expect(alertsQuery.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        guild_id: 'guild-alert-insert',
        alert_type: 'paypal_webhook_verify_failure',
        severity: 'critical',
        metadata: expect.objectContaining({ reason: 'verify API returned 503' }),
      }),
    );
  });

  it('refreshes an existing unresolved alert instead of inserting', async () => {
    const { mock, alertsQuery } = setupAlertMocks('guild-alert-refresh');
    alertsQuery.select.mockResolvedValue({ data: [{ id: 'alert-1' }], error: null });

    await raisePayPalVerifyUnavailableAlert(mock as never, 'token request failed: timeout');

    expect(alertsQuery.update).toHaveBeenCalled();
    expect(alertsQuery.insert).not.toHaveBeenCalled();
  });

  it('treats a 23505 unique violation on insert as dedupe success', async () => {
    const { mock, alertsQuery } = setupAlertMocks('guild-alert-race');
    alertsQuery.insert.mockResolvedValue({
      error: { code: '23505', message: 'duplicate key value violates unique constraint' },
    });

    await raisePayPalVerifyUnavailableAlert(mock as never, 'verify API returned 502');

    const insertFailureLogs = errorSpy.mock.calls.filter((call) =>
      String(call[0]).includes('Failed to insert PayPal verify outage alert'),
    );
    expect(insertFailureLogs).toHaveLength(0);
  });

  it('throttles repeat alert writes for the same guild', async () => {
    const { mock } = setupAlertMocks('guild-alert-throttle');

    await raisePayPalVerifyUnavailableAlert(mock as never, 'verify API returned 503');
    const callsAfterFirst = mock.from.mock.calls.length;
    await raisePayPalVerifyUnavailableAlert(mock as never, 'verify API returned 503');

    expect(mock.from.mock.calls.length).toBe(callsAfterFirst);
  });

  it('skips the alert when DISCORD_GUILD_ID is not configured', async () => {
    const { mock } = setupAlertMocks('guild-alert-unused');
    delete process.env.DISCORD_GUILD_ID;

    await raisePayPalVerifyUnavailableAlert(mock as never, 'verify API returned 503');

    expect(mock.from).not.toHaveBeenCalled();
  });
});

describe('POST /api/paypal/webhook — verify failure status mapping', () => {
  it('responds 503 (not 401) and records no event when verification infrastructure is down', async () => {
    process.env.DISCORD_GUILD_ID = 'guild-route-503';
    const mock = createMockSupabase();
    const alertsQuery = registerTable(mock, 'alerts');
    alertsQuery.select.mockResolvedValue({ data: [], error: null });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mock);
    // Token endpoint is down hard — every verification attempt fails.
    fetchScript([networkError], [verifySuccess]);

    const res = await POST(signedRequest() as never);

    expect(res.status).toBe(503);
    // PayPal redelivers non-2xx responses — the event must NOT be recorded
    // as seen, so the redelivery processes cleanly through dedup.
    const tablesTouched = mock.from.mock.calls.map((call) => call[0]);
    expect(tablesTouched).not.toContain('webhook_events');
    expect(tablesTouched).not.toContain('orders');
    // Operator alert raised for the repeated verify-infrastructure failure.
    expect(alertsQuery.insert).toHaveBeenCalledWith(
      expect.objectContaining({ alert_type: 'paypal_webhook_verify_failure' }),
    );
  });

  it('still responds 401 with no alert when the signature is actually invalid', async () => {
    process.env.DISCORD_GUILD_ID = 'guild-route-401';
    const mock = createMockSupabase();
    const alertsQuery = registerTable(mock, 'alerts');
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mock);
    fetchScript([tokenOk], [verifyFailure]);

    const res = await POST(signedRequest() as never);

    expect(res.status).toBe(401);
    expect(alertsQuery.insert).not.toHaveBeenCalled();
    expect(alertsQuery.update).not.toHaveBeenCalled();
  });
});
