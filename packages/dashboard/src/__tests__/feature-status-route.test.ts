import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/rbac', () => ({
  requirePermission: vi.fn(),
  authErrorResponse: vi.fn(),
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminSupabase: vi.fn(),
}));

import { GET } from '@/app/api/dashboard/feature-status/route';
import { requirePermission } from '@/lib/rbac';
import { createAdminSupabase } from '@/lib/supabase/admin';

function chain(data: unknown) {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ['select', 'eq', 'in', 'order', 'limit']) {
    query[method] = vi.fn(() => query);
  }
  query.maybeSingle = vi.fn(async () => ({ data, error: null }));
  return query;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requirePermission).mockResolvedValue({
    guildId: 'guild-1',
    discordId: 'member-1',
    isOwner: false,
    permissions: [],
  } as never);
});

describe('GET /api/dashboard/feature-status', () => {
  it('uses the guild RBAC context and returns only feature readiness data', async () => {
    const config = chain({ economy_enabled: true });
    const heartbeat = chain({ snapshot_at: new Date().toISOString() });
    vi.mocked(createAdminSupabase).mockReturnValue({
      from: vi.fn((table: string) => table === 'guild_config' ? config : heartbeat),
    } as never);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(requirePermission).toHaveBeenCalledWith(null);
    expect(config.eq).toHaveBeenCalledWith('guild_id', 'guild-1');
    expect(heartbeat.eq).toHaveBeenCalledWith('guild_id', 'guild-1');
    expect(body).toMatchObject({
      success: true,
      data: {
        config: { economy_enabled: true },
        bot: { online: true },
      },
    });
  });
});
