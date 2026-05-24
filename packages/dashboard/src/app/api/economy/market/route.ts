/**
 * /api/economy/market — Market config endpoint (no CRUD; listings are player-managed).
 *
 * GET — Returns market status (placeholder for dashboard)
 */
import { NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requirePermission, authErrorResponse } from '@/lib/rbac';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';

export async function GET(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'standard');
  if (rateLimited) return rateLimited;

  try {
    const ctx = await requirePermission('dashboard.manage_economy');
    const supabase = createAdminSupabase();

    const { count } = await supabase
      .from('economy_market_listings')
      .select('id', { count: 'exact', head: true })
      .eq('guild_id', ctx.guildId)
      .eq('status', 'active')
      .limit(500);

    return NextResponse.json({ data: { active_listings: count ?? 0 } });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AuthError') return authErrorResponse(err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
