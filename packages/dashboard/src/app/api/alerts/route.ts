/**
 * /api/alerts — Active alerts and alert history.
 *
 * GET:  List alerts (filterable by status, type, severity)
 * PATCH: Acknowledge or resolve an alert by ID
 *
 * Phase C: Real diagnostics & alerting.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
export async function GET(req: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const { searchParams } = new URL(req.url);

  const status = searchParams.get('status') ?? 'active'; // 'active' | 'resolved' | 'all'
  const alertType = searchParams.get('type');
  const severity = searchParams.get('severity');
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') ?? '50', 10)));

  let query = supabase
    .from('alerts')
    .select('*')
    .eq('guild_id', guildId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (status === 'active') {
    query = query.eq('resolved', false);
  } else if (status === 'resolved') {
    query = query.eq('resolved', true);
  }

  if (alertType) {
    query = query.eq('alert_type', alertType);
  }

  if (severity) {
    query = query.eq('severity', severity);
  }

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  // Separate active and resolved for convenience
  const active = (data ?? []).filter((a) => !a.resolved);
  const resolved = (data ?? []).filter((a) => a.resolved);

  return NextResponse.json({
    success: true,
    data: {
      alerts: data ?? [],
      activeCount: active.length,
      resolvedCount: resolved.length,
    },
  });
}

export async function PATCH(req: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();

  let body: { id?: string; action?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const { id, action } = body;

  if (!id || !action) {
    return NextResponse.json(
      { success: false, error: 'Missing required fields: id, action' },
      { status: 400 },
    );
  }

  if (action === 'acknowledge') {
    const { error } = await supabase
      .from('alerts')
      .update({
        acknowledged: true,
        acknowledged_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('guild_id', guildId);

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
    return NextResponse.json({ success: true });
  }

  if (action === 'resolve') {
    const { error } = await supabase
      .from('alerts')
      .update({
        resolved: true,
        resolved_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('guild_id', guildId);

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
    return NextResponse.json({ success: true });
  }

  return NextResponse.json(
    { success: false, error: `Unknown action: ${action}. Use 'acknowledge' or 'resolve'.` },
    { status: 400 },
  );
}
