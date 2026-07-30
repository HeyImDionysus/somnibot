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

  const from = (page - 1) * pageSize;
  // Authorization and the protected read happen in one database operation.
  // The RPC holds a SHARE lock on guild ownership while it proves whether
  // unattributed rows may be included, closing the owner-addition race.
  const { data: scoped, error } = await supabase.rpc('webhooks_list_scoped', {
    p_guild_id: guildId,
    p_discord_id: discordId,
    p_result: result,
    p_event_type: eventType,
    p_offset: from,
    p_limit: pageSize,
  });

  if (error) {
    return dbError(error, 'webhooks');
  }

  const envelope = scoped && typeof scoped === 'object' && !Array.isArray(scoped)
    ? scoped as { data?: unknown; total?: unknown }
    : {};
  const data = Array.isArray(envelope.data) ? envelope.data : [];
  const count = typeof envelope.total === 'number' ? envelope.total : 0;

  return NextResponse.json({
    success: true,
    data,
    pagination: {
      page,
      pageSize,
      total: count ?? 0,
      totalPages: Math.ceil((count ?? 0) / pageSize),
    },
  });
}
