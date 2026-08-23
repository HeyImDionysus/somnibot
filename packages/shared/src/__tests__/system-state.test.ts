import { describe, expect, it } from 'vitest';
import {
  SystemStateSchema,
  evaluateUpgradeGate,
  redactDiagnosticValue,
} from '../system-state/index.js';

const currentBackup = {
  status: 'current' as const,
  capturedAt: '2026-08-23T04:00:00.000Z',
  checksumSha256: 'a'.repeat(64),
  lastRestoreRehearsalAt: '2026-08-22T04:00:00.000Z',
};

describe('system state contract', () => {
  it('parses one versioned state without carrying credential values', () => {
    const state = SystemStateSchema.parse({
      schemaVersion: 1,
      observedAt: '2026-08-23T04:05:00.000Z',
      mode: 'normal',
      identity: {
        lifecycle: 'ready',
        version: '1.2.3',
        exactSha: 'b'.repeat(40),
        bootId: '11111111-1111-4111-8111-111111111111',
        migrationHead: '20260823142000_dashboard_adoption_map.sql',
        configurationGeneration: 12,
        deploymentProfile: 'vps-multi-guild',
      },
      providers: [{ key: 'discord', status: 'ready', checkedAt: '2026-08-23T04:05:00.000Z' }],
      queues: [{ key: 'action_queue', status: 'ready', depth: 0, oldestAgeMs: 0 }],
      features: [{ key: 'moderation', status: 'ready' }],
      backups: { database: currentBackup, valkey: currentBackup },
      recovery: {
        status: 'ready',
        lastRehearsalAt: '2026-08-22T04:00:00.000Z',
        recoveryPointObjectiveMinutes: 60,
        recoveryTimeObjectiveMinutes: 30,
        evidenceRef: 'restore-rehearsal-20260822',
      },
      credentials: [{
        key: 'discord_bot',
        present: true,
        source: 'os_keychain',
        validity: 'valid',
        observedAt: '2026-08-23T04:05:00.000Z',
        rotatedAt: '2026-08-20T04:05:00.000Z',
        ageDays: 3,
        rotationDueAt: null,
      }],
      guildConditions: [],
    });

    expect(state.identity.exactSha).toBe('b'.repeat(40));
    expect(JSON.stringify(state)).not.toContain('token');
    expect(JSON.stringify(state)).not.toContain('secret');
  });

  it('blocks an upgrade when recovery or protocol evidence is stale', () => {
    const result = evaluateUpgradeGate({
      currentVersion: '1.2.3',
      candidateVersion: '1.3.0',
      currentSha: 'b'.repeat(40),
      candidateSha: 'c'.repeat(40),
      lastKnownGoodSha: 'b'.repeat(40),
      migrationPrerequisitesMet: true,
      sdkProtocolCompatible: false,
      providersConfigured: true,
      resourcesAvailable: true,
      databaseBackup: currentBackup,
      valkeyBackup: { ...currentBackup, status: 'stale' },
      expectedDowntimeSeconds: 45,
      postUpgradeChecks: ['health', 'discord-readback'],
    });

    expect(result.status).toBe('blocked');
    expect(result.blockers.map((blocker) => blocker.code)).toEqual([
      'sdk_protocol_incompatible',
      'valkey_backup_not_current',
    ]);
    expect(result.operationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('blocks an upgrade when capacity exceeds the selected deployment profile', () => {
    const result = evaluateUpgradeGate({
      currentVersion: '1.2.3',
      candidateVersion: '1.3.0',
      currentSha: 'b'.repeat(40),
      candidateSha: 'c'.repeat(40),
      lastKnownGoodSha: 'b'.repeat(40),
      migrationPrerequisitesMet: true,
      sdkProtocolCompatible: true,
      providersConfigured: true,
      resourcesAvailable: true,
      deploymentProfile: 'vps-single-guild',
      deploymentCapacity: {
        guildCount: 2,
        registeredMembersPerGuild: 8_000,
        cpuCores: 4,
        memoryGiB: 8,
        backupConfigured: true,
      },
      databaseBackup: currentBackup,
      valkeyBackup: currentBackup,
      expectedDowntimeSeconds: 45,
      postUpgradeChecks: ['health'],
    });

    expect(result.status).toBe('blocked');
    expect(result.blockers.map((blocker) => blocker.code)).toContain('deployment_profile_incompatible');
  });

  it('redacts nested credentials, authorization headers, and URLs', () => {
    const fixtureSecret = ['sb', 'secret', 'fixture'].join('_');
    const redacted = redactDiagnosticValue({
      env: `SUPABASE_SECRET_KEY=${fixtureSecret}`,
      headers: { authorization: 'Bearer fixture-bearer' },
      url: 'redis://:fixture-password@valkey:6379/0',
      safe: { operationId: '11111111-1111-4111-8111-111111111111' },
    });
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain(fixtureSecret);
    expect(serialized).not.toContain('fixture-bearer');
    expect(serialized).not.toContain('fixture-password');
    expect(serialized).toContain('11111111-1111-4111-8111-111111111111');
  });
});
