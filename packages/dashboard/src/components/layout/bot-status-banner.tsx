/**
 * BotStatusBanner — Shows a warning/error banner when the bot appears offline.
 *
 * V53 Phase 2 (Finding 2.1)
 *
 * Polls /api/diagnostics every 30s and shows:
 * - Yellow banner when stale >90s
 * - Red banner when stale >5min
 * - Auto-clears when bot comes back
 */
'use client';

import { useEffect, useState, useCallback } from 'react';

type BannerState = 'online' | 'stale' | 'offline';

export function BotStatusBanner() {
  const [state, setState] = useState<BannerState>('online');

  const check = useCallback(async () => {
    try {
      const res = await fetch('/api/diagnostics');
      const json = await res.json();
      if (!json.success) return;

      const staleSecs = json.data?.bot?.staleSecs;
      if (staleSecs === null || staleSecs === undefined) {
        // No data yet — assume offline
        setState('offline');
      } else if (staleSecs > 300) {
        setState('offline');
      } else if (staleSecs > 90) {
        setState('stale');
      } else {
        setState('online');
      }
    } catch {
      // Network error — don't change state
    }
  }, []);

  useEffect(() => {
    check();
    const timer = setInterval(check, 30_000);
    return () => clearInterval(timer);
  }, [check]);

  if (state === 'online') return null;

  const isOffline = state === 'offline';

  return (
    <div
      className={`flex items-center gap-2 px-4 py-2 text-sm font-medium ${
        isOffline
          ? 'bg-red-500/15 text-red-400 border-b border-red-500/30'
          : 'bg-yellow-500/15 text-yellow-400 border-b border-yellow-500/30'
      }`}
    >
      <span>{isOffline ? '🛑' : '⚠️'}</span>
      <span>
        {isOffline
          ? 'Bot is offline — no heartbeat received in over 5 minutes'
          : 'Bot may be having issues — heartbeat is stale'}
      </span>
      <a
        href="/diagnostics"
        className="ml-auto text-xs underline opacity-75 hover:opacity-100"
      >
        View Diagnostics →
      </a>
    </div>
  );
}
