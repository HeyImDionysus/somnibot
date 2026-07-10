/**
 * Tests for /api/counts — sidebar badge count route.
 *
 * Covers:
 *  - The DLQ badge: 'action_queue_dlq' is an allowed table and gets the
 *    pending filter (acknowledged=false, retried=false) applied server-side,
 *    since the table is service_role-only.
 *  - DLQ owner-gating: the DLQ count is only returned to the guild owner;
 *    non-owners get 0 (its volume can reveal sensitive failed actions and
 *    the table may hold plaintext license keys).
 *  - Tickets badge counts active tickets = open OR claimed (matches the
 *    dashboard stats query), so a fully-claimed backlog still surfaces.
 *  - Batch form (?tables=a,b,c) returns a { counts } map in one request so
 *    the sidebar can avoid fanning out one request per badge.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac', () => ({
  requirePermission: vi.fn(),
  authErrorResponse: vi.fn(),
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminSupabase: vi.fn(),
}));
vi.mock('@/lib/api/admin-rate-limit', () => ({
  checkAdminRateLimit: vi.fn().mockResolvedValue(null),
}));

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/counts/route';
import { requirePermission } from '@/lib/rbac';
import { createAdminSupabase } from '@/lib/supabase/admin';

const mockFrom = vi.fn();
const mockSupabase = { from: mockFrom };

/**
 * Build a thenable Supabase query chain that records .eq()/.in() filter
 * calls and resolves to the given result when awaited.
 */
function makeChain(result: { count: number | null; error: unknown }) {
  const chain = {
    select: vi.fn(),
    eq: vi.fn(),
    in: vi.fn(),
    then: (resolve: (value: typeof result) => unknown) =>
      Promise.resolve(result).then(resolve),
  };
  chain.select.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  chain.in.mockReturnValue(chain);
  return chain;
}

function makeRequest(params: Record<string, string>) {
  const url = new URL('http://localhost/api/counts');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new NextRequest(url);
}

/**
 * Set the auth context returned by requirePermission for a test.
 *
 * Owners get ['dashboard.full_access'] by default (matching getAuthContext,
 * which always grants owners full access), so per-table permission gates are
 * satisfied. Pass `permissions` to model a delegated non-owner with a narrow
 * set of grants.
 */
function setAuth(
  overrides: Partial<{
    isOwner: boolean;
    guildId: string;
    permissions: string[];
  }> = {},
) {
  const isOwner = overrides.isOwner ?? true;
  (requirePermission as ReturnType<typeof vi.fn>).mockResolvedValue({
    guildId: overrides.guildId ?? 'guild-123',
    userId: 'user-789',
    discordId: 'discord-1',
    isOwner,
    permissions:
      overrides.permissions ?? (isOwner ? ['dashboard.full_access'] : []),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mockSupabase);
  setAuth({ isOwner: true });
});

