import { describe, expect, it } from 'vitest';
import { SystemStateSchema } from '../../../shared/src/system-state/index.js';
import type { RuntimeSystemState } from '../../../shared/src/system-state/index.js';
import { buildDashboardSystemState } from '@/lib/system-state';
import type { SystemStateEvidence } from '@/lib/system-state';

const observedAt = '2026-08-31T14:00:00.000Z';
const capturedAt = '2026-08-31T13:00:00.000Z';
const rehearsedAt = '2026-08-31T13:30:00.000Z';
const backupId = '11111111-1111-4111-8111-111111111111';
const databaseChecksum = 'a'.repeat(64);
const valkeyChecksum = 'b'.repeat(64);
const deployedExactSha = 'd'.repeat(40);
const deployedBootId = '22222222-2222-4222-8222-222222222222';
const deployedMigrationHead = '20260831135500_adoption_recovery_proof.sql';
const deployedConfigurationGeneration = 20260831135500;
const recoveryProof = {
  identity: 'c'.repeat(32),
  backupId,
  databaseChecksumSha256: databaseChecksum,
  valkeyChecksumSha256: valkeyChecksum,
  rehearsedAt,
  deployedExactSha,
  deployedBootId,
  deployedMigrationHead,
  deployedConfigurationGeneration,
  scope: 'database_rehearsal_and_valkey_snapshot',
  expiresAt: '2026-09-01T13:00:00.000Z',
  evidenceIds: [backupId],
};
const recoveryRuntime: RuntimeSystemState = {
  schemaVersion: 1,
  observedAt,
  mode: 'normal',
  identity: {
    lifecycle: 'ready',
    version: '1.0.0',
    exactSha: deployedExactSha,
    bootId: deployedBootId,
    migrationHead: deployedMigrationHead,
    configurationGeneration: deployedConfigurationGeneration,
    deploymentProfile: 'vps-single-guild',
  },
  providers: [],
  queues: [],
  features: [],
  guildConditions: [],
};

function recoveryEvidence(): SystemStateEvidence[] {
  return [
    { action: 'launcher.backup.database_succeeded', timestamp: capturedAt, success: true,
      details: { backupId, capturedAt, checksumSha256: databaseChecksum } },
    { action: 'launcher.backup.valkey_succeeded', timestamp: capturedAt, success: true,
      details: { capturedAt, checksumSha256: valkeyChecksum } },
    { action: 'launcher.restore.rehearsal_succeeded', timestamp: rehearsedAt, success: true,
      details: { backupId, capturedAt, checksumSha256: databaseChecksum, rehearsedAt, validated: true } },
  ];
}

