/**
 * /api/orders — Order list.
 *
 * GET: List orders with optional search
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { sanitizeSearch } from '@/lib/utils/sanitize-search';
import { requireGuildOwner } from '@/lib/api/require-owner';


export async function GET(req: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const { searchParams } = new URL(req.url);
  const search = searchParams.get('search');
  const status = searchParams.get('status');
  const limit = parseInt(searchParams.get('limit') ?? '50', 10);
  const offset = parseInt(searchParams.get('offset') ?? '0', 10);

  let query = supabase
    .from('orders')
    .select('*, customers(discord_id, discord_username), products(name)', { count: 'exact' })
    .eq('guild_id', guildId)
    .order('created_at', { ascending: false })
    .limit(500)
    .range(offset, offset + limit - 1);

  if (status) {
    query = query.eq('status', status);
  }

  if (search) {
    // Search by order number, customer username, or discord ID
    const s = sanitizeSearch(search);
    if (s) {
      query = query.or(
        `order_number.ilike.%${s}%,customers.discord_username.ilike.%${s}%,customers.discord_id.eq.${s}`,
      );
    }
  }

  const { data, error, count } = await query;

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, data: data ?? [], total: count ?? 0 });
}
