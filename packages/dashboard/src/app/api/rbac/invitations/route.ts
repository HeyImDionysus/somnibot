/**
 * GET /api/rbac/invitations — List dashboard-team invitations for the guild.
 *
 * Returns pending invitations by default (the Team page's "Pending Invitations"
 * section) and, when `?include=all`, the recent resolved history too. Creation
 * flows through POST /api/rbac/users (consent model); acceptance/revocation have
 * their own routes.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requirePermission } from '@/lib/rbac';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';

export async function GET(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'standard');
  if (rateLimited) return rateLimited;

  try {
    const ctx = await requirePermission('dashboard.manage_team');
    const admin = createAdminSupabase();

    const { searchParams } = new URL(request.url);
    const includeAll = searchParams.get('include') === 'all';

    let query = admin
      .from('team_invitations')
      .select(
        'id, discord_id, role_id, status, dm_status, delivery_mode, invited_by, expires_at, accepted_at, responded_at, created_at, dashboard_roles(name, description, priority)',
      )
      .eq('guild_id', ctx.guildId)
      .order('created_at', { ascending: false })
      .limit(200);

    if (!includeAll) {
      query = query.eq('status', 'pending');
    }

    const { data, error } = await query;
    if (error) return dbError(error, 'rbac/invitations');

    return NextResponse.json({ success: true, data: data ?? [] });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: msg === 'Unauthorized' ? 401 : 403 });
  }
}
