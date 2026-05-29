/**
 * Tests for /api/music — music config GET/PUT routes.
 * V5 Audit §13.P2a: Dashboard API coverage for music settings.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/api/require-owner', () => ({
  requireGuildOwner: vi.fn(),
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminSupabase: vi.fn(),
}));
vi.mock('@/lib/notify-bot', () => ({
  notifyBot: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/api/validation', () => ({
  parseBody: vi.fn(),
  schemas: { music: { config: {} } },
}));
vi.mock('@/lib/api/admin-rate-limit', () => ({
  checkAdminRateLimit: vi.fn().mockResolvedValue(null),
}));

import { GET, PUT } from '@/app/api/music/route';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { parseBody } from '@/lib/api/validation';

const mockFrom = vi.fn();
const mockSupabase = { from: mockFrom };

function mockAuthSuccess(guildId = 'guild-123') {
  (requireGuildOwner as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: true,
    ctx: { guildId, discordId: 'discord-456', userId: 'user-789' },
  });
}

function mockAuthFailure() {
  (requireGuildOwner as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: false,
    response: new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mockSupabase);
});

describe('GET /api/music', () => {
  it('returns 401 when not authenticated', async () => {
    mockAuthFailure();
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('returns music config with defaults when no row exists', async () => {
    mockAuthSuccess();
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
    mockFrom.mockReturnValue(chain);

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.music_enabled).toBe(true);
    expect(body.data.music_default_volume).toBe(50);
    expect(body.data.dj_role_id).toBeNull();
  });

  it('returns existing config values', async () => {
    mockAuthSuccess();
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          music_enabled: false,
          music_default_volume: 80,
          dj_role_id: 'role-1',
          music_auto_leave_minutes: 10,
          music_auto_destroy_minutes: 60,
        },
        error: null,
      }),
    };
    mockFrom.mockReturnValue(chain);

    const res = await GET();
    const body = await res.json();
    expect(body.data.music_enabled).toBe(false);
    expect(body.data.music_default_volume).toBe(80);
    expect(body.data.dj_role_id).toBe('role-1');
  });

  it('returns 500 on database error', async () => {
    mockAuthSuccess();
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'connection refused' },
      }),
    };
    mockFrom.mockReturnValue(chain);

    const res = await GET();
    expect(res.status).toBe(500);
  });
});

describe('PUT /api/music', () => {
  function makePutRequest(body: unknown = {}) {
    return new Request('http://localhost/api/music', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('returns 401 when not authenticated', async () => {
    mockAuthFailure();
    (parseBody as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, data: {} });
    const res = await PUT(makePutRequest() as never);
    expect(res.status).toBe(401);
  });

  it('returns 400 when no valid fields provided', async () => {
    mockAuthSuccess();
    (parseBody as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, data: {} });

    const res = await PUT(makePutRequest() as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('No valid fields');
  });

  it('clamps volume to 0-150 range', async () => {
    mockAuthSuccess();
    (parseBody as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: { music_default_volume: 999 },
    });

    const chain = {
      upsert: vi.fn().mockResolvedValue({ error: null }),
    };
    mockFrom.mockReturnValue(chain);

    await PUT(makePutRequest({ music_default_volume: 999 }) as never);

    // Verify upsert was called with clamped value
    const upsertArg = chain.upsert.mock.calls[0][0];
    expect(upsertArg.music_default_volume).toBe(150);
  });

  it('updates config successfully', async () => {
    mockAuthSuccess();
    (parseBody as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: { music_enabled: false },
    });

    const chain = {
      upsert: vi.fn().mockResolvedValue({ error: null }),
    };
    mockFrom.mockReturnValue(chain);

    const res = await PUT(makePutRequest({ music_enabled: false }) as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });
});
