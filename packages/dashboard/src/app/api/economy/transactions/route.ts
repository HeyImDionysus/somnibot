/**
 * GET /api/economy/transactions — Paginated economy transaction log.
 *
 * Query params:
 *   user_id  — filter by user (optional)
 *   type     — filter by transaction type (optional)
 *   limit    — page size (default 50, max 200)
 *   offset   — pagination offset (default 0)
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requirePermission } from '@/lib/rbac';

export async function GET(request: NextRequest) {
  try {
    const ctx = await requirePermission('dashboard.manage_economy');
    const { searchParams } = new URL(request.url);

    const userId = searchParams.get('user_id');
    const type = searchParams.get('type');
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '50', 10), 200);
    const offset = parseInt(searchParams.get('offset') ?? '0', 10);

    const admin = createAdminSupabase();

    let query = admin
      .from('economy_transactions')
      .select('*', { count: 'exact' })
      .eq('guild_id', ctx.guildId)
      .order('created_at', { ascending: false })
      .limit(500)
      .range(offset, offset + limit - 1);

    if (userId) query = query.eq('user_id', userId);
    if (type) query = query.eq('type', type);

    const { data, count, error } = await query;

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      data: data ?? [],
      pagination: {
        total: count ?? 0,
        limit,
        offset,
        hasMore: (offset + limit) < (count ?? 0),
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to load transactions';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
