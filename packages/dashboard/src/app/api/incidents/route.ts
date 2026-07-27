/**
 * GET /api/incidents — List incidents with filtering.
 * POST /api/incidents — Create a new incident.
 * PATCH /api/incidents — Update incident status/details.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requirePermission, authErrorResponse } from '@/lib/rbac';
import { z } from 'zod';
import { parseBody } from '@/lib/api/validation';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';
import type { SupabaseClient } from '@supabase/supabase-js';

const snowflake = z.string().regex(/^\d{17,20}$/);

/**
 * Map an incident severity onto the alerts table's CHECK vocabulary
 * ('info' | 'warning' | 'critical'). 'outage' has no alert equivalent, so it
 * escalates to 'critical'.
 */
function toAlertSeverity(severity: string): 'info' | 'warning' | 'critical' {
  if (severity === 'info' || severity === 'warning' || severity === 'critical') return severity;
  return 'critical'; // 'outage'
}

/**
 * Mirror a manual incident to the owner-facing surfaces: an append-only
 * audit_logs row plus (on open) a row in the alerts table the owner dashboard
 * reads. Never throws — observability must not break the incident write.
 */
async function mirrorIncidentToOwner(
  admin: SupabaseClient,
  args: {
    guildId: string;
    actorId: string;
    action: 'incident.created' | 'incident.updated' | 'incident.resolved';
    incidentId: string;
    details: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await admin.from('audit_logs').insert({
      guild_id: args.guildId,
      actor_type: 'dashboard',
      actor_id: args.actorId,
      action: args.action,
      category: 'incidents',
      target_type: 'incident',
      target_id: args.incidentId,
      details: args.details,
      success: true,
    });
  } catch {
    // audit write is best-effort
  }
}

const incidentCreate = z.object({
  title: z.string().min(1).max(256).trim(),
  description: z.string().max(4000).optional().nullable(),
  severity: z.enum(['info', 'warning', 'critical', 'outage']).default('warning'),
  source: z.string().max(64).default('manual'),
  source_ref_id: z.string().max(256).optional().nullable(),
  assigned_to: snowflake.optional().nullable(),
});

const incidentUpdate = z.object({
  id: z.string().uuid(),
  status: z.enum(['open', 'investigating', 'identified', 'monitoring', 'resolved', 'closed']).optional(),
  severity: z.enum(['info', 'warning', 'critical', 'outage']).optional(),
  assigned_to: snowflake.optional().nullable(),
  impact_summary: z.string().max(4000).optional(),
  root_cause: z.string().max(4000).optional(),
  resolution: z.string().max(4000).optional(),
  note: z.string().max(4000).optional(),
  message: z.string().max(4000).optional(),
});

export async function GET(request: NextRequest) {
  try {
    const ctx = await requirePermission('dashboard.manage_incidents');
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');
    const severity = searchParams.get('severity');
    const rawPage = parseInt(searchParams.get('page') || '1', 10);
    // A page of 0 or negative produced a negative range offset.
    const page = Number.isFinite(rawPage) ? Math.max(1, rawPage) : 1;
    // Clamped: an unbounded pageSize (pageSize=100000 was accepted) lets one
    // request pull the entire incident history in a single range scan, and a
    // NaN from a non-numeric value produced a broken range.
    const rawPageSize = parseInt(searchParams.get('pageSize') || '50', 10);
    const pageSize = Number.isFinite(rawPageSize)
      ? Math.min(100, Math.max(1, rawPageSize))
      : 50;

    const admin = createAdminSupabase();
    let query = admin
      .from('incidents')
      .select('*, incident_events(count)', { count: 'exact' })
      .eq('guild_id', ctx.guildId)
      .order('created_at', { ascending: false })
      .range((page - 1) * pageSize, page * pageSize - 1)
      .limit(1000);

    if (status) {
      if (status === 'active') {
        query = query.not('status', 'eq', 'resolved');
      } else {
        query = query.eq('status', status);
      }
    }
    if (severity) query = query.eq('severity', severity);

    const { data, count, error } = await query;
    if (error) return dbError(error, 'incidents');

    // Summary counts
    const { data: allIncidents } = await admin
      .from('incidents')
      .select('status, severity')
      .eq('guild_id', ctx.guildId)
      .limit(500);

    const summary = {
      total: (allIncidents || []).length,
      open: (allIncidents || []).filter(i => i.status === 'open').length,
      investigating: (allIncidents || []).filter(i => i.status === 'investigating').length,
      identified: (allIncidents || []).filter(i => i.status === 'identified').length,
      monitoring: (allIncidents || []).filter(i => i.status === 'monitoring').length,
      resolved: (allIncidents || []).filter(i => i.status === 'resolved').length,
      critical: (allIncidents || []).filter(i => i.severity === 'critical' && i.status !== 'resolved').length,
      outage: (allIncidents || []).filter(i => i.severity === 'outage' && i.status !== 'resolved').length,
    };

    return NextResponse.json({
      success: true,
      data,
      summary,
      pagination: { page, pageSize, total: count || 0, totalPages: Math.ceil((count || 0) / pageSize) },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: msg === 'Unauthorized' ? 401 : 403 });
  }
}

