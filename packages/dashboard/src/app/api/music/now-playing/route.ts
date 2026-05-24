/**
 * GET /api/music/now-playing — Live music player status.
 *
 * Reads from Valkey cache (set by the bot's MusicPlayerManager):
 *   music:now_playing:{guildId} — current track info
 *   music:queue:{guildId} — queue metadata
 *   music:stats:daily_plays:{guildId} — daily play count
 *   music:stats:top_tracks:{guildId} — top tracks
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
// For now, read from Supabase since we can't directly connect to Valkey from dashboard.
// The bot writes music status to bot_diagnostics periodically.
export async function GET(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'standard');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();

  // Try reading from bot_diagnostics (the bot's DiagnosticsService writes these)
  const { data: diag } = await supabase
    .from('bot_diagnostics')
    .select('data')
    .eq('guild_id', guildId)
    .eq('type', 'music_status')
    .order('snapshot_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // Also get music stats from the guild_config for basic info
  const { data: config } = await supabase
    .from('guild_config')
    .select('music_enabled')
    .eq('guild_id', guildId)
    .maybeSingle();

  // Read from workflow_events as a recent track history source
  const { data: recentTracks } = await supabase
    .from('audit_logs')
    .select('details, timestamp')
    .eq('guild_id', guildId)
    .like('action', 'music.%')
    .order('timestamp', { ascending: false })
    .limit(10);

  const musicData = diag?.data as Record<string, unknown> | null;

  return NextResponse.json({
    success: true,
    data: {
      enabled: config?.music_enabled ?? true,
      nowPlaying: musicData?.now_playing ?? null,
      queue: musicData?.queue ?? { length: 0, duration: 0 },
      listeners: musicData?.listeners ?? 0,
      recentTracks: (recentTracks ?? []).map((t) => ({
        title: (t.details as Record<string, string>)?.title ?? 'Unknown',
        author: (t.details as Record<string, string>)?.author ?? 'Unknown',
        requester: (t.details as Record<string, string>)?.requester ?? 'Unknown',
        timestamp: t.timestamp,
      })),
    },
  });
}
