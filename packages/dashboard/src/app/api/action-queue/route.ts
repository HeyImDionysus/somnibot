/**
 * /api/action-queue — DLQ (Dead Letter Queue) management.
 *
 * GET:   List DLQ entries for the guild (paginated)
 * POST:  Retry or acknowledge DLQ entries
 *
 * V53 Phase 2 (Finding 2.3)
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { parseBody } from '@/lib/api/validation';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';
import { recordAdminChange } from '@/lib/admin-changes';

/** "1 failed bot action" / "3 failed bot actions". */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

const actionQueuePostSchema = z.object({
  action: z.enum(['acknowledge', 'retry']),
  ids: z.array(z.string().uuid())
    .min(1, 'At least one id is required')
    .max(1000, 'At most 1000 ids may be processed at once')
    .refine(
      (ids) => new Set(ids).size === ids.length,
      'Every id must be unique',
    ),
});

const exactRoleDeliveryCarrierActions = new Set([
  'fulfill_purchase',
  'fulfill_subscription',
  'reconcile_entitlement_roles',
]);

type ExactRoleDeliveryRetryDisposition =
  | 'reopened'
  | 'already_active'
  | 'completed_from_evidence'
  | 'operator_held';

type GenericRetryDisposition =
  | 'requeued'
  | 'reopened'
  | 'already_active'
  | 'already_completed'
  | 'already_retried'
  | 'exact_carrier_required'
  | 'invalid_carrier';

function parseGenericRetry(value: unknown): {
  actionId: string | null;
  actionStatus: 'pending' | 'processing' | 'completed' | null;
  disposition: GenericRetryDisposition;
} | null {
  if (!Array.isArray(value) || value.length !== 1) return null;
  const row = value[0];
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const evidence = row as Record<string, unknown>;
  if (
    typeof evidence.disposition !== 'string'
    || ![
      'requeued',
      'reopened',
      'already_active',
      'already_completed',
      'already_retried',
      'exact_carrier_required',
      'invalid_carrier',
    ].includes(evidence.disposition)
  ) {
    return null;
  }
  const disposition = evidence.disposition as GenericRetryDisposition;
  if (
    disposition === 'requeued'
    || disposition === 'reopened'
    || disposition === 'already_active'
    || disposition === 'already_completed'
  ) {
    if (
      typeof evidence.action_id !== 'string'
      || !z.string().uuid().safeParse(evidence.action_id).success
    ) {
      return null;
    }
    const combinationMatches =
      ((disposition === 'requeued' || disposition === 'reopened')
        && evidence.action_status === 'pending')
      || (disposition === 'already_active'
        && (evidence.action_status === 'pending' || evidence.action_status === 'processing'))
      || (disposition === 'already_completed' && evidence.action_status === 'completed');
    if (!combinationMatches) return null;
    return {
      actionId: evidence.action_id,
      actionStatus: evidence.action_status as 'pending' | 'processing' | 'completed',
      disposition,
    };
  }
  if (evidence.action_id !== null || evidence.action_status !== null) return null;
  return { actionId: null, actionStatus: null, disposition };
}

function parseExactRoleDeliveryRetry(
  value: unknown,
  expectedActionId: string,
): {
  actionId: string;
  actionStatus: 'staged' | 'pending' | 'processing' | 'completed' | 'failed';
  disposition: ExactRoleDeliveryRetryDisposition;
} | null {
  if (!Array.isArray(value) || value.length !== 1) return null;
  const row = value[0];
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const evidence = row as Record<string, unknown>;
  if (
    typeof evidence.action_id !== 'string'
    || evidence.action_id !== expectedActionId
    || !z.string().uuid().safeParse(evidence.action_id).success
    || typeof evidence.action_status !== 'string'
    || !['staged', 'pending', 'processing', 'completed', 'failed'].includes(
      evidence.action_status,
    )
    || typeof evidence.disposition !== 'string'
    || ![
      'reopened',
      'already_active',
      'completed_from_evidence',
      'operator_held',
    ].includes(evidence.disposition)
  ) {
    return null;
  }
  const disposition = evidence.disposition as ExactRoleDeliveryRetryDisposition;
  const combinationMatches =
    (disposition === 'reopened' && evidence.action_status === 'pending')
    || (disposition === 'already_active'
      && (evidence.action_status === 'pending' || evidence.action_status === 'processing'))
    || (disposition === 'completed_from_evidence'
      && evidence.action_status === 'completed')
    || (disposition === 'operator_held'
      && ['staged', 'pending', 'processing', 'failed'].includes(evidence.action_status));
  if (!combinationMatches) return null;
  return {
    actionId: evidence.action_id,
    actionStatus: evidence.action_status as (
      'staged' | 'pending' | 'processing' | 'completed' | 'failed'
    ),
    disposition,
  };
}

