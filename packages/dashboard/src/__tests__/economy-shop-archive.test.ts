import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/rbac', () => ({
  requirePermission: vi.fn(),
  authErrorResponse: vi.fn(),
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn() }));
vi.mock('@/lib/notify-bot', () => ({ notifyBot: vi.fn() }));
vi.mock('@/lib/admin-changes', () => ({
  readRowBefore: vi.fn(),
  recordCrudChange: vi.fn().mockResolvedValue(undefined),
}));

import { DELETE } from '@/app/api/economy/shop/route';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { readRowBefore, recordCrudChange } from '@/lib/admin-changes';
import { notifyBot } from '@/lib/notify-bot';
import { requirePermission } from '@/lib/rbac';
import { createAdminSupabase } from '@/lib/supabase/admin';

const ITEM_ID = '10000000-0000-4000-8000-000000000001';
const GUILD_ID = '111111111111111111';

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(checkAdminRateLimit).mockResolvedValue(null);
  vi.mocked(requirePermission).mockResolvedValue({
    userId: 'user-1',
    guildId: GUILD_ID,
    discordId: '222222222222222222',
    isOwner: true,
    permissions: ['dashboard.manage_economy'],
  });
  vi.mocked(readRowBefore).mockResolvedValue({
    id: ITEM_ID,
    guild_id: GUILD_ID,
    name: 'Adventure Key',
    active: true,
  });
});

describe('DELETE /api/economy/shop', () => {
  it('archives an item so configured rewards and existing inventory retain a valid item identity', async () => {
    const result = { data: null, error: null };
    const chain: Record<string, unknown> = {
      eq: vi.fn(() => chain),
      then: (resolve: (value: typeof result) => unknown) => resolve(result),
    };
    const update = vi.fn(() => chain);
    const hardDelete = vi.fn(() => chain);
    const admin = {
      from: vi.fn(() => ({ ...chain, update, delete: hardDelete })),
    };
    vi.mocked(createAdminSupabase).mockReturnValue(admin as never);

    const response = await DELETE(new NextRequest(
      `http://localhost/api/economy/shop?id=${ITEM_ID}`,
      { method: 'DELETE' },
    ));

    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledWith({
      active: false,
      updated_at: expect.any(String),
    });
    expect(hardDelete).not.toHaveBeenCalled();
    expect(notifyBot).toHaveBeenCalledWith(GUILD_ID, 'economy');
    expect(recordCrudChange).toHaveBeenCalledWith(expect.objectContaining({
      guildId: GUILD_ID,
      operation: 'updated',
      action: 'shop.item_archived',
      targetId: ITEM_ID,
      before: expect.objectContaining({ active: true }),
      after: expect.objectContaining({ active: false }),
      match: { id: ITEM_ID, guild_id: GUILD_ID },
    }), admin);
    await expect(response.json()).resolves.toMatchObject({ success: true, archived: true });
  });
});
