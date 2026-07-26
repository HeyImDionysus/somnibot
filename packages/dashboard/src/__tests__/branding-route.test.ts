/**
 * Tests for /api/branding — white-label brand kit read/write route.
 *
 * Covers:
 *  - GET returns the 5 brand columns scoped to the auth guild (empty object
 *    when no config row exists yet).
 *  - PUT validation mirrors the guild_config CHECK constraints exactly:
 *    colors int 0..16777215 or null, preset enum, name ≤64 nullable,
 *    powered-by boolean; unknown keys and empty payloads are rejected so a
 *    passing payload can never die as a raw 23514 CHECK violation.
 *  - PUT scopes the update to the auth guild and notifies the bot with the
 *    'branding' section so its brand kit cache invalidates immediately.
 *  - Auth failures map through authErrorResponse; rate limiting short-circuits.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac', () => ({
  requirePermission: vi.fn(),
  authErrorResponse: vi.fn(() =>
    // Minimal stand-in for the real 401/403 mapper.
    new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
  ),
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminSupabase: vi.fn(),
}));
vi.mock('@/lib/api/admin-rate-limit', () => ({
  checkAdminRateLimit: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/notify-bot', () => ({
  notifyBot: vi.fn().mockResolvedValue(undefined),
}));

import { NextRequest } from 'next/server';
import { GET, PUT } from '@/app/api/branding/route';
import { requirePermission } from '@/lib/rbac';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { notifyBot } from '@/lib/notify-bot';

const mockFrom = vi.fn();
const mockSupabase = { from: mockFrom };

/** guild_config select().eq().maybeSingle() chain for GET. */
function makeSelectChain(result: { data: unknown; error: unknown }) {
  const chain: any = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn(async () => result),
  };
  chain.select.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  return chain;
}

/** guild_config update().eq() thenable chain for PUT. */
function makeUpdateChain(result: { error: unknown } = { error: null }) {
  const chain: any = {
    update: vi.fn(),
    eq: vi.fn(async () => result),
  };
  chain.update.mockReturnValue(chain);
  return chain;
}

