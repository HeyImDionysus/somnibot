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

function deactivateOk(): Response {
  return jsonResponse({ success: true });
}

function sdk(overrides: Partial<SomniLicenseConfig> = {}): SomniLicense {
  return new SomniLicense({
    apiBase: 'https://dash.test/api',
    licenseKey: 'SMNI-AAAA-BBBB-CCCC',
    productId: 'prod-1',
    ...overrides,
  });
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
        .mockRejectedValueOnce(new Error('reset'));
      const client = sdk();
      await client.validate();

      const res = await client.deactivate();
      expect(res.success).toBe(false);
      expect(res.error).toBe('reset');
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
