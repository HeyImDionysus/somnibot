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
  readRowBefore: vi.fn().mockResolvedValue({ id: '10000000-0000-4000-8000-000000000001' }),
  recordCrudChange: vi.fn().mockResolvedValue(undefined),
}));

import { POST, PUT } from '@/app/api/economy/adventures/route';
import { requirePermission } from '@/lib/rbac';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';

const ADVENTURE_ID = '10000000-0000-4000-8000-000000000001';

const graph = {
  name: 'Forest Trial',
  emoji: '🌲',
  description: 'Choose a path through the forest.',
  adventure_type: 'forest',
  difficulty: 'normal',
  active: true,
  scenes: [
    {
      text: 'Two paths split ahead.',
      is_ending: false,
      ending_type: null,
      choices: [{
        label: 'Take the bright path',
        emoji: '➡️',
        next_scene_index: 1,
        loot: [],
        currency: 5,
        damage_pct: 0,
        requires_item: null,
      }],
      loot: [],
      image_url: null,
    },
    {
      text: 'You find the exit.',
      is_ending: true,
      ending_type: 'success',
      choices: [],
      loot: [],
      image_url: null,
    },
  ],
} as const;

function request(method: 'POST' | 'PUT', body: unknown) {
  return new NextRequest('http://localhost/api/economy/adventures', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(checkAdminRateLimit).mockResolvedValue(null);
  vi.mocked(requirePermission).mockResolvedValue({
    userId: 'user-1',
    guildId: 'guild-1',
    discordId: 'owner-1',
    isOwner: true,
    permissions: ['dashboard.manage_economy'],
  });
});

describe('/api/economy/adventures graph writes', () => {
  it('rejects an incomplete graph before any database mutation', async () => {
    const rpc = vi.fn();
    vi.mocked(createAdminSupabase).mockReturnValue({ rpc } as never);

    const response = await POST(request('POST', {
      ...graph,
      scenes: [{ ...graph.scenes[0], choices: [] }],
    }));

    expect(response.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('returns a truthful conflict instead of replacing scenes during an active run', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { code: '55006', message: 'adventure_has_active_sessions' },
    });
    vi.mocked(createAdminSupabase).mockReturnValue({ rpc } as never);

    const response = await PUT(request('PUT', { ...graph, id: ADVENTURE_ID }));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toContain('actively playing');
    expect(rpc).toHaveBeenCalledWith('upsert_economy_adventure_graph', {
      p_guild_id: 'guild-1',
      p_adventure: expect.objectContaining({ id: ADVENTURE_ID, scenes: expect.any(Array) }),
    });
  });
});
