import { createHash } from 'node:crypto';
import { lstat, open, opendir, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RuntimeIdentitySchema, type RuntimeIdentity } from '@somnibot/shared';
import { DatabaseRecoveryError } from './database-recovery-contract.js';
import { RECOVERY_MAX_BYTES } from './database-recovery-process.js';
import type { RecoveryIdentity } from './database-recovery-sql.js';

export const RECOVERY_ARTIFACTS = ['roles.sql', 'schema.sql', 'data.sql'] as const;
export const RECOVERY_HISTORY_ARTIFACTS = ['history-schema.sql', 'history-data.sql'] as const;
export type RecoveryArtifact = { readonly name: string; readonly bytes: number; readonly sha256: string };
export type RecoveryBackupSummary = { readonly backupId: string; readonly capturedAt: string };
export type RecoveryManifest = RecoveryIdentity & {
  readonly backupId: string;
  readonly guildId: string;
  readonly capturedAt: string;
  readonly sourceProjectRef: string;
  readonly artifacts: readonly RecoveryArtifact[];
  readonly storageObjectsIncluded: false;
  readonly deployedIdentity: RuntimeIdentity | null;
  readonly consistency: 'single-data-snapshot-with-stable-schema-config-checks';
};
type RecoverySourceIdentity = { readonly sourceProjectRef: string; readonly guildId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH_32 = /^[0-9a-f]{32}$/;
const HASH_64 = /^[0-9a-f]{64}$/;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_CATALOG_ENTRIES = 256;
const MAX_TABLES = 1_000;
const MANIFEST_KEYS = ['adoptionConfigurationHash', 'artifacts', 'backupId', 'capturedAt', 'configurationHash', 'consistency', 'deployedIdentity', 'guildId', 'migrationHash', 'migrationHead', 'objectCount', 'schemaHash', 'sourceProjectRef', 'storageObjectsIncluded', 'tables', 'userCount'] as const;
const ARTIFACT_KEYS = ['bytes', 'name', 'sha256'] as const;
const RUNTIME_IDENTITY_KEYS = ['bootId', 'configurationGeneration', 'deploymentProfile', 'exactSha', 'lifecycle', 'migrationHead', 'version'] as const;

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function parseArtifact(value: unknown): RecoveryArtifact | null {
  if (!value || typeof value !== 'object' || !hasExactKeys(value, ARTIFACT_KEYS)
    || !('name' in value) || typeof value.name !== 'string'
    || !('bytes' in value) || typeof value.bytes !== 'number' || !Number.isSafeInteger(value.bytes) || value.bytes <= 0 || value.bytes > RECOVERY_MAX_BYTES
    || !('sha256' in value) || typeof value.sha256 !== 'string' || !HASH_64.test(value.sha256)) return null;
  return { name: value.name, bytes: value.bytes, sha256: value.sha256 };
}

function parseManifest(value: unknown, backupId: string): RecoveryManifest {
  if (!value || typeof value !== 'object' || !hasExactKeys(value, MANIFEST_KEYS)
    || !('backupId' in value) || value.backupId !== backupId || typeof value.backupId !== 'string' || !UUID.test(value.backupId)
    || !('guildId' in value) || typeof value.guildId !== 'string' || !/^\d{17,20}$/.test(value.guildId)
    || !('capturedAt' in value) || typeof value.capturedAt !== 'string' || !Number.isFinite(Date.parse(value.capturedAt)) || new Date(value.capturedAt).toISOString() !== value.capturedAt
    || !('sourceProjectRef' in value) || typeof value.sourceProjectRef !== 'string' || !/^[a-z0-9]{1,63}$/.test(value.sourceProjectRef)
    || !('migrationHead' in value) || typeof value.migrationHead !== 'string' || !/^\d{14}_[a-z0-9_]+\.sql$/.test(value.migrationHead)
    || !('migrationHash' in value) || typeof value.migrationHash !== 'string' || !HASH_32.test(value.migrationHash)
    || !('configurationHash' in value) || typeof value.configurationHash !== 'string' || !HASH_32.test(value.configurationHash)
    || !('adoptionConfigurationHash' in value) || typeof value.adoptionConfigurationHash !== 'string' || !HASH_32.test(value.adoptionConfigurationHash)
    || !('schemaHash' in value) || typeof value.schemaHash !== 'string' || !HASH_32.test(value.schemaHash)
    || !('tables' in value) || !Array.isArray(value.tables) || value.tables.length > MAX_TABLES
    || !value.tables.every((table: unknown): table is string => typeof table === 'string' && table.length > 0 && table.length <= 128 && !table.includes('\0'))
    || new Set(value.tables).size !== value.tables.length
    || !('userCount' in value) || typeof value.userCount !== 'number' || !Number.isSafeInteger(value.userCount) || value.userCount < 0
    || !('objectCount' in value) || typeof value.objectCount !== 'number' || !Number.isSafeInteger(value.objectCount) || value.objectCount < 0
    || !('storageObjectsIncluded' in value) || value.storageObjectsIncluded !== false
    || !('consistency' in value) || value.consistency !== 'single-data-snapshot-with-stable-schema-config-checks'
    || !('artifacts' in value) || !Array.isArray(value.artifacts)) throw new DatabaseRecoveryError('retained-manifest-invalid');
  const artifacts = value.artifacts.map(parseArtifact);
  if (artifacts.some((artifact) => artifact === null)) throw new DatabaseRecoveryError('retained-manifest-invalid');
  const parsedArtifacts = artifacts.filter((artifact): artifact is RecoveryArtifact => artifact !== null);
  const names = parsedArtifacts.map((artifact) => artifact.name);
  const ordinaryNames = [...RECOVERY_ARTIFACTS];
  const historyNames = [...RECOVERY_ARTIFACTS, ...RECOVERY_HISTORY_ARTIFACTS];
  if (JSON.stringify(names) !== JSON.stringify(ordinaryNames) && JSON.stringify(names) !== JSON.stringify(historyNames)) throw new DatabaseRecoveryError('retained-manifest-invalid');
  if (parsedArtifacts.reduce((bytes, artifact) => bytes + artifact.bytes, 0) > RECOVERY_MAX_BYTES) throw new DatabaseRecoveryError('artifact-size-limit');
  if (!('deployedIdentity' in value)) throw new DatabaseRecoveryError('retained-manifest-invalid');
  if (value.deployedIdentity !== null && (typeof value.deployedIdentity !== 'object' || !hasExactKeys(value.deployedIdentity, RUNTIME_IDENTITY_KEYS))) throw new DatabaseRecoveryError('retained-manifest-invalid');
  const runtime = value.deployedIdentity === null ? null : RuntimeIdentitySchema.safeParse(value.deployedIdentity);
  if (runtime !== null && !runtime.success) throw new DatabaseRecoveryError('retained-manifest-invalid');
  return { migrationHead: value.migrationHead, migrationHash: value.migrationHash, configurationHash: value.configurationHash,
    adoptionConfigurationHash: value.adoptionConfigurationHash, schemaHash: value.schemaHash, tables: value.tables,
    userCount: value.userCount, objectCount: value.objectCount, backupId: value.backupId, guildId: value.guildId,
    capturedAt: value.capturedAt, sourceProjectRef: value.sourceProjectRef, artifacts: parsedArtifacts,
    storageObjectsIncluded: false, deployedIdentity: runtime === null ? null : runtime.data,
    consistency: 'single-data-snapshot-with-stable-schema-config-checks' };
}

export function manifestChecksum(manifest: RecoveryManifest): string {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

export async function describeArtifact(directory: string, name: string): Promise<RecoveryArtifact> {
  const file = path.join(directory, name);
  const linkStat = await lstat(file);
  if (!linkStat.isFile() || linkStat.isSymbolicLink() || linkStat.nlink !== 1 || linkStat.size === 0 || linkStat.size > RECOVERY_MAX_BYTES
    || await realpath(file) !== file) throw new DatabaseRecoveryError('invalid-artifact');
  const handle = await open(file, 'r');
  const digest = createHash('sha256');
  let bytes = 0;
  try {
    const openedStat = await handle.stat();
    if (openedStat.dev !== linkStat.dev || openedStat.ino !== linkStat.ino) throw new DatabaseRecoveryError('artifact-changed-during-read');
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      if (bytes > RECOVERY_MAX_BYTES) throw new DatabaseRecoveryError('artifact-size-limit');
      digest.update(chunk);
    }
    const finalStat = await handle.stat();
    if (finalStat.size !== openedStat.size || finalStat.mtimeMs !== openedStat.mtimeMs) throw new DatabaseRecoveryError('artifact-changed-during-read');
  } finally {
    await handle.close();
  }
  if (bytes !== linkStat.size) throw new DatabaseRecoveryError('artifact-changed-during-read');
  return { name, bytes, sha256: digest.digest('hex') };
}

export async function verifyOwnedArtifacts(root: string, manifest: RecoveryManifest): Promise<string> {
  const directory = path.resolve(root, manifest.backupId);
  if (path.dirname(directory) !== path.resolve(root) || await realpath(directory) !== directory) throw new DatabaseRecoveryError('invalid-owned-directory');
  const expected = [...manifest.artifacts.map((artifact) => artifact.name), 'manifest.json'].sort();
  if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify(expected)) throw new DatabaseRecoveryError('artifact-set-changed');
  for (const artifact of manifest.artifacts) {
    if (JSON.stringify(await describeArtifact(directory, artifact.name)) !== JSON.stringify(artifact)) throw new DatabaseRecoveryError('artifact-checksum-mismatch');
  }
  const actualManifest = await describeArtifact(directory, 'manifest.json');
  if (actualManifest.sha256 !== manifestChecksum(manifest)) throw new DatabaseRecoveryError('manifest-checksum-mismatch');
  return directory;
}

