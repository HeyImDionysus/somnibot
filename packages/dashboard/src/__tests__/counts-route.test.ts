/**
 * Tests for /api/counts — sidebar badge count route.
 *
 * Covers the DLQ badge fix: 'action_queue_dlq' must be an allowed table
 * and must get the pending filter (acknowledged=false, retried=false)
 * applied server-side, since the table is service_role-only and its
 * count can never be derived client-side.
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

function makeRequest(table: string | null) {
  const url = new URL('http://localhost/api/counts');
  if (table !== null) url.searchParams.set('table', table);
  return new NextRequest(url);
}

beforeEach(() => {
  vi.clearAllMocks();
  (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mockSupabase);
  (requirePermission as ReturnType<typeof vi.fn>).mockResolvedValue({
    guildId: 'guild-123',
    userId: 'user-789',
    permissions: [],
  });
});

describe('GET /api/counts', () => {
  it('returns count 0 for a table not in the allowlist', async () => {
    const res = await GET(makeRequest('users'));
    const body = await res.json();
    expect(body.count).toBe(0);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('returns count 0 when table param is missing', async () => {
    const res = await GET(makeRequest(null));
    const body = await res.json();
    expect(body.count).toBe(0);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('counts action_queue_dlq with the pending filter applied server-side', async () => {
    const chain = makeChain({ count: 7, error: null });
    mockFrom.mockReturnValue(chain);

    const res = await GET(makeRequest('action_queue_dlq'));
    const body = await res.json();

    expect(body.count).toBe(7);
    expect(mockFrom).toHaveBeenCalledWith('action_queue_dlq');
    expect(chain.select).toHaveBeenCalledWith('id', { count: 'exact', head: true });
    // Guild scoping + pending state (not acknowledged, not retried)
    expect(chain.eq).toHaveBeenCalledWith('guild_id', 'guild-123');
    expect(chain.eq).toHaveBeenCalledWith('acknowledged', false);
    expect(chain.eq).toHaveBeenCalledWith('retried', false);
  });

  it('counts tickets with the open-status filter', async () => {
    const chain = makeChain({ count: 3, error: null });
    mockFrom.mockReturnValue(chain);

    const res = await GET(makeRequest('tickets'));
    const body = await res.json();

    expect(body.count).toBe(3);
    expect(chain.eq).toHaveBeenCalledWith('guild_id', 'guild-123');
    expect(chain.eq).toHaveBeenCalledWith('status', 'open');
  });

  it('counts orders with the pending-status filter', async () => {
    const chain = makeChain({ count: 2, error: null });
    mockFrom.mockReturnValue(chain);

    await GET(makeRequest('orders'));
    expect(chain.eq).toHaveBeenCalledWith('status', 'pending');
  });

  it('counts giveaways with the active-status filter', async () => {
    const chain = makeChain({ count: 1, error: null });
    mockFrom.mockReturnValue(chain);

    await GET(makeRequest('giveaways'));
    expect(chain.eq).toHaveBeenCalledWith('status', 'active');
  });

  it('counts incidents with the open-lifecycle filter', async () => {
    const chain = makeChain({ count: 4, error: null });
    mockFrom.mockReturnValue(chain);

    await GET(makeRequest('incidents'));
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

    const res = await GET(makeRequest('infractions'));
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

    const res = await GET(makeRequest('action_queue_dlq'));
    const body = await res.json();
    expect(body.count).toBe(0);
  });

  it('returns count 0 when unauthenticated', async () => {
    (requirePermission as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Unauthorized'),
    );

    const res = await GET(makeRequest('action_queue_dlq'));
    const body = await res.json();
    expect(body.count).toBe(0);
  });

  it('returns null count as 0', async () => {
    const chain = makeChain({ count: null, error: null });
    mockFrom.mockReturnValue(chain);

    const res = await GET(makeRequest('tickets'));
    const body = await res.json();
    expect(body.count).toBe(0);
  });
});
