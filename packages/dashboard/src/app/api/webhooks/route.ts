/**
 * /api/webhooks — Webhook event log.
 *
 * GET: List webhook events with filtering by type, result, and pagination.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';
import { buildWebhookScopeFilter, isSoleInstanceOperator } from './scope';

const DEFAULT_PAGE_SIZE = 25;

export async function GET(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'standard');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId, discordId } = auth.ctx;

  const supabase = createAdminSupabase();
  const { searchParams } = new URL(req.url);

  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10));
  const pageSize = Math.min(50, Math.max(1, parseInt(searchParams.get('pageSize') ?? String(DEFAULT_PAGE_SIZE), 10)));
  const result = searchParams.get('result');
  const eventType = searchParams.get('eventType');

  // Finding 2: events the route could not attribute to a guild (a failed
  // capture, or a capture whose custom_id was malformed) are stored with a
  // NULL guild_id, and `.eq('guild_id', …)` never matches NULL — so the money
  // events that most need an operator were the ones hidden from them. They are
  // surfaced only to a caller who owns the whole instance; see ./scope.ts for
  // why that is the boundary.
  const scopeFilter = buildWebhookScopeFilter(
    guildId,
    await isSoleInstanceOperator(supabase, discordId),
  );

  let query = supabase
    .from('webhook_events')
    .select('*', { count: 'exact' })
    .order('processed_at', { ascending: false })
    .limit(500);

  query = scopeFilter ? query.or(scopeFilter) : query.eq('guild_id', guildId);

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
    return dbError(error, 'webhooks');
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
