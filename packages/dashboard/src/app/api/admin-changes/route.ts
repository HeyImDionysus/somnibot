/**
 * GET /api/admin-changes — List admin changes with undo support.
 * POST /api/admin-changes/undo — Undo a specific change.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requirePermission } from '@/lib/rbac';
import { z } from 'zod';
import { parseBody } from '@/lib/api/validation';

const undoChangeSchema = z.object({
  action: z.literal('undo'),
  id: z.string().uuid(),
});

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
      .range((page - 1) * pageSize, page * pageSize - 1);

    if (targetType) query = query.eq('target_type', targetType);
    if (actorId) query = query.eq('actor_id', actorId);
    if (undoableOnly) query = query.eq('is_undoable', true).eq('is_undone', false);

    const { data, count, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

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

    // Apply the undo payload
    const undo = change.undo_payload as Record<string, unknown> | null;
    if (undo?.table && undo?.data && undo?.match) {
      const { error: undoError } = await admin
        .from(undo.table as string)
        .update(undo.data as Record<string, unknown>)
        .match(undo.match as Record<string, unknown>);

      if (undoError) return NextResponse.json({ error: `Undo failed: ${undoError.message}` }, { status: 500 });
    }

    // Mark as undone
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

    if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

    // Create a reverse change record
    const { data: undoRecord } = await admin
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

    // Link the undo record
    if (undoRecord) {
      // V52-L2: add guild_id filter for defense-in-depth
      await admin
        .from('admin_changes')
        .update({ undo_change_id: undoRecord.id })
        .eq('id', body.id)
        .eq('guild_id', ctx.guildId);
    }

    return NextResponse.json({ success: true, data: { undone: change, undoRecord } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: msg === 'Unauthorized' ? 401 : 403 });
  }
}
