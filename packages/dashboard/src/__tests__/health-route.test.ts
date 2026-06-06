/**
 * Tests for GET /api/health — service health check endpoint.
 *
 * V10 §7: Verifies bot heartbeat detection via Valkey key.
 * The health route checks both Valkey connectivity and bot liveness
 * (heartbeat key with 120s TTL). Always returns 200 — status field
 * differentiates healthy/degraded for monitors.
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
  vi.clearAllMocks();
});

describe('GET /api/health', () => {
  it('returns healthy with bot online when heartbeat is fresh', async () => {
    mockCheckHealth.mockResolvedValue(true);
    mockReadKey.mockResolvedValue(JSON.stringify({ timestamp: Date.now() - 30_000 }));

    const res = await buildHealthResponse(probe);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe('healthy');
    expect(body.services.valkey).toBe('connected');
    expect(body.services.bot).toBe('online');
    expect(body.timestamp).toBeTruthy();
  });

  it('returns degraded with bot offline when heartbeat exceeds 120s TTL', async () => {
    mockCheckHealth.mockResolvedValue(true);
    // 3 minutes old — bot crashed or disconnected
    mockReadKey.mockResolvedValue(JSON.stringify({ timestamp: Date.now() - 180_000 }));

    const res = await buildHealthResponse(probe);
    const body = await res.json();

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

    expect(body.services.bot).toBe('offline');
  });

  it('returns degraded with bot unknown when Valkey itself is down', async () => {
    mockCheckHealth.mockResolvedValue(false);

    const res = await buildHealthResponse(probe);
    const body = await res.json();

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

    expect(res.status).toBe(200);
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
    expect(res.status).toBe(200);
    expect(body.status).toBe('degraded');
    expect(body.services.bot).toBe('unknown');
  });

  it('never returns non-200 — monitors should read status field not HTTP code', async () => {
    // Even worst case (Valkey down, bot unknown) is 200
    mockCheckHealth.mockResolvedValue(false);
    const res = await buildHealthResponse(probe);
    expect(res.status).toBe(200);
  });

  it('production GET uses the heartbeat probe when the probe module loads', async () => {
    vi.resetModules();
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
    vi.doMock('@/lib/api/rate-limit', () => {
      throw new Error('rate-limit module failed to load');
    });

    try {
      const { GET } = await import('@/app/api/health/route');
      const res = await GET();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.status).toBe('degraded');
      expect(body.services.valkey).toBe('fallback');
      expect(body.services.bot).toBe('unknown');
    } finally {
      vi.doUnmock('@/lib/api/rate-limit');
      vi.resetModules();
    }
  });

  it('production GET degrades when the loaded health probe reports unavailable', async () => {
    vi.resetModules();
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

      expect(res.status).toBe(200);
      expect(body.status).toBe('degraded');
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

    expect(res.status).toBe(200);
    expect(['healthy', 'degraded']).toContain(body.status);
    expect(['connected', 'fallback']).toContain(body.services.valkey);
    expect(['online', 'offline', 'unknown']).toContain(body.services.bot);
  });
});
