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

  return NextResponse.json(
    {
      status: valkeyUp ? 'healthy' : 'degraded',
      services: {
        valkey: valkeyUp ? 'connected' : 'fallback',
      },
      timestamp: new Date().toISOString(),
    },
    { status: valkeyUp ? 200 : 503 },
  );
}