function makePutRequest(body: unknown) {
  return new NextRequest('http://localhost/api/branding', {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

function authError() {
  const err = new Error('Forbidden');
  err.name = 'AuthError';
  return err;
}

beforeEach(() => {
  vi.clearAllMocks();
  (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mockSupabase);
  (checkAdminRateLimit as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (requirePermission as ReturnType<typeof vi.fn>).mockResolvedValue({
    userId: 'user-1',
    discordId: 'discord-1',
    guildId: 'guild-123',
    isOwner: true,
    permissions: ['dashboard.full_access'],
  });
});

describe('GET /api/branding', () => {
  it('returns the brand columns scoped to the auth guild', async () => {
    const row = {
      store_brand_name: 'Acme',
      store_show_powered_by: false,
      brand_primary_color: 0x112233,
      brand_accent_color: null,
      brand_voice_preset: 'friendly',
    };
    const chain = makeSelectChain({ data: row, error: null });
    mockFrom.mockReturnValue(chain);

    const res = await GET();
    const body = await res.json();

    expect(body).toEqual({ success: true, data: row });
    expect(mockFrom).toHaveBeenCalledWith('guild_config');
    expect(chain.select).toHaveBeenCalledWith(
      'store_brand_name, store_show_powered_by, brand_primary_color, brand_accent_color, brand_voice_preset',
    );
    expect(chain.eq).toHaveBeenCalledWith('guild_id', 'guild-123');
    expect(requirePermission).toHaveBeenCalledWith('dashboard.manage_server');
  });

  it('returns an empty object when no config row exists yet', async () => {
    mockFrom.mockReturnValue(makeSelectChain({ data: null, error: null }));

    const res = await GET();
    const body = await res.json();

    expect(body).toEqual({ success: true, data: {} });
  });

  it('maps a DB error to a generic 500', async () => {
    mockFrom.mockReturnValue(makeSelectChain({ data: null, error: { message: 'boom' } }));

    const res = await GET();
    expect(res.status).toBe(500);
    expect((await res.json()).success).toBe(false);
  });

  it('maps AuthError through authErrorResponse', async () => {
    (requirePermission as ReturnType<typeof vi.fn>).mockRejectedValue(authError());

    const res = await GET();
    expect(res.status).toBe(401);
    expect(mockFrom).not.toHaveBeenCalled();
  });
});

describe('PUT /api/branding — happy path', () => {
  it('updates the parsed fields for the auth guild and notifies the bot', async () => {
    const chain = makeUpdateChain();
    mockFrom.mockReturnValue(chain);

    const payload = {
      store_brand_name: 'Acme Support',
      store_show_powered_by: false,
      brand_primary_color: 0xabcdef,
      brand_accent_color: null,
      brand_voice_preset: 'playful',
    };
    const res = await PUT(makePutRequest(payload));
    const body = await res.json();

    expect(body).toEqual({ success: true });
    expect(mockFrom).toHaveBeenCalledWith('guild_config');
    expect(chain.update).toHaveBeenCalledWith(payload);
    expect(chain.eq).toHaveBeenCalledWith('guild_id', 'guild-123');
    expect(notifyBot).toHaveBeenCalledWith('branding');
  });

  it('accepts a partial update (single field)', async () => {
    const chain = makeUpdateChain();
    mockFrom.mockReturnValue(chain);

    const res = await PUT(makePutRequest({ brand_voice_preset: 'professional' }));

    expect((await res.json()).success).toBe(true);
    expect(chain.update).toHaveBeenCalledWith({ brand_voice_preset: 'professional' });
  });

  it('normalizes a blank brand name to NULL (falls back to the guild name)', async () => {
    const chain = makeUpdateChain();
    mockFrom.mockReturnValue(chain);

    await PUT(makePutRequest({ store_brand_name: '   ' }));

    expect(chain.update).toHaveBeenCalledWith({ store_brand_name: null });
  });

  it('boundary colors 0 and 16777215 are accepted', async () => {
    const chain = makeUpdateChain();
    mockFrom.mockReturnValue(chain);

    const res = await PUT(
      makePutRequest({ brand_primary_color: 0, brand_accent_color: 16777215 }),
    );

    expect((await res.json()).success).toBe(true);
    expect(chain.update).toHaveBeenCalledWith({
      brand_primary_color: 0,
      brand_accent_color: 16777215,
    });
  });
});

describe('PUT /api/branding — validation mirrors the DB CHECKs', () => {
  // Each of these payloads would violate a guild_config CHECK constraint (or
  // write an unintended column) if it reached the DB, so zod must reject it
  // with a 400 and the DB must never be touched.
  const invalidPayloads: Array<[string, unknown]> = [
    ['color above 16777215', { brand_primary_color: 16777216 }],
    ['negative color', { brand_accent_color: -1 }],
    ['non-integer color', { brand_primary_color: 3.14 }],
    ['color as hex string', { brand_primary_color: '#ff1493' }],
    ['unknown voice preset', { brand_voice_preset: 'sarcastic' }],
    ['null voice preset (column is NOT NULL)', { brand_voice_preset: null }],
    ['brand name over 64 chars', { store_brand_name: 'x'.repeat(65) }],
    ['non-boolean powered-by', { store_show_powered_by: 'yes' }],
    ['unknown column (mass-assignment guard)', { store_brand_name: 'ok', guild_id: 'g-evil' }],
    ['empty payload', {}],
  ];

  for (const [label, payload] of invalidPayloads) {
    it(`rejects ${label} with 400 and never touches the DB`, async () => {
      const res = await PUT(makePutRequest(payload));

      expect(res.status).toBe(400);
      expect(mockFrom).not.toHaveBeenCalled();
      expect(notifyBot).not.toHaveBeenCalled();
    });
  }

  it('rejects a non-JSON body with 400', async () => {
    const req = new NextRequest('http://localhost/api/branding', {
      method: 'PUT',
      body: 'not json',
      headers: { 'content-type': 'application/json' },
    });
    const res = await PUT(req);
    expect(res.status).toBe(400);
  });
});

describe('PUT /api/branding — auth, rate limit, DB failure', () => {
  it('short-circuits when the admin rate limit trips', async () => {
    const limited = new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429 });
    (checkAdminRateLimit as ReturnType<typeof vi.fn>).mockResolvedValue(limited);

    const res = await PUT(makePutRequest({ brand_voice_preset: 'default' }));

    expect(res.status).toBe(429);
    expect(requirePermission).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('maps AuthError through authErrorResponse', async () => {
    (requirePermission as ReturnType<typeof vi.fn>).mockRejectedValue(authError());

    const res = await PUT(makePutRequest({ brand_voice_preset: 'default' }));

    expect(res.status).toBe(401);
    expect(mockFrom).not.toHaveBeenCalled();
    expect(notifyBot).not.toHaveBeenCalled();
  });

  it('maps a DB update error to a generic 500 and does not notify the bot', async () => {
    mockFrom.mockReturnValue(makeUpdateChain({ error: { message: '23514 check violation' } }));

    const res = await PUT(makePutRequest({ brand_primary_color: 0x123456 }));

    expect(res.status).toBe(500);
    expect(notifyBot).not.toHaveBeenCalled();
  });
});
