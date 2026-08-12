import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn() }));

import { GET } from '@/app/api/economy/analytics/route';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';

describe('GET /api/economy/analytics', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    (checkAdminRateLimit as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (requireGuildOwner as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      ctx: { guildId: 'guild-1' },
    });
  });

  it('maps the deployed wallet stats RPC contract into the dashboard response', async () => {
    const responses: Record<string, unknown[]> = {
      economy_wallet_stats: [{ total_wallets: 4, total_circulation: 1_250, total_banked: 750 }],
      economy_top_earners: [{ user_id: 'member-1', total_earned: 900, total_spent: 200 }],
    };
    const admin = {
      rpc: vi.fn((name: string) => Promise.resolve({ data: responses[name] ?? [], error: null })),
    };
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(admin);

    const response = await GET(new NextRequest('http://localhost/api/economy/analytics?days=30'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.circulation).toEqual({
      total_wallet: 1_250,
      total_bank: 750,
      total: 2_000,
      active_wallets: 4,
    });
    expect(body.top_earners).toEqual([
      { user_id: 'member-1', total_earned: 900, total_spent: 200 },
    ]);
  });
});
