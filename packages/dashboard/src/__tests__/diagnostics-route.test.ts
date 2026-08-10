import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn() }));
vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));

import { GET } from '@/app/api/diagnostics/route';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { createMockQueryBuilder } from './helpers/mock-supabase';

function rows(data: unknown) {
  const query = createMockQueryBuilder();
  query.then.mockImplementation((resolve) => resolve({ data, error: null }));
  return query;
}

describe('GET /api/diagnostics', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T12:00:00.000Z'));
    vi.mocked(checkAdminRateLimit).mockResolvedValue(null);
    vi.mocked(requireGuildOwner).mockResolvedValue({
      ok: true,
      ctx: { guildId: 'guild-1', discordId: 'owner-1', userId: 'user-1' },
    } as never);
  });

  it('reports a fresh heartbeat as online while marking stale health metrics with their source age', async () => {
    const health = rows(null);
    health.maybeSingle.mockResolvedValue({
      data: {
        snapshot_at: '2026-08-10T11:50:00.000Z',
        uptime_seconds: 3600,
        memory_rss_mb: 128,
      },
      error: null,
    });
    const heartbeat = rows(null);
    heartbeat.maybeSingle.mockResolvedValue({
      data: { snapshot_at: '2026-08-10T11:59:45.000Z', uptime_seconds: 3615 },
      error: null,
    });
    const webhooks = rows([]);
    const sync = rows(null);
    const drift = rows(null);
    const dlq = rows(null);
    dlq.then.mockImplementation((resolve) => resolve({ count: 0, error: null }));
    const metrics = rows([]);
    const config = rows(null);
    let diagnosticsReads = 0;

    vi.mocked(createAdminSupabase).mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === 'bot_diagnostics') {
          diagnosticsReads += 1;
          return diagnosticsReads === 1 ? health : heartbeat;
        }
        if (table === 'webhook_events') return webhooks;
        if (table === 'audit_logs') return sync.maybeSingle.mock.calls.length === 0 ? sync : drift;
        if (table === 'action_queue_dlq') return dlq;
        if (table === 'health_metrics') return metrics;
        return config;
      }),
    } as never);

    const response = await GET(new NextRequest('http://localhost/api/diagnostics'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.bot).toMatchObject({
      online: true,
      onlineSource: 'heartbeat',
      onlineSourceAt: '2026-08-10T11:59:45.000Z',
      onlineSourceAgeSecs: 15,
      heartbeatAt: '2026-08-10T11:59:45.000Z',
      heartbeatAgeSecs: 15,
      metricsSnapshotAt: '2026-08-10T11:50:00.000Z',
      metricsAgeSecs: 600,
      metricsStale: true,
      metricsAvailable: true,
    });
    expect(health.order).toHaveBeenCalledWith('snapshot_at', { ascending: false });
    expect(heartbeat.order).toHaveBeenCalledWith('snapshot_at', { ascending: false });
  });
});
