/**
 * /api/sync/status — GET sync engine status and drift items.
 */
import { NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';

const GUILD_ID = process.env.DISCORD_GUILD_ID!;

export async function GET() {
  const supabase = createAdminSupabase();

  const [configResult, driftResult] = await Promise.all([
    supabase
      .from('guild_config')
      .select('sync_enabled, sync_interval_minutes, sync_auto_repair, sync_auto_repair_everyone')
      .eq('guild_id', GUILD_ID)
      .maybeSingle(),
    supabase
      .from('guild_desired_state')
      .select('last_sync_at, drift_detected, drift_details')
      .eq('guild_id', GUILD_ID)
      .maybeSingle(),
  ]);

  if (configResult.error) {
    return NextResponse.json({ success: false, error: configResult.error.message }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    data: {
      config: configResult.data ?? {
        sync_enabled: true,
        sync_interval_minutes: 15,
        sync_auto_repair: false,
        sync_auto_repair_everyone: true,
      },
      lastSyncAt: driftResult.data?.last_sync_at ?? null,
      driftDetected: driftResult.data?.drift_detected ?? false,
      driftItems: driftResult.data?.drift_details ?? [],
    },
  });
}
