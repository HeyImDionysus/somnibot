import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDatabaseRecovery } from '../main/database-recovery.js';
import { databaseConnection, DatabaseRecoveryError, type RecoveryCommand } from '../main/database-recovery-contract.js';

vi.mock('node:crypto', async () => {
  const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto');
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))); roots.length = 0; });

const identity = { observedAt: '2026-08-31T12:00:00Z', migrationHead: '20260831135000_test.sql', migrationHash: 'a'.repeat(32), configurationHash: 'b'.repeat(32), adoptionConfigurationHash: 'd'.repeat(32), schemaHash: 'c'.repeat(32), tables: ['guild_config', 'schema_migrations'], userCount: 2, objectCount: 0 };
const source = { projectUrl: 'https://sourceproject.supabase.co', password: 'source secret', template: '', guildId: '123456789012345678' };

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'somnibot-db-recovery-test-'));
  roots.push(directory);
  const run = vi.fn(async (command: RecoveryCommand) => {
    if (command.outputFile) await writeFile(command.outputFile, '-- owned test dump\nSELECT 1;\n');
    if (command.tool === 'docker') return command.args[0] === 'image' ? JSON.stringify([`sha256:${'a'.repeat(64)}`, null]) : '';
    if (command.args.some((arg) => arg.includes("'major',current_setting"))) return JSON.stringify({ major: 15, history: false });
    if (command.args.some((arg) => arg.includes("a.details->'runtimeIdentity'"))) return 'null';
    if (command.args.includes('SELECT to_jsonb(clock_timestamp());')) return JSON.stringify('2026-08-31T12:01:00Z');
    return command.args.includes('--version') ? 'test-version' : JSON.stringify(identity);
  });
  const audit = vi.fn(async () => true);
  return { directory, run, audit, recovery: createDatabaseRecovery(directory, { run, audit }) };
}

