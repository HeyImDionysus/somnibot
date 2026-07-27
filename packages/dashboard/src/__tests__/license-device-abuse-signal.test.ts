/**
 * The device-abuse fraud signal must be able to fire in the DEFAULT
 * configuration.
 *
 * It used to fire on `activeDevices > maxDevices * 3`. Under `evict_oldest` —
 * the schema default — every new device evicts the least-recently-seen one, so
 * the active session count is *pinned at* `max_devices` by construction and can
 * never reach three times it. Under `reject` the RPC refuses past the limit, so
 * it is pinned there too. The signal was mathematically unreachable: ten people
 * sharing one 3-seat key looked exactly like one honest customer with three
 * machines.
 *
 * The detector now counts distinct DEVICES in a rolling window instead of
 * seats. Eviction pins the seat count; it does not pin the number of machines.
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
import { createMockSupabase, registerTable, buildRequest } from './helpers';

const PRODUCT_ID = '00000000-0000-4000-a000-000000000001';
const MAX_DEVICES = 3;

type SessionRow = { active: boolean; last_seen_at: string; deactivation_reason: string | null };

/**
 * The exact session table a key under `evict_oldest` produces: `max_devices`
 * rows still holding a seat, everyone else evicted but still a device that
 * used the key.
 */
function seatThrashingRows(distinctDevices: number): SessionRow[] {
  const now = new Date().toISOString();
  return Array.from({ length: distinctDevices }, (_, i) => ({
    active: i < MAX_DEVICES,
    last_seen_at: now,
    deactivation_reason: i < MAX_DEVICES ? null : 'device_limit',
  }));
}

function setup(guildId: string, rows: SessionRow[], devicePolicy = 'evict_oldest') {
  const mock = Object.assign(createMockSupabase(), {
    rpc: vi.fn().mockImplementation(async (fn: string) => {
      if (fn === 'license_validate_lookup') {
        return {
          data: {
            found: true,
            key_id: 'key-1',
            key_status: 'active',
            key_product_id: PRODUCT_ID,
            key_failed_attempts: 0,
            entitlement_id: 'ent-1',
            entitlement_status: 'active',
            entitlement_expires_at: null,
            config_max_devices: MAX_DEVICES,
            config_device_policy: devicePolicy,
            config_feature_flags: [],
            config_heartbeat_interval_seconds: 300,
            customer_discord_id: 'discord-1',
            product_guild_id: guildId,
          },
          error: null,
        };
      }
      if (fn === 'license_validate_device') {
        return { data: { status: 'reactivated', session_id: 'sess-1', active_devices: MAX_DEVICES, max_devices: MAX_DEVICES }, error: null };
      }
      return { data: null, error: null };
    }),
  });

  const sessions = registerTable(mock, 'license_sessions');
  // Both fraud checks read this table; the device check terminates on
  // `.limit()`, the IP check on `.limit()` too, so one thenable serves both.
  sessions.then = vi.fn().mockImplementation((resolve) =>
    resolve?.({ data: rows, error: null, count: rows.length }),
  );

  const fraudSignals = registerTable(mock, 'fraud_signals');
  const alerts = registerTable(mock, 'alerts');
  alerts.select.mockResolvedValue({ data: [], error: null });

  (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mock);
  return { mock, fraudSignals };
}

function req() {
  return buildRequest('/api/license/validate', {
    method: 'POST',
    body: {
      license_key: 'SOMNI-TEST-1234-ABCD',
      product_id: PRODUCT_ID,
      device_fingerprint: 'device-abc',
      app_version: '1.0.0',
    },
  });
}

function deviceAbuseInserts(fraudSignals: ReturnType<typeof registerTable>) {
  return fraudSignals.insert.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((s) => s.signal_type === 'device_abuse');
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe('device-abuse signal under the default evict_oldest policy', () => {
  it('fires on ten sharers even though the seat count is pinned at three', async () => {
    // The scenario the old detector could not see. Only MAX_DEVICES rows are
    // active — `activeDevices > maxDevices * 3` is 3 > 9, false, forever.
    const { fraudSignals } = setup('guild-shared', seatThrashingRows(10));

    const res = await POST(req() as never);
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(deviceAbuseInserts(fraudSignals)).toHaveLength(1));

    const signal = deviceAbuseInserts(fraudSignals)[0];
    expect(signal.severity).toBe('high');
    expect(signal.entity_id).toBe('key-1');
    const evidence = signal.evidence as Record<string, unknown>;
    expect(evidence.devices_in_window).toBe(10);
    // The signature of seat thrashing: many devices, seats pinned at the limit.
    expect(evidence.active_sessions).toBe(MAX_DEVICES);
    expect(evidence.evicted_for_device_limit).toBe(7);
  });

  it('escalates to critical for a widely shared key', async () => {
    const { fraudSignals } = setup('guild-very-shared', seatThrashingRows(20));

    await POST(req() as never);
    await vi.waitFor(() => expect(deviceAbuseInserts(fraudSignals)).toHaveLength(1));

    expect(deviceAbuseInserts(fraudSignals)[0].severity).toBe('critical');
  });

  it('fires under the reject policy too, where the count is equally pinned', async () => {
    const { fraudSignals } = setup('guild-reject', seatThrashingRows(12), 'reject');

    await POST(req() as never);
    await vi.waitFor(() => expect(deviceAbuseInserts(fraudSignals)).toHaveLength(1));
  });

  it('stays quiet for an honest customer using their three seats', async () => {
    const { fraudSignals } = setup('guild-honest', seatThrashingRows(3));

    const res = await POST(req() as never);
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 10));

    expect(deviceAbuseInserts(fraudSignals)).toHaveLength(0);
  });

  it('stays quiet through normal churn — a reinstall and a new laptop', async () => {
    // 3 seats + 6 historical devices over a whole week is still under the bar.
    const { fraudSignals } = setup('guild-churn', seatThrashingRows(9));

    await POST(req() as never);
    await new Promise((r) => setTimeout(r, 10));

    expect(deviceAbuseInserts(fraudSignals)).toHaveLength(0);
  });

  it('never blocks the validation — the signal is advisory', async () => {
    // A paying customer whose fingerprint is unstable gets reviewed, not
    // locked out. This is what makes the generous threshold safe.
    const { fraudSignals } = setup('guild-advisory', seatThrashingRows(30));

    const res = await POST(req() as never);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.valid).toBe(true);

    await vi.waitFor(() => expect(deviceAbuseInserts(fraudSignals)).toHaveLength(1));
  });
});
