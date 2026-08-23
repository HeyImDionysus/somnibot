import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));

import { GET } from '@/app/api/guild/route';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { PUBLIC_DESIRED_STATE_COLUMNS } from '@/lib/public-desired-state';

const GUILD_ID = '111111111111111111';

function query(data: unknown, error: { message: string } | null = null) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ['select', 'eq']) {
    chain[method] = vi.fn(() => chain);
  }
  chain.single = vi.fn(async () => ({ data, error }));
  chain.maybeSingle = vi.fn(async () => ({ data, error }));
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

  it('never returns internal deployment lease or error fields', async () => {
    const guild = query({ id: GUILD_ID, guild_config: {} });
    const desiredState = query({
      guild_id: GUILD_ID,
      roles: [{ key: 'member' }],
      deploy_status: 'running',
      deploy_claim_token: 'internal-claim-token',
      deploy_claimed_at: '2026-08-23T09:38:00.000Z',
      deploy_lease_expires_at: '2026-08-23T09:40:00.000Z',
      deploy_error: 'internal stack details',
    });
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

    expect(body.desiredState).toMatchObject({
      guild_id: GUILD_ID,
      deploy_status: 'running',
    });
    expect(body.desiredState).not.toHaveProperty('deploy_claim_token');
    expect(body.desiredState).not.toHaveProperty('deploy_claimed_at');
    expect(body.desiredState).not.toHaveProperty('deploy_lease_expires_at');
    expect(body.desiredState).not.toHaveProperty('deploy_error');
    expect(desiredState.select).toHaveBeenCalledWith(PUBLIC_DESIRED_STATE_COLUMNS);
  });

  it('fails closed when desired state cannot be read', async () => {
    const guild = query({ id: GUILD_ID, guild_config: {} });
    const desiredState = query(null, { message: 'invalid projection' });
    const liveState = query({ member_count: 3 });
    vi.mocked(createAdminSupabase).mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === 'guild') return guild;
        if (table === 'guild_desired_state') return desiredState;
        return liveState;
      }),
    } as never);

    const response = await GET();

    expect(response.status).toBe(500);
  });

  it('returns null desired state for a fresh guild', async () => {
    const guild = query({ id: GUILD_ID, guild_config: {} });
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
    expect(body.desiredState).toBeNull();
  });
});
