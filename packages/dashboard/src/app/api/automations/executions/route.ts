/**
 * /api/automations/executions — Read-only execution log.
 *
 * GET: List recent executions, optionally filtered by automation_id.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';

const GUILD_ID = process.env.DISCORD_GUILD_ID!;

export async function GET(req: NextRequest) {
  const supabase = createAdminSupabase();
  const { searchParams } = new URL(req.url);
  const automationId = searchParams.get('automation_id');
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '50', 10), 200);

  let query = supabase
    .from('automation_executions')
    .select('*')
    .eq('guild_id', GUILD_ID)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (automationId) {
    query = query.eq('automation_id', automationId);
  }

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, data: data ?? [] });
}
