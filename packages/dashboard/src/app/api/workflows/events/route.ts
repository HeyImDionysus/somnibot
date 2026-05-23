/**
 * GET /api/workflows/events — List durable workflow events with filtering.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requirePermission, authErrorResponse } from '@/lib/rbac';

export async function GET(request: NextRequest) {
  try {
    const ctx = await requirePermission('dashboard.view_workflows');
    const { searchParams } = new URL(request.url);
    const eventType = searchParams.get('eventType');
    const source = searchParams.get('source');
    const result = searchParams.get('result');
    const correlationId = searchParams.get('correlationId');
    const page = parseInt(searchParams.get('page') || '1');
    const pageSize = parseInt(searchParams.get('pageSize') || '100');

    const admin = createAdminSupabase();
    let query = admin
      .from('workflow_events')
      .select('*', { count: 'exact' })
      .eq('guild_id', ctx.guildId)
      .order('created_at', { ascending: false })
      .range((page - 1) * pageSize, page * pageSize - 1);

    if (eventType) query = query.eq('event_type', eventType);
    if (source) query = query.eq('source', source);
    if (result) query = query.eq('result', result);
    if (correlationId) query = query.eq('correlation_id', correlationId);

    const { data, count, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({
      success: true,
      data,
      pagination: { page, pageSize, total: count || 0, totalPages: Math.ceil((count || 0) / pageSize) },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: msg === 'Unauthorized' ? 401 : 403 });
  }
}
