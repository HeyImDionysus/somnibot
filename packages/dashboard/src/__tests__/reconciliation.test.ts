/**
 * Tests for /api/reconciliation route.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/api/admin-rate-limit', () => ({
  checkAdminRateLimit: vi.fn().mockResolvedValue(null),
}));

import { GET, POST } from '@/app/api/reconciliation/route';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { NextRequest } from 'next/server';

const mockQuery = {
  select: vi.fn().mockReturnThis(),
  insert: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(),
  order: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(),
  maybeSingle: vi.fn().mockResolvedValue({ data: null }),
};
const mockSupabase = { from: vi.fn(() => mockQuery) };

beforeEach(() => {
  vi.resetAllMocks();
  mockQuery.select.mockReturnThis();
  mockQuery.insert.mockReturnThis();
  mockQuery.eq.mockReturnThis();
  mockQuery.order.mockReturnThis();
  mockQuery.limit.mockReturnThis();
  mockQuery.maybeSingle.mockResolvedValue({ data: null });
  mockSupabase.from.mockReturnValue(mockQuery);
  (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mockSupabase);
  vi.mocked(checkAdminRateLimit).mockResolvedValue(null);
});

describe('GET /api/reconciliation', () => {
  it('returns 401 when not authenticated', async () => {
    (requireGuildOwner as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    });
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('returns runs and summary when authenticated', async () => {
    (requireGuildOwner as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, ctx: { guildId: 'guild-123' },
    });
    mockQuery.limit.mockResolvedValue({
      data: [
        { id: '1', status: 'completed', completed_at: '2026-01-01', findings: 0 },
        { id: '2', status: 'running', completed_at: null, findings: null },
      ],
    });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runs).toHaveLength(2);
    expect(body.summary.is_running).toBe(true);
  });
});

describe('POST /api/reconciliation', () => {
  it('returns 401 when not authenticated', async () => {
    (requireGuildOwner as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    });
    const req = new NextRequest('http://localhost:3000/api/reconciliation', { method: 'POST' });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('returns 409 when already running', async () => {
    (requireGuildOwner as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, ctx: { guildId: 'guild-123' },
    });
    mockQuery.maybeSingle.mockResolvedValue({ data: { id: 'running-1' } });
    const req = new NextRequest('http://localhost:3000/api/reconciliation', { method: 'POST' });
    const res = await POST(req);
    expect(res.status).toBe(409);
  });

  it('queues reconciliation when valid', async () => {
    (requireGuildOwner as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, ctx: { guildId: 'guild-123' },
    });
    mockQuery.maybeSingle.mockResolvedValue({ data: null });
    mockQuery.insert.mockResolvedValue({ error: null });
    const req = new NextRequest('http://localhost:3000/api/reconciliation', { method: 'POST' });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('rejects invalid body', async () => {
    (requireGuildOwner as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, ctx: { guildId: 'guild-123' },
    });
    const req = new NextRequest('http://localhost:3000/api/reconciliation', {
      method: 'POST',
      body: JSON.stringify({ trigger: 'invalid_value' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});
