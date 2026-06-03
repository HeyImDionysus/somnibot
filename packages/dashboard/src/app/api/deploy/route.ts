/**
 * POST /api/deploy — Store desired state and trigger bot deployment.
 * GET /api/deploy — Get deployment status and recent actions.
 *
 * The dashboard stores the desired state in Supabase's `guild_desired_state` table.
 * Setting `applied_at = null` signals to the bot (via Realtime subscription) to deploy.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { parseBody, schemas } from '@/lib/api/validation';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';


export async function POST(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'bulk');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const parsed = await parseBody(request, schemas.deploy.action);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const admin = createAdminSupabase();

  // Validate required fields
  if (!body.roles || !body.channels) {
    return NextResponse.json(
      { error: 'Missing roles or channels' },
      { status: 400 },
    );
  }

  // Store desired state — setting applied_at = null triggers the bot
  const { error } = await admin.from('guild_desired_state').upsert(
    {
      guild_id: guildId,
      roles: body.roles,
      channels: body.channels,
      permission_map: body.permissionMap ?? {},
      applied_at: null, // This signals "needs deployment" to the bot
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'guild_id' },
  );

  if (error)
    return dbError(error, 'deploy');

  // Audit: log the deploy request
  await admin.from('audit_logs').insert({
    guild_id: guildId,
    actor_type: 'dashboard',
    actor_id: 'setup-wizard',
    action: 'deploy.requested',
    target_type: 'guild',
    target_id: guildId,
    details: {
      roleCount: body.roles.length,
      channelCount: body.channels.length,
      cleanExisting: body.cleanExisting ?? true,
    },
    success: true,
  });

  return NextResponse.json({
    success: true,
    message: 'Deploy request stored — bot will pick it up via Realtime',
  });
}

export async function GET() {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const admin = createAdminSupabase();

  // Get current desired state
  const { data: desiredState } = await admin
    .from('guild_desired_state')
    .select('*')
    .eq('guild_id', guildId)
    .single();

  // Get guild setup status
  const { data: guild } = await admin
    .from('guild')
    .select('setup_completed, setup_confirmed_at')
    .eq('id', guildId)
    .single();

  // Get recent deploy audit log entries
  const { data: recentActions } = await admin
    .from('audit_logs')
    .select('*')
    .eq('guild_id', guildId)
    .like('action', 'deploy.%')
    .order('timestamp', { ascending: false })
    .limit(20);

  return NextResponse.json({
    desiredState,
    setupCompleted: guild?.setup_completed ?? false,
    setupConfirmedAt: guild?.setup_confirmed_at ?? null,
    isDeploying: desiredState?.applied_at === null && desiredState?.roles?.length > 0,
    recentActions: recentActions ?? [],
  });
}
