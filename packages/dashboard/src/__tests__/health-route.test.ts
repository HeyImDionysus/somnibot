/**
 * Tests for GET /api/health — service health check endpoint.
 *
 * V10 §7: Verifies bot heartbeat detection via Valkey key.
 * The health route checks both Valkey connectivity and bot liveness
 * (heartbeat key with 120s TTL). Always returns 200 — status field
 * differentiates healthy/degraded for monitors.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/api/rate-limit', () => ({
  checkValkeyHealth: vi.fn(),
  readValkeyKey: vi.fn(),
}));

import { GET } from '@/app/api/health/route';
import { checkValkeyHealth, readValkeyKey } from '@/lib/api/rate-limit';

const mockCheckHealth = vi.mocked(checkValkeyHealth);
const mockReadKey = vi.mocked(readValkeyKey);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/health', () => {
  it('returns healthy with bot online when heartbeat is fresh', async () => {
    mockCheckHealth.mockResolvedValue(true);
    mockReadKey.mockResolvedValue(JSON.stringify({ timestamp: Date.now() - 30_000 }));

    const res = await GET();
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

    const res = await GET();
    const body = await res.json();

    expect(body.status).toBe('degraded');
    expect(body.services.bot).toBe('offline');
    expect(body.services.valkey).toBe('connected');
  });

  it('returns degraded with bot offline when heartbeat key is absent', async () => {
    // Bot has never written a heartbeat (first deploy, or key expired)
    mockCheckHealth.mockResolvedValue(true);
    mockReadKey.mockResolvedValue(null);

    const res = await GET();
    const body = await res.json();

    expect(body.services.bot).toBe('offline');
  });

  it('returns degraded with bot unknown when Valkey itself is down', async () => {
    mockCheckHealth.mockResolvedValue(false);

    const res = await GET();
    const body = await res.json();

    expect(body.status).toBe('degraded');
    expect(body.services.valkey).toBe('fallback');
    expect(body.services.bot).toBe('unknown');
    // Should not attempt to read heartbeat when Valkey is unreachable
    expect(mockReadKey).not.toHaveBeenCalled();
  });

  it('treats unparseable heartbeat JSON as unknown, not crash', async () => {
    mockCheckHealth.mockResolvedValue(true);
    mockReadKey.mockResolvedValue('not-json');

    const res = await GET();
    const body = await res.json();

    // JSON.parse throws → caught → bot: unknown
    expect(res.status).toBe(200);
    expect(body.services.bot).toBe('unknown');
  });

  it('never returns non-200 — monitors should read status field not HTTP code', async () => {
    // Even worst case (Valkey down, bot unknown) is 200
    mockCheckHealth.mockResolvedValue(false);
    const res = await GET();
    expect(res.status).toBe(200);
  });
});
