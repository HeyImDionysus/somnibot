/**
 * /api/action-queue — DLQ (Dead Letter Queue) management.
 *
 * GET:   List DLQ entries for the guild (paginated)
 * POST:  Retry or acknowledge DLQ entries
 *
 * V53 Phase 2 (Finding 2.3)
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { parseBody } from '@/lib/api/validation';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';

const actionQueuePostSchema = z.object({
  action: z.enum(['acknowledge', 'retry']),
  ids: z.array(z.string().uuid()).min(1, 'At least one id is required'),
});

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
    .order('failed_at', { ascending: false })
    .limit(500);

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
    return dbError(error, 'action-queue');
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
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const parsed = await parseBody(request, actionQueuePostSchema);
  if (!parsed.ok) return parsed.response;
  const { action, ids } = parsed.data;

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
      return dbError(error, 'action-queue');
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
      .eq('retried', false)
      .limit(1000);

    if (fetchErr) {
      return dbError(fetchErr, 'action-queue');
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
