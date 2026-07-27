/**
 * POST /api/license/validate — the device/seat layer.
 *
 * The route used to log-and-swallow a failure from `license_validate_device`
 * and fall through to `{ valid: true, ..., session_id: null }`. Combined with
 * the RPC's 23505 on any returning device (fixed in
 * 20260727011000_license_device_session_reuse.sql), that meant a machine could
 * validate as healthy forever while consuming ZERO seats and never
 * heartbeating again — the seat limit silently stopped counting it.
 *
 * The `over_device_limit` branch also had no route-level coverage at all,
 * which is why it was never noticed that it is unreachable under the default
 * `evict_oldest` policy.
 *
 * The SQL half of this fix (a returning device reclaims its row; deactivating
 * frees a seat; re-validating an active device costs nothing) is proven
 * directly against the real schema — see the migration header. These tests pin
 * the route's half of the contract: no seat, no success.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
import { createMockSupabase, registerTable, buildRequest } from './helpers';

const PRODUCT_ID = '00000000-0000-4000-a000-000000000001';

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
    config_max_devices: 3,
    config_device_policy: 'evict_oldest',
    config_feature_flags: [],
    config_tier: 'pro',
    config_heartbeat_interval_seconds: 300,
    customer_discord_username: 'buyer',
    customer_discord_id: 'discord-1',
    // No guild id → the fire-and-forget fraud pipeline stays out of these tests.
    product_guild_id: null,
    ...overrides,
  };
}

/** @param device  What `license_validate_device` resolves with. */
function setup(device: { data: unknown; error: unknown }, lookupOverrides: Record<string, unknown> = {}) {
  const mock = Object.assign(createMockSupabase(), {
    rpc: vi.fn().mockImplementation(async (fn: string) => {
      if (fn === 'license_validate_lookup') return { data: lookupResult(lookupOverrides), error: null };
      if (fn === 'license_validate_device') return device;
      return { data: null, error: null };
    }),
  });
  const validations = registerTable(mock, 'license_validations');
  (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mock);
  return { mock, validations };
}

function req(body: Record<string, unknown> = {}) {
  return buildRequest('/api/license/validate', {
    method: 'POST',
    body: {
      license_key: 'SOMNI-TEST-1234-ABCD',
      product_id: PRODUCT_ID,
      device_fingerprint: 'device-abc',
      device_name: 'Laptop',
      app_version: '1.0.0',
      ...body,
    },
  });
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('POST /api/license/validate — no seat, no success', () => {
  it('never answers valid:true when the device RPC fails', async () => {
    // This is the exact shape of the old bug: the 23505 from a returning
    // device's INSERT. It used to be logged and swallowed, and the response
    // was a healthy `valid: true` with `session_id: null`.
    setup({
      data: null,
      error: { code: '23505', message: 'duplicate key value violates unique constraint "license_sessions_license_key_id_device_fingerprint_key"' },
    });

    const res = await POST(req() as never);
    const body = await res.json();

    expect(body.valid).not.toBe(true);
    expect(res.status).toBe(503);
    expect(body.status).toBe('service_unavailable');
    // …and specifically not a verdict on the licence, which is fine.
    expect(body.status).not.toBe('revoked');
    expect(errorSpy).toHaveBeenCalled();
  });

  it('never answers valid:true when the RPC returns no session id', async () => {
    // Defence in depth: the RPC answered, but granted nothing.
    setup({ data: { status: 'created', session_id: null }, error: null });

    const res = await POST(req() as never);
    const body = await res.json();

    expect(body.valid).not.toBe(true);
    expect(res.status).toBe(503);
  });

  it('records the failure in the forensic ledger', async () => {
    const { validations } = setup({ data: null, error: { message: 'boom' } });

    await POST(req() as never);

    expect(validations.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        result: 'unavailable',
        license_key_id: 'key-1',
        device_fingerprint: 'device-abc',
      }),
    );
  });
});

describe('POST /api/license/validate — device outcomes', () => {
  it('issues the session for a brand-new device', async () => {
    setup({ data: { status: 'created', session_id: 'sess-new', active_devices: 1, max_devices: 3 }, error: null });

    const body = await (await POST(req() as never)).json();
    expect(body.valid).toBe(true);
    expect(body.session_id).toBe('sess-new');
  });

  it('issues the session for a device RECLAIMING its row after deactivation', async () => {
    // The returning-device path that used to raise 23505. The session id is the
    // device's original row — reused, not duplicated — so the customer's portal
    // device list keeps showing one entry for one machine.
    setup({ data: { status: 'reactivated', session_id: 'sess-original', active_devices: 2, max_devices: 3, evicted: false }, error: null });

    const body = await (await POST(req() as never)).json();
    expect(body.valid).toBe(true);
    expect(body.session_id).toBe('sess-original');
  });

  it('refreshes an already-active device without changing its session', async () => {
    setup({ data: { status: 'existing', session_id: 'sess-original', active_devices: 2, max_devices: 3 }, error: null });

    const body = await (await POST(req() as never)).json();
    expect(body.valid).toBe(true);
    expect(body.session_id).toBe('sess-original');
  });

  it('refuses a device over the limit under the reject policy', async () => {
    // Previously untested at the route level.
    setup(
      { data: { status: 'over_device_limit', active_devices: 3, max_devices: 3 }, error: null },
      { config_device_policy: 'reject' },
    );

    const res = await POST(req() as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.valid).toBe(false);
    expect(body.status).toBe('over_device_limit');
    expect(body.active_devices).toBe(3);
    expect(body.max_devices).toBe(3);
    // Actionable for the customer, not a dead end.
    expect(body.error).toMatch(/deactivate an existing device/i);
  });

  it('logs an over-limit refusal to the forensic ledger', async () => {
    const { validations } = setup(
      { data: { status: 'over_device_limit', active_devices: 3, max_devices: 3 }, error: null },
      { config_device_policy: 'reject' },
    );

    await POST(req() as never);

    expect(validations.insert).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'over_device_limit', license_key_id: 'key-1' }),
    );
  });

  it('still validates a product with no seat tracking, without a session', async () => {
    // config_max_devices null → the RPC is never called and session_id is
    // legitimately null. The "no seat, no success" rule must not break this.
    const { mock } = setup({ data: null, error: null }, { config_max_devices: null });

    const body = await (await POST(req() as never)).json();
    expect(body.valid).toBe(true);
    expect(body.session_id).toBeNull();
    expect(mock.rpc).not.toHaveBeenCalledWith('license_validate_device', expect.anything());
  });

  it('does not call the device RPC when the client sends no fingerprint', async () => {
    const { mock } = setup({ data: null, error: null });

    const body = await (await POST(req({ device_fingerprint: undefined }) as never)).json();
    expect(body.valid).toBe(true);
    expect(body.session_id).toBeNull();
    expect(mock.rpc).not.toHaveBeenCalledWith('license_validate_device', expect.anything());
  });
});