describe('GET /api/counts (single table)', () => {
  it('returns count 0 for a table not in the allowlist', async () => {
    const res = await GET(makeRequest({ table: 'users' }));
    const body = await res.json();
    expect(body.count).toBe(0);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('returns count 0 when table param is missing', async () => {
    const res = await GET(makeRequest({}));
    const body = await res.json();
    expect(body.count).toBe(0);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('counts action_queue_dlq with the pending filter applied server-side (owner)', async () => {
    const chain = makeChain({ count: 7, error: null });
    mockFrom.mockReturnValue(chain);

    const res = await GET(makeRequest({ table: 'action_queue_dlq' }));
    const body = await res.json();

    expect(body.count).toBe(7);
    expect(mockFrom).toHaveBeenCalledWith('action_queue_dlq');
    expect(chain.select).toHaveBeenCalledWith('id', { count: 'exact', head: true });
    // Guild scoping + pending state (not acknowledged, not retried)
    expect(chain.eq).toHaveBeenCalledWith('guild_id', 'guild-123');
    expect(chain.eq).toHaveBeenCalledWith('acknowledged', false);
    expect(chain.eq).toHaveBeenCalledWith('retried', false);
  });

  it('does NOT expose action_queue_dlq to non-owners — returns 0 without querying', async () => {
    setAuth({ isOwner: false });
    const chain = makeChain({ count: 7, error: null });
    mockFrom.mockReturnValue(chain);

    const res = await GET(makeRequest({ table: 'action_queue_dlq' }));
    const body = await res.json();

    expect(body.count).toBe(0);
    // The sensitive table must not be queried at all for a non-owner.
    expect(mockFrom).not.toHaveBeenCalledWith('action_queue_dlq');
  });

  it('counts tickets as open OR claimed (matches dashboard stats)', async () => {
    const chain = makeChain({ count: 3, error: null });
    mockFrom.mockReturnValue(chain);

    const res = await GET(makeRequest({ table: 'tickets' }));
    const body = await res.json();

    expect(body.count).toBe(3);
    expect(chain.eq).toHaveBeenCalledWith('guild_id', 'guild-123');
    expect(chain.in).toHaveBeenCalledWith('status', ['open', 'claimed']);
    // Must not narrow to only 'open' — claimed tickets still need attention.
    expect(chain.eq).not.toHaveBeenCalledWith('status', 'open');
  });

  it('counts orders with the pending-status filter', async () => {
    const chain = makeChain({ count: 2, error: null });
    mockFrom.mockReturnValue(chain);

    await GET(makeRequest({ table: 'orders' }));
    expect(chain.eq).toHaveBeenCalledWith('status', 'pending');
  });

  it('counts giveaways with the active-status filter', async () => {
    const chain = makeChain({ count: 1, error: null });
    mockFrom.mockReturnValue(chain);

    await GET(makeRequest({ table: 'giveaways' }));
    expect(chain.eq).toHaveBeenCalledWith('status', 'active');
  });

  it('counts incidents with the open-lifecycle filter', async () => {
    const chain = makeChain({ count: 4, error: null });
    mockFrom.mockReturnValue(chain);

    await GET(makeRequest({ table: 'incidents' }));
    expect(chain.in).toHaveBeenCalledWith('status', [
      'open',
      'investigating',
      'identified',
      'monitoring',
    ]);
  });

  it('applies no status filter for infractions', async () => {
    const chain = makeChain({ count: 9, error: null });
    mockFrom.mockReturnValue(chain);

    const res = await GET(makeRequest({ table: 'infractions' }));
    const body = await res.json();

    expect(body.count).toBe(9);
    // Only the guild_id filter — no status column on infractions
    expect(chain.eq).toHaveBeenCalledTimes(1);
    expect(chain.eq).toHaveBeenCalledWith('guild_id', 'guild-123');
    expect(chain.in).not.toHaveBeenCalled();
  });

  it('returns count 0 on database error', async () => {
    const chain = makeChain({ count: null, error: { message: 'boom' } });
    mockFrom.mockReturnValue(chain);

    const res = await GET(makeRequest({ table: 'action_queue_dlq' }));
    const body = await res.json();
    expect(body.count).toBe(0);
  });

  it('returns count 0 when unauthenticated', async () => {
    (requirePermission as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Unauthorized'),
    );

    const res = await GET(makeRequest({ table: 'action_queue_dlq' }));
    const body = await res.json();
    expect(body.count).toBe(0);
  });

  it('returns null count as 0', async () => {
    const chain = makeChain({ count: null, error: null });
    mockFrom.mockReturnValue(chain);

    const res = await GET(makeRequest({ table: 'tickets' }));
    const body = await res.json();
    expect(body.count).toBe(0);
  });
});

describe('GET /api/counts (batch: ?tables=a,b,c)', () => {
  it('returns a counts map for multiple tables in one request', async () => {
    // Distinct count per table so we can assert the map is keyed correctly.
    const byTable: Record<string, number> = {
      tickets: 5,
      orders: 2,
      giveaways: 1,
      action_queue_dlq: 3,
    };
    mockFrom.mockImplementation((table: string) =>
      makeChain({ count: byTable[table] ?? 0, error: null }),
    );

    const res = await GET(
      makeRequest({ tables: 'tickets,orders,giveaways,action_queue_dlq' }),
    );
    const body = await res.json();

    expect(body.counts).toEqual({
      tickets: 5,
      orders: 2,
      giveaways: 1,
      action_queue_dlq: 3,
    });
  });

  it('owner-gates the DLQ within the batch: non-owner gets 0 and no DLQ query', async () => {
    // Non-owner who CAN see tickets (delegated manage_tickets) but is still
    // blocked from the owner-only DLQ.
    setAuth({ isOwner: false, permissions: ['dashboard.manage_tickets'] });
    mockFrom.mockImplementation((table: string) =>
      makeChain({ count: table === 'tickets' ? 4 : 9, error: null }),
    );

    const res = await GET(makeRequest({ tables: 'tickets,action_queue_dlq' }));
    const body = await res.json();

    expect(body.counts.tickets).toBe(4);
    expect(body.counts.action_queue_dlq).toBe(0);
    expect(mockFrom).not.toHaveBeenCalledWith('action_queue_dlq');
    expect(mockFrom).toHaveBeenCalledWith('tickets');
  });

  it('ignores unknown tables in the batch and dedupes repeats', async () => {
    mockFrom.mockImplementation(() => makeChain({ count: 1, error: null }));

    const res = await GET(makeRequest({ tables: 'tickets,users,tickets, orders ' }));
    const body = await res.json();

    // 'users' dropped, duplicate 'tickets' collapsed.
    expect(Object.keys(body.counts).sort()).toEqual(['orders', 'tickets']);
    expect(mockFrom).toHaveBeenCalledWith('tickets');
    expect(mockFrom).toHaveBeenCalledWith('orders');
    expect(mockFrom).not.toHaveBeenCalledWith('users');
  });

  it('returns an empty counts map when no valid tables are requested', async () => {
    const res = await GET(makeRequest({ tables: 'users,nonsense' }));
    const body = await res.json();
    expect(body.counts).toEqual({});
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('returns an empty counts map (not a single count) when unauthenticated', async () => {
    (requirePermission as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Unauthorized'),
    );

    const res = await GET(makeRequest({ tables: 'tickets,orders' }));
    const body = await res.json();
    expect(body.counts).toEqual({});
    expect(body.count).toBeUndefined();
  });
});

describe('GET /api/counts — per-table permission gating', () => {
  it('returns 0 (no query) for a table whose page permission the delegated user lacks', async () => {
    // Delegated non-owner with ONLY analytics — no ticket permission.
    setAuth({ isOwner: false, permissions: ['dashboard.view_analytics'] });
    const chain = makeChain({ count: 12, error: null });
    mockFrom.mockReturnValue(chain);

    const res = await GET(makeRequest({ table: 'tickets' }));
    const body = await res.json();

    expect(body.count).toBe(0);
    // Must not even query a table the user cannot access.
    expect(mockFrom).not.toHaveBeenCalledWith('tickets');
  });

  it('counts a table the delegated user IS permitted to see', async () => {
    setAuth({ isOwner: false, permissions: ['dashboard.manage_tickets'] });
    const chain = makeChain({ count: 6, error: null });
    mockFrom.mockReturnValue(chain);

    const res = await GET(makeRequest({ table: 'tickets' }));
    const body = await res.json();

    expect(body.count).toBe(6);
    expect(mockFrom).toHaveBeenCalledWith('tickets');
  });

  it('gates each requested table independently in the batch form', async () => {
    // finance-style role: orders yes, tickets no.
    setAuth({
      isOwner: false,
      permissions: ['dashboard.manage_orders', 'dashboard.view_analytics'],
    });
    mockFrom.mockImplementation((table: string) =>
      makeChain({ count: table === 'orders' ? 8 : 99, error: null }),
    );

    const res = await GET(
      makeRequest({ tables: 'tickets,orders,giveaways' }),
    );
    const body = await res.json();

    // Permitted → real count; unpermitted → 0 and never queried.
    expect(body.counts.orders).toBe(8);
    expect(body.counts.tickets).toBe(0);
    expect(body.counts.giveaways).toBe(0);
    expect(mockFrom).toHaveBeenCalledWith('orders');
    expect(mockFrom).not.toHaveBeenCalledWith('tickets');
    expect(mockFrom).not.toHaveBeenCalledWith('giveaways');
  });

  it('full_access (owner) satisfies every per-table gate', async () => {
    setAuth({ isOwner: true, permissions: ['dashboard.full_access'] });
    mockFrom.mockImplementation((table: string) =>
      makeChain({ count: table === 'orders' ? 2 : table === 'infractions' ? 5 : 1, error: null }),
    );

    const res = await GET(
      makeRequest({ tables: 'tickets,orders,giveaways,infractions,incidents' }),
    );
    const body = await res.json();

    expect(body.counts).toEqual({
      tickets: 1,
      orders: 2,
      giveaways: 1,
      infractions: 5,
      incidents: 1,
    });
  });

  it('maps giveaways to manage_server and infractions to manage_moderation', async () => {
    // manage_server grants giveaways; NOT moderation → infractions blocked.
    setAuth({ isOwner: false, permissions: ['dashboard.manage_server'] });
    mockFrom.mockImplementation((table: string) =>
      makeChain({ count: 3, error: null }),
    );

    const res = await GET(makeRequest({ tables: 'giveaways,infractions' }));
    const body = await res.json();

    expect(body.counts.giveaways).toBe(3);
    expect(body.counts.infractions).toBe(0);
    expect(mockFrom).toHaveBeenCalledWith('giveaways');
    expect(mockFrom).not.toHaveBeenCalledWith('infractions');
  });
});
