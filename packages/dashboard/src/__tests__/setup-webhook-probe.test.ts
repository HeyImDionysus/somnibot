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

// Tests never hit real DNS: the probe now vets resolved addresses before
// fetching (SSRF guard), so every network-path test injects a lookup. This
// one resolves to a plainly public address.
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

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

    const result = await probeSetupWebhookUrl(WEBHOOK_URL, { fetchImpl, lookupImpl: publicLookup });

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

    const result = await probeSetupWebhookUrl(WEBHOOK_URL, { fetchImpl, lookupImpl: publicLookup });

    expect(result.status).toBe('unreachable');
    expect(result.failureReason).toBe('echo-mismatch');
  });

  it.each([
    ['Latin-1 multi-byte', 'é'.repeat(64)],
    ['surrogate-pair emoji', '\u{1f98a}'.repeat(32)],
  ])('reports echo-mismatch instead of throwing for a %s echo of matching string length', async (_label, badEcho) => {
    // Same UTF-16 string length as the real 64-char hex echo, but a longer
    // UTF-8 byte length. String-length comparison used to let this reach
    // timingSafeEqual with unequal-length Buffers, which throws RangeError.
    expect(badEcho.length).toBe(64);
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ status: 'probe', echo: badEcho }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));

    const result = await probeSetupWebhookUrl(WEBHOOK_URL, { fetchImpl, lookupImpl: publicLookup });

    expect(result.status).toBe('unreachable');
    expect(result.failureReason).toBe('echo-mismatch');
  });

  it('reports echo-mismatch when a 200 response is not JSON', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>captive portal</html>', { status: 200 }));

    const result = await probeSetupWebhookUrl(WEBHOOK_URL, { fetchImpl, lookupImpl: publicLookup });

    expect(result.status).toBe('unreachable');
    expect(result.failureReason).toBe('echo-mismatch');
  });

  it('reports http-status failures with the status code', async () => {
    const fetchImpl = vi.fn(async () => new Response('not found', { status: 404 }));

    const result = await probeSetupWebhookUrl(WEBHOOK_URL, { fetchImpl, lookupImpl: publicLookup });

    expect(result.status).toBe('unreachable');
    expect(result.failureReason).toBe('http-status');
    expect(result.detail).toContain('404');
  });

  it('treats redirects as failures instead of following them', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, {
      status: 301,
      headers: { Location: 'https://elsewhere.example.com/' },
    }));

    const result = await probeSetupWebhookUrl(WEBHOOK_URL, { fetchImpl, lookupImpl: publicLookup });

    expect(result.status).toBe('unreachable');
    expect(result.failureReason).toBe('http-status');
    expect(result.detail).toContain('301');
  });

  it('classifies DNS failures', async () => {
    const fetchImpl = vi.fn(async () => { throw fetchFailure('ENOTFOUND'); });

    const result = await probeSetupWebhookUrl(WEBHOOK_URL, { fetchImpl, lookupImpl: publicLookup });

    expect(result.status).toBe('unreachable');
    expect(result.failureReason).toBe('dns');
    expect(result.detail).toContain('ENOTFOUND');
  });

  it('classifies TLS failures', async () => {
    const fetchImpl = vi.fn(async () => { throw fetchFailure('CERT_HAS_EXPIRED'); });

    const result = await probeSetupWebhookUrl(WEBHOOK_URL, { fetchImpl, lookupImpl: publicLookup });

    expect(result.status).toBe('unreachable');
    expect(result.failureReason).toBe('tls');
    expect(result.detail).toContain('CERT_HAS_EXPIRED');
  });

  it('classifies timeouts', async () => {
    const timeoutError = Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
    });
    const fetchImpl = vi.fn(async () => { throw timeoutError; });

    const result = await probeSetupWebhookUrl(WEBHOOK_URL, { fetchImpl, lookupImpl: publicLookup });

    expect(result.status).toBe('unreachable');
    expect(result.failureReason).toBe('timeout');
  });

  it('classifies refused connections', async () => {
    const fetchImpl = vi.fn(async () => { throw fetchFailure('ECONNREFUSED'); });

    const result = await probeSetupWebhookUrl(WEBHOOK_URL, { fetchImpl, lookupImpl: publicLookup });

    expect(result.status).toBe('unreachable');
    expect(result.failureReason).toBe('connection');
  });

  it('classifies unknown fetch failures as request-failed', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed'); });

    const result = await probeSetupWebhookUrl(WEBHOOK_URL, { fetchImpl, lookupImpl: publicLookup });

    expect(result.status).toBe('unreachable');
    expect(result.failureReason).toBe('request-failed');
  });

  it('skips instead of reporting unreachable when no probe secret exists', async () => {
    delete process.env.WEBHOOK_REPLAY_SECRET;
    delete process.env.NEXTAUTH_SECRET;
    const fetchImpl = vi.fn();

    const result = await probeSetupWebhookUrl(WEBHOOK_URL, { fetchImpl, lookupImpl: publicLookup });

    expect(result.status).toBe('skipped');
    expect(result.failureReason).toBe('probe-secret-missing');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an oversized 200 response instead of buffering it', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      `{"echo":"${'a'.repeat(64 * 1024)}"}`,
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));

    const result = await probeSetupWebhookUrl(WEBHOOK_URL, { fetchImpl, lookupImpl: publicLookup });

    expect(result.status).toBe('unreachable');
    expect(result.failureReason).toBe('oversized-response');
    expect(result.detail).toContain('oversized');
  });

  it('still verifies echoes that arrive split across multiple stream chunks', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const payload = new TextEncoder().encode(
        JSON.stringify({ status: 'probe', echo: buildSetupWebhookProbeEcho(probeHeaderOf(init)) }),
      );
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(payload.slice(0, 10));
          controller.enqueue(payload.slice(10));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const result = await probeSetupWebhookUrl(WEBHOOK_URL, { fetchImpl, lookupImpl: publicLookup });

    expect(result.status).toBe('reachable');
  });
});

