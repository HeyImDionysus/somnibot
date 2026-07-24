/**
 * /api/moderation/appeals — owner review queue for member infraction appeals.
 *
 * GET lists appeals scoped to the active guild; PATCH decides a pending appeal
 * atomically (only a still-pending row can be decided) and records the reviewer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn().mockResolvedValue(null) }));

import { GET, PATCH } from '@/app/api/moderation/appeals/route';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { mockAuthSuccess, mockAuthUnauthorized } from './helpers/mock-auth';

function makeAdmin(opts: { list?: unknown[]; count?: number; decideRow?: unknown; decideError?: unknown } = {}) {
  const { list = [], count = 0, decideRow = null, decideError = null } = opts;
  const calls: Record<string, unknown[][]> = {};
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order', 'range', 'limit', 'update']) {
    chain[m] = vi.fn((...a: unknown[]) => {
      (calls[m] ??= []).push(a);
      return chain;
    });
  }
  chain.maybeSingle = vi.fn(() => Promise.resolve({ data: decideRow, error: decideError }));
  chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: list, error: null, count });
  return { admin: { from: vi.fn(() => chain) }, calls };
}

function makeRequest(method: string, opts: { query?: Record<string, string>; body?: unknown } = {}) {
  const url = new URL('http://localhost/api/moderation/appeals');
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  return new NextRequest(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

const APPEAL = {
  id: 'appeal-1',
  guild_id: 'guild-1',
  infraction_id: 'inf-1',
  appellant_discord_id: 'user-1',
  reason: 'Please reconsider',
  status: 'pending',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthSuccess(requireGuildOwner as ReturnType<typeof vi.fn>, { guildId: 'guild-1', discordId: 'owner-1' });
});

describe('GET /api/moderation/appeals', () => {
  it('lists appeals scoped to the active guild with total count', async () => {
    const { admin, calls } = makeAdmin({ list: [APPEAL], count: 3 });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(admin);

    const res = await GET(makeRequest('GET', { query: { status: 'pending' } }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.total).toBe(3);
    expect(json.data).toHaveLength(1);
    expect(calls.eq).toEqual(expect.arrayContaining([['guild_id', 'guild-1'], ['status', 'pending']]));
  });

  it('rejects an invalid status filter with 400', async () => {
    const { admin } = makeAdmin();
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(admin);

    const res = await GET(makeRequest('GET', { query: { status: 'bogus' } }));
    expect(res.status).toBe(400);
  });

  it('requires authentication', async () => {
    mockAuthUnauthorized(requireGuildOwner as ReturnType<typeof vi.fn>);
    const res = await GET(makeRequest('GET'));
    expect(res.status).toBe(401);
  });
});

describe('PATCH /api/moderation/appeals', () => {
  it('approves a pending appeal atomically and records the reviewer', async () => {
    const { admin, calls } = makeAdmin({ decideRow: { ...APPEAL, status: 'approved', reviewer_id: 'owner-1' } });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(admin);

    const res = await PATCH(makeRequest('PATCH', { body: { id: 'appeal-1', action: 'approve' } }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.status).toBe('approved');
    // Atomic guard + reviewer identity from the authenticated owner.
    expect(calls.eq).toEqual(expect.arrayContaining([['id', 'appeal-1'], ['guild_id', 'guild-1'], ['status', 'pending']]));
    const updatePayload = (calls.update?.[0]?.[0] ?? {}) as Record<string, unknown>;
    expect(updatePayload.status).toBe('approved');
    expect(updatePayload.reviewer_id).toBe('owner-1');
    expect(updatePayload.decision_notified).toBe(false);
  });

  it('denies a pending appeal', async () => {
    const { admin } = makeAdmin({ decideRow: { ...APPEAL, status: 'denied' } });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(admin);

    const res = await PATCH(makeRequest('PATCH', { body: { id: 'appeal-1', action: 'deny' } }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.status).toBe('denied');
  });

  it('returns 409 when the appeal is not found or already decided', async () => {
    const { admin } = makeAdmin({ decideRow: null });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(admin);

    const res = await PATCH(makeRequest('PATCH', { body: { id: 'appeal-1', action: 'approve' } }));
    expect(res.status).toBe(409);
  });

  it('rejects an unknown action with 400 and no write', async () => {
    const { admin, calls } = makeAdmin();
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(admin);

    const res = await PATCH(makeRequest('PATCH', { body: { id: 'appeal-1', action: 'nuke' } }));
    expect(res.status).toBe(400);
    expect(calls.update).toBeUndefined();
  });

  it('rejects a missing appeal id with 400', async () => {
    const { admin } = makeAdmin();
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(admin);

    const res = await PATCH(makeRequest('PATCH', { body: { action: 'approve' } }));
    expect(res.status).toBe(400);
  });
});
