/**
 * /api/sync/action — POST repair/accept/ignore actions on drift items.
 *
 * The dashboard sends the action + drift item. Actions that require
 * Discord state/API calls are queued in bot_action_queue for the bot.
 * Ignore/clear_all can update Supabase directly.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { parseBody, schemas } from '@/lib/api/validation';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';


interface DriftActionRequest {
  action: 'repair' | 'accept' | 'ignore' | 'clear_all';
  driftItem?: {
    entityType: string;
    entityName: string;
    entityDiscordId?: string;
    type: string;
    severity?: 'critical' | 'warning' | 'info';
    description?: string;
    details?: Record<string, { expected: unknown; actual: unknown }>;
    suggestedAction?: 'repair' | 'accept' | 'ignore';
    templateKey?: string;
    template_key?: string;
  };
}

type QueuedSyncAction = 'repair' | 'accept';

function isPermissionOverwriteDrift(
  driftItem: DriftActionRequest['driftItem'] | null | undefined,
): boolean {
  return driftItem?.type === 'PERMISSION_DRIFT' &&
    (driftItem.entityType === 'channel' || driftItem.entityType === 'category');
}

function stringDetail(
  driftItem: NonNullable<DriftActionRequest['driftItem']>,
  key: string,
): string | undefined {
  const detail = driftItem.details?.[key];
  const actual = detail?.actual;
  const expected = detail?.expected;
  if (typeof actual === 'string' && actual.trim()) return actual.trim();
  if (typeof expected === 'string' && expected.trim()) return expected.trim();
  return undefined;
}

function hasStructuredPermissionOverwriteDetails(
  driftItem: NonNullable<DriftActionRequest['driftItem']>,
): boolean {
  if (driftItem.entityType !== 'channel') return false;
  const channelId = driftItem.entityDiscordId;
  const channelKey = driftItem.templateKey ?? driftItem.template_key ?? stringDetail(driftItem, 'overrideChannelKey');
  const roleKey = stringDetail(driftItem, 'overrideRoleKey');
  const roleId = stringDetail(driftItem, 'overrideRoleId');
  return Boolean(
    channelId &&
    channelKey &&
    roleKey &&
    (roleId || roleKey === 'everyone'),
  );
}

function toBotQueueAction(action: QueuedSyncAction): string {
  return action === 'repair' ? 'sync_repair_drift' : 'sync_accept_drift';
}

async function queueBotSyncAction(
  supabase: ReturnType<typeof createAdminSupabase>,
  guildId: string,
  action: QueuedSyncAction,
  driftItem: NonNullable<DriftActionRequest['driftItem']>,
) {
  return supabase
    .from('bot_action_queue')
    .insert({
      guild_id: guildId,
      action: toBotQueueAction(action),
      payload: { driftItem },
      status: 'pending',
      created_at: new Date().toISOString(),
    })
    .select('id')
    .single();
}

export async function POST(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'bulk');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const parsed = await parseBody(req, schemas.sync.action);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data as DriftActionRequest;

  if (!body.action) {
    return NextResponse.json(
      { success: false, error: 'Missing action' },
      { status: 400 },
    );
  }

  // Clear all drift
  if (body.action === 'clear_all') {
    const { error } = await supabase
      .from('guild_desired_state')
      .update({
        drift_detected: false,
        drift_details: [],
        last_sync_at: new Date().toISOString(),
      })
      .eq('guild_id', guildId);

    if (error) {
      return dbError(error, 'sync/action');
    }

    return NextResponse.json({ success: true });
  }

  if (!body.driftItem) {
    return NextResponse.json(
      { success: false, error: 'Missing driftItem' },
      { status: 400 },
    );
  }

  if (
    body.action === 'accept' &&
    isPermissionOverwriteDrift(body.driftItem) &&
    !hasStructuredPermissionOverwriteDetails(body.driftItem)
  ) {
    return NextResponse.json(
      {
        success: false,
        error: `${body.driftItem.entityType} permission drift accept requires structured permission overwrite details`,
      },
      { status: 400 },
    );
  }

  // For 'ignore' — just remove from drift list
  if (body.action === 'ignore') {
    const { data: current } = await supabase
      .from('guild_desired_state')
      .select('drift_details')
      .eq('guild_id', guildId)
      .maybeSingle();

    const items = Array.isArray(current?.drift_details) ? current.drift_details : [];
    const filtered = items.filter(
      (i: Record<string, unknown>) =>
        !(
          i.entityType === body.driftItem!.entityType &&
          i.entityName === body.driftItem!.entityName
        ),
    );

    await supabase
      .from('guild_desired_state')
      .update({
        drift_detected: filtered.length > 0,
        drift_details: filtered,
      })
      .eq('guild_id', guildId);

    return NextResponse.json({ success: true });
  }

  // For 'accept' — queue for the bot so desired state can be updated from Discord.
  if (body.action === 'accept') {
    const { data, error } = await queueBotSyncAction(supabase, guildId, body.action, body.driftItem);
    if (error) return dbError(error, 'sync/action');

    return NextResponse.json(
      { success: true, actionId: data?.id ?? null, message: 'Accept action queued for bot execution' },
      { status: 202 },
    );
  }

  // For 'repair' — queue action for the bot to execute through its durable queue.
  const { data, error } = await queueBotSyncAction(supabase, guildId, body.action, body.driftItem);
  if (error) return dbError(error, 'sync/action');

  return NextResponse.json(
    { success: true, actionId: data?.id ?? null, message: 'Repair action queued for bot execution' },
    { status: 202 },
  );
}
