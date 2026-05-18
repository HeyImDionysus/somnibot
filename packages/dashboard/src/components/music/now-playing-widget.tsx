/**
 * NowPlayingWidget — Live music status display for the dashboard.
 *
 * Shows current track, queue info, and recent play history.
 * Auto-refreshes every 10 seconds.
 */
'use client';

import { useState, useEffect, useCallback } from 'react';

interface NowPlaying {
  title: string;
  author: string;
  url: string;
  duration: number;
  position: number;
  requester: string;
  thumbnail?: string;
}

interface QueueInfo {
  length: number;
  duration: number;
}

interface RecentTrack {
  title: string;
  author: string;
  requester: string;
  timestamp: string;
}

interface MusicStatus {
  enabled: boolean;
  nowPlaying: NowPlaying | null;
  queue: QueueInfo;
  listeners: number;
  recentTracks: RecentTrack[];
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function formatTimeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function NowPlayingWidget() {
  const [status, setStatus] = useState<MusicStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/music/now-playing');
      const json = await res.json();
      if (json.success) setStatus(json.data);
    } catch {
      // Silently fail — widget is non-critical
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 10_000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  if (loading) {
    return (
      <div className="bg-discord-secondary rounded-lg border border-discord-border p-4 animate-pulse">
        <div className="h-4 bg-discord-tertiary rounded w-32 mb-3" />
        <div className="h-8 bg-discord-tertiary rounded w-full" />
      </div>
    );
  }

  if (!status?.enabled) {
    return (
      <div className="bg-discord-secondary rounded-lg border border-discord-border p-4">
        <h3 className="text-sm font-semibold text-white mb-2">🎵 Music</h3>
        <p className="text-xs text-discord-text-muted">Music system is disabled</p>
      </div>
    );
  }

  return (
    <div className="bg-discord-secondary rounded-lg border border-discord-border overflow-hidden">
      {/* Header */}
      <div className="p-4 border-b border-discord-border">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-white">🎵 Now Playing</h3>
          {status.nowPlaying && (
            <span className="flex items-center gap-1 text-xs">
              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              <span className="text-green-400">Live</span>
            </span>
          )}
        </div>
      </div>

      {/* Now Playing */}
      {status.nowPlaying ? (
        <div className="p-4">
          <div className="flex items-start gap-3">
            {status.nowPlaying.thumbnail && (
              <img
                src={status.nowPlaying.thumbnail}
                alt=""
                className="w-14 h-14 rounded object-cover flex-shrink-0"
              />
            )}
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white truncate">
                {status.nowPlaying.title}
              </p>
              <p className="text-xs text-discord-text-muted truncate">
                {status.nowPlaying.author}
              </p>
              <div className="mt-2">
                {/* Progress bar */}
                <div className="w-full h-1 bg-discord-tertiary rounded-full overflow-hidden">
                  <div
                    className="h-full bg-discord-blurple rounded-full transition-all"
                    style={{
                      width: `${Math.min(100, (status.nowPlaying.position / status.nowPlaying.duration) * 100)}%`,
                    }}
                  />
                </div>
                <div className="flex justify-between mt-1 text-xs text-discord-text-muted">
                  <span>{formatDuration(status.nowPlaying.position)}</span>
                  <span>{formatDuration(status.nowPlaying.duration)}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Queue info */}
          <div className="mt-3 flex items-center gap-4 text-xs text-discord-text-muted">
            <span>📋 {status.queue.length} in queue</span>
            <span>👥 {status.listeners} listening</span>
            <span>Requested by {status.nowPlaying.requester}</span>
          </div>
        </div>
      ) : (
        <div className="p-4 text-center">
          <p className="text-2xl mb-1">🔇</p>
          <p className="text-xs text-discord-text-muted">Nothing playing right now</p>
        </div>
      )}

      {/* Recent tracks */}
      {status.recentTracks.length > 0 && (
        <div className="border-t border-discord-border">
          <div className="px-4 py-2">
            <p className="text-xs font-medium text-discord-text-muted uppercase">Recent</p>
          </div>
          {status.recentTracks.slice(0, 5).map((track, i) => (
            <div
              key={i}
              className="px-4 py-1.5 flex items-center justify-between text-xs hover:bg-discord-tertiary"
            >
              <div className="flex-1 min-w-0">
                <span className="text-white truncate">{track.title}</span>
                <span className="text-discord-text-muted"> — {track.author}</span>
              </div>
              <span className="text-discord-text-muted ml-2 flex-shrink-0">{formatTimeAgo(track.timestamp)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
