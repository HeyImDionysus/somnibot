import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseRecoveryError } from './database-recovery-contract.js';
import { RECOVERY_MAX_BYTES } from './database-recovery-process.js';
import type { RecoveryIdentity } from './database-recovery-sql.js';
import type { RuntimeIdentity } from '@somnibot/shared';

export const RECOVERY_ARTIFACTS = ['roles.sql', 'schema.sql', 'data.sql'] as const;
export const RECOVERY_HISTORY_ARTIFACTS = ['history-schema.sql', 'history-data.sql'] as const;
export type RecoveryArtifact = { readonly name: string; readonly bytes: number; readonly sha256: string };
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

export function manifestChecksum(manifest: RecoveryManifest): string {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

export async function describeArtifact(directory: string, name: string): Promise<RecoveryArtifact> {
  const file = path.join(directory, name);
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > RECOVERY_MAX_BYTES) throw new DatabaseRecoveryError('invalid-artifact');
  const digest = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    bytes += chunk.length;
    if (bytes > RECOVERY_MAX_BYTES) throw new DatabaseRecoveryError('artifact-size-limit');
    digest.update(chunk);
  }
  if (bytes !== stat.size) throw new DatabaseRecoveryError('artifact-changed-during-read');
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

export async function saveManifest(directory: string, manifest: RecoveryManifest): Promise<void> {
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
}
