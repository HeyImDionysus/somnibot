/**
 * POST/PATCH /api/incidents — owner-mirror observability.
 *
 * A manual incident create/update/resolve must now leave an append-only
 * audit_logs row AND mirror to the owner via the alerts table (open on create,
 * resolve on resolution). Previously these transitions were invisible to the
 * owner surfaces.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/rbac', () => ({ requirePermission: vi.fn(), authErrorResponse: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn().mockResolvedValue(null) }));

import { POST, PATCH } from '@/app/api/incidents/route';
import { requirePermission } from '@/lib/rbac';
import { createAdminSupabase } from '@/lib/supabase/admin';

function makeRequest(method: string, body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/incidents', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeAdmin() {
  const inserts: Array<{ table: string; payload: any }> = [];
  const updates: Array<{ table: string; payload: any }> = [];
  const from = vi.fn((table: string) => {
    const chain: any = {};
    for (const m of ['select', 'eq', 'order', 'range', 'limit']) chain[m] = vi.fn(() => chain);
    chain.insert = vi.fn((p: any) => { inserts.push({ table, payload: p }); return chain; });
    chain.update = vi.fn((p: any) => { updates.push({ table, payload: p }); return chain; });
    chain.single = vi.fn(() => Promise.resolve({ data: { id: 'inc-1', started_at: new Date().toISOString() }, error: null }));
    chain.maybeSingle = vi.fn(() => Promise.resolve({ data: { started_at: new Date().toISOString() }, error: null }));
    chain.then = (r: (v: any) => unknown) => r({ data: null, error: null });
    return chain;
  });
  const rpc = vi.fn().mockResolvedValue({ data: 7, error: null });
  return { admin: { from, rpc }, inserts, updates };
}

beforeEach(() => {
  vi.resetAllMocks();
  (requirePermission as ReturnType<typeof vi.fn>).mockResolvedValue({
    guildId: 'guild-1',
    discordId: 'discord-1',
    permissions: ['dashboard.full_access'],
  });
});

describe('POST /api/incidents owner mirror', () => {
  it('writes an incident.created audit row and opens an owner alert', async () => {
    const { admin, inserts } = makeAdmin();
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(admin);

    const res = await POST(makeRequest('POST', { title: 'DB latency spike', severity: 'critical' }));
    expect(res.status).toBe(200);

    expect(inserts.some((i) => i.table === 'audit_logs' && i.payload.action === 'incident.created')).toBe(true);
    const alert = inserts.find((i) => i.table === 'alerts');
    expect(alert).toBeTruthy();
    expect(alert!.payload.alert_type).toBe('incident_reported');
    expect(alert!.payload.severity).toBe('critical');
  });

  it('maps the outage severity onto the critical alert vocabulary', async () => {
    const { admin, inserts } = makeAdmin();
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(admin);

    await POST(makeRequest('POST', { title: 'Total outage', severity: 'outage' }));

    const alert = inserts.find((i) => i.table === 'alerts');
    expect(alert!.payload.severity).toBe('critical');
  });
});

describe('PATCH /api/incidents owner mirror', () => {
  it('writes an incident.resolved audit row and resolves the owner alert', async () => {
    const { admin, inserts, updates } = makeAdmin();
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(admin);

    const res = await PATCH(makeRequest('PATCH', {
      id: '00000000-0000-0000-0000-000000000001',
      status: 'resolved',
    }));
    expect(res.status).toBe(200);

    expect(inserts.some((i) => i.table === 'audit_logs' && i.payload.action === 'incident.resolved')).toBe(true);
    expect(updates.some((u) => u.table === 'alerts' && u.payload.resolved === true)).toBe(true);
  });
});
