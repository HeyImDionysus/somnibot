import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, authErrorResponse } from '@/lib/rbac';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';

export async function GET(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'standard');
  if (rateLimited) return rateLimited;

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
