import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseRecoveryError } from './database-recovery-contract.js';

const FILES = { roles: 'dump_role.sh', schema: 'dump_schema.sh', data: 'dump_data.sh', historySchema: 'dump_schema.sh', historyData: 'dump_data.sh' } as const;
export type RecoveryVariant = keyof typeof FILES;
export const RECOVERY_SCRIPT_ENV = ['INCLUDED_SCHEMAS', 'EXCLUDED_SCHEMAS', 'EXTRA_FLAGS', 'EXTRA_SED', 'RESERVED_ROLES', 'ALLOWED_CONFIGS'] as const;
export type RecoveryResources = { readonly image: string; readonly scripts: Readonly<Record<RecoveryVariant, { readonly script: string; readonly env: Readonly<Record<string, string>> }>> };
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }

export async function loadRecoveryResources(major: string): Promise<RecoveryResources> {
  const base = new URL('../resources/database-recovery/', import.meta.url);
  const descriptor: unknown = JSON.parse(await readFile(new URL('descriptor.json', base), 'utf8'));
  if (!record(descriptor) || descriptor.schemaVersion !== 1 || !record(descriptor.upstream)
    || descriptor.upstream.version !== '2.114.0' || descriptor.upstream.commit !== '181bc4a7466559393fbf3bc31b7cfc5e74d81cf2'
    || !record(descriptor.images) || !record(descriptor.variants)) throw new DatabaseRecoveryError('invalid-recovery-resources');
  const image = descriptor.images[major];
  if (!['15', '17'].includes(major) || typeof image !== 'string' || !/^[a-z0-9./_-]+:[a-zA-Z0-9._-]+$/.test(image)) throw new DatabaseRecoveryError('unsupported-server-prerequisite');
  const variants = descriptor.variants;
  async function load(variant: RecoveryVariant) {
    const item = variants[variant];
    if (!record(item) || item.file !== FILES[variant] || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256) || !record(item.env)) throw new DatabaseRecoveryError('invalid-recovery-resources');
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(item.env)) {
      if (!RECOVERY_SCRIPT_ENV.some((allowed) => allowed === key) || typeof value !== 'string' || value.includes('\0')) throw new DatabaseRecoveryError('invalid-recovery-resources');
      env[key] = value;
    }
    const bytes = await readFile(new URL(FILES[variant], base));
    if (createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw new DatabaseRecoveryError('recovery-resource-checksum-mismatch');
    return { script: bytes.toString('utf8'), env };
  }
  return { image, scripts: { roles: await load('roles'), schema: await load('schema'), data: await load('data'), historySchema: await load('historySchema'), historyData: await load('historyData') } };
}
