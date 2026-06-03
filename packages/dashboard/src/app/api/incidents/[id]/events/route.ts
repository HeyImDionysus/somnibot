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

    // V51: verify incident belongs to this guild before adding events
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
    return NextResponse.json({ success: true, data });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: msg === 'Unauthorized' ? 401 : 403 });
  }
}