export async function POST(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;

  try {
    const ctx = await requirePermission('dashboard.manage_incidents');
    const parsed = await parseBody(request, incidentCreate);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    const admin = createAdminSupabase();

    // Get next incident number (atomic sequence — no race condition)
    const { data: seqVal } = await admin.rpc('nextval_incident');
    const nextNumber = typeof seqVal === 'number' ? seqVal : 1;

    const { data: incident, error } = await admin
      .from('incidents')
      .insert({
        guild_id: ctx.guildId,
        incident_number: nextNumber,
        title: body.title,
        description: body.description || null,
        severity: body.severity || 'warning',
        status: 'open',
        source: body.source || 'manual',
        source_ref_id: body.source_ref_id || null,
        assigned_to: body.assigned_to || null,
        created_by: ctx.discordId,
      })
      .select()
      .single();

    if (error) return dbError(error, 'incidents');

    // Create initial event
    await admin.from('incident_events').insert({
      incident_id: incident.id,
      event_type: 'created',
      actor_id: ctx.discordId,
      message: `Incident created: ${body.title}`,
      metadata: { severity: body.severity || 'warning', source: body.source || 'manual' },
    });

    // Mirror to the owner: append-only audit trail + an owner-facing alert row.
    // Previously a manual incident create/update/resolve was invisible to the
    // owner surfaces (no audit_logs, no alert).
    await mirrorIncidentToOwner(admin, {
      guildId: ctx.guildId,
      actorId: ctx.discordId,
      action: 'incident.created',
      incidentId: incident.id,
      details: {
        incident_number: nextNumber,
        title: body.title,
        severity: body.severity || 'warning',
        source: body.source || 'manual',
      },
    });
    try {
      await admin.from('alerts').insert({
        guild_id: ctx.guildId,
        alert_type: 'incident_reported',
        severity: toAlertSeverity(body.severity || 'warning'),
        title: `Incident #${nextNumber}: ${body.title}`,
        message: body.description || `A ${body.severity || 'warning'} incident was reported.`,
        metadata: { incident_id: incident.id, incident_number: nextNumber, source: body.source || 'manual' },
      });
    } catch {
      // owner-alert mirror is best-effort
    }

    return NextResponse.json({ success: true, data: incident });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: msg === 'Unauthorized' ? 401 : 403 });
  }
}

export async function PATCH(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;

  try {
    const ctx = await requirePermission('dashboard.manage_incidents');
    const parsed = await parseBody(request, incidentUpdate);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    const admin = createAdminSupabase();

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    const eventMeta: Record<string, unknown> = {};

    if (body.status) {
      updates.status = body.status;
      eventMeta.new_status = body.status;
      if (body.status === 'identified') updates.identified_at = new Date().toISOString();
      if (body.status === 'resolved') {
        updates.resolved_at = new Date().toISOString();
        // Calculate duration
        const { data: inc } = await admin
          .from('incidents')
          .select('started_at')
          .eq('id', body.id)
          .single();
        if (inc) {
          updates.duration_seconds = Math.round(
            (Date.now() - new Date(inc.started_at).getTime()) / 1000,
          );
        }
      }
    }
    if (body.severity !== undefined) { updates.severity = body.severity; eventMeta.severity = body.severity; }
    if (body.assigned_to !== undefined) { updates.assigned_to = body.assigned_to; eventMeta.assigned_to = body.assigned_to; }
    if (body.impact_summary !== undefined) updates.impact_summary = body.impact_summary;
    if (body.root_cause !== undefined) updates.root_cause = body.root_cause;
    if (body.resolution !== undefined) updates.resolution = body.resolution;

    const { data, error } = await admin
      .from('incidents')
      .update(updates)
      .eq('id', body.id)
      .eq('guild_id', ctx.guildId)
      .select()
      .single();

    if (error) return dbError(error, 'incidents');

    // Add timeline event
    const eventType = body.status ? 'status_change' : body.note ? 'note' : 'updated';
    await admin.from('incident_events').insert({
      incident_id: body.id,
      event_type: eventType,
      actor_id: ctx.discordId,
      message: body.note || body.message || `Status changed to ${body.status || 'updated'}`,
      metadata: eventMeta,
    });

    // Mirror the update/resolution to the owner: audit_logs always; on
    // resolution, close out the owner-facing alert opened at creation.
    const resolved = body.status === 'resolved';
    await mirrorIncidentToOwner(admin, {
      guildId: ctx.guildId,
      actorId: ctx.discordId,
      action: resolved ? 'incident.resolved' : 'incident.updated',
      incidentId: body.id,
      details: { status: body.status, severity: body.severity, ...eventMeta },
    });
    if (resolved) {
      try {
        await admin
          .from('alerts')
          .update({ resolved: true, resolved_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq('guild_id', ctx.guildId)
          .eq('alert_type', 'incident_reported')
          .eq('metadata->>incident_id', body.id)
          .eq('resolved', false);
      } catch {
        // best-effort alert resolution
      }
    }

    return NextResponse.json({ success: true, data });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: msg === 'Unauthorized' ? 401 : 403 });
  }
}
