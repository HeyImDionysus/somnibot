/**
 * /api/commerce/requests — the owner's queue of customer refund/support requests.
 *
 * THE GAP THIS CLOSES: `commerce_portal_requests` shipped so buyers could ask
 * for a refund or support. Customers could file. **Nothing ever read the
 * queue** — every request sat at 'pending' with no owner surface and no way to
 * answer. A request queue nobody reads is worse than no queue, because it looks
 * like asking works.
 *
 * The properties that matter here are not the happy path:
 *   - deciding a refund request must NOT move money;
 *   - an already-decided request cannot be silently re-decided, because the
 *     customer has been told;
 *   - two owners deciding at once must not both win;
 *   - a final decision must carry an explanation the customer will see.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/admin-rate-limit', () => ({
  checkAdminRateLimit: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/admin-changes', () => ({
  recordAdminChange: vi.fn().mockResolvedValue(undefined),
}));

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/commerce/requests/route';
import { PATCH } from '@/app/api/commerce/requests/[id]/route';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { recordAdminChange } from '@/lib/admin-changes';

const GUILD = '111111111111111111';
const OWNER = '222222222222222222';
const REQ_ID = '33333333-3333-4333-8333-333333333333';

/**
 * Records every table touched, so a test can assert that deciding a request
 * wrote to the queue and NOTHING else — no orders, no payments, no entitlements.
 */
function mockDb(opts: {
  existing?: Record<string, unknown> | null;
  updated?: Record<string, unknown> | null;
  rows?: Array<Record<string, unknown>>;
  count?: number;
} = {}) {
  const touched: string[] = [];
  const updates: Array<Record<string, unknown>> = [];
  const eqs: Array<[string, unknown]> = [];

  const from = vi.fn((table: string) => {
    touched.push(table);
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'order', 'range']) chain[m] = vi.fn(() => chain);
    chain.eq = vi.fn((col: string, val: unknown) => { eqs.push([col, val]); return chain; });
    chain.update = vi.fn((row: Record<string, unknown>) => { updates.push(row); return chain; });
    chain.maybeSingle = vi.fn(async () => ({
      data: updates.length > 0
        ? (opts.updated === undefined ? { id: REQ_ID, status: 'resolved' } : opts.updated)
        : (opts.existing === undefined ? null : opts.existing),
      error: null,
    }));
    chain.then = (resolve: (v: unknown) => unknown) =>
      resolve({ data: opts.rows ?? [], error: null, count: opts.count ?? 0 });
    return chain;
  });

  vi.mocked(createAdminSupabase).mockReturnValue({ from } as never);
  return { touched, updates, eqs };
}

