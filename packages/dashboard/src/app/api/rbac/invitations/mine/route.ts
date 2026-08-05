/**
 * GET /api/rbac/invitations/mine — invitations addressed to the signed-in
 * Discord identity. Unlike the owner Team list this route needs no guild role;
 * it is the dashboard discovery path used before the invitee has accepted.
 */
import { NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { getSessionIdentity } from '@/lib/team-invitations';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';

export async function GET(request: Request) {
  const rateLimited = await checkAdminRateLimit(request, 'standard');
  if (rateLimited) return rateLimited;

  const identity = await getSessionIdentity();
  if (!identity) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const admin = createAdminSupabase();
  const { data, error } = await admin
    .from('team_invitations')
    .select('id, guild_id, discord_id, role_id, status, dm_status, delivery_mode, invited_by, expires_at, created_at, dashboard_roles(name, description, priority)')
    .eq('discord_id', identity.discordId)
    .eq('status', 'pending')
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) return dbError(error, 'rbac/invitations/mine');
  return NextResponse.json({ success: true, data: data ?? [] });
}
