import { describe, expect, it } from 'vitest';
import { SystemStateSchema } from '../../../shared/src/system-state/index.js';
import { buildDashboardSystemState } from '@/lib/system-state';

describe('dashboard system state builder', () => {
  it('combines bot identity, operational evidence, and credential metadata without values', () => {
    const state = buildDashboardSystemState({
      observedAt: '2026-08-23T04:05:00.000Z',
      guildId: '1464713668766732393',
      runtime: {
        schemaVersion: 1,
        observedAt: '2026-08-23T04:04:59.000Z',
        mode: 'normal',
        identity: {
          lifecycle: 'ready',
          version: '1.2.3',
          exactSha: 'b'.repeat(40),
          bootId: '11111111-1111-4111-8111-111111111111',
          migrationHead: '20260823142000_dashboard_adoption_map.sql',
          configurationGeneration: 9,
          deploymentProfile: 'vps-single-guild',
        },
        providers: [{ key: 'discord', status: 'ready', checkedAt: '2026-08-23T04:04:59.000Z' }],
        queues: [],
        features: [],
        guildConditions: [{ guildId: '1464713668766732393', status: 'ready', conditions: [] }],
      },
      valkeyConnected: true,
      supabaseConnected: true,
      dlqDepth: 2,
      evidence: [{
        action: 'launcher.backup.valkey_succeeded',
        timestamp: '2026-08-23T04:00:00.000Z',
        success: true,
        details: { status: 'current', checksumSha256: 'a'.repeat(64), capturedAt: '2026-08-23T04:00:00.000Z' },
      }],
      credentials: [{ key: 'discord_bot_token_encrypted', present: true, updatedAt: '2026-08-20T04:00:00.000Z' }],
    });

    expect(SystemStateSchema.parse(state).backups.valkey.status).toBe('current');
    expect(state.queues).toContainEqual({ key: 'action_queue_dlq', status: 'backlogged', depth: 2, oldestAgeMs: null });
    expect(state.credentials[0]).toMatchObject({ present: true, source: 'cloud_vault', ageDays: 3 });
    expect(JSON.stringify(state)).not.toContain('encrypted-value');
  });

  it('reports missing evidence honestly instead of synthesizing recovery readiness', () => {
    const state = buildDashboardSystemState({
      observedAt: '2026-08-23T04:05:00.000Z',
      guildId: '1464713668766732393',
      runtime: null,
      valkeyConnected: false,
      supabaseConnected: true,
      dlqDepth: null,
      evidence: [],
      credentials: [],
    });

    expect(state.mode).toBe('degraded');
    expect(state.backups.database.status).toBe('unknown');
    expect(state.backups.valkey.status).toBe('unknown');
    expect(state.recovery.status).toBe('unverified');
  });
});
