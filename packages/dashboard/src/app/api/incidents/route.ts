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
import { recordAdminChange, readRowBefore } from '@/lib/admin-changes';
import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

/**
 * Columns of an incident copied into an admin-changes before/after payload.
 * Explicit rather than `*`: the change log is rendered verbatim, and an
 * incident row can accumulate free-text operator fields we would rather name
 * than inherit.
 */
const INCIDENT_RECORD_COLUMNS =
  'id, incident_number, title, status, severity, assigned_to, started_at, source, source_ref_id';

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
    action: 'incident.created' | 'incident.create_failed' | 'incident.updated' | 'incident.resolved';
    incidentId: string;
    details: Record<string, unknown>;
    occurrenceKey?: string;
    success?: boolean;
    errorMessage?: string;
  },
): Promise<void> {
  try {
    const row = {
      guild_id: args.guildId,
      actor_type: 'dashboard',
      actor_id: args.actorId,
      action: args.action,
      category: 'incidents',
      target_type: 'incident',
      target_id: args.incidentId,
      details: args.details,
      occurrence_key: args.occurrenceKey ?? null,
      success: args.success ?? true,
      error_message: args.errorMessage ?? null,
    };
    if (args.occurrenceKey) {
      await admin.from('audit_logs').upsert(row, {
        onConflict: 'guild_id,occurrence_key',
        ignoreDuplicates: true,
      });
    } else {
      await admin.from('audit_logs').insert(row);
    }
  } catch {
    // audit write is best-effort
  }
}

