/**
 * /api/tickets — List and manage tickets.
 *
 * GET: List tickets with optional status filter
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';


export async function GET(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'standard');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const { searchParams } = new URL(req.url);
  // V11 Audit H-4: Whitelist status values and validate panelId format.
  const VALID_STATUSES = ['open', 'claimed', 'closed', 'archived'] as const;
  const rawStatus = searchParams.get('status');
  const status = rawStatus && VALID_STATUSES.includes(rawStatus as typeof VALID_STATUSES[number]) ? rawStatus : null;
  const rawPanelId = searchParams.get('panel_id');
  const panelId = rawPanelId?.match(/^[a-f0-9-]{1,64}$/i) ? rawPanelId : null;
  const limit = Math.min(200, Math.max(1, parseInt(searchParams.get('limit') || '50', 10)));
  const offset = Math.max(0, parseInt(searchParams.get('offset') || '0', 10));

  let query = supabase
    .from('tickets')
    .select('*', { count: 'exact' })
    .eq('guild_id', guildId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)
    .limit(1000);

  if (status) {
    query = query.eq('status', status);
  }

  if (panelId) {
    query = query.eq('panel_id', panelId);
  }

  const { data, error, count } = await query;

  if (error) {
    return dbError(error, 'tickets');
  }

  return NextResponse.json({ success: true, data: data ?? [], total: count ?? 0 });
}
