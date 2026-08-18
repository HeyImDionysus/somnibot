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

function makeAdmin(incidentResults: Array<{
  data: Record<string, unknown> | null;
  error: { message: string } | null;
}> = [], beforeRow: Record<string, unknown> = {}) {
  const inserts: Array<{ table: string; payload: any }> = [];
  const updates: Array<{ table: string; payload: any }> = [];
  const upserts: Array<{
    table: string;
    payload: Record<string, unknown>;
    options: Record<string, unknown>;
  }> = [];
  const from = vi.fn((table: string) => {
    const chain: any = {};
    for (const m of ['select', 'eq', 'order', 'range', 'limit']) chain[m] = vi.fn(() => chain);
    chain.insert = vi.fn((p: any) => { inserts.push({ table, payload: p }); return chain; });
    chain.upsert = vi.fn((p: Record<string, unknown>, options: Record<string, unknown>) => {
      upserts.push({ table, payload: p, options });
      return chain;
    });
    chain.update = vi.fn((p: any) => { updates.push({ table, payload: p }); return chain; });
    chain.single = vi.fn(() => Promise.resolve(
      table === 'incidents' && incidentResults.length > 0
        ? incidentResults.shift()
        : { data: { id: 'inc-1', started_at: new Date().toISOString() }, error: null },
    ));
    chain.maybeSingle = vi.fn(() => Promise.resolve({
      data: {
        started_at: new Date().toISOString(),
        status: 'open',
        source: 'manual',
        source_ref_id: null,
        ...beforeRow,
      },
      error: null,
    }));
    chain.then = (r: (v: any) => unknown) => r({ data: null, error: null });
    return chain;
  });
  const rpc = vi.fn().mockResolvedValue({ data: 7, error: null });
  return { admin: { from, rpc }, inserts, updates, upserts };
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
    const { admin, inserts, upserts } = makeAdmin();
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(admin);

    const res = await POST(makeRequest('POST', { title: 'DB latency spike', severity: 'critical' }));
    expect(res.status).toBe(200);

    expect(upserts.some((i) => i.table === 'audit_logs' && i.payload.action === 'incident.created')).toBe(true);
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

  it('keys a successful create audit to the stable incident request occurrence', async () => {
    const { admin, upserts } = makeAdmin();
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(admin);

    const res = await POST(makeRequest('POST', {
      title: 'DB latency spike',
      severity: 'critical',
      request_id: '00000000-0000-4000-a000-000000000012',
    }));

    expect(res.status).toBe(200);
    expect(upserts).toContainEqual(expect.objectContaining({
      table: 'audit_logs',
      payload: expect.objectContaining({
        guild_id: 'guild-1',
        actor_type: 'dashboard',
        actor_id: 'discord-1',
        action: 'incident.created',
        target_type: 'incident',
        target_id: 'inc-1',
        occurrence_key: 'incident.created:00000000-0000-4000-a000-000000000012',
        success: true,
        error_message: null,
      }),
      options: { onConflict: 'guild_id,occurrence_key', ignoreDuplicates: true },
    }));
  });

  it('records a failed create and later success as distinct rows for one request occurrence', async () => {
    const { admin, upserts } = makeAdmin([
      { data: null, error: { message: 'temporary database fault' } },
      { data: { id: 'inc-retry' }, error: null },
    ]);
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(admin);
    const body = {
      title: 'Transient incident',
      request_id: '00000000-0000-4000-a000-000000000013',
    };

    const failed = await POST(makeRequest('POST', body));
    const succeeded = await POST(makeRequest('POST', body));

    expect(failed.status).toBeGreaterThanOrEqual(400);
    expect(succeeded.status).toBe(200);
    expect(upserts.filter((entry) => entry.table === 'audit_logs').map((entry) => entry.payload)).toEqual([
      expect.objectContaining({
        action: 'incident.create_failed',
        target_id: '00000000-0000-4000-a000-000000000013',
        occurrence_key: 'incident.create_failed:00000000-0000-4000-a000-000000000013',
        success: false,
        error_message: 'temporary database fault',
      }),
      expect.objectContaining({
        action: 'incident.created',
        target_id: 'inc-retry',
        occurrence_key: 'incident.created:00000000-0000-4000-a000-000000000013',
        success: true,
        error_message: null,
      }),
    ]);
  });

  it('reuses the failure audit key for one request and appends a later request occurrence', async () => {
    const failure = { data: null, error: { message: 'temporary database fault' } };
    const { admin, upserts } = makeAdmin([failure, failure, failure]);
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(admin);
    const repeated = {
      title: 'Transient incident',
      request_id: '00000000-0000-4000-a000-000000000014',
    };

    await POST(makeRequest('POST', repeated));
    await POST(makeRequest('POST', repeated));
    await POST(makeRequest('POST', {
      ...repeated,
      request_id: '00000000-0000-4000-a000-000000000015',
    }));

    const keys = upserts
      .filter((entry) => entry.table === 'audit_logs')
      .map((entry) => entry.payload['occurrence_key']);
    expect(keys).toEqual([
      'incident.create_failed:00000000-0000-4000-a000-000000000014',
      'incident.create_failed:00000000-0000-4000-a000-000000000014',
      'incident.create_failed:00000000-0000-4000-a000-000000000015',
    ]);
    expect(upserts.every((entry) => entry.options['ignoreDuplicates'] === true)).toBe(true);
  });
});

describe('PATCH /api/incidents owner mirror', () => {
  it('keeps linked health incident status authoritative to its diagnostics alert', async () => {
    const { admin, updates } = makeAdmin([], {
      status: 'open',
      source: 'health_alert',
      source_ref_id: 'alert-1',
    });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(admin);

    const res = await PATCH(makeRequest('PATCH', {
      id: '00000000-0000-0000-0000-000000000001',
      status: 'resolved',
    }));

    expect(res.status).toBe(409);
    expect(updates.some((entry) => entry.table === 'incidents')).toBe(false);
  });

  it('allows legacy unlinked health incidents to follow the manual lifecycle', async () => {
    const { admin, updates } = makeAdmin([], {
      status: 'open',
      source: 'health_alert',
      source_ref_id: null,
    });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(admin);

    const res = await PATCH(makeRequest('PATCH', {
      id: '00000000-0000-0000-0000-000000000001',
      status: 'resolved',
    }));

    expect(res.status).toBe(200);
    expect(updates.some((entry) => entry.table === 'incidents')).toBe(true);
  });

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