const incidentCreate = z.object({
  title: z.string().min(1).max(256).trim(),
  description: z.string().max(4000).optional().nullable(),
  severity: z.enum(['info', 'warning', 'critical', 'outage']).optional(),
  source: z.string().max(64).default('manual'),
  source_ref_id: z.string().max(256).optional().nullable(),
  assigned_to: snowflake.optional().nullable(),
  request_id: z.string().uuid().optional(),
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
    const configResult = await createAdminSupabase()
      .from('guild_config')
      .select('incidents_list_page_size')
      .eq('guild_id', ctx.guildId)
      .maybeSingle();
    const status = searchParams.get('status');
    const severity = searchParams.get('severity');
    const rawPage = parseInt(searchParams.get('page') || '1', 10);
    // A page of 0 or negative produced a negative range offset.
    const page = Number.isFinite(rawPage) ? Math.max(1, rawPage) : 1;
    // Clamped: an unbounded pageSize (pageSize=100000 was accepted) lets one
    // request pull the entire incident history in a single range scan, and a
    // NaN from a non-numeric value produced a broken range.
    const configuredPageSize = Number(configResult.data?.incidents_list_page_size);
    const defaultPageSize = Number.isInteger(configuredPageSize) ? Math.min(100, Math.max(1, configuredPageSize)) : 50;
    const rawPageSize = parseInt(searchParams.get('pageSize') || String(defaultPageSize), 10);
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
    const requestOccurrenceId = body.request_id ?? randomUUID();
    const admin = createAdminSupabase();
    const { data: config } = await admin
      .from('guild_config')
      .select('incidents_default_severity')
      .eq('guild_id', ctx.guildId)
      .maybeSingle();
    const configuredSeverity = config?.incidents_default_severity;
    const effectiveSeverity = body.severity ?? (configuredSeverity === 'info' || configuredSeverity === 'warning' || configuredSeverity === 'critical' || configuredSeverity === 'outage' ? configuredSeverity : 'warning');

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
        severity: effectiveSeverity,
        status: 'open',
        source: body.source || 'manual',
        source_ref_id: body.source_ref_id || null,
        assigned_to: body.assigned_to || null,
        created_by: ctx.discordId,
      })
      .select()
      .single();

    if (error) {
      await mirrorIncidentToOwner(admin, {
        guildId: ctx.guildId,
        actorId: ctx.discordId,
        action: 'incident.create_failed',
        incidentId: requestOccurrenceId,
        details: {
          request_id: requestOccurrenceId,
          title: body.title,
          severity: effectiveSeverity,
          source: body.source || 'manual',
        },
        occurrenceKey: `incident.create_failed:${requestOccurrenceId}`,
        success: false,
        errorMessage: error.message,
      });
      return dbError(error, 'incidents');
    }

    // Create initial event
    await admin.from('incident_events').insert({
      incident_id: incident.id,
      event_type: 'created',
      actor_id: ctx.discordId,
      message: `Incident created: ${body.title}`,
      metadata: { severity: effectiveSeverity, source: body.source || 'manual' },
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
        severity: effectiveSeverity,
        source: body.source || 'manual',
      },
      occurrenceKey: `incident.created:${requestOccurrenceId}`,
    });
    try {
      await admin.from('alerts').insert({
        guild_id: ctx.guildId,
        alert_type: 'incident_reported',
        severity: toAlertSeverity(effectiveSeverity),
        title: `Incident #${nextNumber}: ${body.title}`,
        message: body.description || `A ${effectiveSeverity} incident was reported.`,
        metadata: { incident_id: incident.id, incident_number: nextNumber, source: body.source || 'manual' },
      });
    } catch {
      // owner-alert mirror is best-effort
    }

    await recordAdminChange({
      guildId: ctx.guildId,
      actorId: ctx.discordId,
      action: 'incident.created',
      targetType: 'incident',
      targetId: incident.id,
      description:
        `Opened incident #${nextNumber} "${body.title}" at ${effectiveSeverity} severity`,
      after: {
        incident_number: nextNumber,
        title: body.title,
        severity: effectiveSeverity,
        status: 'open',
        source: body.source || 'manual',
        assigned_to: body.assigned_to || null,
      },
      // An incident record documents the server; it does not change how the
      // server behaves.
      blastRadius: 'low',
      undoReason:
        'an incident is a permanent operational record — close or resolve it instead of removing it',
    }, admin);

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

    // Read the incident's prior state BEFORE the update. This is what makes
    // the recorded change show what actually changed rather than echoing the
    // new values back, and it doubles as the source of `started_at` for the
    // resolution duration below — one guild-scoped read instead of the
    // previous unscoped, resolve-only one.
    const before = await readRowBefore(
      admin,
      'incidents',
      { id: body.id, guild_id: ctx.guildId },
      INCIDENT_RECORD_COLUMNS,
    );

    if (
      body.status
      && before?.source === 'health_alert'
      && !(body.status === 'closed' && before.status === 'resolved')
    ) {
      return NextResponse.json(
        { error: 'Linked health incident status follows its diagnostics alert.' },
        { status: 409 },
      );
    }

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    const eventMeta: Record<string, unknown> = {};

    if (body.status) {
      updates.status = body.status;
      eventMeta.new_status = body.status;
      if (body.status === 'identified') updates.identified_at = new Date().toISOString();
      if (body.status === 'resolved') {
        updates.resolved_at = new Date().toISOString();
        // Calculate duration
        const startedAt = before?.started_at;
        if (startedAt) {
          updates.duration_seconds = Math.round(
            (Date.now() - new Date(String(startedAt)).getTime()) / 1000,
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

    const label = before?.incident_number
      ? `#${String(before.incident_number)} "${String(before.title ?? '')}"`.trim()
      : 'this incident';
    const changed = Object.keys(updates).filter(
      (k) => k !== 'updated_at' && k !== 'duration_seconds',
    );
    await recordAdminChange({
      guildId: ctx.guildId,
      actorId: ctx.discordId,
      action: resolved ? 'incident.resolved' : 'incident.updated',
      targetType: 'incident',
      targetId: body.id,
      description: resolved
        ? `Marked incident ${label} resolved`
        : body.status
          ? `Moved incident ${label} to ${body.status}`
          : `Updated the details of incident ${label}`,
      before: before
        ? {
            status: before.status ?? null,
            severity: before.severity ?? null,
            assigned_to: before.assigned_to ?? null,
          }
        : undefined,
      after: Object.fromEntries(changed.map((k) => [k, updates[k]])),
      blastRadius: 'low',
      undoReason:
        'an incident timeline is an append-only record — file a further update instead of rewinding one',
    }, admin);

    return NextResponse.json({ success: true, data });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: msg === 'Unauthorized' ? 401 : 403 });
  }
}
