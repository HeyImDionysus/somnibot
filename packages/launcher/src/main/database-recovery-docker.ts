import { randomUUID } from 'node:crypto';
import { DatabaseRecoveryError, type RecoveryCommand } from './database-recovery-contract.js';
import { RECOVERY_SCRIPT_ENV, type RecoveryResources, type RecoveryVariant } from './database-recovery-resources.js';

type Runner = (command: RecoveryCommand) => Promise<string>;
const PROJECT_LABEL = 'com.supabase.cli.project';
const COMPOSE_LABEL = 'com.docker.compose.project';
const IMAGE_FORMAT = '[{{json .Id}},{{json .Config.Volumes}}]';
const OWNED_FORMAT = '[{{json .Id}},{{json .Image}},{{json .Name}},{{json (index .Config.Labels "com.supabase.cli.project")}},{{json (index .Config.Labels "com.docker.compose.project")}},{{json .Mounts}}]';
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const CONTAINER_ID = /^[a-f0-9]{64}$/;
function decodeProjection(raw: string): unknown[] {
  try { const value: unknown = JSON.parse(raw); if (Array.isArray(value)) return value; throw new Error('projection'); }
  catch { throw new DatabaseRecoveryError('invalid-container-projection'); }
}

export async function prepareRecoveryImage(resources: RecoveryResources, run: Runner): Promise<{ readonly id: string; readonly volumes: readonly string[] }> {
  let raw: string;
  try { raw = await run({ tool: 'docker', args: ['image', 'inspect', '--format', IMAGE_FORMAT, resources.image], env: {} }); }
  catch { throw new DatabaseRecoveryError('cached-image-prerequisite'); }
  const [id, volumeMap] = decodeProjection(raw);
  if (typeof id !== 'string' || !IMAGE_ID.test(id) || (volumeMap !== null && (typeof volumeMap !== 'object' || Array.isArray(volumeMap)))) throw new DatabaseRecoveryError('invalid-image-prerequisite');
  const volumes = volumeMap === null ? [] : Object.keys(volumeMap ?? {});
  if (volumes.some((volume) => volume !== '/var/lib/postgresql/data')) throw new DatabaseRecoveryError('image-volume-prerequisite');
  return { id, volumes };
}

export async function dumpRecoveryArtifact(input: { readonly resources: RecoveryResources; readonly image: { readonly id: string; readonly volumes: readonly string[] }; readonly variant: RecoveryVariant; readonly env: NodeJS.ProcessEnv; readonly directory: string; readonly outputFile: string; readonly remainingBytes: number }, run: Runner): Promise<void> {
  const name = `sbrec-${randomUUID().replaceAll('-', '')}`;
  const list = () => run({ tool: 'docker', args: ['container', 'ls', '--all', '--no-trunc', '--filter', `name=^/${name}$`, '--format', '{{.ID}}'], env: {} });
  if (await list()) throw new DatabaseRecoveryError('owned-container-name-collision');
  const variant = input.resources.scripts[input.variant];
  const env = { ...input.env, ...variant.env };
  const args = ['run', '--pull=never', '--name', name, '--label', `${PROJECT_LABEL}=${name}`, '--label', `${COMPOSE_LABEL}=${name}`,
    '--rm', '--log-driver=none', '--read-only', '--memory=512m', '--memory-swap=512m', '--cpus=1', '--pids-limit=64', '--no-healthcheck', '--network=host', '--entrypoint', '/bin/bash'];
  for (const volume of new Set(['/tmp', ...input.image.volumes])) args.push('--tmpfs', `${volume}:rw,noexec,nosuid,nodev,size=16777216,mode=1777`);
  for (const key of Object.keys(env)) {
    if (!/^PG[A-Z_]+$/.test(key) && !RECOVERY_SCRIPT_ENV.some((allowed) => allowed === key)) throw new DatabaseRecoveryError('invalid-dump-environment');
    args.push('--env', key);
  }
  args.push(input.image.id, '-c', variant.script);
  try {
    await run({ tool: 'docker', args, env, directory: input.directory, outputFile: input.outputFile, outputLimit: input.remainingBytes });
  } finally {
    const id = (await list()).trim();
    if (id) {
      if (!CONTAINER_ID.test(id)) throw new DatabaseRecoveryError('owned-container-cleanup-unverified');
      const projection = decodeProjection(await run({ tool: 'docker', args: ['container', 'inspect', '--format', OWNED_FORMAT, id], env: {} }));
      const [observedId, image, observedName, project, compose, mounts] = projection;
      if (observedId !== id || image !== input.image.id || observedName !== `/${name}` || project !== name || compose !== name
        || !Array.isArray(mounts) || mounts.some((mount: unknown) => !mount || typeof mount !== 'object' || !('Type' in mount) || mount.Type !== 'tmpfs')) throw new DatabaseRecoveryError('owned-container-cleanup-unverified');
      await run({ tool: 'docker', args: ['container', 'rm', '-fv', id], env: {} });
    }
    if (await list()) throw new DatabaseRecoveryError('owned-container-cleanup-unverified');
  }
}
