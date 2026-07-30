/**
 * GET /api/workflows/dead-letter — List dead-letter queue items.
 * POST /api/workflows/dead-letter — Retry or discard an item.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requirePermission, authErrorResponse } from '@/lib/rbac';
import { z } from 'zod';
import { parseBody } from '@/lib/api/validation';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';
import { recordAdminChange, readRowBefore } from '@/lib/admin-changes';

const deadLetterAction = z.object({
  action: z.enum(['retry', 'discard']),
  id: z.string().uuid(),
  note: z.string().max(1000).optional(),
});

export async function GET(request: NextRequest) {
  try {
    const ctx = await requirePermission('dashboard.view_workflows');
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');
    const source = searchParams.get('source');
    const page = parseInt(searchParams.get('page') || '1');
    const pageSize = parseInt(searchParams.get('pageSize') || '50');

    const admin = createAdminSupabase();
    let query = admin
      .from('dead_letter_queue')
      .select('*', { count: 'exact' })
      .eq('guild_id', ctx.guildId)
      .order('created_at', { ascending: false })
      .range((page - 1) * pageSize, page * pageSize - 1)
      .limit(1000);

    if (status) query = query.eq('status', status);
    if (source) query = query.eq('source', source);

    const { data, count, error } = await query;
    if (error) return dbError(error, 'workflows/dead-letter');

    // Summary
    const { data: allItems } = await admin
      .from('dead_letter_queue')
      .select('status, source')
      .eq('guild_id', ctx.guildId)
      .limit(1000);

    const summary = {
      total: (allItems || []).length,
      pending: (allItems || []).filter(i => i.status === 'pending').length,
      retrying: (allItems || []).filter(i => i.status === 'retrying').length,
      exhausted: (allItems || []).filter(i => i.status === 'exhausted').length,
      resolved: (allItems || []).filter(i => i.status === 'resolved').length,
      discarded: (allItems || []).filter(i => i.status === 'discarded').length,
    };

    return NextResponse.json({
      success: true,
      data,
      summary,
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
    const ctx = await requirePermission('dashboard.manage_workflows');
    const parsed = await parseBody(request, deadLetterAction);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    const admin = createAdminSupabase();

    // Prior state, read BEFORE either write — after the update every row says
    // 'retrying' or 'discarded' and the original failure is gone from view.
    const before = await readRowBefore(
      admin,
      'dead_letter_queue',
      { id: body.id, guild_id: ctx.guildId },
      'id, event_type, source, status, retry_count',
    );
    const jobLabel = before?.event_type
      ? `${String(before.source ?? 'background')} job "${String(before.event_type)}"`
      : 'failed background job';

    if (body.action === 'retry') {
      const { data, error } = await admin
        .from('dead_letter_queue')
        .update({
          status: 'retrying',
          retry_count: 0,
          last_retry_at: new Date().toISOString(),
        })
        .eq('id', body.id)
        .eq('guild_id', ctx.guildId)
        .select()
        .single();

      if (error) return dbError(error, 'workflows/dead-letter');

      // A retry re-runs the original job, whatever it did the first time —
      // this is not a bookkeeping status flip.
      await recordAdminChange({
        guildId: ctx.guildId,
        actorId: ctx.discordId,
        action: 'workflows.dead_letter_retried',
        targetType: 'failed background job',
        targetId: body.id,
        description: `Queued the failed ${jobLabel} to run again`,
        before: before
          ? { status: before.status ?? null, retry_count: before.retry_count ?? null }
          : undefined,
        after: { status: 'retrying', retry_count: 0 },
        blastRadius: 'high',
        undoReason:
          'the job is queued to run again and may already have done so, so the retry cannot be called back',
      }, admin);

      return NextResponse.json({ success: true, data });
    }

    if (body.action === 'discard') {
      const { data, error } = await admin
        .from('dead_letter_queue')
        .update({
          status: 'discarded',
          resolved_at: new Date().toISOString(),
          resolved_by: ctx.discordId,
          resolution_note: body.note || 'Manually discarded',
        })
        .eq('id', body.id)
        .eq('guild_id', ctx.guildId)
        .select()
        .single();

      if (error) return dbError(error, 'workflows/dead-letter');

      // Discarding only closes the item out — nothing re-runs, and whatever
      // the job was going to do stays undone.
      await recordAdminChange({
        guildId: ctx.guildId,
        actorId: ctx.discordId,
        action: 'workflows.dead_letter_discarded',
        targetType: 'failed background job',
        targetId: body.id,
        description:
          `Gave up on the failed ${jobLabel} and closed it without running it again`,
        before: before ? { status: before.status ?? null } : undefined,
        after: {
          status: 'discarded',
          resolution_note: body.note || 'Manually discarded',
        },
        blastRadius: 'medium',
        undoReason:
          'a discarded job is closed out for good — there is no supported way to put it back in the queue',
      }, admin);

      return NextResponse.json({ success: true, data });
    }

    if (body.action === 'resolve') {
      const { data, error } = await admin
        .from('dead_letter_queue')
        .update({
          status: 'resolved',
          resolved_at: new Date().toISOString(),
          resolved_by: ctx.discordId,
          resolution_note: body.note || 'Manually resolved',
        })
        .eq('id', body.id)
        .eq('guild_id', ctx.guildId)
        .select()
        .single();

      if (error) return dbError(error, 'workflows/dead-letter');
      return NextResponse.json({ success: true, data });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: msg === 'Unauthorized' ? 401 : 403 });
  }
}
