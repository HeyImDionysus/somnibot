/**
 * /api/action-queue — DLQ (Dead Letter Queue) management.
 *
 * GET:   List DLQ entries for the guild (paginated)
 * POST:  Retry or acknowledge DLQ entries
 *
 * V53 Phase 2 (Finding 2.3)
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';

export async function GET(request: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10));
  const pageSize = Math.min(50, Math.max(1, parseInt(url.searchParams.get('pageSize') ?? '20', 10)));
  const filter = url.searchParams.get('filter') ?? 'pending'; // 'pending' | 'acknowledged' | 'retried' | 'all'

  const supabase = createAdminSupabase();

  let query = supabase
    .from('action_queue_dlq')
    .select('*', { count: 'exact' })
    .eq('guild_id', guildId)
    .order('failed_at', { ascending: false });

  if (filter === 'pending') {
    query = query.eq('acknowledged', false).eq('retried', false);
  } else if (filter === 'acknowledged') {
    query = query.eq('acknowledged', true);
  } else if (filter === 'retried') {
    query = query.eq('retried', true);
  }
  // 'all' = no extra filter

  const from = (page - 1) * pageSize;
  query = query.range(from, from + pageSize - 1);

  const { data, count, error } = await query;

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    data: {
      items: data ?? [],
      pagination: {
        page,
        pageSize,
        total: count ?? 0,
        totalPages: Math.ceil((count ?? 0) / pageSize),
      },
    },
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const body = await request.json();
  const { action, ids } = body as { action: 'acknowledge' | 'retry'; ids: string[] };

  if (!action || !Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json(
      { success: false, error: 'Missing action or ids' },
      { status: 400 },
    );
  }

  const supabase = createAdminSupabase();

  if (action === 'acknowledge') {
    const { error } = await supabase
      .from('action_queue_dlq')
      .update({
        acknowledged: true,
        acknowledged_at: new Date().toISOString(),
      })
      .eq('guild_id', guildId)
      .in('id', ids);

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, acknowledged: ids.length });
  }

  if (action === 'retry') {
    // For each DLQ entry, re-insert into bot_action_queue as 'pending'
    const { data: dlqItems, error: fetchErr } = await supabase
      .from('action_queue_dlq')
      .select('*')
      .eq('guild_id', guildId)
      .in('id', ids)
      .eq('retried', false);

    if (fetchErr) {
      return NextResponse.json({ success: false, error: fetchErr.message }, { status: 500 });
    }

    let retried = 0;
    for (const item of dlqItems ?? []) {
      // Re-insert into action queue
      const { error: insertErr } = await supabase
        .from('bot_action_queue')
        .insert({
          guild_id: guildId,
          action: item.action,
          payload: item.payload,
          status: 'pending',
          retry_count: 0,
        });

      if (!insertErr) {
        // Mark DLQ entry as retried
        await supabase
          .from('action_queue_dlq')
          .update({
            retried: true,
            retried_at: new Date().toISOString(),
          })
          .eq('id', item.id);
        retried++;
      }
    }

    return NextResponse.json({ success: true, retried });
  }

  return NextResponse.json(
    { success: false, error: `Unknown action: ${action}` },
    { status: 400 },
  );
}
