import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));

import { GET } from '@/app/api/sync/status/route';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { createAdminSupabase } from '@/lib/supabase/admin';

function query(result: { data: unknown; error: unknown }) {
  const chain = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn(async () => result),
  };
  chain.select.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  return chain;
}

describe('GET /api/sync/status safe defaults', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(checkAdminRateLimit).mockResolvedValue(null);
    vi.mocked(requireGuildOwner).mockResolvedValue({
      ok: true,
      ctx: { userId: 'user-1', discordId: 'discord-1', guildId: 'guild-1' },
    });
  });

  it('does not opt a guild into destructive @everyone auto-repair without a config row', async () => {
    const configQuery = query({ data: null, error: null });
    const driftQuery = query({ data: null, error: null });
    vi.mocked(createAdminSupabase).mockReturnValue({
      from: vi.fn((table: string) => table === 'guild_config' ? configQuery : driftQuery),
    } as never);

    const response = await GET(new NextRequest('http://localhost/api/sync/status'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.config).toMatchObject({
      sync_auto_repair: false,
      sync_auto_repair_everyone: false,
    });
  });
});