export async function snapshotOwnedArtifacts(root: string, manifest: RecoveryManifest): Promise<Buffer> {
  const directory = await verifyOwnedArtifacts(root, manifest);
  const snapshotBytes = manifest.artifacts.reduce((bytes, artifact) => bytes + artifact.bytes + 1, 0);
  if (snapshotBytes > RECOVERY_MAX_BYTES) throw new DatabaseRecoveryError('artifact-size-limit');
  const snapshot = Buffer.allocUnsafe(snapshotBytes);
  let offset = 0;
  for (const artifact of manifest.artifacts) {
    const file = path.join(directory, artifact.name);
    const linkStat = await lstat(file);
    if (!linkStat.isFile() || linkStat.isSymbolicLink() || linkStat.nlink !== 1 || linkStat.size !== artifact.bytes
      || await realpath(file) !== file) throw new DatabaseRecoveryError('artifact-changed-before-snapshot');
    const handle = await open(file, 'r');
    try {
      const openedStat = await handle.stat();
      if (openedStat.dev !== linkStat.dev || openedStat.ino !== linkStat.ino || openedStat.size !== artifact.bytes) throw new DatabaseRecoveryError('artifact-changed-before-snapshot');
      let artifactOffset = 0;
      while (artifactOffset < artifact.bytes) {
        const result = await handle.read(snapshot, offset + artifactOffset, artifact.bytes - artifactOffset, artifactOffset);
        if (result.bytesRead === 0) throw new DatabaseRecoveryError('artifact-changed-during-snapshot');
        artifactOffset += result.bytesRead;
      }
      const finalStat = await handle.stat();
      if (finalStat.size !== openedStat.size || finalStat.mtimeMs !== openedStat.mtimeMs) throw new DatabaseRecoveryError('artifact-changed-during-snapshot');
      const digest = createHash('sha256').update(snapshot.subarray(offset, offset + artifact.bytes)).digest('hex');
      if (digest !== artifact.sha256) throw new DatabaseRecoveryError('artifact-checksum-mismatch');
    } finally {
      await handle.close();
    }
    offset += artifact.bytes;
    snapshot[offset] = 0x0a;
    offset += 1;
  }
  return snapshot;
}

