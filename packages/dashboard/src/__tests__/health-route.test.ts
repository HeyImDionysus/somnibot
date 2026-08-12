/**
 * Tests for GET /api/health — service health check endpoint.
 *
 * V10 §7: Verifies bot heartbeat detection via Valkey key.
 * The health route checks both Valkey connectivity and bot liveness
 * (heartbeat key with 120s TTL). Healthy returns 200 and degraded returns
 * 503 so orchestrators can act on dependency failure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { buildHealthResponse, type HealthProbe } from '@/lib/api/health-response';

const mockCheckHealth = vi.fn<HealthProbe['checkValkeyHealth']>();
const mockReadKey = vi.fn<HealthProbe['readValkeyKey']>();

const probe: HealthProbe = {
  checkValkeyHealth: mockCheckHealth,
  readValkeyKey: mockReadKey,
};

beforeEach(() => {
  vi.resetAllMocks();
  delete process.env.DASHBOARD_ENV_VALID;
});

describe('GET /api/health', () => {
  it('returns healthy with bot online when heartbeat is fresh', async () => {
    mockCheckHealth.mockResolvedValue(true);
    const heartbeatAt = Date.now() - 30_000;
    mockReadKey.mockResolvedValue(JSON.stringify({
      bootId: '11111111-1111-4111-8111-111111111111',
      timestamp: heartbeatAt,
    }));

    const res = await buildHealthResponse(probe);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe('healthy');
    expect(body.services.config).toBe('unknown');
    expect(body.services.valkey).toBe('connected');
    expect(body.services.bot).toBe('online');
    expect(body.botRuntime).toEqual({
      bootId: '11111111-1111-4111-8111-111111111111',
      heartbeatAt,
    });
    expect(body.timestamp).toBeTruthy();
  });

  it('returns degraded with bot offline when heartbeat exceeds 120s TTL', async () => {
    mockCheckHealth.mockResolvedValue(true);
    // 3 minutes old — bot crashed or disconnected
    mockReadKey.mockResolvedValue(JSON.stringify({ timestamp: Date.now() - 180_000 }));

    const res = await buildHealthResponse(probe);
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.status).toBe('degraded');
    expect(body.services.bot).toBe('offline');
    expect(body.services.valkey).toBe('connected');
  });

  it('returns degraded with bot offline when heartbeat key is absent', async () => {
    // Bot has never written a heartbeat (first deploy, or key expired)
    mockCheckHealth.mockResolvedValue(true);
    mockReadKey.mockResolvedValue(null);

    const res = await buildHealthResponse(probe);
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.services.bot).toBe('offline');
  });

  it('returns degraded with bot unknown when Valkey itself is down', async () => {
    mockCheckHealth.mockResolvedValue(false);

    const res = await buildHealthResponse(probe);
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.status).toBe('degraded');
    expect(body.services.valkey).toBe('fallback');
    expect(body.services.bot).toBe('unknown');
    // Should not attempt to read heartbeat when Valkey is unreachable
    expect(mockReadKey).not.toHaveBeenCalled();
  });

  it('returns degraded JSON when the Valkey health probe throws', async () => {
    mockCheckHealth.mockRejectedValue(new Error('probe failed'));

    const res = await buildHealthResponse(probe);
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.status).toBe('degraded');
    expect(body.services.valkey).toBe('fallback');
    expect(body.services.bot).toBe('unknown');
    expect(mockReadKey).not.toHaveBeenCalled();
  });

  it('treats unparseable heartbeat JSON as unknown, not crash', async () => {
    mockCheckHealth.mockResolvedValue(true);
    mockReadKey.mockResolvedValue('not-json');

    const res = await buildHealthResponse(probe);
    const body = await res.json();

    // JSON.parse throws → caught → bot: unknown
    expect(res.status).toBe(503);
    expect(body.status).toBe('degraded');
    expect(body.services.bot).toBe('unknown');
  });

  it('returns 503 when dependencies are degraded so orchestrators can recover', async () => {
    mockCheckHealth.mockResolvedValue(false);
    const res = await buildHealthResponse(probe);
    expect(res.status).toBe(503);
  });

  it('returns degraded when server config validation failed', async () => {
    process.env.DASHBOARD_ENV_VALID = 'false';
    mockCheckHealth.mockResolvedValue(true);
    mockReadKey.mockResolvedValue(JSON.stringify({ timestamp: Date.now() - 30_000 }));

    const res = await buildHealthResponse(probe);
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.status).toBe('degraded');
    expect(body.services.config).toBe('invalid');
    expect(body.services.valkey).toBe('connected');
    expect(body.services.bot).toBe('online');
  });

  it('production GET uses the heartbeat probe when the probe module loads', async () => {
    vi.resetModules();
    process.env.DASHBOARD_ENV_VALID = 'true';
    const routeCheckHealth = vi.fn().mockResolvedValue(true);
    const routeReadKey = vi.fn().mockResolvedValue(
      JSON.stringify({ timestamp: Date.now() - 10_000 }),
    );
    vi.doMock('@/lib/api/rate-limit', () => ({
      checkValkeyHealth: routeCheckHealth,
      readValkeyKey: routeReadKey,
    }));

    try {
      const { GET } = await import('@/app/api/health/route');
      const res = await GET();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.status).toBe('healthy');
      expect(body.services.config).toBe('valid');
      expect(body.services.valkey).toBe('connected');
      expect(body.services.bot).toBe('online');
      expect(routeCheckHealth).toHaveBeenCalledOnce();
      expect(routeReadKey).toHaveBeenCalledWith('somnibot:heartbeat:bot');
    } finally {
      vi.doUnmock('@/lib/api/rate-limit');
      vi.resetModules();
    }
  });

  it('production GET returns degraded JSON when the probe module cannot load', async () => {
    vi.resetModules();
    delete process.env.DASHBOARD_ENV_VALID;
    vi.doMock('@/lib/api/rate-limit', () => {
      throw new Error('rate-limit module failed to load');
    });

    try {
      const { GET } = await import('@/app/api/health/route');
      const res = await GET();
      const body = await res.json();

      expect(res.status).toBe(503);
      expect(body.status).toBe('degraded');
      expect(body.services.config).toBe('unknown');
      expect(body.services.valkey).toBe('fallback');
      expect(body.services.bot).toBe('unknown');
    } finally {
      vi.doUnmock('@/lib/api/rate-limit');
      vi.resetModules();
    }
  });

  it('production GET degrades when the loaded health probe reports unavailable', async () => {
    vi.resetModules();
    delete process.env.DASHBOARD_ENV_VALID;
    const routeCheckHealth = vi.fn().mockResolvedValue(false);
    const routeReadKey = vi.fn();
    vi.doMock('@/lib/api/rate-limit', () => ({
      checkValkeyHealth: routeCheckHealth,
      readValkeyKey: routeReadKey,
    }));

    try {
      const { GET } = await import('@/app/api/health/route');
      const res = await GET();
      const body = await res.json();

      expect(res.status).toBe(503);
      expect(body.status).toBe('degraded');
      expect(body.services.config).toBe('unknown');
      expect(body.services.valkey).toBe('fallback');
      expect(body.services.bot).toBe('unknown');
      expect(routeCheckHealth).toHaveBeenCalledOnce();
      expect(routeReadKey).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('@/lib/api/rate-limit');
      vi.resetModules();
    }
  });

  it('production GET is still safe with the real probe module', async () => {
    const { GET } = await import('@/app/api/health/route');
    const res = await GET();
    const body = await res.json();

    expect(['healthy', 'degraded']).toContain(body.status);
    expect(res.status).toBe(body.status === 'healthy' ? 200 : 503);
    expect(['connected', 'fallback']).toContain(body.services.valkey);
    expect(['online', 'offline', 'unknown']).toContain(body.services.bot);
  });
});
