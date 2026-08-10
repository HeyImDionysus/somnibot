import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));

import { GET } from '@/app/api/guild/route';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';

const GUILD_ID = '111111111111111111';

function query(data: unknown) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ['select', 'eq']) {
    chain[method] = vi.fn(() => chain);
  }
  chain.single = vi.fn(async () => ({ data, error: null }));
  chain.maybeSingle = vi.fn(async () => ({ data, error: null }));
  return chain;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireGuildOwner).mockResolvedValue({
    ok: true,
    ctx: { guildId: GUILD_ID, discordId: '222222222222222222', userId: 'owner' },
  } as never);
});

describe('GET /api/guild config readback', () => {
  it('returns a one-to-one guild_config object so ticket defaults survive a reload', async () => {
    const guild = query({
      id: GUILD_ID,
      guild_config: { ticket_transcript_enabled: true, ticket_dm_transcript: false },
    });
    const desiredState = query(null);
    const liveState = query({ member_count: 3 });
    vi.mocked(createAdminSupabase).mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === 'guild') return guild;
        if (table === 'guild_desired_state') return desiredState;
        return liveState;
      }),
    } as never);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.config).toEqual({ ticket_transcript_enabled: true, ticket_dm_transcript: false });
  });
});
