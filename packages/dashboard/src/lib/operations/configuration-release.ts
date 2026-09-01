import { z } from 'zod';
import { ConfigurationReleaseSchema } from '@somnibot/shared';
import type { OperationRpc } from './repository';

const releaseRowSchema = z.object({
  id: z.string().uuid(),
  operation_id: z.string().uuid(),
  guild_id: z.string().min(1),
  config_domain: z.string().min(1),
  base_revision: z.number().int().nonnegative(),
  target_revision: z.number().int().positive(),
  base_snapshot: z.record(z.unknown()),
  target_snapshot: z.record(z.unknown()),
  config_diff: z.array(z.record(z.unknown())),
  validation: z.object({ valid: z.boolean(), errors: z.array(z.string()) }),
  recovery_kind: z.enum(['rollback', 'compensation', 'forward_fix']),
  recovery_payload: z.record(z.unknown()),
  status: z.enum(['prepared', 'applied', 'read_back', 'rolled_back', 'compensated', 'forward_fixed']),
  readback: z.record(z.unknown()).nullable(),
  recovered_readback: z.record(z.unknown()).nullable(),
  activated_at: z.string().datetime({ offset: true }).nullable(),
  created_at: z.string().datetime({ offset: true }),
});
export type ConfigurationReleaseRow = z.infer<typeof releaseRowSchema>;

type ReleaseInsert = {
  readonly operationId: string;
  readonly guildId: string;
  readonly release: z.input<typeof ConfigurationReleaseSchema>;
};

export class ConfigurationReleaseError extends Error {
  readonly name = 'ConfigurationReleaseError';
}

function recoveryPayload(
  recovery: z.output<typeof ConfigurationReleaseSchema>['recovery'],
): Readonly<Record<string, unknown>> {
  switch (recovery.kind) {
    case 'rollback':
      return recovery.snapshot;
    case 'compensation':
    case 'forward_fix':
      return recovery.instructions;
    default:
      throw new ConfigurationReleaseError(`unsupported recovery kind: ${JSON.stringify(recovery)}`);
  }
}

export async function saveConfigurationRelease(
  rpc: OperationRpc,
  input: ReleaseInsert,
): Promise<ConfigurationReleaseRow> {
  const release = ConfigurationReleaseSchema.parse(input.release);
  if (!release.validation.valid) {
    throw new ConfigurationReleaseError('Configuration release validation must pass before persistence');
  }
  const recovery = recoveryPayload(release.recovery);
  const result = await rpc('prepare_configuration_release', {
    p_operation_id: input.operationId,
    p_guild_id: input.guildId,
    p_config_domain: release.domain,
    p_base_revision: release.baseRevision,
    p_target_revision: release.targetRevision,
    p_base_snapshot: release.baseSnapshot,
    p_target_snapshot: release.targetSnapshot,
    p_config_diff: release.diff,
    p_validation: release.validation,
    p_recovery_kind: release.recovery.kind,
    p_recovery_payload: recovery,
  });
  if (result.error) throw new ConfigurationReleaseError(result.error.message);
  const candidate = Array.isArray(result.data) ? result.data[0] : result.data;
  const row = releaseRowSchema.safeParse(candidate);
  if (!row.success) throw new ConfigurationReleaseError('configuration release store returned an invalid row');
  return row.data;
}

export async function activateConfigurationRelease(
  rpc: OperationRpc,
  operationId: string,
  expectedOperationRevision: number,
): Promise<ConfigurationReleaseRow> {
  const result = await rpc('activate_configuration_release', {
    p_operation_id: operationId,
    p_expected_operation_revision: expectedOperationRevision,
  });
  if (result.error) throw new ConfigurationReleaseError(result.error.message);
  const candidate = Array.isArray(result.data) ? result.data[0] : result.data;
  const row = releaseRowSchema.safeParse(candidate);
  if (!row.success) throw new ConfigurationReleaseError('configuration release store returned an invalid row');
  return row.data;
}

export async function recordConfigurationReleaseReadback(
  rpc: OperationRpc,
  operationId: string,
  readback: Readonly<Record<string, unknown>>,
): Promise<ConfigurationReleaseRow> {
  const result = await rpc('record_configuration_release_readback', {
    p_operation_id: operationId,
    p_readback: readback,
  });
  if (result.error) throw new ConfigurationReleaseError(result.error.message);
  const candidate = Array.isArray(result.data) ? result.data[0] : result.data;
  const row = releaseRowSchema.safeParse(candidate);
  if (!row.success) throw new ConfigurationReleaseError('configuration release readback returned an invalid row');
  return row.data;
}
