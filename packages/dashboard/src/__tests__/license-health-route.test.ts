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
  for (const method of ['select', 'eq', 'order', 'limit', 'in', 'gte', 'is', 'ilike']) {
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
    ...overrides,
  };
  const supabase = {
    from: vi.fn((table: keyof typeof tables) => query(tables[table])),
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

  it('reports exact record counts without inventing a health score', async () => {
    setup();
    const response = await GET(buildRequest('/api/license/health') as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      state: 'healthy',
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

  it('fails closed when a required health dependency cannot be read', async () => {
    setup({
      license_sessions: { data: null, error: { message: 'db unavailable' } },
    });
    const response = await GET(buildRequest('/api/license/health') as never);
    expect(response.status).toBe(500);
    expect((await response.json()).success).toBe(false);
  });
});
