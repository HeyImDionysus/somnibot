/**
 * /api/tickets/transcripts — List and view ticket transcripts.
 *
 * GET: List transcripts or get a specific one by ticket_id
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';


export async function GET(req: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const { searchParams } = new URL(req.url);
  const ticketId = searchParams.get('ticket_id');
  const ticketNumber = searchParams.get('ticket_number');
  const limit = parseInt(searchParams.get('limit') || '50', 10);
  const offset = parseInt(searchParams.get('offset') || '0', 10);

  // Get a specific transcript
  if (ticketId) {
    const { data, error } = await supabase
      .from('ticket_transcripts')
      .select('*')
      .eq('guild_id', guildId)
      .eq('ticket_id', ticketId)
      .single();

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, data });
  }

  if (ticketNumber) {
    const { data, error } = await supabase
      .from('ticket_transcripts')
      .select('*')
      .eq('guild_id', guildId)
      .eq('ticket_number', parseInt(ticketNumber, 10))
      .single();

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, data });
  }

  // List transcripts (without html_content for performance)
  const search = searchParams.get('search');
  let query = supabase
    .from('ticket_transcripts')
    .select('id, guild_id, ticket_id, ticket_number, creator_id, closed_by_id, message_count, participant_ids, created_at', { count: 'exact' })
    .eq('guild_id', guildId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  // V53 Phase 3: Search by ticket number
  if (search) {
    const parsed = parseInt(search, 10);
    if (!isNaN(parsed)) {
      query = query.eq('ticket_number', parsed);
    }
  }

  const { data, error, count } = await query;

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, data: data ?? [], total: count ?? 0 });
}
