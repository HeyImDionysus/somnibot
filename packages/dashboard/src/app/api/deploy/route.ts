/**
 * POST /api/deploy — Store a reviewed plan and trigger an explicit deployment.
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
import { recordAdminChange } from '@/lib/admin-changes';
import { z } from 'zod';

const deployRequestResultSchema = z.discriminatedUnion('disposition', [
  z.object({
    disposition: z.literal('accepted'),
    state: z.object({
      deploy_request_id: z.string().uuid(),
      deploy_status: z.literal('requested'),
    }).passthrough(),
  }),
  z.object({
    disposition: z.literal('busy'),
    status: z.string(),
  }),
]);

export async function POST(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'bulk');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId, discordId } = auth.ctx;

  const parsed = await parseBody(request, schemas.deploy.action);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const admin = createAdminSupabase();

  if (!body.roles || !body.channels) {
    return NextResponse.json(
      { error: 'Missing roles or channels' },
      { status: 400 },
    );
  }

  // What the guild was set to deploy BEFORE this request replaced it. Only
  // the shape is kept (how many roles/channels, and whether the previous plan
  // had finished applying) — the full role/channel plan can be thousands of
  // lines of JSON and the change log is not a backup of it.
  const { data: priorState, error: priorStateError } = await admin
    .from('guild_desired_state')
    .select('guild_id, roles, channels, categories, applied_at, deploy_mode, deploy_request_id, deploy_status')
    .eq('guild_id', guildId)
    .maybeSingle();
  if (priorStateError) return dbError(priorStateError, 'deploy');
  if (priorState?.deploy_status === 'requested' || priorState?.deploy_status === 'running') {
    return NextResponse.json(
      { error: 'A server deployment is already requested or running' },
      { status: 409 },
    );
  }
  const priorRoles = Array.isArray(priorState?.roles) ? priorState.roles.length : null;
  const priorChannels = Array.isArray(priorState?.channels) ? priorState.channels.length : null;
  const categories = body.categories
    ?? (Array.isArray(priorState?.categories) ? priorState.categories : []);

  const deployMode = body.deployMode;
  const requestId = crypto.randomUUID();
  const requestedAt = new Date().toISOString();
  const { data: requestResultData, error } = await admin.rpc('request_server_deployment', {
    p_guild_id: guildId,
    p_request_id: requestId,
    p_roles: body.roles,
    p_channels: body.channels,
    p_categories: categories,
    p_permission_map: body.permissionMap ?? {},
    p_deploy_mode: deployMode,
    p_requested_at: requestedAt,
  });

  if (error) return dbError(error, 'deploy');
  const parsedRequestResult = deployRequestResultSchema.safeParse(requestResultData);
  if (!parsedRequestResult.success) {
    return NextResponse.json(
      { error: 'Deployment request persistence returned an invalid result' },
      { status: 500 },
    );
  }
  if (parsedRequestResult.data.disposition === 'busy') {
    return NextResponse.json(
      { error: 'A server deployment is already requested or running' },
      { status: 409 },
    );
  }

  // Audit: log the deploy request
  await admin.from('audit_logs').insert({
    guild_id: guildId,
    actor_type: 'dashboard',
    actor_id: auth.ctx.discordId,
    action: 'deploy.requested',
    target_type: 'guild',
    target_id: guildId,
    details: {
      roleCount: body.roles.length,
      channelCount: body.channels.length,
      categoryCount: categories.length,
      deployMode,
      requestId,
    },
    success: true,
  });

  // A deploy is the single most far-reaching thing this dashboard can do: the
  // bot's deploy listener watches guild_desired_state for `applied_at = null`
  // and then creates, edits and (with cleanExisting) DELETES real Discord roles
  // and channels. There is deliberately no `undo` — no db row update and no
  // allowlisted queue action can put a deleted channel and its message history
  // back, and offering a button that pretends otherwise would be the worst
  // possible lie on this page.
  await recordAdminChange({
    guildId,
    actorId: discordId,
    action: 'deploy.requested',
    targetType: 'server deployment',
    targetId: guildId,
    description:
      `Started a server deployment of ${body.roles.length} roles and `
      + `${body.channels.length} channels`
      + (deployMode === 'destructive'
        ? ', replacing existing non-managed roles and channels'
        : ', reconciling only SomniBot-managed roles and channels'),
    before: priorRoles === null && priorChannels === null
      ? undefined
      : {
          role_count: priorRoles,
          channel_count: priorChannels,
          previous_deploy_applied_at: priorState?.applied_at ?? null,
        },
    after: {
      role_count: body.roles.length,
      channel_count: body.channels.length,
      category_count: categories.length,
      deploy_mode: deployMode,
      deploy_request_id: requestId,
    },
    blastRadius: 'critical',
    undoReason:
      'the bot applies deployments directly to Discord — roles and channels it creates or deletes cannot be restored from here',
  }, admin);

  return NextResponse.json({
    success: true,
    message: 'Deploy request stored — bot will pick it up via Realtime',
    deployMode,
    requestId,
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
    isDeploying: desiredState?.deploy_status === 'requested'
      || desiredState?.deploy_status === 'running',
    recentActions: recentActions ?? [],
  });
}
