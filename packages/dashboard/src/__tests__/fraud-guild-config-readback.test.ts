import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));

import { GET } from '@/app/api/guild/route';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';

const guildId = '111111111111111111';
const persistedConfig = { fraud_owner_dm_on_critical: false };
let guildConfig: unknown;

describe('GET /api/guild fraud notification readback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    guildConfig = persistedConfig;
    vi.mocked(requireGuildOwner).mockResolvedValue({
      ok: true,
      ctx: { guildId, discordId: '222222222222222222', userId: 'owner' },
    } as never);

    const guildQuery = {
      select: vi.fn(() => guildQuery),
      eq: vi.fn(() => guildQuery),
      single: vi.fn(async () => ({
        data: { id: guildId, total_roles: 4, guild_config: guildConfig },
      })),
    };
    const stateQuery = {
      select: vi.fn(() => stateQuery),
      eq: vi.fn(() => stateQuery),
      single: vi.fn(async () => ({ data: null })),
      maybeSingle: vi.fn(async () => ({ data: null })),
    };

    vi.mocked(createAdminSupabase).mockReturnValue({
      from: vi.fn((table: string) => table === 'guild' ? guildQuery : stateQuery),
    } as never);
  });

  it('returns persisted false from an object relation', async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      config: { fraud_owner_dm_on_critical: false },
    });
  });

  it('returns persisted false from an array relation', async () => {
    guildConfig = [persistedConfig];

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      config: { fraud_owner_dm_on_critical: false },
    });
  });
});
