/**
 * Members Search Route Tests — V5 Audit §13.4 + §14.4
 *
 * Tests both the new RPC-based search and the legacy fallback path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock dependencies ───────────────────────────────────────

const mockRequireGuildOwner = vi.fn();
vi.mock('@/lib/api/require-owner', () => ({
  requireGuildOwner: () => mockRequireGuildOwner(),
}));

const mockRateLimit = vi.fn();
vi.mock('@/lib/api/admin-rate-limit', () => ({
  checkAdminRateLimit: (...args: unknown[]) => mockRateLimit(...args),
}));

const mockRpc = vi.fn();
const mockQueryChain = {
  select: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(),
  single: vi.fn(),
};
const mockSupabase = {
  from: vi.fn().mockReturnValue(mockQueryChain),
  rpc: (...args: unknown[]) => mockRpc(...args),
};
vi.mock('@/lib/supabase/admin', () => ({
  createAdminSupabase: () => mockSupabase,
}));

import { GET } from '../app/api/members/search/route';

// ── Helpers ─────────────────────────────────────────────────

function buildRequest(params: Record<string, string> = {}) {
  const sp = new URLSearchParams(params);
  const url = `http://localhost/api/members/search?${sp.toString()}`;
  return new Request(url, {
    headers: { 'x-forwarded-for': '1.2.3.4' },
  }) as unknown as import('next/server').NextRequest;
}

// ── Tests ───────────────────────────────────────────────────

beforeEach(() => {
  vi.resetAllMocks();
  mockQueryChain.select.mockReturnThis();
  mockQueryChain.eq.mockReturnThis();
  mockSupabase.from.mockReturnValue(mockQueryChain);
  mockRateLimit.mockResolvedValue(null);
  mockRequireGuildOwner.mockResolvedValue({
    ok: true,
    ctx: { userId: 'user-1', discordId: '123', guildId: 'guild-1' },
  });
});

describe('GET /api/members/search', () => {
  it('returns 401 when not authenticated', async () => {
    mockRequireGuildOwner.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    });

    const res = await GET(buildRequest({ q: 'test' }));
    expect(res.status).toBe(401);
  });

  describe('RPC-based search (V5 §14.4)', () => {
    it('passes search query to the RPC', async () => {
      mockRpc.mockResolvedValue({
        data: [
          { member_id: '111', username: 'testuser', display_name: 'Test User', avatar: 'abc', is_bot: false, total_matches: 1 },
        ],
        error: null,
      });

      const res = await GET(buildRequest({ q: 'test' }));
      const body = await res.json();

      expect(body.success).toBe(true);
      expect(body.members).toHaveLength(1);
      expect(body.members[0].id).toBe('111');
      expect(body.members[0].username).toBe('testuser');
      expect(mockRpc).toHaveBeenCalledWith('search_guild_members', expect.objectContaining({
        p_guild_id: 'guild-1',
        p_query: 'test',
        p_limit: 25,
      }));
    });

    it('passes IDs to the RPC for resolution', async () => {
      mockRpc.mockResolvedValue({
        data: [
          { member_id: '111', username: 'user1', display_name: null, avatar: null, is_bot: false, total_matches: 1 },
          { member_id: '222', username: 'user2', display_name: null, avatar: null, is_bot: false, total_matches: 2 },
        ],
        error: null,
      });

      const res = await GET(buildRequest({ ids: '111,222' }));
      const body = await res.json();

      expect(body.success).toBe(true);
      expect(body.members).toHaveLength(2);
      expect(mockRpc).toHaveBeenCalledWith('search_guild_members', expect.objectContaining({
        p_guild_id: 'guild-1',
        p_ids: ['111', '222'],
      }));
    });

    it('returns empty members when RPC returns empty', async () => {
      mockRpc.mockResolvedValue({ data: [], error: null });

      const res = await GET(buildRequest({ q: 'nonexistent' }));
      const body = await res.json();

      expect(body.success).toBe(true);
      expect(body.members).toHaveLength(0);
    });
  });

  describe('legacy fallback (pre-migration)', () => {
    it('falls back when RPC does not exist', async () => {
      mockRpc.mockResolvedValue({
        data: null,
        error: { message: 'Could not find the function search_guild_members' },
      });

      // Legacy path reads from guild_live_state
      mockQueryChain.single.mockResolvedValue({
        data: {
          members: [
            { id: '111', username: 'alice', display_name: 'Alice', avatar: 'a', bot: false },
            { id: '222', username: 'bob', display_name: 'Bob', avatar: 'b', bot: false },
          ],
          snapshot_at: '2026-01-01T00:00:00Z',
        },
      });

      const res = await GET(buildRequest({ q: 'alice' }));
      const body = await res.json();

      expect(body.success).toBe(true);
      expect(body.members).toHaveLength(1);
      expect(body.members[0].username).toBe('alice');
    });
  });
});
