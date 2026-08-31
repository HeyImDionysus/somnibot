import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LauncherAuditEntry } from './audit-log.js';
import { databaseConnection, DatabaseRecoveryError, type RecoveryCommand, type RecoveryResult, type RecoverySource, type RehearsalRequest } from './database-recovery-contract.js';
import { checkRecoveryCapacity, RECOVERY_MAX_BYTES } from './database-recovery-process.js';
import { describeArtifact, manifestChecksum, RECOVERY_ARTIFACTS, RECOVERY_HISTORY_ARTIFACTS, saveManifest, verifyOwnedArtifacts, type RecoveryManifest } from './database-recovery-artifacts.js';
import { parseRecoveryIdentity, RECOVERY_IDENTITY_SQL, RECOVERY_TARGET_GUARD_SQL, recoveryValidationSql, recoveryTimestamp } from './database-recovery-sql.js';
import { observeRecoveryRuntime } from './database-recovery-runtime.js';
import { loadRecoveryResources, type RecoveryVariant } from './database-recovery-resources.js';
import { prepareRecoveryImage, dumpRecoveryArtifact } from './database-recovery-docker.js';

export type RecoveryDependencies = {
  readonly run: (command: RecoveryCommand) => Promise<string>;
  readonly audit: (entry: LauncherAuditEntry, source: RecoverySource) => Promise<boolean>;
};
export function createDatabaseRecovery(root: string, dependencies: RecoveryDependencies) {
  const backups = new Map<string, RecoveryManifest>();
  let busy = false;
  const psqlArgs = ['--no-psqlrc', '--quiet', '--tuples-only', '--no-align', '--set', 'ON_ERROR_STOP=1'];
  const runExclusive = async (operation: () => Promise<RecoveryResult>): Promise<RecoveryResult> => {
    if (busy) return { status: 'busy', message: 'Another database recovery operation is running.' };
    busy = true;
    try { return await operation(); } finally { busy = false; }
  };
  const proofDetails = (manifest: RecoveryManifest) => ({
    backupId: manifest.backupId, capturedAt: manifest.capturedAt, checksumSha256: manifestChecksum(manifest),
    sourceProjectRef: manifest.sourceProjectRef, migrationHead: manifest.migrationHead, migrationHash: manifest.migrationHash,
    configurationHash: manifest.configurationHash, adoptionConfigurationHash: manifest.adoptionConfigurationHash,
    schemaHash: manifest.schemaHash, artifactChecksums: manifest.artifacts, storageObjectsIncluded: false, deployedIdentity: manifest.deployedIdentity,
  });
  const failed = async (context: { readonly action: string; readonly source: RecoverySource; readonly backupId?: string }, error: unknown): Promise<RecoveryResult> => {
    const code = error instanceof DatabaseRecoveryError ? error.code : 'recovery-operation-failed';
    await dependencies.audit({ action: context.action, category: 'infrastructure', success: false, details: { errorCode: code, backupId: context.backupId ?? null } }, context.source);
    return { status: code.endsWith('-prerequisite') ? 'needs-prerequisite' : 'blocked', message: `Database recovery stopped: ${code}. No production restore was attempted.${context.backupId ? ' The isolated target may retain data; keep it isolated.' : ''}`, ...(context.backupId ? { backupId: context.backupId } : {}) };
  };
  return {
    backup: (source: RecoverySource): Promise<RecoveryResult> => runExclusive(async () => {
      let directory: string | null = null;
      let retained = false;
      try {
        const connection = databaseConnection(source);
        const sourceEnv = { ...connection.env, PGOPTIONS: `${connection.env.PGOPTIONS} -c default_transaction_read_only=on` };
        if (!/^\d{17,20}$/.test(source.guildId)) throw new DatabaseRecoveryError('missing-source-server');
        await mkdir(root, { recursive: true, mode: 0o700 });
        await checkRecoveryCapacity(root);
        await dependencies.run({ tool: 'psql', args: ['--version'], env: {} });
        const query = { tool: 'psql' as const, args: [...psqlArgs, '--dbname', connection.url, '--command', RECOVERY_IDENTITY_SQL], env: sourceEnv };
        const metadataRaw = await dependencies.run({ ...query, args: [...psqlArgs, '--dbname', connection.url, '--command', "SELECT jsonb_build_object('major',current_setting('server_version_num')::int / 10000,'history',to_regnamespace('supabase_migrations') IS NOT NULL);"] });
        const metadata: unknown = JSON.parse(metadataRaw);
        if (!metadata || typeof metadata !== 'object' || !('major' in metadata) || typeof metadata.major !== 'number' || !Number.isInteger(metadata.major) || !('history' in metadata) || typeof metadata.history !== 'boolean') throw new DatabaseRecoveryError('database-metadata-unavailable');
        const resources = await loadRecoveryResources(String(metadata.major));
        const image = await prepareRecoveryImage(resources, dependencies.run);
        const before = parseRecoveryIdentity(await dependencies.run(query));
        const deployedIdentity = await observeRecoveryRuntime(query, source.guildId, dependencies.run);
        const backupId = randomUUID();
        const candidateDirectory = path.resolve(root, backupId);
        await mkdir(candidateDirectory, { mode: 0o700 });
        directory = candidateDirectory;
        await chmod(directory, 0o700);
        const artifacts = [];
        const names = metadata.history ? [...RECOVERY_ARTIFACTS, ...RECOVERY_HISTORY_ARTIFACTS] : RECOVERY_ARTIFACTS;
        const variants: Readonly<Record<string, RecoveryVariant>> = { 'roles.sql': 'roles', 'schema.sql': 'schema', 'data.sql': 'data', 'history-schema.sql': 'historySchema', 'history-data.sql': 'historyData' };
        for (const name of names) {
          const file = path.join(directory, name);
          await writeFile(file, '', { flag: 'wx', mode: 0o600 });
          const variant = variants[name];
          if (!variant) throw new DatabaseRecoveryError('invalid-artifact-variant');
          await dumpRecoveryArtifact({ resources, image, variant, env: sourceEnv, directory, outputFile: file,
            remainingBytes: RECOVERY_MAX_BYTES - artifacts.reduce((bytes, artifact) => bytes + artifact.bytes, 0) }, dependencies.run);
          artifacts.push(await describeArtifact(directory, name));
          if (artifacts.reduce((bytes, artifact) => bytes + artifact.bytes, 0) > RECOVERY_MAX_BYTES) throw new DatabaseRecoveryError('artifact-size-limit');
        }
        const afterRaw = await dependencies.run(query);
        const after = parseRecoveryIdentity(afterRaw);
        const runtimeAfter = await observeRecoveryRuntime(query, source.guildId, dependencies.run);
        if (JSON.stringify(before) !== JSON.stringify(after) || JSON.stringify(deployedIdentity) !== JSON.stringify(runtimeAfter)) throw new DatabaseRecoveryError('source-changed-during-backup');
        const manifest: RecoveryManifest = { ...before, backupId, guildId: source.guildId, capturedAt: recoveryTimestamp(afterRaw),
          sourceProjectRef: connection.projectRef, artifacts, storageObjectsIncluded: false, deployedIdentity,
          consistency: 'single-data-snapshot-with-stable-schema-config-checks' };
        await saveManifest(directory, manifest);
        if (artifacts.reduce((bytes, artifact) => bytes + artifact.bytes, 0) + (await describeArtifact(directory, 'manifest.json')).bytes > RECOVERY_MAX_BYTES) throw new DatabaseRecoveryError('artifact-size-limit');
        backups.set(backupId, manifest);
        retained = true;
        const audited = await dependencies.audit({ action: 'launcher.backup.database_succeeded', category: 'infrastructure', targetType: 'database_backup',
          targetId: backupId, occurrenceKey: `launcher.backup.database_succeeded:${backupId}`, details: proofDetails(manifest) }, source);
        return { status: 'backed-up', backupId, message: audited
          ? `Logical database backup captured in ${directory}. Storage object bytes and provider configuration are excluded.`
          : `Logical backup retained in ${directory}, but durable audit recording failed. Recovery readiness remains unverified.` };
      } catch (error) { return await failed({ action: 'launcher.backup.database_failed', source }, error); }
      finally {
        if (directory && !retained && path.dirname(directory) === path.resolve(root) && /^[0-9a-f-]{36}$/.test(path.basename(directory))) await rm(directory, { recursive: true, force: true });
      }
    }),
    rehearse: (source: RecoverySource, request: RehearsalRequest): Promise<RecoveryResult> => runExclusive(async () => {
      try {
        const manifest = request.backupId ? backups.get(request.backupId) : undefined;
        if (!manifest) throw new DatabaseRecoveryError('needs-current-owned-backup');
        const current = databaseConnection(source);
        const target = databaseConnection(request);
        if (current.projectRef !== manifest.sourceProjectRef || source.guildId !== manifest.guildId) throw new DatabaseRecoveryError('source-context-changed');
        if (target.projectRef === manifest.sourceProjectRef || request.confirmation !== target.projectRef) throw new DatabaseRecoveryError('isolated-target-required');
        const directory = await verifyOwnedArtifacts(root, manifest);
        await checkRecoveryCapacity(directory, 0);
        const args = [...psqlArgs, '--dbname', target.url, '--single-transaction', '--command', RECOVERY_TARGET_GUARD_SQL];
        for (const artifact of manifest.artifacts) args.push('--file', path.join(directory, artifact.name));
        args.push('--command', recoveryValidationSql(parseRecoveryIdentity(JSON.stringify(manifest))));
        await dependencies.run({ tool: 'psql', args, env: target.env, directory });
        const rehearsedAt = recoveryTimestamp(await dependencies.run({ tool: 'psql',
          args: [...psqlArgs, '--dbname', current.url, '--command', 'SELECT to_jsonb(clock_timestamp());'],
          env: { ...current.env, PGOPTIONS: `${current.env.PGOPTIONS} -c default_transaction_read_only=on` } }));
        const audited = await dependencies.audit({ action: 'launcher.restore.rehearsal_succeeded', category: 'infrastructure', targetType: 'isolated_database_rehearsal',
          targetId: manifest.backupId, occurrenceKey: `launcher.restore.rehearsal_succeeded:${manifest.backupId}:${rehearsedAt}`,
          details: { ...proofDetails(manifest), targetProjectRef: target.projectRef, validated: true, rehearsedAt } }, source);
        return { status: 'rehearsed', backupId: manifest.backupId, message: audited
          ? 'Isolated logical restore validated. The target now contains sensitive source data; keep it isolated. Storage object bytes were not restored.'
          : 'Isolated logical restore validated, but audit recording failed. Readiness remains unverified; target data is retained.' };
      } catch (error) { return await failed({ action: 'launcher.restore.rehearsal_failed', source, backupId: request.backupId }, error); }
    }),
  };
}
