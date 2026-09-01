import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadRecoveryManifest, manifestChecksum, type RecoveryManifest } from '../main/database-recovery-artifacts.js';
import { createDatabaseRecovery } from '../main/database-recovery.js';
import type { RecoveryCommand } from '../main/database-recovery-contract.js';

const roots: string[] = [];
const identity = { observedAt: '2026-08-31T12:00:00Z', migrationHead: '20260831135000_test.sql', migrationHash: 'a'.repeat(32), configurationHash: 'b'.repeat(32), adoptionConfigurationHash: 'd'.repeat(32), schemaHash: 'c'.repeat(32), tables: ['guild_config'], userCount: 2, objectCount: 0 };
const source = { projectUrl: 'https://sourceproject.supabase.co', password: 'source secret', template: '', guildId: '123456789012345678' };
const target = { projectUrl: 'https://targetproject.supabase.co', password: 'target secret', template: '', confirmation: 'targetproject' };

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.map(async (root) => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'somnibot-db-authenticity-test-'));
  roots.push(directory);
  const run = vi.fn(async (command: RecoveryCommand) => {
    if (command.outputFile) await writeFile(command.outputFile, '-- captured dump\nSELECT 1;\n');
    if (command.tool === 'docker') return command.args[0] === 'image' ? JSON.stringify([`sha256:${'a'.repeat(64)}`, null]) : '';
    if (command.args.some((arg) => arg.includes("'major',current_setting"))) return JSON.stringify({ major: 15, history: false });
    if (command.args.some((arg) => arg.includes("a.details->'runtimeIdentity'"))) return 'null';
    if (command.args.includes('SELECT to_jsonb(clock_timestamp());')) return JSON.stringify('2026-08-31T12:01:00Z');
    return command.args.includes('--version') ? 'test-version' : JSON.stringify(identity);
  });
  let anchorChecksum = '';
  const audit = vi.fn(async (entry: { readonly action: string; readonly details?: Record<string, unknown> }) => {
    const checksum = entry.details?.checksumSha256;
    if (entry.action === 'launcher.backup.database_succeeded' && typeof checksum === 'string') anchorChecksum = checksum;
    return true;
  });
  const authenticate = vi.fn(async (manifest: RecoveryManifest, _source: typeof source, _timeoutMs: number) => manifestChecksum(manifest) === anchorChecksum);
  return { directory, run, audit, authenticate, recovery: createDatabaseRecovery(directory, { run, audit, authenticate }) };
}

