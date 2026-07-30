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
import { recordAdminChange } from '@/lib/admin-changes';


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

/**
 * Record a repair/accept that has been handed to the bot.
 *
 * Both branches enqueue on `bot_action_queue`, which means the work is out of
 * the dashboard's hands the instant the row lands — the bot may run it before
 * anyone looks at the Admin Changes page. There is deliberately no `undo`:
 * `sync_repair_drift` / `sync_accept_drift` are not reversible queue actions
 * (only the structural create/delete/update role-channel-category pairs are),
 * and an "undo" that re-queued more Discord work would be a second change
 * dressed up as a reversal.
 */
async function recordQueuedDriftAction(
  supabase: ReturnType<typeof createAdminSupabase>,
  args: {
    guildId: string;
    discordId: string;
    action: QueuedSyncAction;
    driftItem: NonNullable<DriftActionRequest['driftItem']>;
    queuedId: string | null;
  },
): Promise<void> {
  const { entityName, entityType } = args.driftItem;
  await recordAdminChange({
    guildId: args.guildId,
    actorId: args.discordId,
    action: args.action === 'repair' ? 'sync.drift_repair_queued' : 'sync.drift_accept_queued',
    targetType: `${entityType} drift`,
    targetId: args.driftItem.entityDiscordId ?? null,
    description: args.action === 'repair'
      ? `Asked the bot to change the "${entityName}" ${entityType} in Discord back to the saved setup`
      : `Asked the bot to treat the current "${entityName}" ${entityType} in Discord as the saved setup`,
    before: { drift_type: args.driftItem.type, severity: args.driftItem.severity ?? null },
    after: { queued_action_id: args.queuedId, decision: args.action },
    // A repair rewrites live Discord state; an accept only rewrites the saved
    // desired state the next scan compares against.
    blastRadius: args.action === 'repair' ? 'high' : 'medium',
    undoReason: args.action === 'repair'
      ? 'the bot may already have applied this repair to Discord, so it cannot be called back — run a fresh sync to see the current state'
      : 'the saved setup has been queued to match Discord and the bot may already have rewritten it; re-deploy the setup you want instead',
  }, supabase);
}

export async function POST(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'bulk');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId, discordId } = auth.ctx;

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
    // How much was on the list BEFORE it was emptied — read first, because
    // after the update the answer is always zero.
    const { data: priorDrift } = await supabase
      .from('guild_desired_state')
      .select('drift_details')
      .eq('guild_id', guildId)
      .maybeSingle();
    const priorCount = Array.isArray(priorDrift?.drift_details)
      ? priorDrift.drift_details.length
      : null;

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

    await recordAdminChange({
      guildId,
      actorId: discordId,
      action: 'sync.drift_cleared',
      targetType: 'configuration drift list',
      targetId: guildId,
      description: priorCount === null
        ? 'Cleared the configuration-drift list'
        : `Dismissed all ${priorCount} configuration-drift items without changing Discord`,
      before: { drift_count: priorCount },
      after: { drift_count: 0 },
      blastRadius: 'low',
      undoReason:
        'the drift list is rebuilt from scratch by the next sync scan, so clearing it is not something an undo can put back',
    }, supabase);

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

    // NOTE: this update's error is still swallowed (pre-existing — the route
    // returns success either way). It is captured here only so a change that
    // did not land is never recorded as if it had.
    const { error: ignoreError } = await supabase
      .from('guild_desired_state')
      .update({
        drift_detected: filtered.length > 0,
        drift_details: filtered,
      })
      .eq('guild_id', guildId);

    if (!ignoreError) {
      await recordAdminChange({
        guildId,
        actorId: discordId,
        action: 'sync.drift_ignored',
        targetType: 'configuration drift item',
        targetId: body.driftItem.entityDiscordId ?? null,
        description:
          `Dismissed the drift reported on the "${body.driftItem.entityName}" `
          + `${body.driftItem.entityType} without changing Discord`,
        before: { drift_count: items.length },
        after: { drift_count: filtered.length },
        blastRadius: 'low',
        undoReason:
          'the drift list is rebuilt by the next sync scan — run a sync to bring the item back if it still differs',
      }, supabase);
    }

    return NextResponse.json({ success: true });
  }

  // For 'accept' — queue for the bot so desired state can be updated from Discord.
  if (body.action === 'accept') {
    const { data, error } = await queueBotSyncAction(supabase, guildId, body.action, body.driftItem);
    if (error) return dbError(error, 'sync/action');

    await recordQueuedDriftAction(supabase, {
      guildId,
      discordId,
      action: 'accept',
      driftItem: body.driftItem,
      queuedId: data?.id ?? null,
    });

    return NextResponse.json(
      { success: true, actionId: data?.id ?? null, message: 'Accept action queued for bot execution' },
      { status: 202 },
    );
  }

  // For 'repair' — queue action for the bot to execute through its durable queue.
  const { data, error } = await queueBotSyncAction(supabase, guildId, body.action, body.driftItem);
  if (error) return dbError(error, 'sync/action');

  await recordQueuedDriftAction(supabase, {
    guildId,
    discordId,
    action: 'repair',
    driftItem: body.driftItem,
    queuedId: data?.id ?? null,
  });

  return NextResponse.json(
    { success: true, actionId: data?.id ?? null, message: 'Repair action queued for bot execution' },
    { status: 202 },
  );
}