describe('probe target vetting (SSRF guard)', () => {
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

  it.each([
    ['RFC1918 10/8', 'https://10.0.0.5:8443/api/paypal/webhook'],
    ['RFC1918 172.16/12', 'https://172.20.1.9/api/paypal/webhook'],
    ['RFC1918 192.168/16', 'https://192.168.1.10/api/paypal/webhook'],
    ['loopback 127/8 (non-127.0.0.1)', 'https://127.1.2.3/api/paypal/webhook'],
    ['link-local metadata', 'https://169.254.169.254/api/paypal/webhook'],
    ['CGNAT metadata-style', 'https://100.100.100.200/api/paypal/webhook'],
    ['IPv6 ULA', 'https://[fd00::1]/api/paypal/webhook'],
    ['IPv6 link-local', 'https://[fe80::1]/api/paypal/webhook'],
    ['IPv4-mapped IPv6', 'https://[::ffff:10.0.0.5]/api/paypal/webhook'],
  ])('rejects a %s IP literal without any DNS lookup or request', async (_label, url) => {
    const fetchImpl = vi.fn();
    const lookupImpl = vi.fn();

    const result = await probeSetupWebhookUrl(url, { fetchImpl, lookupImpl });

    expect(result.status).toBe('unreachable');
    expect(result.failureReason).toBe('private-address');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(lookupImpl).not.toHaveBeenCalled();
  });

  it('rejects a hostname that resolves to a private address without requesting it', async () => {
    const fetchImpl = vi.fn();
    const lookupImpl = vi.fn(async () => [{ address: '10.13.37.1', family: 4 }]);

    const result = await probeSetupWebhookUrl(WEBHOOK_URL, { fetchImpl, lookupImpl });

    expect(result.status).toBe('unreachable');
    expect(result.failureReason).toBe('private-address');
    expect(lookupImpl).toHaveBeenCalledWith('dashboard.example.com');
    expect(fetchImpl).not.toHaveBeenCalled();
    // The resolved address itself is never surfaced to setup-status readers.
    expect(result.detail).not.toContain('10.13.37.1');
  });

  it('rejects a hostname when ANY resolved address is private (mixed answers)', async () => {
    const fetchImpl = vi.fn();
    const lookupImpl = vi.fn(async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '192.168.0.10', family: 4 },
    ]);

    const result = await probeSetupWebhookUrl(WEBHOOK_URL, { fetchImpl, lookupImpl });

    expect(result.status).toBe('unreachable');
    expect(result.failureReason).toBe('private-address');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a non-Tailscale hostname resolving into CGNAT space', async () => {
    const fetchImpl = vi.fn();
    const lookupImpl = vi.fn(async () => [{ address: '100.100.100.200', family: 4 }]);

    const result = await probeSetupWebhookUrl(WEBHOOK_URL, { fetchImpl, lookupImpl });

    expect(result.status).toBe('unreachable');
    expect(result.failureReason).toBe('private-address');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('allows a *.ts.net funnel hostname that MagicDNS resolves to its tailnet IPv4 address', async () => {
    // On the funnel machine itself (where this probe runs), MagicDNS resolves
    // the node's own *.ts.net name to its 100.64.0.0/10 tailnet address, not
    // the public funnel ingress. This supported deployment path must probe.
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => echoResponse(probeHeaderOf(init)));
    const lookupImpl = vi.fn(async () => [{ address: '100.101.102.103', family: 4 }]);

    const result = await probeSetupWebhookUrl(
      'https://somnibot.tailnet.ts.net/api/paypal/webhook',
      { fetchImpl, lookupImpl },
    );

    expect(result.status).toBe('reachable');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('allows a *.ts.net funnel hostname that resolves to the Tailscale IPv6 range', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => echoResponse(probeHeaderOf(init)));
    const lookupImpl = vi.fn(async () => [
      { address: '100.101.102.103', family: 4 },
      { address: 'fd7a:115c:a1e0:ab12::1', family: 6 },
    ]);

    const result = await probeSetupWebhookUrl(
      'https://somnibot.tailnet.ts.net/api/paypal/webhook',
      { fetchImpl, lookupImpl },
    );

    expect(result.status).toBe('reachable');
  });

  it('still blocks non-tailnet private addresses for *.ts.net hostnames', async () => {
    const fetchImpl = vi.fn();
    const lookupImpl = vi.fn(async () => [{ address: '10.0.0.5', family: 4 }]);

    const result = await probeSetupWebhookUrl(
      'https://somnibot.tailnet.ts.net/api/paypal/webhook',
      { fetchImpl, lookupImpl },
    );

    expect(result.status).toBe('unreachable');
    expect(result.failureReason).toBe('private-address');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not extend the Tailscale exception to CGNAT IP literals', async () => {
    const fetchImpl = vi.fn();
    const lookupImpl = vi.fn();

    const result = await probeSetupWebhookUrl('https://100.101.102.103/api/paypal/webhook', { fetchImpl, lookupImpl });

    expect(result.status).toBe('unreachable');
    expect(result.failureReason).toBe('private-address');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('classifies a failing DNS lookup as a dns failure without fetching', async () => {
    const fetchImpl = vi.fn();
    const lookupImpl = vi.fn(async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND dashboard.example.com'), { code: 'ENOTFOUND' });
    });

    const result = await probeSetupWebhookUrl(WEBHOOK_URL, { fetchImpl, lookupImpl });

    expect(result.status).toBe('unreachable');
    expect(result.failureReason).toBe('dns');
    expect(result.detail).toContain('ENOTFOUND');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('probes public addresses normally', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => echoResponse(probeHeaderOf(init)));
    const lookupImpl = vi.fn(async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:21f:cb07:6820:80da:af6b:8b2c', family: 6 },
    ]);

    const result = await probeSetupWebhookUrl(WEBHOOK_URL, { fetchImpl, lookupImpl });

    expect(result.status).toBe('reachable');
  });

  it('bounds a wedged DNS lookup by the probe budget and reports dns-timeout', async () => {
    const fetchImpl = vi.fn();
    // A resolver that never answers: without a deadline on the DNS phase
    // this would hang the probe (and every readiness read awaiting it).
    const lookupImpl = vi.fn(
      () => new Promise<Array<{ address: string; family: number }>>(() => {}),
    );

    const result = await probeSetupWebhookUrl(WEBHOOK_URL, { fetchImpl, lookupImpl, timeoutMs: 50 });

    expect(result.status).toBe('unreachable');
    expect(result.failureReason).toBe('dns-timeout');
    expect(result.detail).toContain('DNS');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a DNS lookup that rejects after the deadline stays a dns-timeout, not an unhandled rejection', async () => {
    const fetchImpl = vi.fn();
    let rejectLookup: ((err: unknown) => void) | undefined;
    const lookupImpl = vi.fn(
      () => new Promise<Array<{ address: string; family: number }>>((_resolve, reject) => {
        rejectLookup = reject;
      }),
    );

    const result = await probeSetupWebhookUrl(WEBHOOK_URL, { fetchImpl, lookupImpl, timeoutMs: 50 });
    expect(result.failureReason).toBe('dns-timeout');

    // The lookup failing late must not crash anything.
    rejectLookup!(Object.assign(new Error('late failure'), { code: 'ENOTFOUND' }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('gives the fetch only the budget remaining after DNS so DNS + fetch fit one timeout', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const lookupImpl = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return [{ address: '93.184.216.34', family: 4 }];
    });
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => echoResponse(probeHeaderOf(init)));

    const result = await probeSetupWebhookUrl(WEBHOOK_URL, { fetchImpl, lookupImpl, timeoutMs: 5_000 });

    expect(result.status).toBe('reachable');
    expect(timeoutSpy).toHaveBeenCalledTimes(1);
    const fetchBudgetMs = timeoutSpy.mock.calls[0][0];
    expect(fetchBudgetMs).toBeGreaterThan(0);
    // The ~100ms DNS phase must come out of the fetch's slice of the budget,
    // never stack on top of it.
    expect(fetchBudgetMs).toBeLessThanOrEqual(5_000 - 90);
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

    const result = await getSetupWebhookReachability(null, { fetchImpl, lookupImpl: publicLookup });

    expect(result.status).toBe('skipped');
    expect(result.failureReason).toBe('no-public-url');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('caches probe results so status polling cannot become a request storm', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => echoResponse(probeHeaderOf(init)));

    const first = await getSetupWebhookReachability(WEBHOOK_URL, { fetchImpl, lookupImpl: publicLookup });
    const second = await getSetupWebhookReachability(WEBHOOK_URL, { fetchImpl, lookupImpl: publicLookup });

    expect(first.status).toBe('reachable');
    expect(second).toBe(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('caches unreachable outcomes too', async () => {
    const fetchImpl = vi.fn(async () => { throw fetchFailure('ECONNREFUSED'); });

    await getSetupWebhookReachability(WEBHOOK_URL, { fetchImpl, lookupImpl: publicLookup });
    const second = await getSetupWebhookReachability(WEBHOOK_URL, { fetchImpl, lookupImpl: publicLookup });

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
      getSetupWebhookReachability(WEBHOOK_URL, { fetchImpl, lookupImpl: publicLookup }),
      getSetupWebhookReachability(WEBHOOK_URL, { fetchImpl, lookupImpl: publicLookup }),
    ];
    // The probe awaits the (async) target vetting before fetching.
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    resolveFetch!(echoResponse(capturedChallenge));
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(first.status).toBe('reachable');
    expect(second.status).toBe('reachable');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('re-probes after the cache TTL elapses', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => echoResponse(probeHeaderOf(init)));

    await getSetupWebhookReachability(WEBHOOK_URL, { fetchImpl, lookupImpl: publicLookup });
    vi.setSystemTime(Date.now() + 31_000);
    await getSetupWebhookReachability(WEBHOOK_URL, { fetchImpl, lookupImpl: publicLookup });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('re-probes immediately when the webhook URL changes', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => echoResponse(probeHeaderOf(init)));

    await getSetupWebhookReachability(WEBHOOK_URL, { fetchImpl, lookupImpl: publicLookup });
    const other = await getSetupWebhookReachability('https://other.example.com/api/paypal/webhook', { fetchImpl, lookupImpl: publicLookup });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(other.checkedUrl).toBe('https://other.example.com/api/paypal/webhook');
  });

  it('forceFresh bypasses a cached verdict so finalize never records a stale result', async () => {
    // Probe 1: URL is broken (DNS failure) — the failure is cached.
    const failingFetch = vi.fn(async () => { throw fetchFailure('ENOTFOUND'); });
    const stale = await getSetupWebhookReachability(WEBHOOK_URL, {
      fetchImpl: failingFetch,
      lookupImpl: publicLookup,
    });
    expect(stale.status).toBe('unreachable');

    // Operator fixes DNS and finalizes immediately: within the cache TTL a
    // plain read still serves the stale verdict, but forceFresh re-probes.
    const workingFetch = vi.fn(async (_url: string, init?: RequestInit) => echoResponse(probeHeaderOf(init)));
    const cached = await getSetupWebhookReachability(WEBHOOK_URL, {
      fetchImpl: workingFetch,
      lookupImpl: publicLookup,
    });
    expect(cached).toBe(stale);
    expect(workingFetch).not.toHaveBeenCalled();

    const fresh = await getSetupWebhookReachability(WEBHOOK_URL, {
      fetchImpl: workingFetch,
      lookupImpl: publicLookup,
      forceFresh: true,
    });

    expect(fresh.status).toBe('reachable');
    expect(workingFetch).toHaveBeenCalledTimes(1);
  });

  it('forceFresh refreshes the cache with the new outcome for subsequent polls', async () => {
    const failingFetch = vi.fn(async () => { throw fetchFailure('ENOTFOUND'); });
    await getSetupWebhookReachability(WEBHOOK_URL, { fetchImpl: failingFetch, lookupImpl: publicLookup });

    const workingFetch = vi.fn(async (_url: string, init?: RequestInit) => echoResponse(probeHeaderOf(init)));
    const fresh = await getSetupWebhookReachability(WEBHOOK_URL, {
      fetchImpl: workingFetch,
      lookupImpl: publicLookup,
      forceFresh: true,
    });

    // A later plain (cached) poll sees the forced result, not the stale one.
    const polled = await getSetupWebhookReachability(WEBHOOK_URL, {
      fetchImpl: workingFetch,
      lookupImpl: publicLookup,
    });
    expect(polled).toBe(fresh);
    expect(workingFetch).toHaveBeenCalledTimes(1);
  });

  it('a stale in-flight poll that finishes last cannot overwrite a fresher forceFresh verdict', async () => {
    // Poll 1 starts while the URL is still broken — and is SLOW.
    let rejectStale: ((err: unknown) => void) | undefined;
    const staleFetch = vi.fn(
      () => new Promise<Response>((_resolve, reject) => { rejectStale = reject; }),
    );
    const stalePoll = getSetupWebhookReachability(WEBHOOK_URL, {
      fetchImpl: staleFetch,
      lookupImpl: publicLookup,
    });
    await vi.waitFor(() => expect(staleFetch).toHaveBeenCalledTimes(1));

    // Operator fixes the URL; finalize force-probes and completes FIRST.
    const workingFetch = vi.fn(async (_url: string, init?: RequestInit) => echoResponse(probeHeaderOf(init)));
    const fresh = await getSetupWebhookReachability(WEBHOOK_URL, {
      fetchImpl: workingFetch,
      lookupImpl: publicLookup,
      forceFresh: true,
    });
    expect(fresh.status).toBe('reachable');

    // The stale poll finishes LAST with the pre-fix failure verdict. Its own
    // caller still sees that outcome, but it must not regress the cache.
    rejectStale!(fetchFailure('ENOTFOUND'));
    await expect(stalePoll).resolves.toMatchObject({ status: 'unreachable' });

    // Subsequent cached polls see the fresher finalize verdict.
    const cachedFetch = vi.fn();
    const polled = await getSetupWebhookReachability(WEBHOOK_URL, {
      fetchImpl: cachedFetch,
      lookupImpl: publicLookup,
    });
    expect(polled).toBe(fresh);
    expect(polled.status).toBe('reachable');
    expect(cachedFetch).not.toHaveBeenCalled();
  });

  it('forceFresh does not join an already in-flight cached probe', async () => {
    let resolveFirst: ((res: Response) => void) | undefined;
    let firstChallenge = '';
    const slowFetch = vi.fn((_url: string, init?: RequestInit) => {
      firstChallenge = probeHeaderOf(init);
      return new Promise<Response>((resolve) => { resolveFirst = resolve; });
    });
    const pollPromise = getSetupWebhookReachability(WEBHOOK_URL, { fetchImpl: slowFetch, lookupImpl: publicLookup });
    await vi.waitFor(() => expect(slowFetch).toHaveBeenCalledTimes(1));

    const freshFetch = vi.fn(async (_url: string, init?: RequestInit) => echoResponse(probeHeaderOf(init)));
    const fresh = await getSetupWebhookReachability(WEBHOOK_URL, {
      fetchImpl: freshFetch,
      lookupImpl: publicLookup,
      forceFresh: true,
    });
    expect(freshFetch).toHaveBeenCalledTimes(1);
    expect(fresh.status).toBe('reachable');

    resolveFirst!(echoResponse(firstChallenge));
    await expect(pollPromise).resolves.toMatchObject({ status: 'reachable' });
  });
});
