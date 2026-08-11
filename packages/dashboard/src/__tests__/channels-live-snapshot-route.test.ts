import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));

import { GET } from '@/app/api/channels/route';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';

const GUILD_ID = '111111111111111111';

function installLiveSnapshot(liveState: Record<string, unknown> | null): void {
  const chain: Record<string, unknown> = {
    maybeSingle: vi.fn(async () => ({ data: liveState, error: null })),
  };
  for (const method of ['select', 'eq']) chain[method] = vi.fn(() => chain);
  vi.mocked(createAdminSupabase).mockReturnValue({ from: vi.fn(() => chain) } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireGuildOwner).mockResolvedValue({
    ok: true,
    ctx: { guildId: GUILD_ID, discordId: '222222222222222222', userId: 'owner' },
  } as never);
});

describe('GET /api/channels live snapshot contract', () => {
  it('returns names and freshness metadata that ticket summaries can render', async () => {
    installLiveSnapshot({
      channels: [{ id: '333333333333333333', name: 'support', type: 0 }],
      categories: [{ id: '444444444444444444', name: 'Help' }],
      bot_permissions: '1024',
      snapshot_version: 7,
      snapshot_at: '2030-01-01T00:00:00.000Z',
    });

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      channels: [{ id: '333333333333333333', name: 'support', type: 0 }],
      categories: [{ id: '444444444444444444', name: 'Help' }],
      botPermissions: '1024',
      snapshotVersion: 7,
      snapshotAt: '2030-01-01T00:00:00.000Z',
      awaitingSnapshot: false,
    });
  });

  it('explicitly signals when the bot has not supplied a channel snapshot', async () => {
    installLiveSnapshot(null);

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      channels: [],
      categories: [],
      snapshotAt: null,
      awaitingSnapshot: true,
    });
  });
});
