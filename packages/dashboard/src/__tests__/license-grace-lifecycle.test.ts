/**
 * Tests for the license grace-period lifecycle (W2 hardening).
 *
 * A `grace_period` entitlement is a paying customer whose payment failed —
 * validation must not silently report it as a healthy active license, and a
 * grace window that has lapsed (but whose row has not been reconciled yet)
 * must be rejected at validation time instead of trusting the stale status.
 *
 * Covers:
 *  - POST /api/license/validate returns grace metadata the SDK can surface
 *    (status 'grace_period' + grace_period_ends_at) while inside the window.
 *  - POST /api/license/validate rejects a lapsed-but-unreconciled grace row,
 *    computing the window at validation time (clock-injected).
 *  - POST /api/license/heartbeat rejects a lapsed grace row so heartbeats
 *    cannot keep a session alive past the grace deadline.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/rate-limit', () => ({
  rateLimits: {
    licenseValidate: vi.fn().mockResolvedValue({ limited: false, remaining: 29, retryAfterMs: 0 }),
    licensePerKey: vi.fn().mockResolvedValue({ limited: false, remaining: 59, retryAfterMs: 0 }),
    licenseFailedAttempt: vi.fn().mockResolvedValue({ limited: false, remaining: 4, retryAfterMs: 0 }),
    licenseHeartbeat: vi.fn().mockResolvedValue({ limited: false, remaining: 59, retryAfterMs: 0 }),
  },
}));

import { POST as validatePost } from '@/app/api/license/validate/route';
import { POST as heartbeatPost } from '@/app/api/license/heartbeat/route';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { rateLimits } from '@/lib/api/rate-limit';
import { createMockSupabase, registerTable, buildRequest } from './helpers';

const PRODUCT_ID = '00000000-0000-4000-a000-000000000001';
const SESSION_ID = '00000000-0000-4000-a000-0000000000aa';

const NOW = new Date('2026-07-09T12:00:00.000Z');
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const FUTURE_DEADLINE = new Date(NOW.getTime() + ONE_DAY_MS).toISOString();
const PAST_DEADLINE = new Date(NOW.getTime() - ONE_DAY_MS).toISOString();

function lookupResult(overrides: Record<string, unknown> = {}) {
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
    entitlement_grace_period_ends_at: null,
    config_max_devices: null,
    config_device_policy: null,
    config_feature_flags: [],
    config_tier: 'pro',
    config_heartbeat_interval_seconds: 0,
    customer_discord_username: 'somni_user',
    customer_discord_id: 'discord-1',
    product_guild_id: 'guild-1',
    ...overrides,
  };
}

function setupValidateMocks(lookup: Record<string, unknown>) {
  const mock = Object.assign(createMockSupabase(), {
    rpc: vi.fn().mockImplementation(async (fn: string) => {
      if (fn === 'license_validate_lookup') return { data: lookup, error: null };
      return { data: null, error: null };
    }),
  });
  const entitlementsQuery = registerTable(mock, 'entitlements');
  const validationsQuery = registerTable(mock, 'license_validations');
  (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mock);
  return { mock, entitlementsQuery, validationsQuery };
}

function validateReq() {
  return buildRequest('/api/license/validate', {
    method: 'POST',
    body: { license_key: 'SOMNI-TEST-1234-ABCD', product_id: PRODUCT_ID },
  });
}

beforeEach(() => {
    vi.resetAllMocks();
  vi.mocked(rateLimits.licenseValidate).mockResolvedValue({ limited: false, remaining: 29, retryAfterMs: 0 });
  vi.mocked(rateLimits.licensePerKey).mockResolvedValue({ limited: false, remaining: 59, retryAfterMs: 0 });
  vi.mocked(rateLimits.licenseFailedAttempt).mockResolvedValue({ limited: false, remaining: 4, retryAfterMs: 0 });
  vi.mocked(rateLimits.licenseHeartbeat).mockResolvedValue({ limited: false, remaining: 59, retryAfterMs: 0 });
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('POST /api/license/validate — grace-period metadata', () => {
  it('stays valid inside the grace window but surfaces grace status + deadline for the SDK', async () => {
    setupValidateMocks(lookupResult({
      entitlement_status: 'grace_period',
      entitlement_grace_period_ends_at: FUTURE_DEADLINE,
    }));

    const res = await validatePost(validateReq() as never);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.valid).toBe(true);
    // The SDK must be able to tell a decaying entitlement from a healthy one.
    expect(body.status).toBe('grace_period');
    expect(body.grace_period_ends_at).toBe(FUTURE_DEADLINE);
  });

  it('reports healthy active entitlements exactly as before (no grace metadata)', async () => {
    setupValidateMocks(lookupResult());

    const res = await validatePost(validateReq() as never);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.valid).toBe(true);
    expect(body.status).toBe('active');
    expect(body.grace_period_ends_at).toBeNull();
  });

  it('treats a grace row with no recorded deadline as still in grace (reconciliation owns it)', async () => {
    setupValidateMocks(lookupResult({
      entitlement_status: 'grace_period',
      entitlement_grace_period_ends_at: null,
    }));

    const res = await validatePost(validateReq() as never);
    const body = await res.json();

    expect(body.valid).toBe(true);
    expect(body.status).toBe('grace_period');
    expect(body.grace_period_ends_at).toBeNull();
  });
});

describe('POST /api/license/validate — lapsed grace window is rejected', () => {
  it('rejects a grace entitlement whose window lapsed but whose row was not reconciled yet', async () => {
    const { entitlementsQuery, validationsQuery } = setupValidateMocks(lookupResult({
      entitlement_status: 'grace_period',
      entitlement_grace_period_ends_at: PAST_DEADLINE,
    }));

    const res = await validatePost(validateReq() as never);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.valid).toBe(false);
    expect(body.status).toBe('expired');
    expect(body.grace_period_ends_at).toBe(PAST_DEADLINE);

    // The route only rejects — the reconciliation job owns the status
    // transition (audit trail + role revocation), so the row must be left
    // in grace_period for it to find.
    expect(entitlementsQuery.update).not.toHaveBeenCalled();

    // The rejection is logged with a CHECK-constraint-safe result value.
    expect(validationsQuery.insert).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'expired', license_key_id: 'key-1' }),
    );
  });

  it('computes the window at validation time — the same row flips to rejected once the clock passes the deadline', async () => {
    const deadline = new Date(NOW.getTime() + 60_000).toISOString(); // 1 min from NOW
    const lookup = lookupResult({
      entitlement_status: 'grace_period',
      entitlement_grace_period_ends_at: deadline,
    });

    setupValidateMocks(lookup);
    const before = await (await validatePost(validateReq() as never)).json();
    expect(before.valid).toBe(true);
    expect(before.status).toBe('grace_period');

    // Advance the injected clock past the deadline — same stale DB row.
    vi.setSystemTime(new Date(NOW.getTime() + 120_000));
    setupValidateMocks(lookup);
    const after = await (await validatePost(validateReq() as never)).json();
    expect(after.valid).toBe(false);
    expect(after.status).toBe('expired');
  });
});

describe('POST /api/license/heartbeat — lapsed grace window is rejected', () => {
  function setupHeartbeatMocks(entitlement: { status: string; grace_period_ends_at: string | null }) {
    const mock = createMockSupabase();
    const decisionAt = new Date().toISOString();
    const status = (
      entitlement.status === 'grace_period'
      && entitlement.grace_period_ends_at !== null
      && entitlement.grace_period_ends_at < decisionAt
    ) ? 'expired' : entitlement.status;
    const live = status === 'active' || status === 'grace_period';
    mock.rpc.mockResolvedValue({
      data: {
        entitlement_id: 'ent-1',
        status,
        grace_period_ends_at: entitlement.grace_period_ends_at,
        decided_at: decisionAt,
        candidate_count: 1,
        session_touched: live,
        next_heartbeat_seconds: 300,
      },
      error: null,
    });
    const sessionsQuery = registerTable(mock, 'license_sessions');
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mock);
    return { sessionsQuery };
  }

  function heartbeatReq() {
    return buildRequest('/api/license/heartbeat', {
      method: 'POST',
      body: { license_key: 'SOMNI-TEST-1234-ABCD', session_id: SESSION_ID },
    });
  }

  it('keeps sessions alive while the grace window is still open and surfaces the grace status + deadline', async () => {
    setupHeartbeatMocks({ status: 'grace_period', grace_period_ends_at: FUTURE_DEADLINE });

    const res = await heartbeatPost(heartbeatReq() as never);
    const body = await res.json();
    expect(body.valid).toBe(true);
    // W2: a grace period entered mid-session must be visible on the heartbeat
    // response, not masked as 'active', so heartbeat-only monitors see it.
    expect(body.status).toBe('grace_period');
    expect(body.grace_period_ends_at).toBe(FUTURE_DEADLINE);
  });

  it('reports a healthy active session as active with no grace deadline', async () => {
    setupHeartbeatMocks({ status: 'active', grace_period_ends_at: null });

    const res = await heartbeatPost(heartbeatReq() as never);
    const body = await res.json();
    expect(body.valid).toBe(true);
    expect(body.status).toBe('active');
    expect(body.grace_period_ends_at).toBeNull();
  });

  it('rejects heartbeats once the grace window has lapsed, even if the row is unreconciled', async () => {
    const { sessionsQuery } = setupHeartbeatMocks({
      status: 'grace_period',
      grace_period_ends_at: PAST_DEADLINE,
    });

    const res = await heartbeatPost(heartbeatReq() as never);
    const body = await res.json();

    expect(body.valid).toBe(false);
    expect(body.status).toBe('expired');
    expect(body.next_heartbeat_seconds).toBe(0);
    // Session row untouched — reconciliation owns state transitions.
    expect(sessionsQuery.update).not.toHaveBeenCalled();
  });
});
