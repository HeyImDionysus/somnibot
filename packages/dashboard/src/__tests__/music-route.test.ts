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
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
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
    expect(errorSpy).toHaveBeenCalledWith(
      '[music] DB error:',
      'connection refused',
    );
    errorSpy.mockRestore();
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

  // ── Out-of-range timers are REJECTED, not silently clamped ──
  // The route used to clamp a submitted 0 to 1 (Math.max(1, ...)); the Zod
  // schema now rejects it with a field-level error so nothing is persisted.
  it('rejects music_auto_leave_minutes=0 with a field-named validation error (real schema)', async () => {
    const actual = await vi.importActual<typeof import('@/lib/api/validation')>('@/lib/api/validation');
    const req = makePutRequest({ music_auto_leave_minutes: 0 });
    const result = await actual.parseBody(req as never, actual.schemas.music.config as never);
    expect(result.ok).toBe(false);
    const response = (result as { response: Response }).response;
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('Validation');
    const paths = (body.details as Array<{ path: string }>).map((d) => d.path);
    expect(paths).toContain('music_auto_leave_minutes');
  });

  it('accepts the minimum valid timers (auto_leave=1, auto_destroy=120) (real schema)', async () => {
    const actual = await vi.importActual<typeof import('@/lib/api/validation')>('@/lib/api/validation');
    const req = makePutRequest({ music_auto_leave_minutes: 1, music_auto_destroy_minutes: 120 });
    const result = await actual.parseBody(req as never, actual.schemas.music.config as never);
    expect(result.ok).toBe(true);
  });

  it('does not write guild_config (no silent clamp to 1) when the timer is rejected', async () => {
    mockAuthSuccess();
    // Validation rejects the out-of-range timer before the route touches the DB.
    (parseBody as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ success: false, error: 'Validation failed' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      }),
    });
    const chain = { upsert: vi.fn().mockResolvedValue({ error: null }) };
    mockFrom.mockReturnValue(chain);

    const res = await PUT(makePutRequest({ music_auto_leave_minutes: 0 }) as never);
    expect(res.status).toBe(400);
    expect(chain.upsert).not.toHaveBeenCalled();
  });
});