export async function saveManifest(directory: string, manifest: RecoveryManifest): Promise<void> {
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
}

export async function loadRecoveryManifest(root: string, backupId: string): Promise<RecoveryManifest> {
  try {
    if (!UUID.test(backupId)) throw new DatabaseRecoveryError('retained-backup-invalid');
    const ownedRoot = path.resolve(root);
    const rootStat = await lstat(ownedRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await realpath(ownedRoot) !== ownedRoot) throw new DatabaseRecoveryError('invalid-owned-directory');
    const directory = path.resolve(ownedRoot, backupId);
    const directoryStat = await lstat(directory);
    if (path.dirname(directory) !== ownedRoot || !directoryStat.isDirectory() || directoryStat.isSymbolicLink() || await realpath(directory) !== directory) throw new DatabaseRecoveryError('invalid-owned-directory');
    const manifestFile = path.join(directory, 'manifest.json');
    const manifestStat = await lstat(manifestFile);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.nlink !== 1 || manifestStat.size === 0
      || manifestStat.size > MAX_MANIFEST_BYTES || await realpath(manifestFile) !== manifestFile) throw new DatabaseRecoveryError('retained-manifest-invalid');
    const handle = await open(manifestFile, 'r');
    let raw = '';
    try {
      const openedStat = await handle.stat();
      if (openedStat.dev !== manifestStat.dev || openedStat.ino !== manifestStat.ino) throw new DatabaseRecoveryError('retained-manifest-invalid');
      raw = await handle.readFile('utf8');
      const finalStat = await handle.stat();
      if (finalStat.size !== openedStat.size || finalStat.mtimeMs !== openedStat.mtimeMs) throw new DatabaseRecoveryError('retained-manifest-invalid');
    } finally {
      await handle.close();
    }
    const manifest = parseManifest(JSON.parse(raw), backupId);
    if (raw !== JSON.stringify(manifest)) throw new DatabaseRecoveryError('retained-manifest-invalid');
    await verifyOwnedArtifacts(ownedRoot, manifest);
    return manifest;
  } catch (error) {
    if (error instanceof DatabaseRecoveryError) throw error;
    if (error instanceof Error) throw new DatabaseRecoveryError('retained-backup-invalid');
    throw new DatabaseRecoveryError('retained-backup-invalid');
  }
}

export async function findLatestRecoveryBackup(root: string, source: RecoverySourceIdentity): Promise<RecoveryBackupSummary | null> {
  const candidates: string[] = [];
  let entries = 0;
  const catalog = await opendir(path.resolve(root));
  for await (const entry of catalog) {
    entries += 1;
    if (entries > MAX_CATALOG_ENTRIES) throw new DatabaseRecoveryError('retained-catalog-limit');
    if (entry.isDirectory() && !entry.isSymbolicLink() && UUID.test(entry.name)) candidates.push(entry.name);
  }
  const manifests: RecoveryManifest[] = [];
  for (const candidate of candidates) {
    try {
      const manifest = await loadRecoveryManifest(root, candidate);
      if (manifest.sourceProjectRef === source.sourceProjectRef && manifest.guildId === source.guildId) manifests.push(manifest);
    } catch (error) {
      if (!(error instanceof DatabaseRecoveryError)) throw error;
    }
  }
  manifests.sort((left, right) => right.capturedAt.localeCompare(left.capturedAt) || right.backupId.localeCompare(left.backupId));
  const latest = manifests[0];
  return latest ? { backupId: latest.backupId, capturedAt: latest.capturedAt } : null;
}
