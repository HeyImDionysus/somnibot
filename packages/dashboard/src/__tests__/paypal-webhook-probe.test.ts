/**
 * Tests for the setup reachability probe short-circuit in
 * POST /api/paypal/webhook.
 *
 * A signed probe challenge must be echoed back without touching PayPal
 * signature verification, webhook_events, or any fulfillment handler; an
 * invalid challenge must be rejected outright instead of falling through
 * to real webhook processing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { replaySecret } = vi.hoisted(() => {
  const secret = 'test-webhook-replay-secret';
  process.env.NEXTAUTH_SECRET = 'test-secret-for-webhook-tests';
  process.env.WEBHOOK_REPLAY_SECRET = secret;
  process.env.PAYPAL_WEBHOOK_ID = 'test-webhook-id';
  return { replaySecret: secret };
});

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
import {
  SETUP_WEBHOOK_PROBE_HEADER,
  buildSetupWebhookProbeEcho,
  createSetupWebhookProbeChallenge,
} from '@/lib/setup-webhook-probe';

const mockFrom = vi.fn();
const mockRpc = vi.fn(async (name: string) => ({
  data: name === 'webhooks_replay_claim_is_current'
    || name === 'webhooks_finish_replay_claim'
    ? true
    : null,
  error: null,
}));
const mockSupabase = { from: mockFrom, rpc: mockRpc };
const replayClaimToken = '11111111-1111-4111-8111-111111111111';

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

function makeWebhookRequest(body: string, headers?: Record<string, string>) {
  return new Request('http://localhost/api/paypal/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(headers ?? {}),
    },
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mockSupabase);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/paypal/webhook reachability probe', () => {
  it('echoes a valid signed challenge without any PayPal or database side effects', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const challenge = createSetupWebhookProbeChallenge();
    expect(challenge).toBeTruthy();

    // Body is intentionally not valid JSON: the probe must short-circuit
    // before body parsing, signature verification, or event recording.
    const res = await POST(makeWebhookRequest('probe-bodies-are-ignored{{{', {
      [SETUP_WEBHOOK_PROBE_HEADER]: challenge!,
    }) as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ status: 'probe', echo: buildSetupWebhookProbeEcho(challenge!) });
    expect(createAdminSupabase).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a tampered challenge without falling through to webhook processing', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const challenge = createSetupWebhookProbeChallenge()!;
    const tampered = challenge.slice(0, -1) + (challenge.endsWith('0') ? '1' : '0');

    const res = await POST(makeWebhookRequest(
      JSON.stringify({ event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAP-1' }, id: 'EVT-1' }),
      { [SETUP_WEBHOOK_PROBE_HEADER]: tampered },
    ) as never);
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body).toEqual({ error: 'Invalid probe challenge' });
    expect(createAdminSupabase).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects an expired challenge', async () => {
    const challenge = createSetupWebhookProbeChallenge(Date.now() - 60 * 60_000)!;

    const res = await POST(makeWebhookRequest('{}', {
      [SETUP_WEBHOOK_PROBE_HEADER]: challenge,
    }) as never);

    expect(res.status).toBe(401);
    expect(createAdminSupabase).not.toHaveBeenCalled();
  });

  it('rejects an empty probe header', async () => {
    const res = await POST(makeWebhookRequest('{}', {
      [SETUP_WEBHOOK_PROBE_HEADER]: '',
    }) as never);

    expect(res.status).toBe(401);
    expect(createAdminSupabase).not.toHaveBeenCalled();
  });

  it('never processes a real event when a probe header is present, even with a valid replay secret', async () => {
    mockUpsertSuccess();
    const challenge = createSetupWebhookProbeChallenge()!;
    const tampered = challenge.slice(0, -1) + (challenge.endsWith('0') ? '1' : '0');

    const res = await POST(makeWebhookRequest(
      JSON.stringify({ event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAP-1' }, id: 'EVT-2' }),
      {
        [SETUP_WEBHOOK_PROBE_HEADER]: tampered,
        'x-replay-secret': replaySecret,
      },
    ) as never);

    expect(res.status).toBe(401);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('leaves real webhook processing untouched when no probe header is present', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockUpsertSuccess();

    const res = await POST(makeWebhookRequest(
      JSON.stringify({ event_type: 'BILLING.SUBSCRIPTION.UNKNOWN_EVENT', resource: { id: 'SUB-1' }, id: 'EVT-3' }),
      {
        'x-replay-secret': replaySecret,
        'x-replay-claim-token': replayClaimToken,
      },
    ) as never);

    expect(res.status).toBe(200);
    expect(logSpy).toHaveBeenCalledWith('[Webhook] Unhandled event: BILLING.SUBSCRIPTION.UNKNOWN_EVENT');
    // Real events still record their result in webhook_events.
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockRpc).toHaveBeenCalledWith('webhooks_finish_replay_claim', expect.objectContaining({
      p_event_id: 'EVT-3',
      p_claim_token: replayClaimToken,
      p_result: 'success',
    }));
    logSpy.mockRestore();
  });
});
