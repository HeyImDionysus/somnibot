/**
 * GET /api/incidents — List incidents with filtering.
 * POST /api/incidents — Create a new incident.
 * PATCH /api/incidents — Update incident status/details.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requirePermission } from '@/lib/rbac';
import { z } from 'zod';
import { parseBody } from '@/lib/api/validation';

const snowflake = z.string().regex(/^\d{17,20}$/);

const incidentCreate = z.object({
  title: z.string().min(1).max(256).trim(),
  description: z.string().max(4000).optional().nullable(),
  severity: z.enum(['info', 'warning', 'critical']).default('warning'),
  source: z.string().max(64).default('manual'),
  source_ref_id: z.string().max(256).optional().nullable(),
  assigned_to: snowflake.optional().nullable(),
});

const incidentUpdate = z.object({
  id: z.string().uuid(),
  status: z.enum(['open', 'investigating', 'identified', 'monitoring', 'resolved', 'closed']).optional(),
  severity: z.enum(['info', 'warning', 'critical']).optional(),
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
    const page = parseInt(searchParams.get('page') || '1');
    const pageSize = parseInt(searchParams.get('pageSize') || '50');

    const admin = createAdminSupabase();
    let query = admin
      .from('incidents')
      .select('*, incident_events(count)', { count: 'exact' })
      .eq('guild_id', ctx.guildId)
      .order('created_at', { ascending: false })
      .limit(500)
      .range((page - 1) * pageSize, page * pageSize - 1);

    if (status) {
      if (status === 'active') {
        query = query.not('status', 'eq', 'resolved');
      } else {
        query = query.eq('status', status);
      }
    }
    if (severity) query = query.eq('severity', severity);

    const { data, count, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Summary counts
    const { data: allIncidents } = await admin
      .from('incidents')
      .select('status, severity')
      .eq('guild_id', ctx.guildId);

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

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Create initial event
    await admin.from('incident_events').insert({
      incident_id: incident.id,
      event_type: 'created',
      actor_id: ctx.discordId,
      message: `Incident created: ${body.title}`,
      metadata: { severity: body.severity || 'warning', source: body.source || 'manual' },
    });

    return NextResponse.json({ success: true, data: incident });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: msg === 'Unauthorized' ? 401 : 403 });
  }
}

export async function PATCH(request: NextRequest) {
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

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Add timeline event
    const eventType = body.status ? 'status_change' : body.note ? 'note' : 'updated';
    await admin.from('incident_events').insert({
      incident_id: body.id,
      event_type: eventType,
      actor_id: ctx.discordId,
      message: body.note || body.message || `Status changed to ${body.status || 'updated'}`,
      metadata: eventMeta,
    });

    return NextResponse.json({ success: true, data });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: msg === 'Unauthorized' ? 401 : 403 });
  }
}
