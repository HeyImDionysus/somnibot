/**
 * /api/giveaways — dashboard CRUD audit rows (#57).
 *
 * The bot rail audits lifecycle events it performs itself (start/pause/end/
 * reroll), but dashboard-origin giveaway config writes were invisible.
 * Every successful mutation now writes one append-only audit_logs row
 * (category giveaways, actor_type dashboard) with an honest before/after
 * diff on update/delete — including a dashboard cancel (status change),
 * which the PUT diff captures.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/notify-bot', () => ({ notifyBot: vi.fn().mockResolvedValue(undefined) }));

import { POST, PUT, DELETE } from '@/app/api/giveaways/route';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { mockAuthSuccess, DEFAULT_OWNER_CTX } from './helpers/mock-auth';

const GW_ID = '223e4567-e89b-12d3-a456-426614174000';

const ROW = {
  id: GW_ID,
  guild_id: 'guild-123',
  channel_id: '123456789012345678',
  prize: 'Nitro',
  winner_count: 1,
  ends_at: '2026-08-01T00:00:00.000Z',
  required_role_id: null,
  required_level: null,
  prize_product_id: null,
  prize_license_count: 1,
  created_by: 'dashboard',
  entries: ['u1', 'u2'],
  winners: [],
  status: 'active',
};

function makeAdmin(config: {
  singles?: Record<string, any[]>;
  thens?: Record<string, any[]>;
} = {}) {
  const singles = config.singles ?? {};
  const thens = config.thens ?? {};
  const auditRows: any[] = [];

  function chainFor(table: string) {
    if (table === 'audit_logs') {
      return { insert: vi.fn(async (row: any) => { auditRows.push(row); return { error: null }; }) };
    }
    const c: any = {};
    for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'order', 'limit', 'range']) {
      c[m] = vi.fn(() => c);
    }
    const pop = () => {
      const queue = singles[table] ?? [];
      return Promise.resolve(queue.length > 0 ? queue.shift() : { data: null, error: null });
    };
    c.single = vi.fn(pop);
    c.maybeSingle = vi.fn(pop);
    c.then = (resolve: (v: any) => any) => {
      const queue = thens[table] ?? [];
      return resolve(queue.length > 0 ? queue.shift() : { data: null, error: null, count: 0 });
    };
    return c;
  }

  return { admin: { from: vi.fn((t: string) => chainFor(t)) }, auditRows };
}

function makeRequest(method: string, opts: { query?: Record<string, string>; body?: unknown } = {}) {
  const url = new URL('http://localhost/api/giveaways');
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  return new NextRequest(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthSuccess(requireGuildOwner as ReturnType<typeof vi.fn>);
});

describe('POST /api/giveaways — audit', () => {
  it('writes giveaway.created with the new row as after-state', async () => {
    const { admin, auditRows } = makeAdmin({
      singles: { giveaways: [{ data: ROW, error: null }] },
      thens: { giveaways: [{ count: 0, data: null, error: null }] },
    });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(admin);

    const res = await POST(makeRequest('POST', {
      body: { channel_id: '123456789012345678', prize: 'Nitro', ends_at: '2026-08-01T00:00:00.000Z' },
    }));

    expect(res.status).toBe(200);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      guild_id: 'guild-123',
      actor_type: 'dashboard',
      actor_id: DEFAULT_OWNER_CTX.discordId,
      action: 'giveaway.created',
      category: 'giveaways',
      target_type: 'giveaway',
      target_id: GW_ID,
      success: true,
    });
    expect(auditRows[0].after_state).toMatchObject({ prize: 'Nitro', status: 'active' });
  });
});

describe('PUT /api/giveaways — audit', () => {
  it('captures a dashboard cancel as a status before/after diff', async () => {
    const { admin, auditRows } = makeAdmin({
      singles: {
        giveaways: [
          { data: ROW, error: null },                                  // before-row read
          { data: { ...ROW, status: 'cancelled' }, error: null },      // updated row
        ],
      },
    });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(admin);

    const res = await PUT(makeRequest('PUT', { body: { id: GW_ID, status: 'cancelled' } }));

    expect(res.status).toBe(200);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: 'giveaway.updated',
      category: 'giveaways',
      actor_type: 'dashboard',
      target_id: GW_ID,
      before_state: { status: 'active' },
      after_state: { status: 'cancelled' },
    });
    expect(auditRows[0].details.fields).toContain('status');
  });
});

describe('DELETE /api/giveaways — audit', () => {
  it('writes giveaway.deleted with the deleted row as before-state', async () => {
    const { admin, auditRows } = makeAdmin({
      thens: { giveaways: [{ data: [ROW], error: null }] },
    });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(admin);

    const res = await DELETE(makeRequest('DELETE', { query: { id: GW_ID } }));

    expect(res.status).toBe(200);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: 'giveaway.deleted',
      category: 'giveaways',
      target_id: GW_ID,
    });
    expect(auditRows[0].before_state).toMatchObject({ prize: 'Nitro', status: 'active' });
    expect(auditRows[0].details).toMatchObject({ entryCount: 2 });
  });

  it('writes NO audit row when nothing was deleted', async () => {
    const { admin, auditRows } = makeAdmin({
      thens: { giveaways: [{ data: [], error: null }] },
    });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(admin);

    const res = await DELETE(makeRequest('DELETE', { query: { id: GW_ID } }));

    expect(res.status).toBe(200);
    expect(auditRows).toHaveLength(0);
  });
});
