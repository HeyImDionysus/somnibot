/**
 * Tests for /api/branding — white-label brand kit read/write route.
 *
 * Covers:
 *  - OWNER-ONLY auth: both GET and PUT gate on requireGuildOwner (matching the
 *    sibling settings routes) — store_brand_name feeds the PayPal checkout
 *    brand_name, so a delegated dashboard role must never control it.
 *  - GET returns the 5 brand columns scoped to the auth guild (empty object
 *    when no config row exists yet).
 *  - PUT validation mirrors the guild_config CHECK constraints exactly:
 *    colors int 0..16777215 or null, preset enum, name ≤64 nullable,
 *    powered-by boolean; unknown keys and empty payloads are rejected so a
 *    passing payload can never die as a raw 23514 CHECK violation.
 *  - PUT UPSERTS on guild_id so a pre-init guild (no guild_config row yet)
 *    persists the save instead of a 0-row update reporting phantom success.
 *  - PUT reads the changed keys' prior values before the write and passes
 *    them to notifyBot('branding', changes, ..., before) so the bot's
 *    config.updated audit row carries a real before_state.
 *  - Rate limiting short-circuits before auth or DB work.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/api/require-owner', () => ({
  requireGuildOwner: vi.fn(),
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
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { notifyBot } from '@/lib/notify-bot';
import { mockAuthSuccess, mockAuthUnauthorized, mockAuthForbidden } from './helpers/mock-auth';

const mockFrom = vi.fn();
const mockSupabase = { from: mockFrom };

/** guild_config select().eq().maybeSingle() chain for GET / the PUT before-read. */
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

/** guild_config upsert() thenable chain for the PUT write. */
function makeUpsertChain(result: { error: unknown } = { error: null }) {
  return { upsert: vi.fn(async () => result) } as any;
}

/**
 * Wire the PUT's two from('guild_config') calls in order: the before-read
 * select, then the upsert write.
 */
function mockPutChains(opts: { prior?: unknown; priorError?: unknown; upsertError?: unknown } = {}) {
  const selectChain = makeSelectChain({ data: opts.prior ?? null, error: opts.priorError ?? null });
  const upsertChain = makeUpsertChain({ error: opts.upsertError ?? null });
  mockFrom.mockReturnValueOnce(selectChain).mockReturnValueOnce(upsertChain);
  return { selectChain, upsertChain };
}

function makePutRequest(body: unknown) {
  return new NextRequest('http://localhost/api/branding', {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mockSupabase);
  (checkAdminRateLimit as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  mockAuthSuccess(requireGuildOwner as ReturnType<typeof vi.fn>, { guildId: 'guild-123' });
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
    expect(requireGuildOwner).toHaveBeenCalled();
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

  it('returns 401 when there is no valid session', async () => {
    mockAuthUnauthorized(requireGuildOwner as ReturnType<typeof vi.fn>);

    const res = await GET();
    expect(res.status).toBe(401);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('returns 403 for an authenticated non-owner (owner-only surface)', async () => {
    mockAuthForbidden(requireGuildOwner as ReturnType<typeof vi.fn>);

    const res = await GET();
    expect(res.status).toBe(403);
    expect(mockFrom).not.toHaveBeenCalled();
  });
});

describe('PUT /api/branding — happy path', () => {
  it('upserts the parsed fields keyed on the auth guild and notifies the bot with before-values', async () => {
    const prior = {
      store_brand_name: 'Old Name',
      store_show_powered_by: true,
      brand_primary_color: 0x111111,
      brand_accent_color: 0x222222,
      brand_voice_preset: 'default',
    };
    const { selectChain, upsertChain } = mockPutChains({ prior });

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
    // Before-read selects exactly the changed keys for the auth guild.
    expect(selectChain.select).toHaveBeenCalledWith(Object.keys(payload).join(', '));
    expect(selectChain.eq).toHaveBeenCalledWith('guild_id', 'guild-123');
    // Upsert (not update) keyed on the guild_config PK.
    expect(upsertChain.upsert).toHaveBeenCalledWith(
      { guild_id: 'guild-123', ...payload },
      { onConflict: 'guild_id' },
    );
    // The audit payload carries the changed keys AND their prior values.
    expect(notifyBot).toHaveBeenCalledWith('branding', payload, 'dashboard', undefined, prior);
  });

  it('persists a save for a pre-init guild with no guild_config row yet', async () => {
    const { upsertChain } = mockPutChains({ prior: null });

    const res = await PUT(makePutRequest({ brand_voice_preset: 'professional' }));

    expect((await res.json()).success).toBe(true);
    expect(upsertChain.upsert).toHaveBeenCalledWith(
      { guild_id: 'guild-123', brand_voice_preset: 'professional' },
      { onConflict: 'guild_id' },
    );
    // No prior row → no before payload (bot falls back to its own snapshot).
    expect(notifyBot).toHaveBeenCalledWith(
      'branding', { brand_voice_preset: 'professional' }, 'dashboard', undefined, undefined,
    );
  });

  it('a failed before-read never blocks the save', async () => {
    const { upsertChain } = mockPutChains({ priorError: { message: 'transient' } });

    const res = await PUT(makePutRequest({ store_show_powered_by: true }));

    expect((await res.json()).success).toBe(true);
    expect(upsertChain.upsert).toHaveBeenCalled();
    expect(notifyBot).toHaveBeenCalledWith(
      'branding', { store_show_powered_by: true }, 'dashboard', undefined, undefined,
    );
  });

  it('normalizes a blank brand name to NULL (falls back to the guild name)', async () => {
    const { upsertChain } = mockPutChains();

    await PUT(makePutRequest({ store_brand_name: '   ' }));

    expect(upsertChain.upsert).toHaveBeenCalledWith(
      { guild_id: 'guild-123', store_brand_name: null },
      { onConflict: 'guild_id' },
    );
  });

  it('boundary colors 0 and 16777215 are accepted', async () => {
    const { upsertChain } = mockPutChains();

    const res = await PUT(
      makePutRequest({ brand_primary_color: 0, brand_accent_color: 16777215 }),
    );

    expect((await res.json()).success).toBe(true);
    expect(upsertChain.upsert).toHaveBeenCalledWith(
      { guild_id: 'guild-123', brand_primary_color: 0, brand_accent_color: 16777215 },
      { onConflict: 'guild_id' },
    );
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
    expect(requireGuildOwner).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('returns 401 when there is no valid session', async () => {
    mockAuthUnauthorized(requireGuildOwner as ReturnType<typeof vi.fn>);

    const res = await PUT(makePutRequest({ brand_voice_preset: 'default' }));

    expect(res.status).toBe(401);
    expect(mockFrom).not.toHaveBeenCalled();
    expect(notifyBot).not.toHaveBeenCalled();
  });

  it('returns 403 for an authenticated non-owner (owner-only surface)', async () => {
    mockAuthForbidden(requireGuildOwner as ReturnType<typeof vi.fn>);

    const res = await PUT(makePutRequest({ brand_voice_preset: 'default' }));

    expect(res.status).toBe(403);
    expect(mockFrom).not.toHaveBeenCalled();
    expect(notifyBot).not.toHaveBeenCalled();
  });

  it('maps a DB upsert error to a generic 500 and does not notify the bot', async () => {
    mockPutChains({ upsertError: { message: '23514 check violation' } });

    const res = await PUT(makePutRequest({ brand_primary_color: 0x123456 }));

    expect(res.status).toBe(500);
    expect(notifyBot).not.toHaveBeenCalled();
  });
});
