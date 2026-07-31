import { NextResponse } from 'next/server';
import { requirePermission, authErrorResponse } from '@/lib/rbac';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { dbError } from '@/lib/api/response';

const FEATURE_CONFIG_COLUMNS = [
  'scheduled_messages_enabled',
  'stats_enabled',
  'temp_channels_enabled',
  'onboarding_enabled',
  'giveaways_enabled',
  'store_enabled',
  'economy_enabled',
  'welcome_enabled',
  'levels_enabled',
  'music_enabled',
  'polls_enabled',
  'sync_enabled',
].join(', ');

export async function GET() {
  try {
    // Any authenticated user assigned to the active guild may read this
    // minimal status projection. It contains no owner-only configuration.
    const ctx = await requirePermission(null);
    const supabase = createAdminSupabase();
    const [configResult, heartbeatResult] = await Promise.all([
      supabase
        .from('guild_config')
        .select(FEATURE_CONFIG_COLUMNS)
        .eq('guild_id', ctx.guildId)
        .maybeSingle(),
      supabase
        .from('bot_diagnostics')
        .select('snapshot_at')
        .eq('guild_id', ctx.guildId)
        .in('type', ['heartbeat', 'health'])
        .order('snapshot_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    if (configResult.error) return dbError(configResult.error, 'dashboard/feature-status/config');
    if (heartbeatResult.error) return dbError(heartbeatResult.error, 'dashboard/feature-status/heartbeat');

    const snapshotAt = heartbeatResult.data?.snapshot_at
      ? Date.parse(heartbeatResult.data.snapshot_at)
      : Number.NaN;
    const ageMs = Number.isFinite(snapshotAt) ? Date.now() - snapshotAt : Number.NaN;
    // A small negative age is normal clock skew. A heartbeat farther in the
    // future is impossible evidence and must not keep a stopped bot "online".
    const staleSecs = Number.isFinite(ageMs) && ageMs >= -30_000
      ? Math.max(0, Math.round(ageMs / 1_000))
      : null;

    return NextResponse.json({
      success: true,
      data: {
        config: configResult.data ?? {},
        bot: {
          online: staleSecs !== null && staleSecs < 120,
          staleSecs,
        },
      },
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}
