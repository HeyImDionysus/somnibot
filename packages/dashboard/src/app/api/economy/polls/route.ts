import { NextResponse } from 'next/server';
import { requirePermission, authErrorResponse } from '@/lib/rbac';
import { createAdminSupabase } from '@/lib/supabase/admin';

export async function GET() {
  try {
    const ctx = await requirePermission('dashboard.manage_economy');
    const supabase = createAdminSupabase();

    const [pollsRes, predsRes] = await Promise.all([
      supabase
        .from('polls')
        .select('*')
        .eq('guild_id', ctx.guildId)
        .order('created_at', { ascending: false })
        .limit(50),
      supabase
        .from('predictions')
        .select('*')
        .eq('guild_id', ctx.guildId)
        .order('created_at', { ascending: false })
        .limit(50),
    ]);

    return NextResponse.json({
      success: true,
      polls: pollsRes.data ?? [],
      predictions: predsRes.data ?? [],
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 401 });
  }
}
