/**
 * incidents-route.live.test — drive the REAL /api/incidents handlers through the
 * REAL requirePermission guard against LOCAL Supabase (real-session harness, zero
 * prod edits). Un-gates administration-incidents AND confirms the requirePermission
 * owner short-circuit (rbac.ts: an owner requesting their owned guild gets
 * dashboard.full_access — no dashboard_user_roles seed needed).
 *
 * Proves the full manual-incident lifecycle DB-observably: create lands an
 * incidents row + incident_events 'created' + an append-only audit_logs row + an
 * owner-facing alerts row; resolve flips status/resolved_at + audits + resolves
 * the alert.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  armDashboardLiveEnv,
  localSupabaseReachable,
  createOwnerSession,
  buildNextHeadersMock,
  type OwnerSession,
} from './_session-harness';

const SUPA_URL = armDashboardLiveEnv();

const holder = vi.hoisted(() => ({
  cookies: async () => ({ getAll: () => [] as unknown[], get: () => undefined, set: () => {} }),
  headers: async () => ({ get: () => null, has: () => false }),
}));
vi.mock('next/headers', () => ({
  cookies: () => holder.cookies(),
  headers: () => holder.headers(),
}));

const reachable = await localSupabaseReachable(SUPA_URL);

describe.skipIf(!reachable)('LIVE: /api/incidents (real-session harness)', () => {
  const suffix = `${Date.now()}`;
  const guildId = `e2e-dash-inc-${suffix}`;
  const ownerDiscordId = `e2e-owner-inc-${suffix}`;
  const admin: SupabaseClient = createClient(SUPA_URL, process.env.SUPABASE_SECRET_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  let session: OwnerSession;
  let incidentId: string;

  beforeAll(async () => {
    await admin.from('guild').upsert(
      { id: guildId, name: 'E2E Dash Incidents Guild', owner_discord_id: ownerDiscordId },
      { onConflict: 'id' },
    );
    session = await createOwnerSession(ownerDiscordId);
    const mock = buildNextHeadersMock(session, guildId);
    holder.cookies = mock.cookies;
    holder.headers = mock.headers;
  });

  afterAll(async () => {
    if (incidentId) await admin.from('incident_events').delete().eq('incident_id', incidentId);
    await admin.from('incidents').delete().eq('guild_id', guildId);
    await admin.from('alerts').delete().eq('guild_id', guildId);
    await admin.from('audit_logs').delete().eq('guild_id', guildId);
    await admin.from('guild').delete().eq('id', guildId);
  });

  function jsonReq(method: string, body?: unknown, query = ''): import('next/server').NextRequest {
    return new Request(`http://localhost/api/incidents${query}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `10.4.0.${(Date.now() % 250) + 1}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }) as unknown as import('next/server').NextRequest;
  }

  it('POST creates an incident + timeline event + audit row + owner alert (owner short-circuit through requirePermission)', async () => {
    const { POST } = await import('../../app/api/incidents/route');
    const res = await POST(jsonReq('POST', { title: 'E2E DB blip', severity: 'warning' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { id: string; status: string; created_by: string; guild_id: string } };
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('open');
    expect(body.data.created_by).toBe(ownerDiscordId);
    expect(body.data.guild_id).toBe(guildId);
    incidentId = body.data.id;

    // Timeline event
    const { data: events } = await admin
      .from('incident_events')
      .select('event_type')
      .eq('incident_id', incidentId);
    expect((events ?? []).some((e) => e.event_type === 'created')).toBe(true);

    // Append-only audit row
    const { data: audits } = await admin
      .from('audit_logs')
      .select('action, target_id, actor_id')
      .eq('guild_id', guildId)
      .eq('action', 'incident.created');
    expect((audits ?? []).some((a) => a.target_id === incidentId && a.actor_id === ownerDiscordId)).toBe(true);

    // Owner-facing alert row
    const { data: alerts } = await admin
      .from('alerts')
      .select('alert_type, resolved')
      .eq('guild_id', guildId)
      .eq('alert_type', 'incident_reported');
    expect((alerts ?? []).length).toBeGreaterThanOrEqual(1);
    expect((alerts ?? []).some((a) => a.resolved === false)).toBe(true);
  });

  it('GET lists the incident with a summary', async () => {
    const { GET } = await import('../../app/api/incidents/route');
    const res = await GET(jsonReq('GET'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: Array<{ id: string }>; summary: { total: number; open: number } };
    expect(body.data.some((i) => i.id === incidentId)).toBe(true);
    expect(body.summary.total).toBeGreaterThanOrEqual(1);
    expect(body.summary.open).toBeGreaterThanOrEqual(1);
  });

  it('PATCH resolve flips status + resolved_at, audits, and resolves the owner alert', async () => {
    const { PATCH } = await import('../../app/api/incidents/route');
    const res = await PATCH(jsonReq('PATCH', { id: incidentId, status: 'resolved', resolution: 'transient, recovered' }));
    expect(res.status).toBe(200);

    const { data: inc } = await admin
      .from('incidents')
      .select('status, resolved_at, duration_seconds')
      .eq('id', incidentId)
      .maybeSingle();
    expect(inc?.status).toBe('resolved');
    expect(inc?.resolved_at).toBeTruthy();

    const { data: audits } = await admin
      .from('audit_logs')
      .select('action')
      .eq('guild_id', guildId)
      .eq('action', 'incident.resolved');
    expect((audits ?? []).length).toBeGreaterThanOrEqual(1);

    // The alert opened at creation is now resolved.
    const { data: alerts } = await admin
      .from('alerts')
      .select('resolved')
      .eq('guild_id', guildId)
      .eq('alert_type', 'incident_reported');
    expect((alerts ?? []).every((a) => a.resolved === true)).toBe(true);
  });

  it('denies a POST for a guild the session does not own (real 403)', async () => {
    holder.headers = buildNextHeadersMock(session, `${guildId}-foreign`).headers;
    const { POST } = await import('../../app/api/incidents/route');
    const res = await POST(jsonReq('POST', { title: 'nope', severity: 'info' }));
    expect(res.status).toBe(403);
    holder.headers = buildNextHeadersMock(session, guildId).headers;
  });
});