function buildRecoveryState(
  evidence: SystemStateEvidence[],
  proof: unknown = recoveryProof,
  runtime: RuntimeSystemState | null = recoveryRuntime,
) {
  const input = {
    observedAt, guildId: '1464713668766732393', runtime,
    valkeyConnected: true, supabaseConnected: true, dlqDepth: 0,
    evidence, credentials: [], recoveryProof: proof,
  };
  return buildDashboardSystemState(input);
}

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

  it('marks a daily snapshot stale once its capture is older than 24 hours', () => {
    const evidence = recoveryEvidence();
    evidence[1] = { action: 'launcher.backup.valkey_succeeded', timestamp: '2026-08-30T13:59:59.000Z',
      success: true, details: { capturedAt: '2026-08-30T13:59:59.000Z', checksumSha256: valkeyChecksum } };

    const state = buildRecoveryState(evidence);

    expect(state.backups.valkey.status).toBe('stale');
    expect(state.recovery.status).not.toBe('ready');
  });

  it.each(['database', 'valkey'] as const)('does not hide a newer %s backup failure behind an older success', (kind) => {
    const evidence = recoveryEvidence();
    evidence.push({ action: `launcher.backup.${kind}_failed`, timestamp: '2026-08-31T13:45:00.000Z',
      success: false, details: { errorCode: 'backup-failed' } });

    const state = buildRecoveryState(evidence);

    expect(state.backups[kind].status).toBe('failed');
    expect(state.recovery.status).toBe('failed');
  });

  it.each([
    { label: 'missing', capturedAt: undefined, timestamp: capturedAt },
    { label: 'malformed', capturedAt: 'not-a-date', timestamp: capturedAt },
    { label: 'future capture', capturedAt: '2026-08-31T14:00:01.000Z', timestamp: '2026-08-31T14:00:01.000Z' },
    { label: 'future observation', capturedAt, timestamp: '2026-08-31T14:00:01.000Z' },
  ])('refuses $label snapshot timestamps instead of synthesizing capture time', (fixture) => {
    const evidence = recoveryEvidence();
    evidence[1] = { action: 'launcher.backup.valkey_succeeded', timestamp: fixture.timestamp,
      success: true, details: { capturedAt: fixture.capturedAt, checksumSha256: valkeyChecksum } };

    const state = buildRecoveryState(evidence);

    expect(state.backups.valkey.status).toBe('failed');
    expect(state.recovery.status).not.toBe('ready');
  });

  it('requires current server-derived identity proof, not successful audit labels alone', () => {
    const state = buildRecoveryState(recoveryEvidence(), null);

    expect(state.backups.database.status).toBe('current');
    expect(state.backups.valkey.status).toBe('current');
    expect(state.recovery.status).toBe('unverified');
  });

  it.each([
    { backupId: '22222222-2222-4222-8222-222222222222' },
    { databaseChecksumSha256: 'f'.repeat(64) },
    { valkeyChecksumSha256: 'f'.repeat(64) },
    { rehearsedAt: '2026-08-31T13:31:00.000Z' },
    { rehearsedAt: '2026-08-31T12:59:00.000Z' },
    { expiresAt: '2026-08-31T13:59:59.000Z' },
    { scope: 'database_and_valkey_restored' },
    { deployedExactSha: null },
    { deployedBootId: null },
    { deployedMigrationHead: null },
    { deployedConfigurationGeneration: null },
  ])('rejects mismatched, expired or overclaimed recovery proof %j', (changes) => {
    const state = buildRecoveryState(recoveryEvidence(), { ...recoveryProof, ...changes });

    expect(state.recovery.status).not.toBe('ready');
    expect(state.backups.database.lastRestoreRehearsalAt).toBeNull();
    expect(state.backups.valkey.lastRestoreRehearsalAt).toBeNull();
  });

  it.each([
    { label: 'exact SHA', proof: { ...recoveryProof, deployedExactSha: 'e'.repeat(40) } },
    { label: 'boot ID', proof: { ...recoveryProof, deployedBootId: '33333333-3333-4333-8333-333333333333' } },
    { label: 'migration head', proof: { ...recoveryProof, deployedMigrationHead: '20260831135600_drift.sql' } },
    { label: 'configuration generation', proof: { ...recoveryProof, deployedConfigurationGeneration: deployedConfigurationGeneration + 1 } },
  ])('keeps recovery unverified when proof $label drifts from the current runtime', ({ proof }) => {
    const state = buildRecoveryState(recoveryEvidence(), proof);

    expect(state.recovery.status).toBe('unverified');
    expect(state.recovery.lastRehearsalAt).toBeNull();
  });

  it.each([
    { label: 'exact SHA', identity: { ...recoveryRuntime.identity, exactSha: null } },
    { label: 'boot ID', identity: { ...recoveryRuntime.identity, bootId: null } },
    { label: 'migration head', identity: { ...recoveryRuntime.identity, migrationHead: null } },
    { label: 'configuration generation', identity: { ...recoveryRuntime.identity, configurationGeneration: null } },
  ])('keeps recovery unverified when current runtime $label is unknown', ({ identity }) => {
    const state = buildRecoveryState(recoveryEvidence(), recoveryProof, { ...recoveryRuntime, identity });

    expect(state.recovery.status).toBe('unverified');
    expect(state.recovery.lastRehearsalAt).toBeNull();
  });

  it('invalidates recovery when a newer rehearsal has failed', () => {
    const evidence = recoveryEvidence();
    evidence.push({ action: 'launcher.restore.rehearsal_failed', timestamp: '2026-08-31T13:45:00.000Z',
      success: false, details: { backupId, errorCode: 'restore-validation-failed' } });

    const state = buildRecoveryState(evidence);

    expect(state.recovery.status).toBe('failed');
    expect(state.recovery.lastRehearsalAt).toBeNull();
  });

  it('reports a matched database-only rehearsal without claiming Valkey was restored', () => {
    const state = buildRecoveryState(recoveryEvidence());

    expect(state.recovery).toMatchObject({ status: 'ready', lastRehearsalAt: rehearsedAt, rehearsalScope: 'database' });
    expect(state.backups.database.lastRestoreRehearsalAt).toBe(rehearsedAt);
    expect(state.backups.valkey.lastRestoreRehearsalAt).toBeNull();
    expect(state.recovery.recoveryPointObjectiveMinutes).toBeNull();
    expect(state.recovery.recoveryTimeObjectiveMinutes).toBeNull();
  });

  it('normalizes genuine PostgreSQL timestamp offsets at the evidence boundary', () => {
    const evidence = recoveryEvidence();
    evidence[1] = { action: 'launcher.backup.valkey_succeeded', timestamp: '2026-08-31T13:00:00+00:00',
      success: true, details: { capturedAt: '2026-08-31T13:00:00+00:00', checksumSha256: valkeyChecksum } };

    const state = buildRecoveryState(evidence);

    expect(state.backups.valkey).toMatchObject({ status: 'current', capturedAt });
  });
});
