/**
 * GET /api/incidents/[id]/events — Get timeline events for an incident.
 * POST /api/incidents/[id]/events — Add a note/event to an incident.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requirePermission, authErrorResponse } from '@/lib/rbac';
import { z } from 'zod';
import { parseBody } from '@/lib/api/validation';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';
import { recordAdminChange } from '@/lib/admin-changes';

const incidentEventCreate = z.object({
  event_type: z.string().max(64).default('note'),
  message: z.string().min(1).max(4000),
  metadata: z.record(z.unknown()).default({}),
});

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requirePermission('dashboard.manage_incidents');
    const { id } = await params;
    const admin = createAdminSupabase();

    // V51: verify incident belongs to this guild before returning events
    const { data: incident } = await admin
      .from('incidents')
      .select('id')
      .eq('id', id)
      .eq('guild_id', ctx.guildId)
      .maybeSingle();

    if (!incident) {
      return NextResponse.json({ error: 'Incident not found' }, { status: 404 });
    }

    const { data, error } = await admin
      .from('incident_events')
      .select('*')
      .eq('incident_id', id)
      .order('created_at', { ascending: true })
      .limit(500);

    if (error) return dbError(error, 'incidents/events');
    return NextResponse.json({ success: true, data });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: msg === 'Unauthorized' ? 401 : 403 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;

  try {
    const ctx = await requirePermission('dashboard.manage_incidents');
    const { id } = await params;
    const parsed = await parseBody(request, incidentEventCreate);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    const admin = createAdminSupabase();

    // V51: verify incident belongs to this guild before adding events.
    // `incident_events` has no guild column of its own, so this check is what
    // makes the guild id on the recorded admin change correct rather than
    // assumed. The number/title come from the same read so the recorded
    // sentence names the incident instead of printing a UUID.
    const { data: incident } = await admin
      .from('incidents')
      .select('id, incident_number, title')
      .eq('id', id)
      .eq('guild_id', ctx.guildId)
      .maybeSingle();

    if (!incident) {
      return NextResponse.json({ error: 'Incident not found' }, { status: 404 });
    }

    const { data, error } = await admin
      .from('incident_events')
      .insert({
        incident_id: id,
        event_type: body.event_type,
        actor_id: ctx.discordId,
        message: body.message,
        metadata: body.metadata,
      })
      .select()
      .single();

    if (error) return dbError(error, 'incidents/events');

    const incidentRow = incident as { incident_number?: number; title?: string };
    const label = incidentRow.incident_number
      ? `#${incidentRow.incident_number} "${incidentRow.title ?? ''}"`.trim()
      : 'an incident';
    await recordAdminChange({
      guildId: ctx.guildId,
      actorId: ctx.discordId,
      action: 'incident.event_added',
      targetType: 'incident update',
      // The incident, not the event row: this is what the owner navigates to.
      targetId: id,
      description: `Added a ${body.event_type} to incident ${label}`,
      after: {
        event_id: (data as { id?: string } | null)?.id ?? null,
        event_type: body.event_type,
        message: body.message,
      },
      blastRadius: 'low',
      undoReason:
        'an incident timeline is append-only, so a posted update cannot be taken back',
    }, admin);

    return NextResponse.json({ success: true, data });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: msg === 'Unauthorized' ? 401 : 403 });
  }
}
