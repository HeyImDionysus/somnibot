/**
 * /api/customers — Customer list.
 *
 * GET: List customers with search
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { sanitizeSearch } from '@/lib/utils/sanitize-search';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';


export async function GET(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'standard');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const { searchParams } = new URL(req.url);
  const search = searchParams.get('search');
  // V5 Audit [7.1]: Cap limit to prevent unbounded result sets
  const limit = Math.min(Math.max(1, parseInt(searchParams.get('limit') ?? '50', 10)), 200);
  const offset = Math.max(0, parseInt(searchParams.get('offset') ?? '0', 10));

  let query = supabase
    .from('customers')
    .select('*', { count: 'exact' })
    .eq('guild_id', guildId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (search) {
    const s = sanitizeSearch(search);
    if (s) {
      query = query.or(
        `discord_username.ilike.%${s}%,discord_id.eq.${s},email.ilike.%${s}%`,
      );
    }
  }

  const { data, error, count } = await query;

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, data: data ?? [], total: count ?? 0 });
}