describe('retained database backup authenticity', () => {
  it('rejects forged SQL and a self-consistent rewritten manifest before discovery or psql', async () => {
    // Given a valid backup whose writable SQL and local hashes are all replaced together.
    const f = await fixture();
    const backup = await f.recovery.backup(source);
    expect(backup.status).toBe('backed-up');
    const backupId = backup.backupId ?? '';
    const original = await loadRecoveryManifest(f.directory, backupId);
    const forgedSql = 'SELECT unsafe();\n';
    const forgedArtifacts = original.artifacts.map((artifact) => artifact.name === 'data.sql'
      ? { ...artifact, bytes: Buffer.byteLength(forgedSql), sha256: createHash('sha256').update(forgedSql).digest('hex') }
      : artifact);
    await writeFile(path.join(f.directory, backupId, 'data.sql'), forgedSql);
    await writeFile(path.join(f.directory, backupId, 'manifest.json'), JSON.stringify({ ...original, artifacts: forgedArtifacts }));
    f.run.mockClear();
    const restarted = createDatabaseRecovery(f.directory, { run: f.run, audit: f.audit, authenticate: f.authenticate });

    // When discovery and rehearsal inspect the locally self-consistent forgery.
    const summary = await restarted.latestBackup(source);
    const result = await restarted.rehearse(source, { ...target, backupId });

    // Then the independent checksum anchor rejects it before any database process.
    expect(summary).toBeNull();
    expect(result.status).toBe('blocked');
    expect(f.run).not.toHaveBeenCalled();
  });

  it('accepts an anchored retained backup after service restart', async () => {
    // Given a backup with its successful checksum receipt outside the retained directory.
    const f = await fixture();
    const backup = await f.recovery.backup(source);
    expect(backup.status).toBe('backed-up');
    f.run.mockClear();
    const restarted = createDatabaseRecovery(f.directory, { run: f.run, audit: f.audit, authenticate: f.authenticate });

    // When the recreated recovery service discovers and rehearses it.
    const summary = await restarted.latestBackup(source);
    const result = await restarted.rehearse(source, { ...target, backupId: backup.backupId });

    // Then the exact anchored candidate remains usable and supplies only stdin to psql.
    expect(summary?.backupId).toBe(backup.backupId);
    expect(result.status).toBe('rehearsed');
    expect(f.run.mock.calls[0]?.[0].input?.toString('utf8')).toContain('SELECT 1;');
  });

  it('rejects an implausibly future-dated retained candidate before authentication', async () => {
    // Given locally intact bytes whose manifest claims a far-future capture.
    const f = await fixture();
    const backup = await f.recovery.backup(source);
    const backupId = backup.backupId ?? '';
    const manifest = await loadRecoveryManifest(f.directory, backupId);
    await writeFile(path.join(f.directory, backupId, 'manifest.json'), JSON.stringify({ ...manifest, capturedAt: '2999-01-01T00:00:00.000Z' }));
    f.authenticate.mockClear();
    f.run.mockClear();

    // When discovery and rehearsal parse that candidate.
    const summary = await f.recovery.latestBackup(source);
    const result = await f.recovery.rehearse(source, { ...target, backupId });

    // Then time validation fails closed before the anchor or database boundary.
    expect(summary).toBeNull();
    expect(result.status).toBe('blocked');
    expect(f.authenticate).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
  });

  it('does not reach psql when the durable anchor is unavailable', async () => {
    // Given a valid local backup but an unavailable source-side audit store.
    const f = await fixture();
    const backup = await f.recovery.backup(source);
    f.authenticate.mockResolvedValue(false);
    f.run.mockClear();

    // When the retained candidate is offered or rehearsed.
    const summary = await f.recovery.latestBackup(source);
    const result = await f.recovery.rehearse(source, { ...target, backupId: backup.backupId });

    // Then both paths fail closed without executing a database command.
    expect(summary).toBeNull();
    expect(result.status).toBe('blocked');
    expect(f.run).not.toHaveBeenCalled();
  });

  it('sorts candidates locally and falls back to the newest authenticated backup', async () => {
    // Given two intact candidates where the lexically newest equal-time backup has no matching anchor.
    const f = await fixture();
    const backups = [await f.recovery.backup(source), await f.recovery.backup(source)];
    const backupIds = backups.map((backup) => backup.backupId ?? '').sort((left, right) => right.localeCompare(left));
    const unauthenticatedId = backupIds[0] ?? '';
    const expectedId = backupIds[1] ?? '';
    f.authenticate.mockClear();
    f.authenticate.mockImplementation(async (manifest: RecoveryManifest) => manifest.backupId !== unauthenticatedId);

    // When retained-backup discovery checks candidates in newest-first order.
    const summary = await f.recovery.latestBackup(source);

    // Then it authenticates only as far as the first valid fallback and supplies per-attempt time budgets.
    expect(summary?.backupId).toBe(expectedId);
    expect(f.authenticate.mock.calls.map(([manifest]) => manifest.backupId)).toEqual([unauthenticatedId, expectedId]);
    for (const call of f.authenticate.mock.calls) {
      expect(call[2]).toBeGreaterThan(0);
      expect(call[2]).toBeLessThanOrEqual(2_500);
    }
  });

  it('bounds unavailable multi-candidate authentication to one aggregate deadline', async () => {
    // Given more retained candidates than the authentication cap and a source API that consumes each attempt budget.
    const f = await fixture();
    for (let index = 0; index < 9; index += 1) expect((await f.recovery.backup(source)).status).toBe('backed-up');
    f.authenticate.mockClear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T00:00:00.000Z'));
    f.authenticate.mockImplementation(async (_manifest: RecoveryManifest, _source: typeof source, timeoutMs: number) => {
      expect(timeoutMs).toBeGreaterThan(0);
      expect(timeoutMs).toBeLessThanOrEqual(2_500);
      vi.setSystemTime(Date.now() + 3_000);
      return false;
    });

    // When discovery cannot authenticate any candidate before its ten-second aggregate deadline.
    const summary = await f.recovery.latestBackup(source);

    // Then it fails closed after four bounded attempts instead of serializing every retained candidate.
    expect(summary).toBeNull();
    expect(f.authenticate).toHaveBeenCalledTimes(4);
  });
});