export async function GET(request: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10));
  const pageSize = Math.min(50, Math.max(1, parseInt(url.searchParams.get('pageSize') ?? '20', 10)));
  const filter = url.searchParams.get('filter') ?? 'pending'; // 'pending' | 'acknowledged' | 'retried' | 'all'

  const supabase = createAdminSupabase();

  let query = supabase
    .from('action_queue_dlq')
    .select('*', { count: 'exact' })
    .eq('guild_id', guildId)
    .order('failed_at', { ascending: false })
    .limit(500);

  if (filter === 'pending') {
    query = query.eq('acknowledged', false).eq('retried', false);
  } else if (filter === 'acknowledged') {
    query = query.eq('acknowledged', true);
  } else if (filter === 'retried') {
    query = query.eq('retried', true);
  }
  // 'all' = no extra filter

  const from = (page - 1) * pageSize;
  query = query.range(from, from + pageSize - 1);

  const { data, count, error } = await query;

  if (error) {
    return dbError(error, 'action-queue');
  }

  return NextResponse.json({
    success: true,
    data: {
      items: data ?? [],
      pagination: {
        page,
        pageSize,
        total: count ?? 0,
        totalPages: Math.ceil((count ?? 0) / pageSize),
      },
    },
  });
}

export async function POST(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId, discordId } = auth.ctx;

  const parsed = await parseBody(request, actionQueuePostSchema);
  if (!parsed.ok) return parsed.response;
  const { action, ids } = parsed.data;

  const supabase = createAdminSupabase();

  if (action === 'acknowledge') {
    const { error } = await supabase
      .from('action_queue_dlq')
      .update({
        acknowledged: true,
        acknowledged_at: new Date().toISOString(),
      })
      .eq('guild_id', guildId)
      .in('id', ids);

    if (error) {
      return dbError(error, 'action-queue');
    }

    await recordAdminChange({
      guildId,
      actorId: discordId,
      action: 'action_queue.dlq_acknowledged',
      targetType: 'failed bot actions',
      targetId: ids.length === 1 ? ids[0]! : null,
      description:
        `Marked ${plural(ids.length, 'failed bot action')} as acknowledged, `
        + 'clearing them from the failures list',
      before: { acknowledged: false },
      after: { acknowledged: true, ids },
      blastRadius: 'low',
      undoReason:
        'acknowledging only hides the failures from the pending list; there is no supported way to mark them unacknowledged again',
    }, supabase);

    return NextResponse.json({ success: true, acknowledged: ids.length });
  }

  if (action === 'retry') {
    // Fetch tenant-scoped metadata only to select the correct atomic retry
    // protocol. The RPCs below remain the mutation authority.
    const { data: dlqItems, error: fetchErr } = await supabase
      .from('action_queue_dlq')
      .select('id, guild_id, action, original_id')
      .eq('guild_id', guildId)
      .in('id', ids)
      .or('retried.eq.false,retried.is.null')
      .limit(1000);

    if (fetchErr) {
      return dbError(fetchErr, 'action-queue');
    }

    const requestedIds = new Set(ids);
    const dlqItemsById = new Map<string, NonNullable<typeof dlqItems>[number]>();
    for (const item of dlqItems ?? []) {
      if (
        typeof item.id === 'string'
        && requestedIds.has(item.id)
        && item.guild_id === guildId
        && !dlqItemsById.has(item.id)
      ) {
        dlqItemsById.set(item.id, item);
      }
    }

    let retried = 0;
    let operatorHeld = 0;
    // Missing rows include wrong-guild, already-retried, and otherwise
    // unavailable ids. Deliberately do not distinguish them in the response.
    let failed = ids.length - dlqItemsById.size;
    for (const item of dlqItemsById.values()) {
      if (typeof item.action !== 'string' || item.action.length === 0) {
        failed++;
        continue;
      }
      if (exactRoleDeliveryCarrierActions.has(item.action)) {
        // Exact paid-role actions embed and/or bind their queue id as durable
        // protocol identity. A cloned row would corrupt the carrier and can
        // never resume cleanup/reconciliation safely. The SQL RPC reopens (or
        // converges) that same row and atomically retires its prior DLQ entry.
        const expectedActionId = typeof item.original_id === 'string'
          ? item.original_id
          : '';
        if (!z.string().uuid().safeParse(expectedActionId).success) {
          failed++;
          continue;
        }
        const { data: recoveryData, error: recoveryError } = await (
          supabase.rpc as (
            fn: string,
            params: Record<string, unknown>,
          ) => ReturnType<typeof supabase.rpc>
        )('commerce_retry_role_delivery_dlq', {
          p_dlq_id: item.id,
          p_guild_id: guildId,
        });
        if (recoveryError) {
          failed++;
          continue;
        }
        const recovery = parseExactRoleDeliveryRetry(
          recoveryData,
          expectedActionId,
        );
        if (!recovery) {
          failed++;
          continue;
        }
        if (recovery.disposition === 'operator_held') {
          operatorHeld++;
        } else {
          retried++;
        }
        continue;
      }

      // Generic retries are also one atomic server-side transaction. The RPC
      // locks and rechecks the DLQ row, inserts one replacement, and marks the
      // source retried; concurrent/replayed callers receive an opaque no-op.
      const { data: retryData, error: retryError } = await (
        supabase.rpc as (
          fn: string,
          params: Record<string, unknown>,
        ) => ReturnType<typeof supabase.rpc>
      )('bot_action_queue_retry_dlq', {
        p_dlq_id: item.id,
        p_guild_id: guildId,
      });
      const retry = retryError ? null : parseGenericRetry(retryData);
      if (
        retry
        && [
          'requeued',
          'reopened',
          'already_active',
          'already_completed',
        ].includes(retry.disposition)
      ) {
        retried++;
      } else {
        failed++;
      }
    }

    // Only a retry that actually re-opened work changed anything. A batch where
    // every id failed or was operator-held left the queue exactly as it was,
    // and recording it would put a change on the page that never happened.
    if (retried > 0) {
      await recordAdminChange({
        guildId,
        actorId: discordId,
        action: 'action_queue.dlq_retried',
        targetType: 'failed bot actions',
        targetId: null,
        description:
          `Sent ${plural(retried, 'failed bot action')} back to the bot to run again`
          + (operatorHeld > 0 ? `, held ${operatorHeld} for review` : '')
          + (failed > 0 ? `, and could not retry ${failed}` : ''),
        before: { status: 'failed' },
        after: { retried, operatorHeld, failed },
        // The bot picks these up and performs real work — role grants,
        // fulfilment, notifications.
        blastRadius: 'high',
        undoReason:
          'the bot may already have run the retried actions, so they cannot be pulled back — check the action queue for what they did',
      }, supabase);
    }

    return NextResponse.json({
      success: failed === 0 && operatorHeld === 0,
      retried,
      operatorHeld,
      failed,
    }, { status: failed === 0 && operatorHeld === 0 ? 200 : 409 });
  }

  return NextResponse.json(
    { success: false, error: `Unknown action: ${action}` },
    { status: 400 },
  );
}
