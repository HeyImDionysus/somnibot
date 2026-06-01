/**
 * GET /api/health — Service health check endpoint.
 *
 * V5 Audit §14.5: Surfaces Valkey connection status
 * so uptime monitors can alert on degraded rate limiting.
 *
 * V5 Audit P3-3: Uses Valkey PING instead of consuming a rate-limit
 * counter. Previous approach wasted ~2,880 INCR ops/day from Docker
 * healthchecks alone.
 */
import { NextResponse } from 'next/server';
import { checkValkeyHealth } from '@/lib/api/rate-limit';

export async function GET() {
  const valkeyUp = await checkValkeyHealth();

  // Always return 200 — the dashboard is functional without Valkey (falls back
  // to in-memory rate limiting). Returning 503 when Valkey is down causes
  // Railway/Vercel to restart the container, which doesn't fix Valkey and just
  // creates a restart loop. The 'degraded' status field lets monitors alert
  // without triggering platform-level restarts.
  return NextResponse.json(
    {
      status: valkeyUp ? 'healthy' : 'degraded',
      services: {
        valkey: valkeyUp ? 'connected' : 'fallback',
      },
      timestamp: new Date().toISOString(),
    },
    { status: 200 },
  );
}
