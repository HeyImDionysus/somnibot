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
  it('rejects detector types that the runtime does not evaluate', async () => {
    const response = await POST(request({
      name: 'Inert device rule',
      rule_type: 'device_limit',
      config: { threshold: 3 },
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
});
