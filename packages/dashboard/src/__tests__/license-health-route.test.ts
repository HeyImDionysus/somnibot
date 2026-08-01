import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn() }));
vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));

import { GET } from '@/app/api/license/health/route';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { buildRequest, mockAuthSuccess, mockRateLimitPass } from './helpers';

function query(result: { data: unknown; error: unknown; count?: number }) {
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'order', 'limit', 'in', 'gte', 'is', 'ilike', 'or']) {
    chain[method] = vi.fn(() => chain);
  }
  chain.then = (
    resolve: (value: typeof result) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

function setup(overrides: Partial<Record<string, { data: unknown; error: unknown; count?: number }>> = {}) {
  const tables = {
    license_keys: {
      data: [{
        id: '00000000-0000-0000-0000-000000000001',
        product_id: '00000000-0000-0000-0000-000000000002',
        status: 'active',
        activated_at: '2026-07-30T00:00:00.000Z',
        created_at: '2026-07-29T00:00:00.000Z',
      }],
      error: null,
    },
    license_sessions: {
      data: [{
        id: '00000000-0000-0000-0000-000000000003',
        license_key_id: '00000000-0000-0000-0000-000000000001',
        active: true,
        last_seen_at: '2026-07-30T00:00:00.000Z',
      }],
      error: null,
      count: 1,
    },
    license_validations: {
      data: [{
        id: '00000000-0000-0000-0000-000000000004',
        license_key_id: '00000000-0000-0000-0000-000000000001',
        result: 'valid',
        created_at: '2026-07-30T00:00:00.000Z',
      }],
      error: null,
      count: 1,
    },
    alerts: { data: [], error: null },
    products: {
      data: [{ id: '00000000-0000-0000-0000-000000000002' }],
      error: null,
    },
    // Keyless rows (license_key_id NULL) are loaded by a SECOND
    // license_validations query scoped through the guild's products.
    license_validations_keyless: { data: [], error: null, count: 0 },
    ...overrides,
  };
  const supabase = {
    from: vi.fn((table: keyof typeof tables) => {
      if (table === 'license_validations') {
        // Dispatch on the .is('license_key_id', null) marker only the
        // keyless query applies.
        const proxy: Record<string, unknown> = {};
        let keyless = false;
        for (const method of ['select', 'eq', 'order', 'limit', 'in', 'gte', 'is', 'ilike', 'or']) {
          proxy[method] = vi.fn((...args: unknown[]) => {
            if (method === 'is' && args[0] === 'license_key_id' && args[1] === null) {
              keyless = true;
            }
            return proxy;
          });
        }
        proxy.then = (
          resolve: (value: unknown) => unknown,
          reject?: (reason: unknown) => unknown,
        ) => Promise.resolve(
          keyless ? tables.license_validations_keyless : tables.license_validations,
        ).then(resolve, reject);
        return proxy;
      }
      return query(tables[table]);
    }),
  };
  vi.mocked(createAdminSupabase).mockReturnValue(supabase as never);
  return supabase;
}

describe('GET /api/license/health', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockRateLimitPass(checkAdminRateLimit as ReturnType<typeof vi.fn>);
    mockAuthSuccess(requireGuildOwner as ReturnType<typeof vi.fn>);
  });

  it('counts keyless validation failures even when the guild has no keys (round 27)', async () => {
    // /api/license/validate deliberately records invalid-key and
    // lookup-unavailable attempts with license_key_id NULL. Key-scoped
    // loading skipped them entirely — a guild under a key-guessing attack
    // (or a validation outage) with zero keys read 'empty'.
    setup({
      license_keys: { data: [], error: null, count: 0 },
      license_validations_keyless: {
        data: [
          {
            id: '00000000-0000-0000-0000-000000000011',
            license_key_id: null,
            result: 'unavailable',
            created_at: '2026-07-31T00:00:00.000Z',
          },
          {
            id: '00000000-0000-0000-0000-000000000012',
            license_key_id: null,
            result: 'invalid_key',
            created_at: '2026-07-31T00:05:00.000Z',
          },
        ],
        error: null,
        count: 2,
      },
    });

    const response = await GET(buildRequest());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.data.state).toBe('needs_attention');
    expect(payload.data.unavailable24h).toBe(1);
    expect(payload.data.invalid24h).toBe(1);
    expect(payload.data.validationCount).toBe(2);
  });

  it('reports exact record counts without inventing a health score', async () => {
    setup();
    const response = await GET(buildRequest('/api/license/health') as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      state: 'healthy',
      sampledKeys: 1,
      totalKeys: 1,
      keyCounts: {
        active: 1,
        pending_activation: 0,
        expired: 0,
        revoked: 0,
        suspended: 0,
      },
      activeSessions: 1,
      totalSessions: 1,
      validationCount: 1,
      unavailable24h: 0,
      deviceLimit24h: 0,
    });
    expect(body.data).not.toHaveProperty('score');
  });

  it('surfaces real validation and unresolved-alert problems', async () => {
    setup({
      license_validations: {
        data: [
          { id: 'v1', license_key_id: '00000000-0000-0000-0000-000000000001', result: 'unavailable', created_at: '2026-07-30T00:00:00Z' },
          { id: 'v2', license_key_id: '00000000-0000-0000-0000-000000000001', result: 'over_device_limit', created_at: '2026-07-30T00:01:00Z' },
        ],
        error: null,
        count: 2,
      },
      alerts: {
        data: [{ id: 'a1', alert_type: 'license_delivery', severity: 'high', title: 'Key delivery failed', created_at: '2026-07-30T00:00:00Z' }],
        error: null,
      },
    });

    const body = await (await GET(buildRequest('/api/license/health') as never)).json();
    expect(body.data).toMatchObject({
      state: 'needs_attention',
      unavailable24h: 1,
      deviceLimit24h: 1,
    });
    expect(body.data.unresolvedAlerts).toHaveLength(1);
  });

  it('treats invalid validation traffic as a health issue', async () => {
    setup({
      license_validations: {
        data: [
          { id: 'v1', license_key_id: '00000000-0000-0000-0000-000000000001', result: 'invalid_key', created_at: '2026-07-30T00:00:00Z' },
        ],
        error: null,
        count: 1,
      },
    });

    const body = await (await GET(buildRequest('/api/license/health') as never)).json();
    expect(body.data).toMatchObject({
      state: 'needs_attention',
      invalid24h: 1,
    });
  });

  it('surfaces commerce license-delivery alerts even when no keys remain', async () => {
    const supabase = setup({
      license_keys: { data: [], error: null, count: 0 },
      alerts: {
        data: [{
          id: 'a1',
          alert_type: 'commerce_missing_license_delivery',
          severity: 'critical',
          title: 'Missing license delivery',
          created_at: '2026-07-30T00:00:00Z',
        }],
        error: null,
      },
    });

    const body = await (await GET(buildRequest('/api/license/health') as never)).json();
    expect(body.data).toMatchObject({
      state: 'needs_attention',
      totalKeys: 0,
    });
    expect(body.data.unresolvedAlerts).toHaveLength(1);
    const alertsCallIndex = supabase.from.mock.calls.findIndex((call) => call[0] === 'alerts');
    const alertsQuery = supabase.from.mock.results[alertsCallIndex].value;
    expect(alertsQuery.or).toHaveBeenCalledWith(
      'alert_type.ilike.license%,alert_type.ilike.commerce_license%,alert_type.eq.commerce_missing_license_delivery',
    );
  });

  it('fails closed when a required health dependency cannot be read', async () => {
    setup({
      license_sessions: { data: null, error: { message: 'db unavailable' } },
    });
    const response = await GET(buildRequest('/api/license/health') as never);
    expect(response.status).toBe(500);
    expect((await response.json()).success).toBe(false);
  });

  it('never declares whole-guild health from a truncated key sample', async () => {
    setup({
      license_keys: {
        data: [{
          id: '00000000-0000-0000-0000-000000000001',
          product_id: '00000000-0000-0000-0000-000000000002',
          status: 'active',
          activated_at: '2026-07-30T00:00:00.000Z',
          created_at: '2026-07-29T00:00:00.000Z',
        }],
        error: null,
        count: 5_001,
      },
    });
    const body = await (await GET(buildRequest('/api/license/health') as never)).json();
    expect(body.data).toMatchObject({
      state: 'needs_attention',
      truncated: true,
      sampledKeys: 1,
      totalKeys: 5_001,
    });
  });

  it('never declares health from a truncated validation sample', async () => {
    setup({
      license_validations: {
        data: [{
          id: 'v1',
          license_key_id: '00000000-0000-0000-0000-000000000001',
          result: 'valid',
          created_at: '2026-07-30T00:00:00Z',
        }],
        error: null,
        count: 5_001,
      },
    });
    const body = await (await GET(buildRequest('/api/license/health') as never)).json();
    expect(body.data).toMatchObject({
      state: 'needs_attention',
      validationCount: 5_001,
      truncated: true,
    });
  });

  it('chunks large license-key filters to bounded PostgREST URLs', async () => {
    const keys = Array.from({ length: 205 }, (_, index) => ({
      id: `key-${index}`,
      product_id: '00000000-0000-0000-0000-000000000002',
      status: 'active',
      activated_at: '2026-07-30T00:00:00.000Z',
      created_at: '2026-07-29T00:00:00.000Z',
    }));
    const supabase = setup({
      license_keys: { data: keys, error: null, count: keys.length },
    });

    const response = await GET(buildRequest('/api/license/health') as never);

    expect(response.status).toBe(200);
    // license_validations: 3 key chunks + 1 product-scoped keyless query
    // (round 27); sessions stay purely key-chunked.
    const expectedQueries: Record<string, number> = {
      license_sessions: 3,
      license_validations: 4,
    };
    for (const table of ['license_sessions', 'license_validations']) {
      const tableQueries = supabase.from.mock.calls
        .map((call, index) => ({ table: call[0], query: supabase.from.mock.results[index].value }))
        .filter((entry) => entry.table === table);
      expect(tableQueries).toHaveLength(expectedQueries[table]);
      expect(tableQueries.flatMap((entry) => entry.query.in.mock.calls)
        .every((call: [string, string[]]) => call[1].length <= 100)).toBe(true);
    }
  });

  it('flags an ACTIVE session attached to a revoked key as needing attention', async () => {
    // Review 3691834566: admin revocation deactivates sessions in a separate
    // write whose failure is tolerated before the key is revoked — a device
    // can keep an active session against a terminated licence. Healthy must
    // never paper over that.
    setup({
      license_keys: {
        data: [{
          id: '00000000-0000-0000-0000-000000000001',
          product_id: '00000000-0000-0000-0000-000000000002',
          status: 'revoked',
          activated_at: '2026-07-30T00:00:00.000Z',
          created_at: '2026-07-29T00:00:00.000Z',
        }],
        error: null,
        count: 1,
      },
      license_sessions: {
        data: [{
          id: '00000000-0000-0000-0000-000000000003',
          license_key_id: '00000000-0000-0000-0000-000000000001',
          active: true,
          last_seen_at: '2026-07-30T00:00:00.000Z',
        }],
        error: null,
        count: 1,
      },
    });
    const body = await (await GET(buildRequest('/api/license/health') as never)).json();
    expect(body.data).toMatchObject({
      state: 'needs_attention',
      sessionsOnTerminalKeys: 1,
    });
  });

  it('never declares health from a truncated SESSION sample', async () => {
    // The active-device count is computed from the session sample. When that
    // sample is cut off, the response already admitted `truncated: true` and
    // an incomplete device count — while the state predicate ignored sessions
    // and still said 'healthy', so the page showed the green banner beside a
    // number it had just disclaimed.
    setup({
      license_sessions: {
        data: [{
          id: '00000000-0000-0000-0000-000000000003',
          license_key_id: '00000000-0000-0000-0000-000000000001',
          active: true,
          last_seen_at: '2026-07-30T00:00:00.000Z',
        }],
        error: null,
        count: 5_001,
      },
    });
    const body = await (await GET(buildRequest('/api/license/health') as never)).json();
    expect(body.data).toMatchObject({
      state: 'needs_attention',
      truncated: true,
      totalSessions: 5_001,
    });
  });
});
