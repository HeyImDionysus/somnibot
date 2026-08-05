/**
 * GET /api/rbac/invitations/mine — invitations addressed to the signed-in
 * Discord identity. Unlike the owner Team list this route needs no guild role;
 * it is the dashboard discovery path used before the invitee has accepted.
 */
import { NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireAuth } from '@/lib/api/require-owner';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';

export async function GET(request: Request) {
  const rateLimited = await checkAdminRateLimit(request, 'standard');
  if (rateLimited) return rateLimited;

  const auth = await requireAuth();
  if (!auth.ok) return auth.response;
  if (!auth.discordId) {
    return NextResponse.json({ error: 'Discord identity unavailable' }, { status: 403 });
  }

  const admin = createAdminSupabase();
  const { data, error } = await admin
    .from('team_invitations')
    .select('id, guild_id, discord_id, role_id, status, dm_status, delivery_mode, invited_by, expires_at, created_at, dashboard_roles(name, description, priority)')
    .eq('discord_id', auth.discordId)
    .eq('status', 'pending')
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) return dbError(error, 'rbac/invitations/mine');
  return NextResponse.json({ success: true, data: data ?? [] });
}
