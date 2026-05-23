/**
 * /api/economy/heist — Read heist history + heist config is part of guild config.
 */
import { NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requirePermission, authErrorResponse } from '@/lib/rbac';

export async function GET() {
  try {
    const auth = await requirePermission('dashboard.manage_economy');
    const supabase = createAdminSupabase();

    // Get recent heists (last 50)
    const { data, error } = await supabase
      .from('economy_heists')
      .select('*, economy_heist_participants(*)')
      .eq('guild_id', auth.guildId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ data: data ?? [] });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AuthError') return authErrorResponse(err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
