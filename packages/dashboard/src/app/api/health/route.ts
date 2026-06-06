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
import { buildHealthResponse, type HealthProbe } from '@/lib/api/health-response';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function loadHealthProbe(): Promise<HealthProbe | null> {
  try {
    const { checkValkeyHealth, readValkeyKey } = await import('@/lib/api/rate-limit');
    return { checkValkeyHealth, readValkeyKey };
  } catch {
    return null;
  }
}

export async function GET() {
  // Keep the public monitor endpoint independent from a top-level raw TCP
  // client import. If the probe path cannot load in this runtime, health still
  // returns degraded JSON instead of a platform 500 page.
  return buildHealthResponse(await loadHealthProbe());
}
