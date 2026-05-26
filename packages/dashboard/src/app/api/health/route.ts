/**
 * GET /api/health — Service health check endpoint.
 *
 * V5 Audit §14.5: Surfaces Valkey connection status
 * so uptime monitors can alert on degraded rate limiting.
 */
import { NextResponse } from 'next/server';
import { rateLimits } from '@/lib/api/rate-limit';

export async function GET() {
  const probe = await rateLimits.licenseValidate('__health_check__');

  // When Valkey is connected, max is 30 and remaining starts at 29.
  // In degraded (in-memory fallback) mode, max is halved to 15.
  const isDegraded = probe.remaining < 15;

  return NextResponse.json(
    {
      status: isDegraded ? 'degraded' : 'healthy',
      services: {
        valkey: isDegraded ? 'fallback' : 'connected',
      },
      timestamp: new Date().toISOString(),
    },
    { status: isDegraded ? 503 : 200 },
  );
}
