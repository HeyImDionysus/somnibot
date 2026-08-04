import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/rbac', () => ({
  requirePermission: vi.fn(),
  authErrorResponse: vi.fn(),
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminSupabase: vi.fn(),
}));
vi.mock('@/lib/api/admin-rate-limit', () => ({
  checkAdminRateLimit: vi.fn(),
}));
vi.mock('@/lib/admin-changes', () => ({
  readRowBefore: vi.fn(),
  recordCrudChange: vi.fn(),
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/fraud/rules/route';
import { requirePermission } from '@/lib/rbac';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';

function request(body: unknown) {
  return new NextRequest('http://localhost/api/fraud/rules', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(checkAdminRateLimit).mockResolvedValue(null);
  vi.mocked(requirePermission).mockResolvedValue({
    guildId: 'guild-123',
    discordId: 'owner-123',
  } as never);
});

describe('POST /api/fraud/rules validation', () => {
  it('rejects detector configs outside the runtime safety range', async () => {
    const response = await POST(request({
      name: 'Invalid device rule',
      rule_type: 'device_limit',
      config: { threshold: 1 },
      auto_action: 'flag',
    }));

    expect(response.status).toBe(400);
    expect(createAdminSupabase).not.toHaveBeenCalled();
  });

  it('rejects automatic actions that the runtime does not execute', async () => {
    const response = await POST(request({
      name: 'Unsupported ban rule',
      rule_type: 'velocity_limit',
      config: { threshold: 5, window_minutes: 60 },
      auto_action: 'ban',
    }));

    expect(response.status).toBe(400);
    expect(createAdminSupabase).not.toHaveBeenCalled();
  });

  it.each([
    { threshold: 0, window_minutes: 60 },
    { threshold: 5, window_minutes: -1 },
    { threshold: 5, window_minutes: 1e308 },
    { threshold: 5, window_minute: 60 },
    { threshold: 5, window_minutes: 60, window_ms: 3_600_000 },
  ])('rejects invalid or ambiguous velocity config %#', async (config) => {
    const response = await POST(request({
      name: 'Invalid velocity rule',
      rule_type: 'velocity_limit',
      config,
      auto_action: 'flag',
    }));

    expect(response.status).toBe(400);
    expect(createAdminSupabase).not.toHaveBeenCalled();
  });
});
