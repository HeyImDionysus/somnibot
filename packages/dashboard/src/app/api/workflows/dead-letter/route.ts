/**
 * GET /api/workflows/dead-letter — List dead-letter queue items.
 * POST /api/workflows/dead-letter — Retry or discard an item.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requirePermission } from '@/lib/rbac';
import { z } from 'zod';
import { parseBody } from '@/lib/api/validation';

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
      .range((page - 1) * pageSize, page * pageSize - 1);

    if (status) query = query.eq('status', status);
    if (source) query = query.eq('source', source);

    const { data, count, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Summary
    const { data: allItems } = await admin
      .from('dead_letter_queue')
      .select('status, source')
      .eq('guild_id', ctx.guildId);

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
  try {
    const ctx = await requirePermission('dashboard.manage_workflows');
    const parsed = await parseBody(request, deadLetterAction);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    const admin = createAdminSupabase();

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

      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
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

      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
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

      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ success: true, data });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: msg === 'Unauthorized' ? 401 : 403 });
  }
}
