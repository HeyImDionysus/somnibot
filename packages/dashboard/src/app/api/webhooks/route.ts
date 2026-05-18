/**
 * /api/webhooks — Webhook event log.
 *
 * GET: List webhook events with filtering by type, result, and pagination.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';

const DEFAULT_PAGE_SIZE = 25;

export async function GET(req: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const { searchParams } = new URL(req.url);

  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10));
  const pageSize = Math.min(50, Math.max(1, parseInt(searchParams.get('pageSize') ?? String(DEFAULT_PAGE_SIZE), 10)));
  const result = searchParams.get('result');
  const eventType = searchParams.get('eventType');

  let query = supabase
    .from('webhook_events')
    .select('*', { count: 'exact' })
    .order('processed_at', { ascending: false });

  if (result) {
    query = query.eq('result', result);
  }
  if (eventType) {
    query = query.eq('event_type', eventType);
  }

  const from = (page - 1) * pageSize;
  query = query.range(from, from + pageSize - 1);

  const { data, error, count } = await query;

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    data: data ?? [],
    pagination: {
      page,
      pageSize,
      total: count ?? 0,
      totalPages: Math.ceil((count ?? 0) / pageSize),
    },
  });
}
