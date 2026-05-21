/**
 * /api/economy/market — Market config endpoint (no CRUD; listings are player-managed).
 *
 * GET — Returns market status (placeholder for dashboard)
 */
import { NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requirePermission } from '@/lib/rbac';

export async function GET() {
  const ctx = await requirePermission('/economy/market');
  const supabase = createAdminSupabase();

  const { count } = await supabase
    .from('economy_market_listings')
    .select('id', { count: 'exact', head: true })
    .eq('guild_id', ctx.guildId)
    .eq('status', 'active');

  return NextResponse.json({ data: { active_listings: count ?? 0 } });
}
