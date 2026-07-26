/**
 * /api/scheduled-messages — dashboard CRUD audit rows (#63).
 *
 * The bot rail audits deliveries (scheduled_message.sent / delivery_failed)
 * but the dashboard CRUD surface wrote nothing — create/update/delete were
 * invisible in the audit trail. Every successful mutation now writes one
 * append-only audit_logs row (category scheduled_messages, actor_type
 * dashboard) with an honest before/after diff on update/delete.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/notify-bot', () => ({ notifyBot: vi.fn().mockResolvedValue(undefined) }));

import { POST, PUT, DELETE } from '@/app/api/scheduled-messages/route';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { mockAuthSuccess, DEFAULT_OWNER_CTX } from './helpers/mock-auth';

const MSG_ID = '123e4567-e89b-12d3-a456-426614174000';

const ROW = {
  id: MSG_ID,
  guild_id: 'guild-123',
  name: 'Daily Digest',
  channel_id: '123456789012345678',
  message: 'hello',
  embed_config_id: null,
  cron_expression: '0 9 * * *',
  timezone: 'UTC',
  start_date: null,
  end_date: null,
  max_sends: null,
  missed_run_policy: 'skip-missed',
  active: true,
};

/**
 * Table-aware admin double — single()/maybeSingle() pop per-table queues,
 * awaiting a bare chain pops the table's then-queue, audit_logs inserts are
 * captured for assertion.
 */
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
  const url = new URL('http://localhost/api/scheduled-messages');
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

describe('POST /api/scheduled-messages — audit', () => {
  it('writes scheduled_message.created with the new row as after-state', async () => {
    const { admin, auditRows } = makeAdmin({
      singles: { scheduled_messages: [{ data: ROW, error: null }] },
      thens: { scheduled_messages: [{ count: 0, data: null, error: null }] },
    });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(admin);

    const res = await POST(makeRequest('POST', {
      body: { name: 'Daily Digest', channel_id: '123456789012345678', message: 'hello', cron_expression: '0 9 * * *' },
    }));

    expect(res.status).toBe(200);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      guild_id: 'guild-123',
      actor_type: 'dashboard',
      actor_id: DEFAULT_OWNER_CTX.discordId,
      action: 'scheduled_message.created',
      category: 'scheduled_messages',
      target_type: 'scheduled_message',
      target_id: MSG_ID,
      success: true,
    });
    expect(auditRows[0].after_state).toMatchObject({ name: 'Daily Digest', cron_expression: '0 9 * * *' });
  });
});

describe('PUT /api/scheduled-messages — audit', () => {
  it('writes scheduled_message.updated with a before/after diff of the touched keys', async () => {
    const { admin, auditRows } = makeAdmin({
      singles: {
        scheduled_messages: [
          { data: ROW, error: null },                                     // before-row read
          { data: { ...ROW, name: 'Weekly Digest', active: false }, error: null }, // updated row
        ],
      },
    });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(admin);

    const res = await PUT(makeRequest('PUT', {
      body: { id: MSG_ID, name: 'Weekly Digest', active: false },
    }));

    expect(res.status).toBe(200);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: 'scheduled_message.updated',
      category: 'scheduled_messages',
      actor_type: 'dashboard',
      target_id: MSG_ID,
      before_state: { name: 'Daily Digest', active: true },
      after_state: { name: 'Weekly Digest', active: false },
    });
    expect(auditRows[0].details.fields).toEqual(expect.arrayContaining(['name', 'active']));
  });

  it('writes NO scheduled_message.updated row when the PUT changed zero fields', async () => {
    const { admin, auditRows } = makeAdmin({
      singles: {
        scheduled_messages: [
          { data: ROW, error: null }, // before-row read
          { data: ROW, error: null }, // "updated" row — only updated_at bumped
        ],
      },
    });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(admin);

    const res = await PUT(makeRequest('PUT', { body: { id: MSG_ID } }));

    expect(res.status).toBe(200);
    // An empty diff is not a mutation — no fabricated audit row.
    expect(auditRows).toHaveLength(0);
  });

  it('logs a failed before-read and keeps the diff honestly one-sided', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { admin, auditRows } = makeAdmin({
      singles: {
        scheduled_messages: [
          { data: null, error: { message: 'read blew up' } },                    // before-row read FAILS
          { data: { ...ROW, name: 'Weekly Digest' }, error: null },              // updated row
        ],
      },
    });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(admin);

    const res = await PUT(makeRequest('PUT', { body: { id: MSG_ID, name: 'Weekly Digest' } }));

    expect(res.status).toBe(200);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].before_state).toBeNull();
    expect(auditRows[0].after_state).toMatchObject({ name: 'Weekly Digest' });
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('before-state read failed'),
      'read blew up',
    );
    errSpy.mockRestore();
  });

  it('logs a discarded audit insert error instead of swallowing it', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { admin } = makeAdmin({
      singles: {
        scheduled_messages: [
          { data: ROW, error: null },
          { data: { ...ROW, name: 'Weekly Digest' }, error: null },
        ],
      },
    });
    const baseFrom = admin.from;
    admin.from = vi.fn((t: string) => t === 'audit_logs'
      ? { insert: vi.fn(async () => ({ error: { message: 'insert denied' } })) }
      : baseFrom(t)) as any;
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(admin);

    const res = await PUT(makeRequest('PUT', { body: { id: MSG_ID, name: 'Weekly Digest' } }));

    expect(res.status).toBe(200); // audit failure never fails the request…
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to write scheduled_message.updated audit row'),
      'insert denied',
    ); // …but it is never silent either.
    errSpy.mockRestore();
  });
});

describe('DELETE /api/scheduled-messages — audit', () => {
  it('writes scheduled_message.deleted with the deleted row as before-state', async () => {
    const { admin, auditRows } = makeAdmin({
      thens: { scheduled_messages: [{ data: [ROW], error: null }] },
    });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(admin);

    const res = await DELETE(makeRequest('DELETE', { query: { id: MSG_ID } }));

    expect(res.status).toBe(200);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: 'scheduled_message.deleted',
      category: 'scheduled_messages',
      target_id: MSG_ID,
    });
    expect(auditRows[0].before_state).toMatchObject({ name: 'Daily Digest', channel_id: '123456789012345678' });
  });

  it('writes NO audit row when nothing was deleted', async () => {
    const { admin, auditRows } = makeAdmin({
      thens: { scheduled_messages: [{ data: [], error: null }] },
    });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(admin);

    const res = await DELETE(makeRequest('DELETE', { query: { id: MSG_ID } }));

    expect(res.status).toBe(200);
    expect(auditRows).toHaveLength(0);
  });
});
