/**
 * Tests for POST /api/license/validate — fraud check observability.
 *
 * The fraud checks are fire-and-forget (validation latency must not change),
 * but failures must not be invisible: a failing check produces a structured
 * error log plus an operator-visible `alerts` row, deduped/throttled so a
 * sustained outage cannot spam thousands of rows.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/rate-limit', () => ({
  rateLimits: {
    licenseValidate: vi.fn().mockResolvedValue({ limited: false, remaining: 29, retryAfterMs: 0 }),
    licensePerKey: vi.fn().mockResolvedValue({ limited: false, remaining: 59, retryAfterMs: 0 }),
    licenseFailedAttempt: vi.fn().mockResolvedValue({ limited: false, remaining: 4, retryAfterMs: 0 }),
  },
}));

import { POST } from '@/app/api/license/validate/route';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { rateLimits } from '@/lib/api/rate-limit';
import { createMockSupabase, registerTable, buildRequest } from './helpers';

const PRODUCT_ID = '00000000-0000-4000-a000-000000000001';

function lookupResult(guildId: string) {
  return {
    found: true,
    key_id: 'key-1',
    key_status: 'active',
    key_product_id: PRODUCT_ID,
    key_customer_id: 'cust-1',
    key_failed_attempts: 0,
    entitlement_id: 'ent-1',
    entitlement_status: 'active',
    entitlement_expires_at: null,
    config_max_devices: 3,
    config_device_policy: 'evict_oldest',
    config_feature_flags: [],
    config_tier: 'pro',
    config_heartbeat_interval_seconds: 0,
    customer_discord_username: 'somni_user',
    customer_discord_id: 'discord-1',
    product_guild_id: guildId,
  };
}

/**
 * Fresh mock Supabase wired for a fully valid license, parameterized by guild.
 * The module-level alert throttle in the route is keyed by guild id, so each
 * test uses its own guild to stay isolated.
 */
function setupMocks(guildId: string) {
  const mock = Object.assign(createMockSupabase(), {
    rpc: vi.fn().mockImplementation(async (fn: string) => {
      if (fn === 'license_validate_lookup') return { data: lookupResult(guildId), error: null };
      if (fn === 'license_validate_device') return { data: { session_id: 'sess-1' }, error: null };
      return { data: null, error: null };
    }),
  });

  const sessionsQuery = registerTable(mock, 'license_sessions');
  const fraudSignalsQuery = registerTable(mock, 'fraud_signals');
  const alertsQuery = registerTable(mock, 'alerts');

  (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mock);
  return { mock, sessionsQuery, fraudSignalsQuery, alertsQuery };
}

/**
 * Make every awaited `license_sessions` query resolve with a PostgREST-style
 * error (Supabase builders don't reject — they resolve `{ data, error }`).
 */
function failSessions(sessionsQuery: ReturnType<typeof registerTable>, message = 'connection refused') {
  sessionsQuery.then = vi.fn().mockImplementation((resolve) =>
    resolve?.({ data: null, error: { message }, count: null }),
  );
}

function makeReq() {
  return buildRequest('/api/license/validate', {
    method: 'POST',
    body: {
      license_key: 'SOMNI-TEST-1234-ABCD',
      product_id: PRODUCT_ID,
      device_fingerprint: 'device-abc',
      device_name: 'Test Device',
      app_version: '1.0.0',
    },
  });
}

/** Count structured fraud-check failure logs recorded by the console.error spy. */
function fraudFailureLogs(spy: ReturnType<typeof vi.spyOn>) {
  return spy.mock.calls.filter((call) => call[0] === '[License] Fraud check failed:');
}

/** Let the fire-and-forget fraud pipeline drain (all mocks resolve in microtasks). */
function flushAsync() {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  (rateLimits.licenseValidate as ReturnType<typeof vi.fn>).mockResolvedValue({ limited: false, remaining: 29, retryAfterMs: 0 });
  (rateLimits.licensePerKey as ReturnType<typeof vi.fn>).mockResolvedValue({ limited: false, remaining: 59, retryAfterMs: 0 });
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe('POST /api/license/validate — fraud check observability', () => {
  it('logs each failed check and writes an operator alert while validation still succeeds', async () => {
    const { sessionsQuery, alertsQuery } = setupMocks('guild-fail');
    failSessions(sessionsQuery);

    const res = await POST(makeReq() as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(true);

    await vi.waitFor(() => expect(alertsQuery.insert).toHaveBeenCalledTimes(1));

    expect(alertsQuery.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        guild_id: 'guild-fail',
        alert_type: 'fraud_check_failure',
        severity: 'critical',
        title: expect.any(String),
        message: expect.stringContaining('device_abuse'),
      }),
    );

    // Structured log per failed check
    expect(errorSpy).toHaveBeenCalledWith(
      '[License] Fraud check failed:',
      expect.objectContaining({ guild_id: 'guild-fail', check: 'device_abuse', error: expect.stringContaining('connection refused') }),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      '[License] Fraud check failed:',
      expect.objectContaining({ guild_id: 'guild-fail', check: 'ip_mismatch', error: expect.stringContaining('connection refused') }),
    );
  });

  it('updates the existing unresolved alert instead of inserting a duplicate row', async () => {
    const { sessionsQuery, alertsQuery } = setupMocks('guild-dedupe');
    failSessions(sessionsQuery);
    alertsQuery.maybeSingle.mockResolvedValue({ data: { id: 'alert-1' }, error: null });

    const res = await POST(makeReq() as never);
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(alertsQuery.update).toHaveBeenCalledTimes(1));

    expect(alertsQuery.update).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.any(String), updated_at: expect.any(String) }),
    );
    expect(alertsQuery.insert).not.toHaveBeenCalled();
  });

  it('throttles alert writes during a sustained outage', async () => {
    const { sessionsQuery, alertsQuery } = setupMocks('guild-throttle');
    failSessions(sessionsQuery);

    await POST(makeReq() as never);
    await vi.waitFor(() => expect(alertsQuery.insert).toHaveBeenCalledTimes(1));
    expect(fraudFailureLogs(errorSpy)).toHaveLength(2);

    await POST(makeReq() as never);
    // Second run still logs its failures...
    await vi.waitFor(() => expect(fraudFailureLogs(errorSpy)).toHaveLength(4));
    await flushAsync();

    // ...but does not touch the alerts table again within the throttle window.
    expect(alertsQuery.insert).toHaveBeenCalledTimes(1);
    expect(alertsQuery.select).toHaveBeenCalledTimes(1);
  });

  it('writes no alerts and no fraud signals when all checks pass', async () => {
    const { mock, fraudSignalsQuery, alertsQuery } = setupMocks('guild-green');

    const res = await POST(makeReq() as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(true);

    await flushAsync();

    expect(mock.from).not.toHaveBeenCalledWith('alerts');
    expect(alertsQuery.insert).not.toHaveBeenCalled();
    expect(alertsQuery.update).not.toHaveBeenCalled();
    expect(fraudSignalsQuery.insert).not.toHaveBeenCalled();
    expect(fraudFailureLogs(errorSpy)).toHaveLength(0);
  });
});
