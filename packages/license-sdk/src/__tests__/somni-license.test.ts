/**
 * @somnibot/license-sdk — test suite.
 *
 * Tests the actual state machine in SomniLicense: validation → cache → offline
 * grace → expiry, heartbeat lifecycle, and clock-manipulation resistance.
 *
 * `fetch` is the only thing mocked — all SDK logic (monotonic cache, grace
 * anchoring, heartbeat scheduling, clamping, deactivation) runs for real.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SomniLicense, type SomniLicenseConfig } from '../index.js';

// ─── Helpers ─────────────────────────────────────────



/**
 * Build a JSON Response that looks like what the dashboard returns.
 * Includes a Date header so anchorServerTime() works.
 */
function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      Date: new Date().toUTCString(),
    },
  });
}

/** Shorthand for a successful validation response. */
function validationOk(overrides: Record<string, unknown> = {}): Response {
  return jsonResponse({
    valid: true,
    status: 'active',
    entitlement_id: 'ent-001',
    features: ['auto-mod', 'music'],
    tier: 'pro',
    session_id: 'sess-aaa',
    heartbeat_interval_seconds: 120,
    ...overrides,
  });
}

function validationInvalid(): Response {
  return jsonResponse({ valid: false, status: 'invalid_key' });
}

function validationSessionInvalidated(): Response {
  return jsonResponse({ valid: false, status: 'session_invalidated' });
}

function heartbeatOk(next = 120): Response {
  return jsonResponse({ valid: true, status: 'active', next_heartbeat_seconds: next });
}

/** A still-valid heartbeat whose entitlement entered grace mid-session. */
function heartbeatGrace(deadlineMsFromNow: number, next = 120): Response {
  return jsonResponse({
    valid: true,
    status: 'grace_period',
    grace_period_ends_at: new Date(Date.now() + deadlineMsFromNow).toISOString(),
    next_heartbeat_seconds: next,
  });
}

function heartbeatRevoked(): Response {
  return jsonResponse({ valid: false, status: 'revoked', next_heartbeat_seconds: 0 });
}

// ─── Indeterminate ("we could not determine your licence status") ───
//
// These are what the dashboard returns when a query/RPC fails, plus the shapes
// a proxy can produce. None of them is a verdict on the licence.

/** The pre-fix shape: HTTP 500 whose BODY still claims 'revoked'. */
function serverError(): Response {
  return jsonResponse({ valid: false, status: 'revoked', error: 'Internal validation error' }, 500);
}

/** The post-fix shape from POST /api/license/validate on a DB fault. */
function validationUnavailable(): Response {
  return jsonResponse(
    { valid: false, status: 'service_unavailable', retryable: true, error: 'temporary' },
    503,
  );
}

function heartbeatUnavailable(): Response {
  return jsonResponse(
    { valid: false, status: 'service_unavailable', retryable: true, next_heartbeat_seconds: 0 },
    503,
  );
}

function rateLimited(): Response {
  return jsonResponse({ valid: false, status: 'rate_limited', error: 'Too many requests' }, 429);
}

/** A reverse proxy's HTML error page — not JSON at all. */
function proxyErrorPage(): Response {
  return new Response('<html><body>502 Bad Gateway</body></html>', {
    status: 502,
    headers: { 'Content-Type': 'text/html', Date: new Date().toUTCString() },
  });
}

function deactivateOk(): Response {
  return jsonResponse({ success: true });
}

function deactivateUnavailable(): Response {
  return jsonResponse({ success: false, error: 'temporary deactivation fault' }, 503);
}

