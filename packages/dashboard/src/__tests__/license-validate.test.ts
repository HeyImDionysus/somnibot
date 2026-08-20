/**
 * Tests for POST /api/license/validate — License key validation.
 * V5 Audit §13.3: Core payment/licensing path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

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

const mockFrom = vi.fn();
const mockRpc = vi.fn();
const mockSupabase = { from: mockFrom, rpc: mockRpc };

function mockTable(resolveValue: unknown) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue(resolveValue),
    single: vi.fn().mockResolvedValue(resolveValue),
    update: vi.fn().mockReturnThis(),
    insert: vi.fn().mockResolvedValue({ error: null }),
    upsert: vi.fn().mockResolvedValue({ error: null }),
    limit: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
  };
  mockFrom.mockReturnValue(chain);
  return chain;
}

/** Make `license_validate_lookup` resolve with a composite lookup result. */
function mockLookup(data: Record<string, unknown> | null) {
  mockRpc.mockImplementation(async (fn: string) => {
    if (fn === 'license_validate_lookup') return { data: data ?? { found: false }, error: null };
    return { data: null, error: null };
  });
}

function makeReq(body: Record<string, unknown> = {}) {
  return new NextRequest('http://localhost/api/license/validate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': '1.2.3.4',
    },
    body: JSON.stringify({
      license_key: 'SOMNI-TEST-1234-ABCD',
      product_id: '00000000-0000-4000-a000-000000000001',
      ...body,
    }),
  });
}

beforeEach(() => {
    vi.resetAllMocks();
    // `vi.resetAllMocks()` clears calls and implementations, so every
  // `mockResolvedValue` set inside one test leaks into every later test in the
  // file. That is how the two key-status cases below used to pass without ever
  // reaching the route's key logic: the rate-limit test left `limited: true`
  // behind and they were silently re-asserting the 429 path. Re-arm the happy
  // path here so each test starts from a known state.
  (rateLimits.licenseValidate as ReturnType<typeof vi.fn>).mockResolvedValue({
    limited: false, remaining: 29, retryAfterMs: 0,
  });
  (rateLimits.licensePerKey as ReturnType<typeof vi.fn>).mockResolvedValue({
    limited: false, remaining: 59, retryAfterMs: 0,
  });
  (rateLimits.licenseFailedAttempt as ReturnType<typeof vi.fn>).mockResolvedValue({
    limited: false, remaining: 4, retryAfterMs: 0,
  });
  mockTable({ data: null, error: null });
  mockLookup(null);
  (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mockSupabase);
});

