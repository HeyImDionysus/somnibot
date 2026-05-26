/**
 * Tests for GET /api/license/sessions — V5 Audit Fix #1 (rate limiting).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn() }));

import { GET } from '@/app/api/license/sessions/route';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';

import {
  createMockSupabase,
  registerTable,
  buildRequest,
  mockAuthSuccess,
  mockAuthUnauthorized,
  mockRateLimited,
  mockRateLimitPass,
} from './helpers';

const mock = createMockSupabase();

beforeEach(() => {
  vi.clearAllMocks();
  (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mock);
  mockRateLimitPass(checkAdminRateLimit as ReturnType<typeof vi.fn>);
});

describe('GET /api/license/sessions', () => {
  it('returns 429 when rate limited', async () => {
    mockRateLimited(checkAdminRateLimit as ReturnType<typeof vi.fn>);

    const res = await GET(buildRequest('/api/license/sessions', { searchParams: { key_id: 'key-1' } }));
    expect(res.status).toBe(429);
    expect(checkAdminRateLimit).toHaveBeenCalledWith(expect.anything(), 'standard');
  });

  it('returns 401 when not authenticated', async () => {
    mockAuthUnauthorized(requireGuildOwner as ReturnType<typeof vi.fn>);

    const res = await GET(buildRequest('/api/license/sessions', { searchParams: { key_id: 'key-1' } }));
    expect(res.status).toBe(401);
  });

  it('returns 400 when key_id is missing', async () => {
    mockAuthSuccess(requireGuildOwner as ReturnType<typeof vi.fn>);

    const res = await GET(buildRequest('/api/license/sessions'));
    expect(res.status).toBe(400);
  });

  it('returns sessions on success', async () => {
    mockAuthSuccess(requireGuildOwner as ReturnType<typeof vi.fn>);

    const keyQuery = registerTable(mock, 'license_keys');
    keyQuery.maybeSingle.mockResolvedValue({ data: { product_id: 'prod-1' } });

    const configQuery = registerTable(mock, 'product_license_config');
    configQuery.maybeSingle.mockResolvedValue({ data: { max_devices: 5 } });

    const sessionsQuery = registerTable(mock, 'license_sessions');
    sessionsQuery.limit.mockResolvedValue({
      data: [{ id: 's1', active: true }, { id: 's2', active: false }],
      error: null,
    });

    const res = await GET(buildRequest('/api/license/sessions', { searchParams: { key_id: 'key-1' } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.sessions).toHaveLength(2);
    expect(body.data.max_devices).toBe(5);
    expect(body.data.active_count).toBe(1);
  });
});
