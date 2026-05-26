/**
 * Tests for /api/server-setup — V5 Audit Fix #1 (rate limiting).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn() }));

import { GET, POST } from '@/app/api/server-setup/route';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';

import {
  createMockSupabase,
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

describe('GET /api/server-setup', () => {
  it('returns 429 when rate limited', async () => {
    mockRateLimited(checkAdminRateLimit as ReturnType<typeof vi.fn>);

    const res = await GET(buildRequest('/api/server-setup'));
    expect(res.status).toBe(429);
    expect(checkAdminRateLimit).toHaveBeenCalledWith(expect.anything(), 'standard');
  });

  it('returns 401 when not authenticated', async () => {
    mockAuthUnauthorized(requireGuildOwner as ReturnType<typeof vi.fn>);

    const res = await GET(buildRequest('/api/server-setup'));
    expect(res.status).toBe(401);
  });
});

describe('POST /api/server-setup', () => {
  it('returns 429 when rate limited', async () => {
    mockRateLimited(checkAdminRateLimit as ReturnType<typeof vi.fn>);

    const res = await POST(buildRequest('/api/server-setup', {
      method: 'POST',
      body: { action: 'confirm' },
    }));
    expect(res.status).toBe(429);
    expect(checkAdminRateLimit).toHaveBeenCalledWith(expect.anything(), 'write');
  });

  it('returns 401 when not authenticated', async () => {
    mockAuthUnauthorized(requireGuildOwner as ReturnType<typeof vi.fn>);

    const res = await POST(buildRequest('/api/server-setup', {
      method: 'POST',
      body: { action: 'confirm' },
    }));
    expect(res.status).toBe(401);
  });

  it('returns 400 when deployment not completed', async () => {
    mockAuthSuccess(requireGuildOwner as ReturnType<typeof vi.fn>);
    mock._query.single.mockResolvedValue({ data: { applied_at: null } });

    const res = await POST(buildRequest('/api/server-setup', {
      method: 'POST',
      body: { action: 'confirm' },
    }));
    expect(res.status).toBe(400);
  });
});