const patchReq = (body: unknown) =>
  new NextRequest(`http://x/api/commerce/requests/${REQ_ID}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });

const params = (id = REQ_ID) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
    vi.resetAllMocks();
  vi.mocked(requireGuildOwner).mockResolvedValue({
    ok: true,
    ctx: { userId: 'u', discordId: OWNER, guildId: GUILD },
  } as never);
});

describe('GET — reading the queue', () => {
  it('scopes to the caller guild and flags requests left waiting', async () => {
    const old = new Date(Date.now() - 72 * 3_600_000).toISOString();
    const fresh = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const { eqs } = mockDb({
      rows: [
        { id: 'a', status: 'pending', created_at: old, decided_at: null, customer_notified: false },
        { id: 'b', status: 'pending', created_at: fresh, decided_at: null, customer_notified: false },
      ],
      count: 2,
    });

    const res = await GET(new NextRequest('http://x/api/commerce/requests'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(eqs).toContainEqual(['guild_id', GUILD]);
    expect(body.summary.pending).toBe(2);
    // 72h old crosses the 48h threshold the pending alert uses; 2h does not.
    expect(body.summary.stale).toBe(1);
    expect(body.data[0].ageHours).toBeGreaterThanOrEqual(72);
  });

  it('counts decisions the buyer has never been told about', async () => {
    mockDb({
      rows: [
        { id: 'a', status: 'resolved', created_at: new Date().toISOString(), decided_at: new Date().toISOString(), customer_notified: false },
        { id: 'b', status: 'resolved', created_at: new Date().toISOString(), decided_at: new Date().toISOString(), customer_notified: true },
      ],
      count: 2,
    });

    const body = await (await GET(new NextRequest('http://x/api/commerce/requests'))).json();

    // Undelivered decisions are outstanding work that would otherwise be invisible.
    expect(body.summary.awaitingDelivery).toBe(1);
  });

  it('clamps pageSize so one request cannot pull the whole history', async () => {
    mockDb({ rows: [], count: 0 });
    const body = await (await GET(
      new NextRequest('http://x/api/commerce/requests?pageSize=100000&page=0'),
    )).json();

    expect(body.pagination.pageSize).toBe(100);
    expect(body.pagination.page).toBe(1);
  });
});

describe('PATCH — deciding a request', () => {
  it('resolves a pending request and records the decision', async () => {
    const { updates } = mockDb({
      existing: { id: REQ_ID, type: 'service', status: 'pending', order_id: null, customer_id: 'c1', customer_notified: false },
    });

    const res = await PATCH(patchReq({ status: 'resolved', resolution_note: 'Fixed for you.' }), params());

    expect(res.status).toBe(200);
    expect(updates[0]).toMatchObject({ status: 'resolved', reviewer_id: OWNER });
    expect(updates[0].decided_at).toBeTruthy();
    expect(recordAdminChange).toHaveBeenCalledTimes(1);
  });

  it('does NOT move money when a refund request is resolved', async () => {
    const { touched } = mockDb({
      existing: { id: REQ_ID, type: 'refund', status: 'pending', order_id: 'order-1', customer_id: 'c1', customer_notified: false },
    });

    const res = await PATCH(patchReq({ status: 'resolved', resolution_note: 'Refunding.' }), params());
    const body = await res.json();

    // Only the queue table is written. Marking a request resolved must never be
    // mistaken for issuing the refund.
    expect(new Set(touched)).toEqual(new Set(['commerce_portal_requests']));
    expect(body.notice).toContain('did not issue a refund');
    expect(body.refundOrderId).toBe('order-1');
  });

  it('refuses to re-decide a request the customer was already told about', async () => {
    const { updates } = mockDb({
      existing: { id: REQ_ID, type: 'refund', status: 'resolved', order_id: 'o1', customer_id: 'c1', customer_notified: true },
    });

    const res = await PATCH(patchReq({ status: 'rejected', resolution_note: 'Changed my mind.' }), params());

    expect(res.status).toBe(409);
    expect(updates).toHaveLength(0);
  });

  it('rejects a final decision with no explanation for the customer', async () => {
    mockDb({ existing: { id: REQ_ID, type: 'service', status: 'pending', order_id: null, customer_id: 'c1' } });

    // A bare "rejected" with nothing to tell the buyer is not a decision.
    const res = await PATCH(patchReq({ status: 'rejected' }), params());
    expect(res.status).toBe(400);
  });

  it('allows picking a request up without a note', async () => {
    const { updates } = mockDb({
      existing: { id: REQ_ID, type: 'service', status: 'pending', order_id: null, customer_id: 'c1' },
      updated: { id: REQ_ID, status: 'reviewing' },
    });

    const res = await PATCH(patchReq({ status: 'reviewing' }), params());

    expect(res.status).toBe(200);
    // Still undecided, so no decision timestamp — the DB constraint requires this.
    expect(updates[0].decided_at).toBeNull();
  });

  it('reports a lost race instead of overwriting the other decision', async () => {
    // The guarded update matched zero rows: someone decided it first.
    mockDb({
      existing: { id: REQ_ID, type: 'service', status: 'pending', order_id: null, customer_id: 'c1' },
      updated: null,
    });

    const res = await PATCH(patchReq({ status: 'resolved', resolution_note: 'Done.' }), params());

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('someone else');
  });

  it('offers no undo, because the decision has been communicated', async () => {
    mockDb({ existing: { id: REQ_ID, type: 'service', status: 'pending', order_id: null, customer_id: 'c1' } });

    await PATCH(patchReq({ status: 'resolved', resolution_note: 'Sorted.' }), params());

    const [arg] = vi.mocked(recordAdminChange).mock.calls[0];
    expect(arg.undo).toBeUndefined();
    expect(arg.undoReason).toContain('cannot be silently reversed');
  });

  it('404s another guild request without touching it', async () => {
    const { updates } = mockDb({ existing: null });
    const res = await PATCH(patchReq({ status: 'resolved', resolution_note: 'x' }), params());
    expect(res.status).toBe(404);
    expect(updates).toHaveLength(0);
  });
});
