import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createMockQueryBuilder, type MockQueryBuilder } from './helpers/mock-supabase';

interface OwnerAuth {
  readonly ok: true;
  readonly ctx: {
    readonly guildId: string;
    readonly discordId: string;
    readonly userId: string;
  };
}

interface DiagnosticsClient {
  from: (table: string) => MockQueryBuilder;
}

const mocks = vi.hoisted(() => ({
  checkAdminRateLimit: vi.fn<() => Promise<null>>(),
  requireGuildOwner: vi.fn<() => Promise<OwnerAuth>>(),
  createAdminSupabase: vi.fn<() => DiagnosticsClient>(),
}));

vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: mocks.checkAdminRateLimit }));
vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: mocks.requireGuildOwner }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: mocks.createAdminSupabase }));

import { GET } from '@/app/api/diagnostics/route';

interface DiagnosticsFixture {
  readonly healthSnapshotAt: string | null;
  readonly heartbeatAt: string | null;
}

function rows(data: unknown): MockQueryBuilder {
  const query = createMockQueryBuilder();
  query.then.mockImplementation((resolve) => resolve({ data, error: null }));
  return query;
}

function snapshot(snapshotAt: string | null): MockQueryBuilder {
  const query = rows(null);
  query.maybeSingle.mockResolvedValue({
    data: snapshotAt === null ? null : { snapshot_at: snapshotAt, uptime_seconds: 3600 },
    error: null,
  });
  return query;
}

function diagnosticsClient(fixture: DiagnosticsFixture) {
  const health = snapshot(fixture.healthSnapshotAt);
  const heartbeat = snapshot(fixture.heartbeatAt);
  const diagnostics = rows(null);
  diagnostics.eq.mockImplementation((column: string, value: unknown) => {
    if (column === 'type' && value === 'health') return health;
    if (column === 'type' && value === 'heartbeat') return heartbeat;
    return diagnostics;
  });

  const webhooks = rows([]);
  const sync = rows(null);
  const drift = rows(null);
  const audit = rows(null);
  audit.in.mockReturnValue(sync);
  audit.eq.mockImplementation((column: string) => column === 'action' ? drift : audit);

  const dlq = rows(null);
  dlq.then.mockImplementation((resolve) => resolve({ count: 0, error: null }));
  const metrics = rows([]);
  const config = rows(null);
  const client: DiagnosticsClient = {
    from(table) {
      if (table === 'bot_diagnostics') return diagnostics;
      if (table === 'webhook_events') return webhooks;
      if (table === 'audit_logs') return audit;
      if (table === 'action_queue_dlq') return dlq;
      if (table === 'health_metrics') return metrics;
      return config;
    },
  };
  return { client, health, heartbeat };
}

async function getDiagnostics(fixture: DiagnosticsFixture) {
  const tables = diagnosticsClient(fixture);
  mocks.createAdminSupabase.mockReturnValue(tables.client);
  const response = await GET(new NextRequest('http://localhost/api/diagnostics'));
  return { body: await response.json(), response, ...tables };
}

describe('GET /api/diagnostics', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T12:00:00.000Z'));
    mocks.checkAdminRateLimit.mockResolvedValue(null);
    mocks.requireGuildOwner.mockResolvedValue({
      ok: true,
      ctx: { guildId: 'guild-1', discordId: 'owner-1', userId: 'user-1' },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports a fresh heartbeat as online while marking stale health metrics with their source age', async () => {
    const result = await getDiagnostics({
      healthSnapshotAt: '2026-08-10T11:50:00.000Z',
      heartbeatAt: '2026-08-10T11:59:45.000Z',
    });

    expect(result.response.status).toBe(200);
    expect(result.body.data.bot).toMatchObject({
      online: true,
      onlineSource: 'heartbeat',
      onlineSourceAgeSecs: 15,
      heartbeatAgeSecs: 15,
      metricsAgeSecs: 600,
      metricsStale: true,
      metricsAvailable: true,
    });
    expect(result.health.order).toHaveBeenCalledWith('snapshot_at', { ascending: false });
    expect(result.heartbeat.order).toHaveBeenCalledWith('snapshot_at', { ascending: false });
  });

  it('treats the exact health freshness cutoff as offline and stale', async () => {
    const result = await getDiagnostics({
      healthSnapshotAt: '2026-08-10T11:58:00.000Z',
      heartbeatAt: null,
    });

    expect(result.body.data.bot).toMatchObject({
      online: false,
      onlineSource: 'health_snapshot',
      onlineSourceAgeSecs: 120,
      metricsAgeSecs: 120,
      metricsStale: true,
    });
  });

  it('uses a fresh health snapshot when the heartbeat is missing or stale', async () => {
    const result = await getDiagnostics({
      healthSnapshotAt: '2026-08-10T11:59:50.000Z',
      heartbeatAt: '2026-08-10T11:50:00.000Z',
    });

    expect(result.body.data.bot).toMatchObject({
      online: true,
      onlineSource: 'health_snapshot',
      onlineSourceAgeSecs: 10,
      metricsAgeSecs: 10,
      metricsStale: false,
    });
  });

  it.each([
    ['missing', null, null],
    ['invalid', null, 'not-a-date'],
    ['future', null, '2026-08-10T12:05:00.000Z'],
  ])('fails closed when the newest observation is %s', async (_condition, healthSnapshotAt, heartbeatAt) => {
    const result = await getDiagnostics({ healthSnapshotAt, heartbeatAt });

    expect(result.body.data.bot).toMatchObject({
      online: false,
      onlineSource: 'unavailable',
      onlineSourceAgeSecs: null,
      heartbeatAt: null,
      heartbeatAgeSecs: null,
      metricsAvailable: false,
      metricsStale: true,
    });
  });
});
