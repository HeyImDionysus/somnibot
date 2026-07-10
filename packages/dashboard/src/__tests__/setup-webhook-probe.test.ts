/**
 * Tests for the setup-time PayPal webhook reachability probe helpers.
 *
 * The probe signs a short-lived challenge, POSTs it to the deployment's own
 * public webhook URL, and only reports "reachable" when the endpoint answers
 * with the deployment-signed echo. These tests cover challenge integrity,
 * failure classification (DNS/TLS/timeout/status), and probe caching.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SETUP_WEBHOOK_PROBE_HEADER,
  buildSetupWebhookProbeEcho,
  createSetupWebhookProbeChallenge,
  getSetupWebhookReachability,
  probeSetupWebhookUrl,
  resetSetupWebhookReachabilityCacheForTests,
  verifySetupWebhookProbeChallenge,
} from '@/lib/setup-webhook-probe';

const WEBHOOK_URL = 'https://dashboard.example.com/api/paypal/webhook';

function fetchFailure(code: string, message = `request failed (${code})`) {
  const cause = Object.assign(new Error(message), { code });
  return Object.assign(new TypeError('fetch failed'), { cause });
}

function echoResponse(challenge: string) {
  return new Response(
    JSON.stringify({ status: 'probe', echo: buildSetupWebhookProbeEcho(challenge) }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function probeHeaderOf(init?: RequestInit): string {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  return headers[SETUP_WEBHOOK_PROBE_HEADER];
}

describe('setup webhook probe challenge', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.WEBHOOK_REPLAY_SECRET = 'probe-test-secret';
    delete process.env.NEXTAUTH_SECRET;
    resetSetupWebhookReachabilityCacheForTests();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('verifies a freshly created challenge', () => {
    const challenge = createSetupWebhookProbeChallenge();
    expect(challenge).toBeTruthy();
    expect(verifySetupWebhookProbeChallenge(challenge!)).toBe(true);
  });

  it('rejects a challenge whose signature was tampered with', () => {
    const challenge = createSetupWebhookProbeChallenge()!;
    const flipped = challenge.slice(0, -1) + (challenge.endsWith('0') ? '1' : '0');
    expect(verifySetupWebhookProbeChallenge(flipped)).toBe(false);
  });

  it('rejects a challenge whose expiry was tampered with', () => {
    const challenge = createSetupWebhookProbeChallenge()!;
    const [version, nonce, expiresAt, signature] = challenge.split('.');
    const extended = `${version}.${nonce}.${Number(expiresAt) + 60_000}.${signature}`;
    expect(verifySetupWebhookProbeChallenge(extended)).toBe(false);
  });

  it('rejects an expired challenge', () => {
    const issuedAt = Date.now();
    const challenge = createSetupWebhookProbeChallenge(issuedAt)!;
    expect(verifySetupWebhookProbeChallenge(challenge, issuedAt + 60_000)).toBe(true);
    expect(verifySetupWebhookProbeChallenge(challenge, issuedAt + 3 * 60_000)).toBe(false);
  });

  it('rejects malformed challenges', () => {
    expect(verifySetupWebhookProbeChallenge('')).toBe(false);
    expect(verifySetupWebhookProbeChallenge(null)).toBe(false);
    expect(verifySetupWebhookProbeChallenge(undefined)).toBe(false);
    expect(verifySetupWebhookProbeChallenge('not-a-challenge')).toBe(false);
    expect(verifySetupWebhookProbeChallenge('v1.abc.123.deadbeef')).toBe(false);
    expect(verifySetupWebhookProbeChallenge('x'.repeat(4096))).toBe(false);
  });

  it('rejects a challenge signed under a different secret', () => {
    const challenge = createSetupWebhookProbeChallenge()!;
    process.env.WEBHOOK_REPLAY_SECRET = 'rotated-secret';
    expect(verifySetupWebhookProbeChallenge(challenge)).toBe(false);
  });

  it('falls back to NEXTAUTH_SECRET when WEBHOOK_REPLAY_SECRET is unset', () => {
    delete process.env.WEBHOOK_REPLAY_SECRET;
    process.env.NEXTAUTH_SECRET = 'nextauth-secret';
    const challenge = createSetupWebhookProbeChallenge();
    expect(challenge).toBeTruthy();
    expect(verifySetupWebhookProbeChallenge(challenge!)).toBe(true);
  });

  it('cannot create or verify challenges without any secret', () => {
    delete process.env.WEBHOOK_REPLAY_SECRET;
    delete process.env.NEXTAUTH_SECRET;
    expect(createSetupWebhookProbeChallenge()).toBeNull();
    expect(buildSetupWebhookProbeEcho('v1.aa.1.bb')).toBeNull();
    expect(verifySetupWebhookProbeChallenge('v1.aa.1.bb')).toBe(false);
  });

  it('derives echoes that are bound to the challenge and never equal the challenge signature', () => {
    const a = createSetupWebhookProbeChallenge()!;
    const b = createSetupWebhookProbeChallenge()!;
    expect(buildSetupWebhookProbeEcho(a)).toBe(buildSetupWebhookProbeEcho(a));
    expect(buildSetupWebhookProbeEcho(a)).not.toBe(buildSetupWebhookProbeEcho(b));
    expect(a.endsWith(buildSetupWebhookProbeEcho(a)!)).toBe(false);
  });
});

describe('probeSetupWebhookUrl', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.WEBHOOK_REPLAY_SECRET = 'probe-test-secret';
    resetSetupWebhookReachabilityCacheForTests();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('reports reachable when the endpoint answers with the signed echo', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(WEBHOOK_URL);
      expect(init?.method).toBe('POST');
      expect(init?.redirect).toBe('manual');
      const challenge = probeHeaderOf(init);
      expect(verifySetupWebhookProbeChallenge(challenge)).toBe(true);
      return echoResponse(challenge);
    });

    const result = await probeSetupWebhookUrl(WEBHOOK_URL, { fetchImpl });

    expect(result.status).toBe('reachable');
    expect(result.failureReason).toBeNull();
    expect(result.checkedUrl).toBe(WEBHOOK_URL);
    expect(result.checkedAt).toBeTruthy();
    expect(result.detail).toContain('does not prove PayPal');
  });

  it('reports echo-mismatch when a 200 response carries the wrong echo', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ status: 'probe', echo: 'f'.repeat(64) }),
      { status: 200 },
    ));

    const result = await probeSetupWebhookUrl(WEBHOOK_URL, { fetchImpl });

    expect(result.status).toBe('unreachable');
    expect(result.failureReason).toBe('echo-mismatch');
  });

  it('reports echo-mismatch when a 200 response is not JSON', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>captive portal</html>', { status: 200 }));

    const result = await probeSetupWebhookUrl(WEBHOOK_URL, { fetchImpl });

    expect(result.status).toBe('unreachable');
    expect(result.failureReason).toBe('echo-mismatch');
  });

  it('reports http-status failures with the status code', async () => {
    const fetchImpl = vi.fn(async () => new Response('not found', { status: 404 }));

    const result = await probeSetupWebhookUrl(WEBHOOK_URL, { fetchImpl });

    expect(result.status).toBe('unreachable');
    expect(result.failureReason).toBe('http-status');
    expect(result.detail).toContain('404');
  });

  it('treats redirects as failures instead of following them', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, {
      status: 301,
      headers: { Location: 'https://elsewhere.example.com/' },
    }));

    const result = await probeSetupWebhookUrl(WEBHOOK_URL, { fetchImpl });

    expect(result.status).toBe('unreachable');
    expect(result.failureReason).toBe('http-status');
    expect(result.detail).toContain('301');
  });

  it('classifies DNS failures', async () => {
    const fetchImpl = vi.fn(async () => { throw fetchFailure('ENOTFOUND'); });

    const result = await probeSetupWebhookUrl(WEBHOOK_URL, { fetchImpl });

    expect(result.status).toBe('unreachable');
    expect(result.failureReason).toBe('dns');
    expect(result.detail).toContain('ENOTFOUND');
  });

  it('classifies TLS failures', async () => {
    const fetchImpl = vi.fn(async () => { throw fetchFailure('CERT_HAS_EXPIRED'); });

    const result = await probeSetupWebhookUrl(WEBHOOK_URL, { fetchImpl });

    expect(result.status).toBe('unreachable');
    expect(result.failureReason).toBe('tls');
    expect(result.detail).toContain('CERT_HAS_EXPIRED');
  });

  it('classifies timeouts', async () => {
    const timeoutError = Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
    });
    const fetchImpl = vi.fn(async () => { throw timeoutError; });

    const result = await probeSetupWebhookUrl(WEBHOOK_URL, { fetchImpl });

    expect(result.status).toBe('unreachable');
    expect(result.failureReason).toBe('timeout');
  });

  it('classifies refused connections', async () => {
    const fetchImpl = vi.fn(async () => { throw fetchFailure('ECONNREFUSED'); });

    const result = await probeSetupWebhookUrl(WEBHOOK_URL, { fetchImpl });

    expect(result.status).toBe('unreachable');
    expect(result.failureReason).toBe('connection');
  });

  it('classifies unknown fetch failures as request-failed', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed'); });

    const result = await probeSetupWebhookUrl(WEBHOOK_URL, { fetchImpl });

    expect(result.status).toBe('unreachable');
    expect(result.failureReason).toBe('request-failed');
  });

  it('skips instead of reporting unreachable when no probe secret exists', async () => {
    delete process.env.WEBHOOK_REPLAY_SECRET;
    delete process.env.NEXTAUTH_SECRET;
    const fetchImpl = vi.fn();

    const result = await probeSetupWebhookUrl(WEBHOOK_URL, { fetchImpl });

    expect(result.status).toBe('skipped');
    expect(result.failureReason).toBe('probe-secret-missing');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('getSetupWebhookReachability caching', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.WEBHOOK_REPLAY_SECRET = 'probe-test-secret';
    resetSetupWebhookReachabilityCacheForTests();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('skips without probing when no URL is ready yet', async () => {
    const fetchImpl = vi.fn();

    const result = await getSetupWebhookReachability(null, { fetchImpl });

    expect(result.status).toBe('skipped');
    expect(result.failureReason).toBe('no-public-url');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('caches probe results so status polling cannot become a request storm', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => echoResponse(probeHeaderOf(init)));

    const first = await getSetupWebhookReachability(WEBHOOK_URL, { fetchImpl });
    const second = await getSetupWebhookReachability(WEBHOOK_URL, { fetchImpl });

    expect(first.status).toBe('reachable');
    expect(second).toBe(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('caches unreachable outcomes too', async () => {
    const fetchImpl = vi.fn(async () => { throw fetchFailure('ECONNREFUSED'); });

    await getSetupWebhookReachability(WEBHOOK_URL, { fetchImpl });
    const second = await getSetupWebhookReachability(WEBHOOK_URL, { fetchImpl });

    expect(second.status).toBe('unreachable');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('shares a single in-flight probe across concurrent readiness reads', async () => {
    let resolveFetch: ((res: Response) => void) | undefined;
    let capturedChallenge = '';
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      capturedChallenge = probeHeaderOf(init);
      return new Promise<Response>((resolve) => { resolveFetch = resolve; });
    });

    const [firstPromise, secondPromise] = [
      getSetupWebhookReachability(WEBHOOK_URL, { fetchImpl }),
      getSetupWebhookReachability(WEBHOOK_URL, { fetchImpl }),
    ];
    resolveFetch!(echoResponse(capturedChallenge));
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(first.status).toBe('reachable');
    expect(second.status).toBe('reachable');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('re-probes after the cache TTL elapses', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => echoResponse(probeHeaderOf(init)));

    await getSetupWebhookReachability(WEBHOOK_URL, { fetchImpl });
    vi.setSystemTime(Date.now() + 31_000);
    await getSetupWebhookReachability(WEBHOOK_URL, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('re-probes immediately when the webhook URL changes', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => echoResponse(probeHeaderOf(init)));

    await getSetupWebhookReachability(WEBHOOK_URL, { fetchImpl });
    const other = await getSetupWebhookReachability('https://other.example.com/api/paypal/webhook', { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(other.checkedUrl).toBe('https://other.example.com/api/paypal/webhook');
  });
});