describe('database recovery boundaries', () => {
  it('keeps passwords out of process arguments and validates pooler project identity', () => {
    // Given a source password and another project's pooler alias.
    const template = 'postgresql://postgres.otherproject@aws-0-us-east-1.pooler.supabase.com:5432/postgres';
    // When parsing that conflicting connection.
    // Then it is refused, while the legitimate connection exposes only a password-free URL.
    expect(() => databaseConnection({ ...source, template })).toThrow();
    const connection = databaseConnection(source);
    expect(connection.url).not.toContain('secret');
    expect(connection.env.PGPASSWORD).toBe('source secret');
  });

  it('captures owned artifact checksums and emits proof only after successful files', async () => {
    // Given a bounded runner standing in for unavailable provider/client processes.
    const f = await fixture();
    // When the owner requests a backup.
    const result = await f.recovery.backup(source);
    // Then the actual owned files and their manifest exist, with a durable backup audit.
    expect(result.status).toBe('backed-up');
    expect(result.backupId).toMatch(/^[0-9a-f-]{36}$/);
    expect(f.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'launcher.backup.database_succeeded' }), source);
    const entries = await readdir(f.directory);
    expect(entries).toHaveLength(1);
    const manifest = JSON.parse(await readFile(path.join(f.directory, entries[0] ?? '', 'manifest.json'), 'utf8'));
    expect(manifest.storageObjectsIncluded).toBe(false);
    expect(manifest.deployedIdentity).toBeNull();
    expect(JSON.stringify(f.run.mock.calls.map(([command]) => command.args))).not.toContain('source secret');
  });

  it('refuses a production-source alias before running restore', async () => {
    // Given an owned backup and a target that aliases its source project.
    const f = await fixture();
    const backup = await f.recovery.backup(source);
    expect(backup.status).toBe('backed-up');
    f.run.mockClear();
    // When rehearsal is requested against the source.
    const result = await f.recovery.rehearse(source, { ...source, backupId: backup.backupId, confirmation: 'sourceproject' });
    // Then no client or provider process runs.
    expect(result.status).toBe('blocked');
    expect(f.run).not.toHaveBeenCalled();
  });

  it('refuses tampered artifacts without running the restore client', async () => {
    // Given a backup file modified after capture.
    const f = await fixture();
    const backup = await f.recovery.backup(source);
    expect(backup.status).toBe('backed-up');
    await writeFile(path.join(f.directory, backup.backupId ?? '', 'data.sql'), 'SELECT unsafe();');
    f.run.mockClear();
    // When an isolated rehearsal is requested.
    const result = await f.recovery.rehearse(source, { projectUrl: 'https://targetproject.supabase.co', password: 'target secret', template: '', backupId: backup.backupId, confirmation: 'targetproject' });
    // Then checksum validation blocks every external process.
    expect(result.status).toBe('blocked');
    expect(f.run).not.toHaveBeenCalled();
  });

  it('rehearses only the captured files with the unused-target guard before every restore file', async () => {
    // Given an intact owned artifact set and an explicit different target.
    const f = await fixture();
    const backup = await f.recovery.backup(source);
    expect(backup.status).toBe('backed-up');
    f.run.mockClear();
    // When the owner confirms that exact target project.
    const result = await f.recovery.rehearse(source, { projectUrl: 'https://targetproject.supabase.co', password: 'target secret', template: '', backupId: backup.backupId, confirmation: 'targetproject' });
    // Then the guard, dump files, and validation share one fail-fast transaction.
    expect(result.status).toBe('rehearsed');
    expect(f.run).toHaveBeenCalledTimes(2);
    const command = f.run.mock.calls[0]?.[0];
    expect(command?.env.PGPASSWORD).toBe('target secret');
    expect(command?.args).toContain('--single-transaction');
    expect(command?.args.indexOf('--command')).toBeLessThan(command?.args.indexOf('--file') ?? 0);
    expect(command?.args.filter((arg) => arg.endsWith('.sql'))).toEqual(['roles.sql', 'schema.sql', 'data.sql'].map((name) => path.join(f.directory, backup.backupId ?? '', name)));
    expect(command?.args.at(-1)).not.toContain('artifactChecksums');
    expect(JSON.stringify(command?.args)).not.toContain('target secret');
    expect(f.audit).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'launcher.restore.rehearsal_succeeded', details: expect.objectContaining({ validated: true, targetProjectRef: 'targetproject' }) }), source);
  });

  it('preserves the last good backup when a later dump fails and redacts native failures', async () => {
    // Given an earlier complete backup and a later client failure.
    const f = await fixture();
    const first = await f.recovery.backup(source);
    expect(first.status).toBe('backed-up');
    const implementation = f.run.getMockImplementation();
    f.run.mockImplementation(async (command) => {
      if (command.outputFile?.endsWith('data.sql')) throw new Error('PGPASSWORD=source secret');
      if (!implementation) throw new Error('fixture missing');
      return implementation(command);
    });
    // When another backup fails partway through capture.
    const result = await f.recovery.backup(source);
    // Then only its owned partial directory is removed, and no secret escapes.
    expect(result.status).toBe('blocked');
    expect(JSON.stringify(result)).not.toContain('source secret');
    expect(await readdir(f.directory)).toEqual([first.backupId]);
    expect(f.audit).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'launcher.backup.database_failed', success: false }), source);
  });

  it('requires missing native clients instead of installing or claiming a backup', async () => {
    // Given a machine without the required client.
    const f = await fixture();
    f.run.mockRejectedValue(new DatabaseRecoveryError('missing-client-prerequisite'));
    // When backup is requested.
    const result = await f.recovery.backup(source);
    // Then a prerequisite state is returned without artifacts or success proof.
    expect(result.status).toBe('needs-prerequisite');
    expect(await readdir(f.directory)).toEqual([]);
    expect(f.audit).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'launcher.backup.database_succeeded' }), source);
  });

  it('preserves an existing backup directory when exclusive directory creation fails', async () => {
    const f = await fixture();
    const existingId = '11111111-1111-4111-8111-111111111111';
    vi.mocked(randomUUID).mockReturnValueOnce(existingId);
    expect((await f.recovery.backup(source)).status).toBe('backed-up');
    const existingManifest = await readFile(path.join(f.directory, existingId, 'manifest.json'), 'utf8');
    f.run.mockClear();
    vi.mocked(randomUUID).mockReturnValueOnce(existingId);

    const result = await f.recovery.backup(source);

    expect(result.status).toBe('blocked');
    expect(await readdir(f.directory)).toEqual([existingId]);
    expect(await readFile(path.join(f.directory, existingId, 'manifest.json'), 'utf8')).toBe(existingManifest);
    expect(f.run.mock.calls.some(([command]) => command.outputFile)).toBe(false);
    expect(f.audit).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'launcher.backup.database_failed', success: false }), source);
  });

  it('fails capture if configuration changes between its boundary observations', async () => {
    // Given a source whose configuration changes during the dump.
    const f = await fixture();
    const implementation = f.run.getMockImplementation();
    let identities = 0;
    f.run.mockImplementation(async (command) => {
      if (command.args.some((arg) => arg.includes("'configurationHash'"))) return JSON.stringify({ ...identity, configurationHash: ++identities === 1 ? 'b'.repeat(32) : 'e'.repeat(32) });
      if (!implementation) throw new Error('fixture missing');
      return implementation(command);
    });
    // When capture reaches its final source check.
    const result = await f.recovery.backup(source);
    // Then drift prevents a successful backup receipt and removes only the partial capture.
    expect(result.message).toContain('source-changed-during-backup');
    expect(await readdir(f.directory)).toEqual([]);
  });

  it('retains backup artifacts and emits failure when the target transaction rejects restore', async () => {
    // Given a complete capture and a target whose guarded transaction fails.
    const f = await fixture();
    const backup = await f.recovery.backup(source);
    expect(backup.status).toBe('backed-up');
    f.run.mockRejectedValue(new DatabaseRecoveryError('client-command-failed'));
    // When a target rehearsal fails.
    const result = await f.recovery.rehearse(source, { projectUrl: 'https://targetproject.supabase.co', password: 'target secret', backupId: backup.backupId, confirmation: 'targetproject' });
    // Then it cannot emit successful rehearsal evidence or delete the backup.
    expect(result.status).toBe('blocked');
    expect(await readdir(f.directory)).toEqual([backup.backupId]);
    expect(f.audit).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'launcher.restore.rehearsal_failed', success: false }), source);
  });
});