describe('POST /api/license/validate', () => {
  it('returns 429 when IP rate limited', async () => {
    (rateLimits.licenseValidate as ReturnType<typeof vi.fn>).mockResolvedValue({
      limited: true, remaining: 0, retryAfterMs: 30000,
    });

    const res = await POST(makeReq());
    expect(res.status).toBe(429);
  });

  it('returns invalid for non-existent key', async () => {
    mockLookup({ found: false });

    const res = await POST(makeReq());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.valid).toBe(false);
    expect(body.status).toBe('revoked');
    expect(body.error).toMatch(/invalid license key/i);
  });

  it('returns invalid for suspended key', async () => {
    mockLookup({
      found: true,
      key_id: 'key-1',
      key_status: 'suspended',
      key_product_id: '00000000-0000-4000-a000-000000000001',
      key_failed_attempts: 0,
    });

    const res = await POST(makeReq());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.valid).toBe(false);
    // Specifically the key's own status — not a generic rejection.
    expect(body.status).toBe('suspended');
  });

  it('returns invalid when the key is for a different product', async () => {
    const tables = mockTable({ data: null, error: null });
    mockLookup({
      found: true,
      key_id: 'key-1',
      key_status: 'pending_activation',
      key_product_id: '00000000-0000-4000-a000-0000000000ff',
      key_failed_attempts: 0,
    });

    const body = await (await POST(makeReq())).json();
    expect(body.valid).toBe(false);
    expect(body.error).toMatch(/not valid for this product/i);
    expect(tables.update).not.toHaveBeenCalled();
  });

  it('returns invalid when the entitlement is not active', async () => {
    mockLookup({
      found: true,
      key_id: 'key-1',
      key_status: 'active',
      key_product_id: '00000000-0000-4000-a000-000000000001',
      key_failed_attempts: 0,
      entitlement_id: 'ent-1',
      entitlement_status: 'cancelled',
    });

    const body = await (await POST(makeReq())).json();
    expect(body.valid).toBe(false);
    expect(body.status).toBe('cancelled');
  });

  it('validates a healthy key', async () => {
    mockLookup({
      found: true,
      key_id: 'key-1',
      key_status: 'active',
      key_product_id: '00000000-0000-4000-a000-000000000001',
      key_failed_attempts: 0,
      entitlement_id: 'ent-1',
      entitlement_status: 'active',
      entitlement_expires_at: null,
      config_feature_flags: ['pro-mode'],
      config_tier: 'pro',
      config_heartbeat_interval_seconds: 300,
    });

    const body = await (await POST(makeReq())).json();
    expect(body.valid).toBe(true);
    expect(body.status).toBe('active');
    expect(body.features).toEqual(['pro-mode']);
    expect(body.tier).toBe('pro');
  });

  it('activates a purchased key on its first project validation', async () => {
    mockLookup({
      found: true,
      key_id: 'key-pending',
      key_status: 'pending_activation',
      key_product_id: '00000000-0000-4000-a000-000000000001',
      key_failed_attempts: 0,
      entitlement_id: 'ent-1',
      entitlement_status: 'active',
      entitlement_expires_at: null,
      product_guild_id: 'guild-1',
      config_feature_flags: ['pro-mode'],
      config_heartbeat_interval_seconds: 300,
    });

    const activation = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'key-pending' }, error: null }),
    };
    const audit = {
      upsert: vi.fn().mockResolvedValue({ error: null }),
      insert: vi.fn().mockResolvedValue({ error: null }),
    };
    const validationLog = {
      insert: vi.fn().mockResolvedValue({ error: null }),
    };
    mockFrom.mockImplementation((table: string) => {
      if (table === 'license_keys') return activation;
      if (table === 'audit_logs') return audit;
      return validationLog;
    });

    const response = await POST(makeReq());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ valid: true, status: 'active' });
    expect(activation.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'active',
      activated_at: expect.any(String),
    }));
    expect(audit.upsert).toHaveBeenCalledWith(
      [expect.objectContaining({
        action: 'license.key_activated',
        actor_id: 'license-validator',
        target_id: 'key-pending',
      })],
      expect.objectContaining({ ignoreDuplicates: true }),
    );
  });

  it('accepts a concurrent first validation that already activated the key', async () => {
    mockLookup({
      found: true,
      key_id: 'key-pending',
      key_status: 'pending_activation',
      key_product_id: '00000000-0000-4000-a000-000000000001',
      key_failed_attempts: 0,
      entitlement_id: 'ent-1',
      entitlement_status: 'active',
      entitlement_expires_at: null,
    });

    const activation = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn()
        .mockResolvedValueOnce({ data: null, error: null })
        .mockResolvedValueOnce({ data: { status: 'active' }, error: null }),
    };
    const validationLog = { insert: vi.fn().mockResolvedValue({ error: null }) };
    mockFrom.mockImplementation((table: string) => (
      table === 'license_keys' ? activation : validationLog
    ));

    const response = await POST(makeReq());
    expect(await response.json()).toMatchObject({ valid: true, status: 'active' });
    expect(activation.maybeSingle).toHaveBeenCalledTimes(2);
  });

  it('reports a first-use activation write failure as retryable', async () => {
    mockLookup({
      found: true,
      key_id: 'key-pending',
      key_status: 'pending_activation',
      key_product_id: '00000000-0000-4000-a000-000000000001',
      key_failed_attempts: 0,
      entitlement_id: 'ent-1',
      entitlement_status: 'active',
      entitlement_expires_at: null,
    });

    const activation = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'database unavailable' },
      }),
    };
    const validationLog = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      insert: vi.fn().mockResolvedValue({ error: null }),
      upsert: vi.fn().mockResolvedValue({ error: null }),
    };
    mockFrom.mockImplementation((table: string) => (
      table === 'license_keys' ? activation : validationLog
    ));

    const response = await POST(makeReq());
    const body = await response.json();
    expect(response.status).toBe(503);
    expect(body).toMatchObject({ valid: false, status: 'service_unavailable', retryable: true });
  });

  it('keeps a pending key unchanged when device validation cannot start', async () => {
    mockLookup({
      found: true,
      key_id: 'key-pending',
      key_status: 'pending_activation',
      key_product_id: '00000000-0000-4000-a000-000000000001',
      key_failed_attempts: 0,
      entitlement_id: 'ent-1',
      entitlement_status: 'active',
      entitlement_expires_at: null,
      config_max_devices: 3,
    });
    const tables = mockTable({ data: null, error: null });

    const response = await POST(makeReq());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.status).toBe('device_fingerprint_required');
    expect(tables.update).not.toHaveBeenCalled();
  });

  it('atomically activates a tracked pending key while granting its first session', async () => {
    const lookup = {
      found: true,
      key_id: 'key-pending',
      key_status: 'pending_activation',
      key_product_id: '00000000-0000-4000-a000-000000000001',
      key_failed_attempts: 0,
      entitlement_id: 'ent-1',
      entitlement_status: 'active',
      entitlement_expires_at: null,
      product_guild_id: 'guild-1',
      config_max_devices: 3,
      config_device_policy: 'reject',
      config_heartbeat_interval_seconds: 300,
    };
    mockRpc.mockImplementation(async (fn: string) => {
      if (fn === 'license_validate_lookup') return { data: lookup, error: null };
      if (fn === 'license_validate_device_atomic') {
        return {
          data: { status: 'created', session_id: 'session-1', activated: true },
          error: null,
        };
      }
      return { data: null, error: null };
    });
    const licenseKeys = mockTable({ data: null, error: null });
    const tables = mockTable({ data: null, error: null });
    mockFrom.mockImplementation((table: string) => (
      table === 'license_keys' ? licenseKeys : tables
    ));

    const response = await POST(makeReq({ device_fingerprint: 'device-1' }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ valid: true, status: 'active', session_id: 'session-1' });
    expect(mockRpc).toHaveBeenCalledWith('license_validate_device_atomic', expect.objectContaining({
      p_activate_pending: true,
      p_product_id: '00000000-0000-4000-a000-000000000001',
    }));
    expect(licenseKeys.update).not.toHaveBeenCalled();
  });

  it.each(['revoked', 'suspended', 'expired'] as const)(
    'returns the terminal %s verdict when a key transition wins before atomic activation',
    async (terminalStatus) => {
    const lookup = {
      found: true,
      key_id: 'key-pending',
      key_status: 'pending_activation',
      key_product_id: '00000000-0000-4000-a000-000000000001',
      key_failed_attempts: 0,
      entitlement_id: 'ent-1',
      entitlement_status: 'active',
      entitlement_expires_at: null,
      config_max_devices: 3,
      config_device_policy: 'reject',
    };
    mockRpc.mockImplementation(async (fn: string) => {
      if (fn === 'license_validate_lookup') return { data: lookup, error: null };
      if (fn === 'license_validate_device_atomic') {
        return { data: { status: terminalStatus, session_id: null, activated: false }, error: null };
      }
      return { data: null, error: null };
    });
    const tables = mockTable({ data: null, error: null });

    const response = await POST(makeReq({ device_fingerprint: 'device-1' }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ valid: false, status: terminalStatus });
    expect(tables.update).not.toHaveBeenCalled();
    },
  );
});
