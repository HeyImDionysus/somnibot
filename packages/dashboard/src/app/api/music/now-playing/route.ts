/**
 * GET /api/music/now-playing — Live music player status.
 *
 * Reads from Valkey cache (set by the bot's MusicPlayerManager):
 *   music:now_playing:{guildId} — current track info
 *   music:queue:{guildId} — queue metadata
 *   music:stats:daily_plays:{guildId} — daily play count
 *   music:stats:top_tracks:{guildId} — top tracks
 */
import { NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';

const GUILD_ID = process.env.DISCORD_GUILD_ID!;

// For now, read from Supabase since we can't directly connect to Valkey from dashboard.
// The bot writes music status to bot_diagnostics periodically.
export async function GET() {
  const supabase = createAdminSupabase();

  // Try reading from bot_diagnostics (the bot's DiagnosticsService writes these)
  const { data: diag } = await supabase
    .from('bot_diagnostics')
    .select('data')
    .eq('guild_id', GUILD_ID)
    .eq('type', 'music_status')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // Also get music stats from the guild_config for basic info
  const { data: config } = await supabase
    .from('guild_config')
    .select('music_enabled')
    .eq('guild_id', GUILD_ID)
    .maybeSingle();

  // Read from workflow_events as a recent track history source
  const { data: recentTracks } = await supabase
    .from('audit_logs')
    .select('details, timestamp')
    .eq('guild_id', GUILD_ID)
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
