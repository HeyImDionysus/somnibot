/**
 * /api/sync/config — PUT sync engine configuration.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';

const GUILD_ID = process.env.DISCORD_GUILD_ID!;

export async function PUT(req: NextRequest) {
  const supabase = createAdminSupabase();
  const body = await req.json();

  const allowed: Record<string, unknown> = {};
  const fields = [
    'sync_enabled', 'sync_interval_minutes',
    'sync_auto_repair', 'sync_auto_repair_everyone',
  ];

  for (const key of fields) {
    if (key in body) allowed[key] = body[key];
  }

  // Validate interval
  if ('sync_interval_minutes' in allowed && typeof allowed.sync_interval_minutes === 'number') {
    const val = allowed.sync_interval_minutes as number;
    if (val < 5) allowed.sync_interval_minutes = 5;
    if (val > 1440) allowed.sync_interval_minutes = 1440;
  }

  const { error } = await supabase
    .from('guild_config')
    .update(allowed)
    .eq('guild_id', GUILD_ID);

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
