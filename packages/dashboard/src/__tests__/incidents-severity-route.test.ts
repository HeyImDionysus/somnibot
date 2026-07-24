/**
 * Tests for POST /api/incidents severity vocabulary.
 *
 * Regression: the GET summary counted an `outage` tile, but the create/update
 * severity enum was {info, warning, critical}, so 'outage' was never producible
 * and the tile was always 0. The enum now includes 'outage' (matching the
 * intended DB CHECK), so the tile reflects a real, producible severity.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/rbac', () => ({
  requirePermission: vi.fn(),
  authErrorResponse: vi.fn(),
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/admin-rate-limit', () => ({
  checkAdminRateLimit: vi.fn().mockResolvedValue(null),
}));

import { POST } from '@/app/api/incidents/route';
import { requirePermission } from '@/lib/rbac';
import { createAdminSupabase } from '@/lib/supabase/admin';

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/incidents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeAdmin() {
  const singleChain = { single: vi.fn().mockResolvedValue({ data: { id: 'inc-1', title: 'x' }, error: null }) };
  const selectChain = { select: vi.fn().mockReturnValue(singleChain) };
  const incidentsChain = { insert: vi.fn().mockReturnValue(selectChain) };
  const eventsChain = { insert: vi.fn().mockResolvedValue({ data: null, error: null }) };
  const from = vi.fn((table: string) => (table === 'incidents' ? incidentsChain : eventsChain));
  const rpc = vi.fn().mockResolvedValue({ data: 7, error: null });
  return { admin: { from, rpc }, incidentsChain };
}

beforeEach(() => {
  vi.clearAllMocks();
  (requirePermission as ReturnType<typeof vi.fn>).mockResolvedValue({
    guildId: 'guild-1',
    discordId: 'discord-1',
    permissions: ['dashboard.full_access'],
  });
});

describe('POST /api/incidents severity enum', () => {
  it('accepts severity "outage" and persists it (producible → tile is meaningful)', async () => {
    const { admin, incidentsChain } = makeAdmin();
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(admin);

    const res = await POST(makeRequest({ title: 'Total outage', severity: 'outage' }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(incidentsChain.insert).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'outage' }),
    );
  });

  it('rejects an unknown severity with 400 and no write', async () => {
    const { admin, incidentsChain } = makeAdmin();
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(admin);

    const res = await POST(makeRequest({ title: 'Bad', severity: 'bogus' }));

    expect(res.status).toBe(400);
    expect(incidentsChain.insert).not.toHaveBeenCalled();
  });
});
