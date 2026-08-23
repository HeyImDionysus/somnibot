/**
 * GET /api/admin-changes — List admin changes with undo support.
 * POST /api/admin-changes/undo — Undo a specific change.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requirePermission, authErrorResponse } from '@/lib/rbac';
import { z } from 'zod';
import { parseBody } from '@/lib/api/validation';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';
import { notifyBotForGuildWithResult } from '@/lib/notify-bot';
import {
  validateUndoPayload,
  isDiscordUndo,
  validateDiscordUndo,
} from '@/lib/api/undo-allowlist';

const undoChangeSchema = z.object({
  action: z.literal('undo'),
  id: z.string().uuid(),
});

const onboardingRevisionSchema = z.object({
  onboarding_sync_state: z.object({
    request_id: z.string().uuid(),
  }),
}).passthrough();

const onboardingUndoResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('applied'),
    sync_state: z.object({
      status: z.literal('pending'),
      managed: z.literal(true),
      request_id: z.string().uuid(),
      requested_at: z.string(),
    }).passthrough(),
    undo_record: z.object({ id: z.string().uuid() }).passthrough(),
  }),
  z.object({
    status: z.enum(['not_found', 'unavailable', 'invalid_revision', 'stale']),
  }),
]);

export async function GET(request: NextRequest) {
  try {
    const ctx = await requirePermission('dashboard.undo_changes');
    const { searchParams } = new URL(request.url);
    const targetType = searchParams.get('targetType');
    const actorId = searchParams.get('actorId');
    const undoableOnly = searchParams.get('undoable') === 'true';
    const page = parseInt(searchParams.get('page') || '1');
    const pageSize = parseInt(searchParams.get('pageSize') || '50');

    const admin = createAdminSupabase();
    let query = admin
      .from('admin_changes')
      .select('*', { count: 'exact' })
      .eq('guild_id', ctx.guildId)
      .order('created_at', { ascending: false })
      .range((page - 1) * pageSize, page * pageSize - 1)
      .limit(1000);

    if (targetType) query = query.eq('target_type', targetType);
    if (actorId) query = query.eq('actor_id', actorId);
    if (undoableOnly) query = query.eq('is_undoable', true).eq('is_undone', false);

    const { data, count, error } = await query;
    if (error) return dbError(error, 'admin-changes');

    return NextResponse.json({
      success: true,
      data,
      pagination: { page, pageSize, total: count || 0, totalPages: Math.ceil((count || 0) / pageSize) },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: msg === 'Unauthorized' ? 401 : 403 });
  }
}

export async function POST(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;

  try {
    const ctx = await requirePermission('dashboard.undo_changes');
    const parsed = await parseBody(request, undoChangeSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    const admin = createAdminSupabase();

    // Get the change to undo
    const { data: change } = await admin
      .from('admin_changes')
      .select('*')
      .eq('id', body.id)
      .eq('guild_id', ctx.guildId)
      .single();

    if (!change) return NextResponse.json({ error: 'Change not found' }, { status: 404 });
    if (!change.is_undoable) return NextResponse.json({ error: 'Change is not undoable' }, { status: 400 });
    if (change.is_undone) return NextResponse.json({ error: 'Change already undone' }, { status: 400 });

    // Apply the undo payload.
    //
    // undo_payload is read back from a stored row, so a corrupted or tampered
    // row could steer this write at a non-allowlisted table (e.g. users,
    // guild_secrets) or at columns undo never legitimately touches. Re-validate
    // the resolved table AND every column against the allowlist at APPLY time
    // and never trust the payload's own table/column names. A present-but-off-
    // list payload is rejected here, before any DB write.
    const undo = change.undo_payload;
    let onboardingSync: Record<string, unknown> | null = null;
    let onboardingWarning: string | null = null;
    let undoRecord: Record<string, unknown> | null = null;
    let auditFinalized = false;

    // Discord-side undo. The row-update path below reverses a database edit; it
    // cannot delete a role or recreate a channel, so changes the BOT made to
    // Discord carry an inverse queue action instead. Enqueue it and let the
    // bot's existing create/delete/update handlers do the work.
    //
    // guild_id comes from the authenticated session, never the stored payload,
    // so a tampered row cannot aim queued work at another guild.
    if (isDiscordUndo(undo)) {
      const discord = validateDiscordUndo(undo);
      if (!discord.ok) {
        return NextResponse.json(
          { error: `Undo blocked: ${discord.reason}` },
          { status: 400 },
        );
      }

      const { error: enqueueError } = await admin.from('bot_action_queue').insert({
        guild_id: ctx.guildId,
        action: discord.action,
        payload: discord.payload as never,
        status: 'pending',
      });
      if (enqueueError) return dbError(enqueueError, 'admin-changes');
    } else if (undo !== null && undo !== undefined) {
      const validation = validateUndoPayload(undo, { guildId: ctx.guildId });
      if (!validation.ok) {
        return NextResponse.json(
          { error: `Undo blocked: ${validation.reason}` },
          { status: 400 },
        );
      }

      // For tables with no guild column of their own (e.g.
      // product_license_config), the allowlist can't confine the write to this
      // guild synchronously. Resolve the row's owning guild through its parent
      // table and verify it against ctx.guildId BEFORE applying, so a tampered
      // undo row can't reach across tenants by naming another guild's key.
      if (validation.tenancyCheck) {
        const { foreignTable, foreignKey, keyValue, foreignGuildColumn } =
          validation.tenancyCheck;
        const { data: owner, error: ownerError } = await admin
          .from(foreignTable)
          .select(foreignGuildColumn)
          .eq(foreignKey, keyValue as string)
          .maybeSingle();

        if (ownerError) return dbError(ownerError, 'admin-changes');
        // foreignTable/foreignGuildColumn are dynamic, so the generated
        // Supabase types can't narrow the row shape; read the guild value
        // through an unknown-first cast.
        const ownerGuild =
          owner && ((owner as unknown as Record<string, unknown>)[foreignGuildColumn]);
        if (!owner || ownerGuild !== ctx.guildId) {
          return NextResponse.json(
            { error: 'Undo blocked: target does not belong to this guild' },
            { status: 400 },
          );
        }
      }

      const isOnboardingUndo = change.action === 'onboarding.updated' && validation.table === 'guild_config';
      if (isOnboardingUndo && !ctx.isOwner) {
        return NextResponse.json(
          { error: 'Only the server owner can undo onboarding changes.' },
          { status: 403 },
        );
      }
      const pendingState = isOnboardingUndo ? {
        status: 'pending',
        managed: true,
        request_id: crypto.randomUUID(),
        requested_at: new Date().toISOString(),
      } : null;
      if (pendingState) {
        const revision = onboardingRevisionSchema.safeParse(change.after_state);
        if (!revision.success) {
          return NextResponse.json(
            { error: 'Undo blocked: this onboarding change has no revision evidence.' },
            { status: 409 },
          );
        }
        const { data: undoResult, error: undoError } = await admin.rpc('undo_onboarding_change', {
          p_change_id: body.id,
          p_guild_id: ctx.guildId,
          p_actor_id: ctx.discordId,
          p_expected_request_id: revision.data.onboarding_sync_state.request_id,
          p_new_request_id: pendingState.request_id,
          p_requested_at: pendingState.requested_at,
          p_undo_data: validation.data,
        });
        if (undoError) return dbError(undoError, 'admin-changes');
        const parsedUndoResult = onboardingUndoResultSchema.safeParse(undoResult);
        if (!parsedUndoResult.success) {
          return NextResponse.json(
            { error: 'Undo failed: the database returned malformed transaction evidence.' },
            { status: 500 },
          );
        }
        if (parsedUndoResult.data.status !== 'applied') {
          return NextResponse.json(
            {
              error: parsedUndoResult.data.status === 'not_found'
                ? 'Change not found'
                : parsedUndoResult.data.status === 'unavailable'
                  ? 'Change is no longer undoable'
                  : 'Undo blocked: onboarding has changed since this revision.',
            },
            { status: 409 },
          );
        }
        onboardingSync = parsedUndoResult.data.sync_state;
        undoRecord = parsedUndoResult.data.undo_record;
        auditFinalized = true;
      } else {
        const { error: undoError } = await admin
          .from(validation.table)
          .update(validation.data)
          .match(validation.match);
        if (undoError) return dbError(undoError, 'admin-changes');
      }

      if (pendingState) {
        const queued = await notifyBotForGuildWithResult(
          ctx.guildId,
          'onboarding',
          validation.data,
          'dashboard',
          undefined,
          undefined,
          pendingState.request_id,
        );
        if (queued) {
          onboardingSync = onboardingSync ?? pendingState;
        } else {
          const failedState = {
            ...pendingState,
            status: 'failed',
            observed_at: new Date().toISOString(),
            error: 'The bot notification could not be queued after undo.',
          };
          const { error: receiptError } = await admin
            .from('guild_config')
            .update({ onboarding_sync_state: failedState })
            .eq('guild_id', ctx.guildId)
            .contains('onboarding_sync_state', { request_id: pendingState.request_id });
          if (receiptError) {
            onboardingSync = pendingState;
            onboardingWarning = 'Change undone, but Discord synchronization could not be queued and its failure receipt could not be stored.';
          } else {
            onboardingSync = failedState;
          }
        }
      }
    }

    if (!auditFinalized) {
      // V52-L2: add guild_id filter for defense-in-depth
      const { error: updateError } = await admin
        .from('admin_changes')
        .update({
          is_undone: true,
          undone_at: new Date().toISOString(),
          undone_by: ctx.discordId,
        })
        .eq('id', body.id)
        .eq('guild_id', ctx.guildId);

      if (updateError) return dbError(updateError, 'admin-changes');

      const { data: insertedUndoRecord } = await admin
        .from('admin_changes')
        .insert({
          guild_id: ctx.guildId,
          actor_id: ctx.discordId,
          action: `undo:${change.action}`,
          target_type: change.target_type,
          target_id: change.target_id,
          description: `Undid: ${change.description}`,
          before_state: change.after_state,
          after_state: change.before_state,
          undo_payload: null,
          is_undoable: false,
          blast_radius: change.blast_radius,
        })
        .select()
        .single();
      undoRecord = insertedUndoRecord;

      if (undoRecord && typeof undoRecord.id === 'string') {
        await admin
          .from('admin_changes')
          .update({ undo_change_id: undoRecord.id })
          .eq('id', body.id)
          .eq('guild_id', ctx.guildId);
      }
    }

    return NextResponse.json({
      success: true,
      data: { undone: change, undoRecord, ...(onboardingSync ? { onboardingSync } : {}) },
      ...(onboardingWarning
        ? { warning: onboardingWarning }
        : onboardingSync?.status === 'failed'
          ? { warning: 'Change undone, but Discord synchronization could not be queued.' }
          : {}),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: msg === 'Unauthorized' ? 401 : 403 });
  }
}
