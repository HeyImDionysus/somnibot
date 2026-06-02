/**
 * GET /api/health — Service health check endpoint.
 *
 * V5 Audit §14.5: Surfaces Valkey connection status
 * so uptime monitors can alert on degraded rate limiting.
 *
 * V5 Audit P3-3: Uses Valkey PING instead of consuming a rate-limit
 * counter. Previous approach wasted ~2,880 INCR ops/day from Docker
 * healthchecks alone.
 *
 * V10 Audit §7: Also reads bot heartbeat from Valkey to surface bot
 * connectivity. Heartbeat staleness > 120s means the bot is down.
 */
import { NextResponse } from 'next/server';
import { checkValkeyHealth, readValkeyKey } from '@/lib/api/rate-limit';

const BOT_HEARTBEAT_KEY = 'somnibot:heartbeat:bot';
const BOT_HEARTBEAT_STALE_MS = 120_000; // 2 minutes — matches bot TTL

export async function GET() {
  const valkeyUp = await checkValkeyHealth();

  // V10 Audit §7: Check bot heartbeat if Valkey is available
  let botStatus: 'online' | 'offline' | 'unknown' = 'unknown';
  if (valkeyUp) {
    try {
      const heartbeatRaw = await readValkeyKey(BOT_HEARTBEAT_KEY);
      if (heartbeatRaw) {
        const heartbeat = JSON.parse(heartbeatRaw);
        const age = Date.now() - (heartbeat.timestamp ?? 0);
        botStatus = age < BOT_HEARTBEAT_STALE_MS ? 'online' : 'offline';
      } else {
        botStatus = 'offline';
      }
    } catch {
      botStatus = 'unknown';
    }
  }

  const isHealthy = valkeyUp && botStatus !== 'offline';

  // Always return 200 — the dashboard is functional without Valkey (falls back
  // to in-memory rate limiting). Returning 503 when Valkey is down causes
  // Railway/Vercel to restart the container, which doesn't fix Valkey and just
  // creates a restart loop. The 'degraded' status field lets monitors alert
  // without triggering platform-level restarts.
  return NextResponse.json(
    {
      status: isHealthy ? 'healthy' : 'degraded',
      services: {
        valkey: valkeyUp ? 'connected' : 'fallback',
        bot: botStatus,
      },
      timestamp: new Date().toISOString(),
    },
    { status: 200 },
  );
}
