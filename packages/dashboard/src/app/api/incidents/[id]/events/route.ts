/**
 * GET /api/incidents/[id]/events — Get timeline events for an incident.
 * POST /api/incidents/[id]/events — Add a note/event to an incident.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requirePermission } from '@/lib/rbac';
import { z } from 'zod';
import { parseBody } from '@/lib/api/validation';

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
    await requirePermission('dashboard.manage_incidents');
    const { id } = await params;
    const admin = createAdminSupabase();

    const { data, error } = await admin
      .from('incident_events')
      .select('*')
      .eq('incident_id', id)
      .order('created_at', { ascending: true });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
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
  try {
    const ctx = await requirePermission('dashboard.manage_incidents');
    const { id } = await params;
    const parsed = await parseBody(request, incidentEventCreate);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    const admin = createAdminSupabase();

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

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true, data });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: msg === 'Unauthorized' ? 401 : 403 });
  }
}