function sdk(overrides: Partial<SomniLicenseConfig> = {}): SomniLicense {
  return new SomniLicense({
    apiBase: 'https://dash.test/api',
    licenseKey: 'SMNI-AAAA-BBBB-CCCC',
    productId: 'prod-1',
    ...overrides,
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

// ─── Setup ───────────────────────────────────────────

beforeEach(() => {
  // Must fake 'performance' too — the SDK uses performance.now() as its
  // monotonic clock for cache TTL and offline grace. Without this,
  // vi.advanceTimersByTime only moves Date.now and timer callbacks.
  vi.useFakeTimers({
    toFake: [
      'setTimeout', 'clearTimeout',
      'setInterval', 'clearInterval',
      'Date',
      'performance',
    ],
  });
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─── Tests ───────────────────────────────────────────

describe('SomniLicense', () => {
  // ────────── validation basics ──────────

  describe('validate() — network success', () => {
    it('sends the correct payload shape to /license/validate', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(validationOk());
      const client = sdk({ deviceFingerprint: 'fp-1', appVersion: '2.0.0' });
      await client.validate();

      const [url, init] = vi.mocked(fetch).mock.calls[0];
      expect(url).toBe('https://dash.test/api/license/validate');
      const body = JSON.parse(init!.body as string);
      expect(body).toMatchObject({
        license_key: 'SMNI-AAAA-BBBB-CCCC',
        product_id: 'prod-1',
        device_fingerprint: 'fp-1',
        app_version: '2.0.0',
      });
    });

    it('exposes valid state, features, tier, and session after success', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(validationOk());
      const client = sdk();
      const res = await client.validate();

      expect(res.valid).toBe(true);
      expect(res.features).toEqual(['auto-mod', 'music']);
      expect(client.isValid()).toBe(true);
      expect(client.getFeatures()).toEqual(['auto-mod', 'music']);
      expect(client.getTier()).toBe('pro');
      expect(client.getSessionId()).toBe('sess-aaa');
    });

    it('does not cache an invalid response', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(validationInvalid());
      const client = sdk();
      const res = await client.validate();

      expect(res.valid).toBe(false);
      expect(client.isValid()).toBe(false);
      expect(client.getSessionId()).toBeNull();
      expect(client.getFeatures()).toEqual([]);
    });
  });

  // ────────── indeterminate vs terminal ──────────
  //
  // "We could not determine your licence status" must be a different,
  // NON-TERMINAL outcome from "this licence is revoked". A transient server
  // fault must not stop heartbeats permanently or tell a paying customer they
  // are revoked.

  describe('indeterminate responses are not verdicts', () => {
    it('does not surface a 500 body claiming "revoked" as a revocation', async () => {
      // Regression: the SDK never checked res.ok, so the dashboard's
      // `500 {valid:false,status:'revoked'}` on an RPC error reached the app
      // verbatim as a revocation.
      vi.mocked(fetch).mockResolvedValueOnce(serverError());
      const client = sdk();

      const res = await client.validate();
      expect(res.status).not.toBe('revoked');
      expect(res.status).toBe('service_unavailable');
      expect(res.retryable).toBe(true);
    });

    it('keeps serving the cached validation through a service fault', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(validationOk())
        .mockResolvedValueOnce(validationUnavailable());
      const client = sdk({ cacheTtlMs: 1_000, offlineGraceMs: 3_600_000 });

      await client.validate();
      vi.advanceTimersByTime(2_000); // TTL expired → real refetch

      const res = await client.validate();
      expect(res.valid).toBe(true);
      expect(res.status).toBe('offline_grace');
      // The cache itself survived — the fault cleared nothing. (isValid() is
      // TTL-gated and is expected to be false here; the offline-grace window is
      // what keeps the customer working, exactly as for a network outage.)
      expect(client.getFeatures()).toEqual(['auto-mod', 'music']);
      expect(client.getSessionId()).toBe('sess-aaa');
    });

    it('treats a 429 rate limit as undetermined, not invalid', async () => {
      // A rate-limited response says nothing about the licence — and
      // licenseValidate is limited per IP, so a NAT'd office or a
      // mis-derived client IP must not read as "your licence is bad".
      vi.mocked(fetch)
        .mockResolvedValueOnce(validationOk())
        .mockResolvedValueOnce(rateLimited());
      const client = sdk({ cacheTtlMs: 1_000, offlineGraceMs: 3_600_000 });

      await client.validate();
      vi.advanceTimersByTime(2_000);

      const res = await client.validate();
      expect(res.valid).toBe(true);
      expect(res.status).toBe('offline_grace');
    });

    it('treats an unparseable proxy error page as undetermined', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(proxyErrorPage());
      const client = sdk();

      const res = await client.validate();
      expect(res.valid).toBe(false);
      expect(res.status).toBe('service_unavailable');
    });

    it('a service fault does NOT stop the heartbeat timer', async () => {
      // The core of the bug: heartbeat() treated every `!valid` as terminal,
      // so one bad response killed the timer until validate() was called
      // again — which the app has no reason to do.
      vi.mocked(fetch)
        .mockResolvedValueOnce(validationOk()) // starts a 120s heartbeat
        .mockResolvedValue(heartbeatUnavailable());
      const client = sdk();

      await client.validate();
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      const hb = await client.heartbeat();
      expect(hb.valid).toBe(true); // covered by offline grace
      expect(hb.status).toBe('offline');

      // Timer still armed, and it keeps firing.
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      const before = vi.mocked(fetch).mock.calls.length;
      await vi.advanceTimersByTimeAsync(130_000);
      expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(before);

      client.destroy();
    });

    it('recovers on its own once the fault clears', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(validationOk())
        .mockResolvedValueOnce(heartbeatUnavailable())
        .mockResolvedValueOnce(heartbeatOk());
      const client = sdk();

      await client.validate();
      await client.heartbeat(); // fault
      const recovered = await client.heartbeat();

      expect(recovered.valid).toBe(true);
      expect(recovered.status).toBe('active');
      expect(client.isValid()).toBe(true);
    });

    it('a real revocation is still terminal', async () => {
      // The other side of the split: a genuine verdict must keep its teeth.
      vi.mocked(fetch)
        .mockResolvedValueOnce(validationOk())
        .mockResolvedValueOnce(heartbeatRevoked());
      const client = sdk();

      await client.validate();
      expect(client.isValid()).toBe(true);

      const hb = await client.heartbeat();
      expect(hb.valid).toBe(false);
      expect(hb.status).toBe('revoked');
      expect(client.isValid()).toBe(false);
      expect(client.getSessionId()).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('a terminal validation clears the prior session and cannot fall back to its valid cache', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(validationOk())
        .mockResolvedValueOnce(validationSessionInvalidated())
        .mockRejectedValueOnce(new Error('offline after revocation'));
      const client = sdk({ cacheTtlMs: 1_000, offlineGraceMs: 3_600_000 });

      await client.validate();
      expect(client.isValid()).toBe(true);
      expect(client.getSessionId()).toBe('sess-aaa');
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      vi.advanceTimersByTime(2_000);
      const revoked = await client.validate();
      expect(revoked).toMatchObject({
        valid: false,
        status: 'session_invalidated',
      });
      expect(client.isValid()).toBe(false);
      expect(client.getSessionId()).toBeNull();
      expect(client.getFeatures()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);

      const offline = await client.validate();
      expect(offline.valid).toBe(false);
      expect(offline.status).toBe('network_error');
      expect(offline.status).not.toBe('offline_grace');
    });

    it('does not let an older validation success overwrite a terminal validation', async () => {
      const olderValidResponse = deferred<Response>();
      const terminalResponse = deferred<Response>();
      vi.mocked(fetch)
        .mockImplementationOnce(() => olderValidResponse.promise)
        .mockImplementationOnce(() => terminalResponse.promise);
      const client = sdk();

      const olderValidation = client.validate();
      const terminalValidation = client.validate();

      terminalResponse.resolve(validationSessionInvalidated());
      expect(await terminalValidation).toMatchObject({
        valid: false,
        status: 'session_invalidated',
      });

      olderValidResponse.resolve(validationOk());
      expect(await olderValidation).toMatchObject({
        valid: false,
        status: 'session_invalidated',
      });
      expect(client.isValid()).toBe(false);
      expect(client.getSessionId()).toBeNull();
      expect(client.getFeatures()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps a later terminal validation authoritative when the valid response arrives first', async () => {
      const validResponse = deferred<Response>();
      const terminalResponse = deferred<Response>();
      vi.mocked(fetch)
        .mockImplementationOnce(() => validResponse.promise)
        .mockImplementationOnce(() => terminalResponse.promise);
      const client = sdk();

      const validValidation = client.validate();
      const terminalValidation = client.validate();

      validResponse.resolve(validationOk());
      expect((await validValidation).valid).toBe(true);
      expect(client.isValid()).toBe(true);

      terminalResponse.resolve(validationSessionInvalidated());
      expect((await terminalValidation).valid).toBe(false);
      expect(client.isValid()).toBe(false);
      expect(client.getSessionId()).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps a terminal validation authoritative when it completes after a newer success', async () => {
      const terminalResponse = deferred<Response>();
      const newerValidResponse = deferred<Response>();
      vi.mocked(fetch)
        .mockImplementationOnce(() => terminalResponse.promise)
        .mockImplementationOnce(() => newerValidResponse.promise);
      const client = sdk();

      const terminalValidation = client.validate();
      const newerValidation = client.validate();

      newerValidResponse.resolve(validationOk());
      expect((await newerValidation).valid).toBe(true);
      expect(client.isValid()).toBe(true);

      terminalResponse.resolve(validationSessionInvalidated());
      expect((await terminalValidation).valid).toBe(false);
      expect(client.isValid()).toBe(false);
      expect(client.getSessionId()).toBeNull();
      expect(client.getFeatures()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('does not let a pending newer validation resurrect after a terminal validation completes first', async () => {
      const terminalResponse = deferred<Response>();
      const newerValidResponse = deferred<Response>();
      vi.mocked(fetch)
        .mockImplementationOnce(() => terminalResponse.promise)
        .mockImplementationOnce(() => newerValidResponse.promise);
      const client = sdk();

      const terminalValidation = client.validate();
      const newerValidation = client.validate();

      terminalResponse.resolve(validationSessionInvalidated());
      expect((await terminalValidation).valid).toBe(false);
      expect(client.getSessionId()).toBeNull();

      newerValidResponse.resolve(validationOk());
      expect(await newerValidation).toMatchObject({
        valid: false,
        status: 'session_invalidated',
      });
      expect(client.isValid()).toBe(false);
      expect(client.getSessionId()).toBeNull();
      expect(client.getFeatures()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('does not let an older validation success overwrite a terminal heartbeat', async () => {
      const delayedValidationResponse = deferred<Response>();
      const terminalHeartbeatResponse = deferred<Response>();
      vi.mocked(fetch)
        .mockResolvedValueOnce(validationOk())
        .mockImplementationOnce(() => delayedValidationResponse.promise)
        .mockImplementationOnce(() => terminalHeartbeatResponse.promise);
      const client = sdk({ cacheTtlMs: 1_000 });

      await client.validate();
      vi.advanceTimersByTime(2_000);

      const delayedValidation = client.validate();
      const terminalHeartbeat = client.heartbeat();

      terminalHeartbeatResponse.resolve(heartbeatRevoked());
      expect((await terminalHeartbeat).valid).toBe(false);

      delayedValidationResponse.resolve(validationOk());
      expect(await delayedValidation).toMatchObject({
        valid: false,
        status: 'session_invalidated',
      });
      expect(client.isValid()).toBe(false);
      expect(client.getSessionId()).toBeNull();
      expect(client.getFeatures()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps a later terminal heartbeat authoritative when validation completes first', async () => {
      const validResponse = deferred<Response>();
      const terminalHeartbeatResponse = deferred<Response>();
      vi.mocked(fetch)
        .mockResolvedValueOnce(validationOk())
        .mockImplementationOnce(() => validResponse.promise)
        .mockImplementationOnce(() => terminalHeartbeatResponse.promise);
      const client = sdk({ cacheTtlMs: 1_000 });

      await client.validate();
      vi.advanceTimersByTime(2_000);

      const validation = client.validate();
      const terminalHeartbeat = client.heartbeat();

      validResponse.resolve(validationOk());
      expect((await validation).valid).toBe(true);

      terminalHeartbeatResponse.resolve(heartbeatRevoked());
      expect((await terminalHeartbeat).valid).toBe(false);
      expect(client.isValid()).toBe(false);
      expect(client.getSessionId()).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('does not let a delayed terminal heartbeat for session A clear a newer revalidated session B', async () => {
      const terminalHeartbeatResponse = deferred<Response>();
      const revalidationResponse = deferred<Response>();
      vi.mocked(fetch)
        .mockResolvedValueOnce(validationOk({ session_id: 'sess-a' }))
        .mockImplementationOnce(() => terminalHeartbeatResponse.promise)
        .mockImplementationOnce(() => revalidationResponse.promise);
      const client = sdk({ cacheTtlMs: 1_000 });
      await client.validate();
      vi.advanceTimersByTime(2_000);

      const terminalHeartbeat = client.heartbeat();
      const revalidation = client.validate();

      revalidationResponse.resolve(
        validationOk({ session_id: 'sess-b', tier: 'business' }),
      );
      expect((await revalidation).valid).toBe(true);

      terminalHeartbeatResponse.resolve(heartbeatRevoked());
      expect((await terminalHeartbeat).valid).toBe(false);
      expect(client.getSessionId()).toBe('sess-b');
      expect(client.getTier()).toBe('business');
      expect(client.isValid()).toBe(true);
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      client.destroy();
    });

    it('does not let a pending revalidation resurrect after a terminal heartbeat completes first', async () => {
      const terminalHeartbeatResponse = deferred<Response>();
      const revalidationResponse = deferred<Response>();
      vi.mocked(fetch)
        .mockResolvedValueOnce(validationOk({ session_id: 'sess-a' }))
        .mockImplementationOnce(() => terminalHeartbeatResponse.promise)
        .mockImplementationOnce(() => revalidationResponse.promise);
      const client = sdk({ cacheTtlMs: 1_000 });
      await client.validate();
      vi.advanceTimersByTime(2_000);

      const terminalHeartbeat = client.heartbeat();
      const revalidation = client.validate();

      terminalHeartbeatResponse.resolve(heartbeatRevoked());
      expect((await terminalHeartbeat).valid).toBe(false);
      expect(client.getSessionId()).toBeNull();

      revalidationResponse.resolve(
        validationOk({ session_id: 'sess-b', tier: 'business' }),
      );
      expect(await revalidation).toMatchObject({
        valid: false,
        status: 'session_invalidated',
      });
      expect(client.getSessionId()).toBeNull();
      expect(client.isValid()).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('does not re-anchor server time on a fault (grace still expires)', async () => {
      // If the SDK anchored server time on failed responses, a server stuck at
      // 503 would reset the offline window on every retry and the grace period
      // would never end. The window must keep running down.
      vi.mocked(fetch)
        .mockResolvedValueOnce(validationOk())
        .mockResolvedValue(validationUnavailable());
      const client = sdk({ cacheTtlMs: 1_000, offlineGraceMs: 60_000 });

      await client.validate();

      vi.advanceTimersByTime(30_000);
      expect((await client.validate()).valid).toBe(true); // still inside grace

      vi.advanceTimersByTime(40_000); // 70s total > 60s grace
      const expired = await client.validate();
      expect(expired.valid).toBe(false);
      expect(expired.status).toBe('offline_grace_expired');
    });
  });

  // ────────── monotonic cache TTL ──────────

  describe('validate() — cache TTL (monotonic clock)', () => {
    it('serves the cached result while within TTL', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(validationOk());
      const client = sdk({ cacheTtlMs: 30_000 });

      await client.validate();
      vi.advanceTimersByTime(20_000); // 20s < 30s TTL
      const cached = await client.validate();

      expect(fetch).toHaveBeenCalledTimes(1); // no second fetch
      expect(cached.valid).toBe(true);
    });

    it('re-fetches once the monotonic TTL expires', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(validationOk({ tier: 'pro' }))
        .mockResolvedValueOnce(validationOk({ tier: 'enterprise' }));
      const client = sdk({ cacheTtlMs: 10_000 });

      const first = await client.validate();
      expect(first.tier).toBe('pro');

      vi.advanceTimersByTime(11_000);
      const second = await client.validate();
      expect(second.tier).toBe('enterprise');
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('isValid() transitions to false after TTL expires (no refetch)', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(validationOk());
      const client = sdk({ cacheTtlMs: 5_000 });

      await client.validate();
      expect(client.isValid()).toBe(true);

      vi.advanceTimersByTime(6_000);
      expect(client.isValid()).toBe(false);
    });
  });

  // ────────── grace-period deadline caps the cache ──────────

  describe('validate() — grace deadline caps the cache (W2 review)', () => {
    // Pin the fake clock to a whole second: the HTTP Date header (the
    // server-time anchor) has 1s precision, so a sub-second start time
    // would skew the deadline-to-monotonic conversion by up to 999ms.
    const T0 = new Date('2026-07-09T12:00:00.000Z');

    it('re-validates once the grace deadline passes, even within the cache TTL', async () => {
      vi.setSystemTime(T0);
      vi.mocked(fetch)
        .mockResolvedValueOnce(
          validationOk({
            status: 'grace_period',
            grace_period_ends_at: new Date(Date.now() + 10_000).toISOString(),
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({ valid: false, status: 'expired', error: 'Payment grace period has ended' }),
        );
      const client = sdk({ cacheTtlMs: 60_000 });

      const first = await client.validate();
      expect(first.valid).toBe(true);
      expect(first.status).toBe('grace_period');

      // 12s later: past the 10s grace deadline but well inside the 60s TTL.
      // Must NOT serve the cached grace success — the server has revoked.
      vi.advanceTimersByTime(12_000);
      const second = await client.validate();

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(second.valid).toBe(false);
      expect(second.status).toBe('expired');
      client.destroy();
    });

    it('still serves the cached result before the grace deadline', async () => {
      vi.setSystemTime(T0);
      vi.mocked(fetch).mockResolvedValueOnce(
        validationOk({
          status: 'grace_period',
          grace_period_ends_at: new Date(Date.now() + 30_000).toISOString(),
        }),
      );
      const client = sdk({ cacheTtlMs: 60_000 });

      await client.validate();
      vi.advanceTimersByTime(20_000); // < 30s deadline
      const cached = await client.validate();

      expect(fetch).toHaveBeenCalledTimes(1); // no second fetch
      expect(cached.valid).toBe(true);
      expect(cached.status).toBe('grace_period');
      client.destroy();
    });

    it('a distant grace deadline never EXTENDS the cache past the TTL (min, not max)', async () => {
      vi.setSystemTime(T0);
      vi.mocked(fetch)
        .mockResolvedValueOnce(
          validationOk({
            status: 'grace_period',
            grace_period_ends_at: new Date(Date.now() + 3_600_000).toISOString(),
          }),
        )
        .mockResolvedValueOnce(validationOk());
      const client = sdk({ cacheTtlMs: 10_000 });

      await client.validate();
      vi.advanceTimersByTime(11_000); // past TTL, far before deadline
      await client.validate();

      expect(fetch).toHaveBeenCalledTimes(2);
      client.destroy();
    });

    it('isValid() flips false at the grace deadline (no refetch)', async () => {
      vi.setSystemTime(T0);
      vi.mocked(fetch).mockResolvedValueOnce(
        validationOk({
          status: 'grace_period',
          grace_period_ends_at: new Date(Date.now() + 5_000).toISOString(),
        }),
      );
      const client = sdk({ cacheTtlMs: 60_000 });

      await client.validate();
      expect(client.isValid()).toBe(true);

      vi.advanceTimersByTime(6_000);
      expect(client.isValid()).toBe(false);
      client.destroy();
    });

    it('an unparseable grace deadline falls back to the plain TTL', async () => {
      vi.setSystemTime(T0);
      vi.mocked(fetch).mockResolvedValueOnce(
        validationOk({ status: 'grace_period', grace_period_ends_at: 'not-a-date' }),
      );
      const client = sdk({ cacheTtlMs: 30_000 });

      await client.validate();
      vi.advanceTimersByTime(20_000); // within TTL
      const cached = await client.validate();

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(cached.valid).toBe(true);
      client.destroy();
    });
  });

  // ────────── grace deadline is a hard stop for OFFLINE fallback ──────────

  describe('offline fallback honors the grace deadline (W2 review)', () => {
    // Same whole-second pin as the cache-cap block: the Date-header anchor
    // has 1s precision.
    const T0 = new Date('2026-07-09T12:00:00.000Z');

    it('validate() offline path rejects a cached grace success once its deadline passes, even inside offlineGraceMs', async () => {
      vi.setSystemTime(T0);
      vi.mocked(fetch)
        .mockResolvedValueOnce(
          validationOk({
            status: 'grace_period',
            grace_period_ends_at: new Date(Date.now() + 10_000).toISOString(),
          }),
        )
        // Revalidation (fired because the cache is capped at the 10s deadline)
        // fails — client went offline right after the payment cutoff.
        .mockRejectedValueOnce(new Error('offline'));
      // offlineGraceMs (1h) is far longer than the 10s grace deadline: the
      // deadline must win.
      const client = sdk({ cacheTtlMs: 60_000, offlineGraceMs: 3_600_000 });

      await client.validate();
      vi.advanceTimersByTime(12_000); // past the 10s grace deadline

      const offline = await client.validate();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(offline.valid).toBe(false);
      expect(offline.status).toBe('offline_grace_expired');
      expect(client.isValid()).toBe(false); // cache cleared
      client.destroy();
    });

    it('validate() offline path still serves offline_grace BEFORE the grace deadline', async () => {
      vi.setSystemTime(T0);
      vi.mocked(fetch)
        .mockResolvedValueOnce(
          validationOk({
            status: 'grace_period',
            grace_period_ends_at: new Date(Date.now() + 60_000).toISOString(),
          }),
        )
        .mockRejectedValueOnce(new Error('offline'));
      const client = sdk({ cacheTtlMs: 1_000, offlineGraceMs: 3_600_000 });

      await client.validate();
      vi.advanceTimersByTime(2_000); // past cache TTL, well before 60s deadline

      const offline = await client.validate();
      expect(offline.valid).toBe(true);
      expect(offline.status).toBe('offline_grace');
      client.destroy();
    });

    it('heartbeat() offline path rejects once the grace deadline passes, even inside offlineGraceMs', async () => {
      vi.setSystemTime(T0);
      vi.mocked(fetch)
        .mockResolvedValueOnce(
          validationOk({
            status: 'grace_period',
            grace_period_ends_at: new Date(Date.now() + 10_000).toISOString(),
          }),
        )
        .mockRejectedValueOnce(new Error('offline'));
      const client = sdk({ offlineGraceMs: 3_600_000 });
      await client.validate();

      vi.advanceTimersByTime(12_000); // past the 10s grace deadline
      const hb = await client.heartbeat();
      expect(hb.valid).toBe(false);
      expect(hb.status).toBe('offline_grace_expired');
      client.destroy();
    });

    it('heartbeat() offline path still returns offline BEFORE the grace deadline', async () => {
      vi.setSystemTime(T0);
      vi.mocked(fetch)
        .mockResolvedValueOnce(
          validationOk({
            status: 'grace_period',
            grace_period_ends_at: new Date(Date.now() + 60_000).toISOString(),
          }),
        )
        .mockRejectedValueOnce(new Error('offline'));
      const client = sdk({ offlineGraceMs: 3_600_000 });
      await client.validate();

      vi.advanceTimersByTime(20_000); // before the 60s deadline
      const hb = await client.heartbeat();
      expect(hb.valid).toBe(true);
      expect(hb.status).toBe('offline');
      client.destroy();
    });

    it('a healthy (non-grace) offline grace is unaffected — no deadline stop', async () => {
      vi.setSystemTime(T0);
      vi.mocked(fetch)
        .mockResolvedValueOnce(validationOk()) // status 'active', no deadline
        .mockRejectedValueOnce(new Error('offline'));
      const client = sdk({ cacheTtlMs: 1_000, offlineGraceMs: 60_000 });

      await client.validate();
      vi.advanceTimersByTime(2_000);
      const offline = await client.validate();
      expect(offline.valid).toBe(true);
      expect(offline.status).toBe('offline_grace');
      client.destroy();
    });
  });

  // ── unanchored grace deadline (no Date header) is not trusted (W2 P3) ──

  describe('unanchored grace deadline is non-cacheable + offline hard-stop (W2 P3)', () => {
    /** Grace response WITHOUT a Date header, so no server-time anchor exists. */
    function graceNoDateHeader(deadlineMsFromNow: number): Response {
      return new Response(
        JSON.stringify({
          valid: true,
          status: 'grace_period',
          entitlement_id: 'ent-001',
          session_id: 'sess-aaa',
          grace_period_ends_at: new Date(Date.now() + deadlineMsFromNow).toISOString(),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }, // no Date
      );
    }

    it('does not serve an unanchored grace response from cache — forces revalidation', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(graceNoDateHeader(3_600_000)) // 1h "deadline"
        .mockResolvedValueOnce(validationOk());
      const client = sdk({ cacheTtlMs: 60_000 });

      await client.validate();
      // No time advance: the very next call must still hit the network because
      // an unanchored grace deadline is treated as non-cacheable.
      await client.validate();

      expect(fetch).toHaveBeenCalledTimes(2);
      client.destroy();
    });

    it('offline fallback rejects when the cached grace was unanchored, regardless of offlineGraceMs', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(graceNoDateHeader(3_600_000)) // far-future "deadline"
        .mockRejectedValueOnce(new Error('offline'));
      const client = sdk({ cacheTtlMs: 60_000, offlineGraceMs: 3_600_000 });

      await client.validate();
      // Immediately go offline: the unanchored deadline is treated as already
      // lapsed, so the offline path must reject rather than ride out the 1h
      // offline window on an unverifiable deadline.
      const offline = await client.validate();
      expect(offline.valid).toBe(false);
      expect(offline.status).toBe('offline_grace_expired');
      client.destroy();
    });
  });

  // ────────── offline grace period ──────────

  describe('validate() — offline grace (server-time anchored)', () => {
    it('returns offline_grace when network fails within grace window', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(validationOk())
        .mockRejectedValueOnce(new Error('dns fail'));
      const client = sdk({ cacheTtlMs: 1_000, offlineGraceMs: 60_000 });

      await client.validate(); // anchors server time
      vi.advanceTimersByTime(2_000); // past cache, within grace

      const offline = await client.validate();
      expect(offline.valid).toBe(true);
      expect(offline.status).toBe('offline_grace');
    });

    it('returns offline_grace_expired when grace period elapses', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(validationOk())
        .mockRejectedValueOnce(new Error('dns fail'));
      const client = sdk({ cacheTtlMs: 1_000, offlineGraceMs: 5_000 });

      await client.validate();
      vi.advanceTimersByTime(6_000); // past grace

      const expired = await client.validate();
      expect(expired.valid).toBe(false);
      expect(expired.status).toBe('offline_grace_expired');
    });

    it('clears cache after grace expiry so subsequent calls get network_error', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(validationOk())
        .mockRejectedValue(new Error('offline'));
      const client = sdk({ cacheTtlMs: 1_000, offlineGraceMs: 3_000 });

      await client.validate();
      vi.advanceTimersByTime(4_000);
      await client.validate(); // triggers grace expiry + cache clear

      const third = await client.validate();
      expect(third.status).toBe('network_error'); // no cached result left
    });

    it('returns network_error on first-ever failure (no anchor)', async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const client = sdk();

      const res = await client.validate();
      expect(res.valid).toBe(false);
      expect(res.status).toBe('network_error');
      expect(res.error).toBe('ECONNREFUSED');
    });
  });

  // ────────── heartbeat ──────────

  describe('heartbeat()', () => {
    it('returns no_session when validate() has not been called', async () => {
      const client = sdk();
      const hb = await client.heartbeat();

      expect(hb.valid).toBe(false);
      expect(hb.status).toBe('no_session');
    });

    it('sends session_id and license_key to /license/heartbeat', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(validationOk({ session_id: 'sess-xyz' }))
        .mockResolvedValueOnce(heartbeatOk());
      const client = sdk();
      await client.validate();

      await client.heartbeat();
      const [url, init] = vi.mocked(fetch).mock.calls[1];
      expect(url).toBe('https://dash.test/api/license/heartbeat');
      const body = JSON.parse(init!.body as string);
      expect(body.session_id).toBe('sess-xyz');
      expect(body.license_key).toBe('SMNI-AAAA-BBBB-CCCC');
    });

    it('invalidates session on a revoked heartbeat response', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(validationOk())
        .mockResolvedValueOnce(heartbeatRevoked());
      const client = sdk();
      await client.validate();
      expect(client.isValid()).toBe(true);

      await client.heartbeat();
      expect(client.isValid()).toBe(false); // cache cleared
    });

    it('returns offline within grace period on heartbeat network error', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(validationOk())
        .mockRejectedValueOnce(new Error('timeout'));
      const client = sdk({ offlineGraceMs: 60_000 });
      await client.validate();

      const hb = await client.heartbeat();
      expect(hb.valid).toBe(true);
      expect(hb.status).toBe('offline');
      expect(hb.next_heartbeat_seconds).toBe(300); // fallback retry
    });

    it('expires on heartbeat network error when past grace period', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(validationOk())
        .mockRejectedValueOnce(new Error('timeout'));
      const client = sdk({ offlineGraceMs: 2_000 });
      await client.validate();

      vi.advanceTimersByTime(3_000); // past grace
      const hb = await client.heartbeat();
      expect(hb.valid).toBe(false);
      expect(hb.status).toBe('offline_grace_expired');
    });

    it.each([
      ['service_unavailable', () => heartbeatUnavailable()],
      ['rate_limited', () => jsonResponse({
        valid: false,
        status: 'rate_limited',
        next_heartbeat_seconds: 0,
      }, 429)],
    ])(
      'reports offline_grace_expired when an indeterminate %s heartbeat arrives after grace',
      async (_status, response) => {
        vi.mocked(fetch)
          .mockResolvedValueOnce(validationOk())
          .mockResolvedValueOnce(response());
        const client = sdk({ offlineGraceMs: 2_000 });
        await client.validate();

        vi.advanceTimersByTime(3_000);
        const heartbeat = await client.heartbeat();

        expect(heartbeat.valid).toBe(false);
        expect(heartbeat.status).toBe('offline_grace_expired');
        expect(client.getSessionId()).toBeNull();
        expect(client.isValid()).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
      },
    );

    it('surfaces a grace_period status + deadline reported by the heartbeat (grace entered mid-session)', async () => {
      const T0 = new Date('2026-07-09T12:00:00.000Z');
      vi.setSystemTime(T0);
      vi.mocked(fetch)
        .mockResolvedValueOnce(validationOk()) // validate: healthy 'active'
        .mockResolvedValueOnce(heartbeatGrace(60_000)); // heartbeat: now in grace
      const client = sdk();
      await client.validate();

      const hb = await client.heartbeat();
      expect(hb.valid).toBe(true);
      expect(hb.status).toBe('grace_period');
      expect(hb.grace_period_ends_at).toBeTruthy();
      client.destroy();
    });

    it('a grace heartbeat records the offline hard-stop even though validate() never saw grace', async () => {
      const T0 = new Date('2026-07-09T12:00:00.000Z');
      vi.setSystemTime(T0);
      vi.mocked(fetch)
        .mockResolvedValueOnce(validationOk())        // healthy validate → no deadline
        .mockResolvedValueOnce(heartbeatGrace(10_000)) // grace begins, 10s deadline
        .mockRejectedValueOnce(new Error('offline'));  // next heartbeat offline
      const client = sdk({ offlineGraceMs: 3_600_000 });
      await client.validate();
      await client.heartbeat(); // records the 10s grace deadline as the stop

      vi.advanceTimersByTime(12_000); // past the grace deadline
      const hb = await client.heartbeat();
      // Offline window is 1h, but the grace deadline (10s) is the hard stop.
      expect(hb.valid).toBe(false);
      expect(hb.status).toBe('offline_grace_expired');
      client.destroy();
    });

    it('caps the ONLINE validate() cache at a grace deadline learned via heartbeat', async () => {
      const T0 = new Date('2026-07-09T12:00:00.000Z');
      vi.setSystemTime(T0);
      vi.mocked(fetch)
        .mockResolvedValueOnce(validationOk())         // validate: healthy 'active'
        .mockResolvedValueOnce(heartbeatGrace(10_000)) // heartbeat: grace, 10s deadline
        .mockResolvedValueOnce(                          // forced revalidation past deadline
          jsonResponse({ valid: false, status: 'expired', error: 'Payment grace period has ended' }),
        );
      // Long cache TTL: without the cap, the stale 'active' cache would ride out
      // the full hour past the 10s grace deadline.
      const client = sdk({ cacheTtlMs: 3_600_000 });
      await client.validate();
      await client.heartbeat(); // learns grace + 10s deadline

      vi.advanceTimersByTime(12_000); // past the 10s deadline, far inside the 1h TTL
      const revalidated = await client.validate();

      expect(fetch).toHaveBeenCalledTimes(3); // validate + heartbeat + forced revalidation
      expect(revalidated.valid).toBe(false);
      expect(revalidated.status).toBe('expired');
      client.destroy();
    });

    it('surfaces grace_period from cache after a grace heartbeat, before the deadline', async () => {
      const T0 = new Date('2026-07-09T12:00:00.000Z');
      vi.setSystemTime(T0);
      vi.mocked(fetch)
        .mockResolvedValueOnce(validationOk())          // validate: healthy 'active'
        .mockResolvedValueOnce(heartbeatGrace(60_000)); // heartbeat: grace, 60s deadline
      const client = sdk({ cacheTtlMs: 3_600_000 });
      await client.validate();
      await client.heartbeat();

      vi.advanceTimersByTime(20_000); // well before the 60s deadline
      const cached = await client.validate();

      expect(fetch).toHaveBeenCalledTimes(2); // still cached — no third fetch
      expect(cached.valid).toBe(true);
      expect(cached.status).toBe('grace_period'); // cache rewritten to reflect grace
      expect(cached.grace_period_ends_at).toBeTruthy();
      client.destroy();
    });

    it('isValid() flips false at a grace deadline learned via heartbeat (no refetch)', async () => {
      const T0 = new Date('2026-07-09T12:00:00.000Z');
      vi.setSystemTime(T0);
      vi.mocked(fetch)
        .mockResolvedValueOnce(validationOk())
        .mockResolvedValueOnce(heartbeatGrace(5_000)); // 5s deadline
      const client = sdk({ cacheTtlMs: 3_600_000 });
      await client.validate();
      await client.heartbeat();
      expect(client.isValid()).toBe(true);

      vi.advanceTimersByTime(6_000); // past the 5s deadline
      expect(client.isValid()).toBe(false); // capped, even though TTL is 1h
      client.destroy();
    });

    it('resets the cached status back to active when a heartbeat recovers from grace (W2 codex)', async () => {
      const T0 = new Date('2026-07-09T12:00:00.000Z');
      vi.setSystemTime(T0);
      vi.mocked(fetch)
        .mockResolvedValueOnce(validationOk())          // validate: healthy 'active'
        .mockResolvedValueOnce(heartbeatGrace(3_600_000)) // grace begins, 1h deadline → cache rewritten to grace
        .mockResolvedValueOnce(heartbeatOk());          // payment recovers → heartbeat 'active'
      // Long TTL so the cache from the initial validate is still live throughout.
      const client = sdk({ cacheTtlMs: 3_600_000 });
      await client.validate();

      await client.heartbeat();                          // cache.status → 'grace_period'
      const graceCached = await client.validate();
      expect(fetch).toHaveBeenCalledTimes(2);            // served from cache
      expect(graceCached.status).toBe('grace_period');

      await client.heartbeat();                          // recovery → 'active'
      const recoveredCached = await client.validate();
      // Still cached (no extra fetch), but the stale grace payload must be gone:
      // apps that treat status !== 'active' as unhealthy would otherwise keep
      // restricting a recovered customer until the 1h TTL elapsed.
      expect(fetch).toHaveBeenCalledTimes(3);            // validate + 2 heartbeats, no re-validate
      expect(recoveredCached.valid).toBe(true);
      expect(recoveredCached.status).toBe('active');
      expect(recoveredCached.grace_period_ends_at).toBeNull();
      expect(client.isValid()).toBe(true);
      client.destroy();
    });

    it('keeps a newer grace heartbeat authoritative when a stale active heartbeat completes later', async () => {
      const T0 = new Date('2026-07-09T12:00:00.000Z');
      vi.setSystemTime(T0);
      const staleActiveResponse = deferred<Response>();
      const newerGraceResponse = deferred<Response>();
      vi.mocked(fetch)
        .mockResolvedValueOnce(validationOk())
        .mockImplementationOnce(() => staleActiveResponse.promise)
        .mockImplementationOnce(() => newerGraceResponse.promise);
      const client = sdk({ cacheTtlMs: 3_600_000 });
      await client.validate();

      const staleActive = client.heartbeat();
      const newerGrace = client.heartbeat();

      newerGraceResponse.resolve(heartbeatGrace(60_000));
      expect((await newerGrace).status).toBe('grace_period');

      staleActiveResponse.resolve(heartbeatOk());
      await staleActive;

      const cached = await client.validate();
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(cached.status).toBe('grace_period');
      expect(cached.grace_period_ends_at).toBeTruthy();
      client.destroy();
    });

    it('keeps a newer active heartbeat authoritative when a stale grace heartbeat completes later', async () => {
      const T0 = new Date('2026-07-09T12:00:00.000Z');
      vi.setSystemTime(T0);
      const staleGraceResponse = deferred<Response>();
      const newerActiveResponse = deferred<Response>();
      vi.mocked(fetch)
        .mockResolvedValueOnce(validationOk())
        .mockImplementationOnce(() => staleGraceResponse.promise)
        .mockImplementationOnce(() => newerActiveResponse.promise);
      const client = sdk({ cacheTtlMs: 3_600_000 });
      await client.validate();

      const staleGrace = client.heartbeat();
      const newerActive = client.heartbeat();

      newerActiveResponse.resolve(heartbeatOk());
      expect((await newerActive).status).toBe('active');

      staleGraceResponse.resolve(heartbeatGrace(60_000));
      await staleGrace;

      const cached = await client.validate();
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(cached.status).toBe('active');
      expect(cached.grace_period_ends_at).toBeNull();
      client.destroy();
    });
  });

  // ────────── heartbeat auto-scheduling ──────────

  describe('heartbeat scheduling', () => {
    it('auto-starts heartbeat timer after valid validation', async () => {
      vi.mocked(fetch).mockResolvedValue(validationOk({ heartbeat_interval_seconds: 60 }));
      const spy = vi.spyOn(globalThis, 'setInterval');
      const client = sdk();

      await client.validate();

      // Find the 60s heartbeat interval (in ms)
      const match = spy.mock.calls.find(([, ms]) => ms === 60_000);
      expect(match).toBeDefined();
      client.destroy();
    });

    it('clamps intervals below 30s to 30s', async () => {
      vi.mocked(fetch).mockResolvedValue(validationOk({ heartbeat_interval_seconds: 5 }));
      const spy = vi.spyOn(globalThis, 'setInterval');
      const client = sdk();

      await client.validate();

      // Must be 30_000, not 5_000
      expect(spy.mock.calls.some(([, ms]) => ms === 5_000)).toBe(false);
      expect(spy.mock.calls.some(([, ms]) => ms === 30_000)).toBe(true);
      client.destroy();
    });

    it('respects config heartbeatIntervalSeconds override', async () => {
      vi.mocked(fetch).mockResolvedValue(
        validationOk({ heartbeat_interval_seconds: 120 }),
      );
      const spy = vi.spyOn(globalThis, 'setInterval');
      const client = sdk({ heartbeatIntervalSeconds: 45 });

      await client.validate();

      // Config override (45s) wins over server (120s)
      expect(spy.mock.calls.some(([, ms]) => ms === 45_000)).toBe(true);
      expect(spy.mock.calls.some(([, ms]) => ms === 120_000)).toBe(false);
      client.destroy();
    });

    it('actually fires heartbeat fetch on interval tick', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(validationOk({ heartbeat_interval_seconds: 60 }))
        .mockResolvedValueOnce(heartbeatOk());
      const client = sdk();
      await client.validate();
      expect(fetch).toHaveBeenCalledTimes(1); // only validate

      vi.advanceTimersByTime(60_000); // trigger first heartbeat tick
      // The heartbeat call is async — let the microtask queue drain
      await vi.advanceTimersByTimeAsync(0);

      expect(fetch).toHaveBeenCalledTimes(2);
      const [url] = vi.mocked(fetch).mock.calls[1];
      expect(url).toBe('https://dash.test/api/license/heartbeat');
      client.destroy();
    });
  });

  // ────────── deactivation ──────────

  describe('deactivate()', () => {
    it('sends deactivation request and clears session', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(validationOk())
        .mockResolvedValueOnce(deactivateOk());
      const client = sdk();
      await client.validate();
      expect(client.getSessionId()).toBe('sess-aaa');

      const res = await client.deactivate();
      expect(res.success).toBe(true);
      expect(client.getSessionId()).toBeNull();
      expect(client.isValid()).toBe(false);
    });

    it('succeeds immediately when there is no active session', async () => {
      const client = sdk();
      const res = await client.deactivate();
      expect(res.success).toBe(true);
    });

    it('returns error on network failure during deactivation', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(validationOk())
        .mockRejectedValueOnce(new Error('reset'))
        .mockResolvedValueOnce(deactivateOk());
      const client = sdk();
      await client.validate();

      const res = await client.deactivate();
      expect(res.success).toBe(false);
      expect(res.error).toBe('reset');
      expect(client.getSessionId()).toBe('sess-aaa');
      expect(client.isValid()).toBe(true);
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      expect((await client.deactivate()).success).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(client.getSessionId()).toBeNull();
    });

    it('preserves the session and heartbeat after a parsed deactivation failure so retry can work', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(validationOk())
        .mockResolvedValueOnce(deactivateUnavailable())
        .mockResolvedValueOnce(deactivateOk());
      const client = sdk();
      await client.validate();

      const failed = await client.deactivate();
      expect(failed.success).toBe(false);
      expect(client.getSessionId()).toBe('sess-aaa');
      expect(client.isValid()).toBe(true);
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      expect((await client.deactivate()).success).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(client.getSessionId()).toBeNull();
    });

    it('does not let a delayed deactivation for session A clear a newer revalidated session B', async () => {
      const deactivationResponse = deferred<Response>();
      const revalidationResponse = deferred<Response>();
      vi.mocked(fetch)
        .mockResolvedValueOnce(validationOk({ session_id: 'sess-a' }))
        .mockImplementationOnce(() => deactivationResponse.promise)
        .mockImplementationOnce(() => revalidationResponse.promise);
      const client = sdk({ cacheTtlMs: 1_000 });
      await client.validate();
      vi.advanceTimersByTime(2_000);

      const deactivation = client.deactivate();
      const revalidation = client.validate();

      revalidationResponse.resolve(
        validationOk({ session_id: 'sess-b', tier: 'business' }),
      );
      expect((await revalidation).valid).toBe(true);
      expect(client.getSessionId()).toBe('sess-b');

      deactivationResponse.resolve(deactivateOk());
      expect((await deactivation).success).toBe(true);

      expect(client.getSessionId()).toBe('sess-b');
      expect(client.getTier()).toBe('business');
      expect(client.isValid()).toBe(true);
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      client.destroy();
    });

    it('does not let a delayed deactivation clear a newer reactivation that reused the same session row', async () => {
      const deactivationResponse = deferred<Response>();
      const revalidationResponse = deferred<Response>();
      vi.mocked(fetch)
        .mockResolvedValueOnce(validationOk({ session_id: 'sess-a' }))
        .mockImplementationOnce(() => deactivationResponse.promise)
        .mockImplementationOnce(() => revalidationResponse.promise);
      const client = sdk({ cacheTtlMs: 1_000 });
      await client.validate();
      vi.advanceTimersByTime(2_000);

      const deactivation = client.deactivate();
      const revalidation = client.validate();

      revalidationResponse.resolve(
        validationOk({ session_id: 'sess-a', tier: 'business' }),
      );
      expect((await revalidation).valid).toBe(true);
      expect(client.getSessionId()).toBe('sess-a');

      deactivationResponse.resolve(deactivateOk());
      expect((await deactivation).success).toBe(true);

      expect(client.getSessionId()).toBe('sess-a');
      expect(client.getTier()).toBe('business');
      expect(client.isValid()).toBe(true);
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      client.destroy();
    });

    it('keeps a later-started deactivation authoritative over an earlier same-row revalidation', async () => {
      const revalidationResponse = deferred<Response>();
      const deactivationResponse = deferred<Response>();
      vi.mocked(fetch)
        .mockResolvedValueOnce(validationOk({ session_id: 'sess-a' }))
        .mockImplementationOnce(() => revalidationResponse.promise)
        .mockImplementationOnce(() => deactivationResponse.promise);
      const client = sdk({ cacheTtlMs: 1_000 });
      await client.validate();
      vi.advanceTimersByTime(2_000);

      const revalidation = client.validate();
      const deactivation = client.deactivate();

      revalidationResponse.resolve(
        validationOk({ session_id: 'sess-a', tier: 'business' }),
      );
      expect((await revalidation).valid).toBe(true);
      expect(client.getTier()).toBe('business');

      deactivationResponse.resolve(deactivateOk());
      expect((await deactivation).success).toBe(true);

      expect(client.getSessionId()).toBeNull();
      expect(client.getTier()).toBeNull();
      expect(client.isValid()).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('does not let a pending revalidation resurrect after session A deactivation completes first', async () => {
      const deactivationResponse = deferred<Response>();
      const revalidationResponse = deferred<Response>();
      vi.mocked(fetch)
        .mockResolvedValueOnce(validationOk({ session_id: 'sess-a' }))
        .mockImplementationOnce(() => deactivationResponse.promise)
        .mockImplementationOnce(() => revalidationResponse.promise);
      const client = sdk({ cacheTtlMs: 1_000 });
      await client.validate();
      vi.advanceTimersByTime(2_000);

      const deactivation = client.deactivate();
      const revalidation = client.validate();

      deactivationResponse.resolve(deactivateOk());
      expect((await deactivation).success).toBe(true);
      expect(client.getSessionId()).toBeNull();

      revalidationResponse.resolve(
        validationOk({ session_id: 'sess-b', tier: 'business' }),
      );
      expect(await revalidation).toMatchObject({
        valid: false,
        status: 'session_invalidated',
      });

      expect(client.getSessionId()).toBeNull();
      expect(client.getTier()).toBeNull();
      expect(client.isValid()).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  // ────────── destroy / cleanup ──────────

  describe('destroy()', () => {
    it('clears the heartbeat interval', async () => {
      vi.mocked(fetch).mockResolvedValue(validationOk());
      const clearSpy = vi.spyOn(globalThis, 'clearInterval');
      const client = sdk();
      await client.validate();

      client.destroy();
      expect(clearSpy).toHaveBeenCalled();
    });

    it('is idempotent', () => {
      const client = sdk();
      expect(() => {
        client.destroy();
        client.destroy();
        client.destroy();
      }).not.toThrow();
    });

    it('prevents an in-flight validation from resurrecting state after destroy', async () => {
      const validationResponse = deferred<Response>();
      vi.mocked(fetch).mockImplementationOnce(() => validationResponse.promise);
      const client = sdk();

      const validation = client.validate();
      client.destroy();

      validationResponse.resolve(validationOk());
      expect(await validation).toMatchObject({
        valid: false,
        status: 'destroyed',
      });
      expect(client.getSessionId()).toBeNull();
      expect(client.isValid()).toBe(false);
      expect(client.getFeatures()).toEqual([]);
      expect(client.getTier()).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('permanently blocks future network operations after destroy', async () => {
      vi.mocked(fetch).mockResolvedValue(validationOk());
      const client = sdk();
      client.destroy();

      const validation = await client.validate();
      const heartbeat = await client.heartbeat();
      const deactivation = await client.deactivate();

      expect(validation).toMatchObject({ valid: false, status: 'destroyed' });
      expect(heartbeat).toMatchObject({ valid: false, status: 'destroyed' });
      expect(deactivation).toMatchObject({
        success: false,
        error: 'SomniLicense instance has been destroyed',
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(client.getSessionId()).toBeNull();
      expect(client.isValid()).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  // ────────── full lifecycle ──────────

  describe('end-to-end lifecycle', () => {
    it('validate → heartbeat → deactivate → clean state', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(validationOk())
        .mockResolvedValueOnce(heartbeatOk())
        .mockResolvedValueOnce(deactivateOk());
      const client = sdk({ cacheTtlMs: 5_000 });

      // Step 1: validate
      const v = await client.validate();
      expect(v.valid).toBe(true);
      expect(client.getSessionId()).toBe('sess-aaa');

      // Step 2: heartbeat
      const hb = await client.heartbeat();
      expect(hb.valid).toBe(true);

      // Step 3: deactivate
      const d = await client.deactivate();
      expect(d.success).toBe(true);

      // Everything clean
      expect(client.getSessionId()).toBeNull();
      expect(client.isValid()).toBe(false);
      expect(client.getFeatures()).toEqual([]);
      expect(client.getTier()).toBeNull();
    });

    it('a transient server fault does not end the customer\'s session', async () => {
      // The whole point, end to end: validate OK, then the licence server has
      // a bad minute (500 on validate, 503 on heartbeat), then it recovers.
      // The customer must never be told they are revoked and must never lose
      // their heartbeat loop.
      vi.mocked(fetch)
        .mockResolvedValueOnce(validationOk())
        .mockResolvedValueOnce(serverError())
        .mockResolvedValueOnce(heartbeatUnavailable())
        .mockResolvedValueOnce(heartbeatOk());
      const client = sdk({ cacheTtlMs: 1_000, offlineGraceMs: 3_600_000 });

      await client.validate();
      vi.advanceTimersByTime(2_000); // past the cache TTL, so this really refetches

      const duringFault = await client.validate();
      expect(duringFault.status).not.toBe('revoked');
      expect(duringFault.valid).toBe(true); // served from cache

      const hbDuringFault = await client.heartbeat();
      expect(hbDuringFault.valid).toBe(true);
      expect(client.getSessionId()).toBe('sess-aaa');

      const hbAfterRecovery = await client.heartbeat();
      expect(hbAfterRecovery.valid).toBe(true);
      expect(hbAfterRecovery.status).toBe('active');
    });

    it('re-validation after grace expiry starts fresh', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(validationOk({ tier: 'pro' }))
        .mockRejectedValueOnce(new Error('offline')) // grace expiry
        .mockResolvedValueOnce(validationOk({ tier: 'business', session_id: 'sess-bbb' }));
      const client = sdk({ cacheTtlMs: 1_000, offlineGraceMs: 2_000 });

      await client.validate();
      vi.advanceTimersByTime(3_000);
      await client.validate(); // grace expired, cache cleared

      // Now re-validate with network back
      const fresh = await client.validate();
      expect(fresh.valid).toBe(true);
      expect(fresh.tier).toBe('business');
      expect(client.getSessionId()).toBe('sess-bbb');
    });
  });
});
