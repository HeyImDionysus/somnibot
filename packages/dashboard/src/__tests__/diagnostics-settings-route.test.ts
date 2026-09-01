import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  notifyBot: vi.fn<() => Promise<void>>(),
  readGuildConfigBefore: vi.fn<() => Promise<Record<string, unknown>>>(),
  recordGuildConfigChange: vi.fn<() => Promise<void>>(),
}));

vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: mocks.checkAdminRateLimit }));
vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: mocks.requireGuildOwner }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: mocks.createAdminSupabase }));
vi.mock('@/lib/notify-bot', () => ({ notifyBot: mocks.notifyBot }));
vi.mock('@/lib/admin-changes', () => ({
  readGuildConfigBefore: mocks.readGuildConfigBefore,
  recordGuildConfigChange: mocks.recordGuildConfigChange,
}));

import { PATCH } from '@/app/api/diagnostics/route';

function request(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/diagnostics', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('PATCH /api/diagnostics', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.checkAdminRateLimit.mockResolvedValue(null);
    mocks.requireGuildOwner.mockResolvedValue({
      ok: true,
      ctx: { guildId: 'guild-1', discordId: 'owner-1', userId: 'user-1' },
    });
    mocks.notifyBot.mockResolvedValue(undefined);
    mocks.readGuildConfigBefore.mockResolvedValue({ memory_alert_threshold_mb: 512 });
    mocks.recordGuildConfigChange.mockResolvedValue(undefined);
  });

  it('persists a valid diagnostics patch and returns authoritative per-guild readback', async () => {
    const config = createMockQueryBuilder();
    config.upsert.mockResolvedValue({ error: null });
    config.maybeSingle.mockResolvedValue({
      data: {
        diagnostics_guided_mode: false,
        memory_alert_threshold_mb: 768,
        ws_ping_alert_threshold_ms: 600,
        webhook_error_rate_threshold: '0.125',
        diagnostics_snapshot_interval_ms: 45_000,
      },
      error: null,
    });
    mocks.createAdminSupabase.mockReturnValue({ from: () => config });

    const response = await PATCH(request({
      diagnostics_guided_mode: false,
      memory_alert_threshold_mb: 768,
      webhook_error_rate_threshold: 0.125,
      diagnostics_snapshot_interval_ms: 45_000,
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(config.upsert).toHaveBeenCalledWith({
      guild_id: 'guild-1',
      diagnostics_guided_mode: false,
      memory_alert_threshold_mb: 768,
      webhook_error_rate_threshold: 0.125,
      diagnostics_snapshot_interval_ms: 45_000,
    }, { onConflict: 'guild_id' });
    expect(body.data).toEqual({
      guidedMode: false,
      thresholds: { memoryRssMb: 768, wsPingMs: 600, webhookErrorRate: 0.125 },
      snapshotIntervalMs: 45_000,
    });
    expect(mocks.notifyBot).toHaveBeenCalledWith(
      'guild-1',
      'all',
      expect.objectContaining({ memory_alert_threshold_mb: 768 }),
      'owner-1',
      undefined,
      { memory_alert_threshold_mb: 512 },
    );
  });

  it.each([
    { memory_alert_threshold_mb: 127 },
    { ws_ping_alert_threshold_ms: 10_001 },
    { webhook_error_rate_threshold: 1.01 },
    { diagnostics_snapshot_interval_ms: 14_999 },
  ])('rejects invalid diagnostics settings before persistence: %j', async (body) => {
    const config = createMockQueryBuilder();
    mocks.createAdminSupabase.mockReturnValue({ from: () => config });

    const response = await PATCH(request(body));

    expect(response.status).toBe(400);
    expect(config.upsert).not.toHaveBeenCalled();
  });
});
