import { z } from 'zod';
import {
  OperationLifecycleSchema,
  OperationStageSchema,
  SignificantOperationRequestSchema,
} from '@somnibot/shared';

const rpcErrorSchema = z.object({ message: z.string() });
const rpcDataSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
]);
const rpcResultSchema = z.object({ data: rpcDataSchema, error: rpcErrorSchema.nullable() });

const significantOperationSchema = z.object({
  id: z.string().uuid(),
  guild_id: z.string().min(1),
  idempotency_key: z.string().min(1),
  domain: z.string().min(1),
  action: z.string().min(1),
  actor_type: z.enum(['owner', 'administrator', 'moderator', 'finance', 'support', 'system', 'customer']),
  actor_id: z.string().min(1),
  source_surface: z.enum(['dashboard', 'discord', 'launcher', 'portal', 'sdk', 'system']),
  lifecycle_stages: OperationLifecycleSchema,
  current_stage: OperationStageSchema,
  recovery_strategy: z.enum(['none', 'rollback', 'compensation']),
  outcome: z.enum(['active', 'completed', 'failed', 'recovering', 'rolled_back', 'compensated', 'forward_fixed']),
  request_payload: z.record(z.unknown()),
  conflicts: z.array(z.record(z.unknown())),
  blast_radius: z.record(z.unknown()),
  external_effects: z.array(z.record(z.unknown())),
  readback: z.record(z.unknown()).nullable(),
  audit_evidence: z.record(z.unknown()).nullable(),
  recovery_evidence: z.record(z.unknown()).nullable(),
  recovery_outcome: z.enum(['rolled_back', 'compensated', 'forward_fixed']).nullable(),
  failure_code: z.string().nullable(),
  configuration_generation: z.number().int().nonnegative().nullable(),
  revision: z.number().int().nonnegative(),
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
  completed_at: z.string().datetime({ offset: true }).nullable(),
});
export type SignificantOperation = z.infer<typeof significantOperationSchema>;

export type OperationRpc = (
  name: string,
  parameters: Readonly<Record<string, unknown>>,
) => Promise<{ readonly data: unknown; readonly error: { readonly message: string } | null }>;

type RpcClient = {
  readonly rpc: (
    name: string,
    parameters: Readonly<Record<string, unknown>>,
  ) => PromiseLike<unknown>;
};

export class OperationPersistenceError extends Error {
  readonly name = 'OperationPersistenceError';
}

export type PrepareOperationInput = z.input<typeof SignificantOperationRequestSchema>;

export type AdvanceOperationInput = {
  readonly operationId: string;
  readonly expectedRevision: number;
  readonly completedStage: SignificantOperation['current_stage'];
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly conflicts?: readonly Readonly<Record<string, unknown>>[];
  readonly blastRadius?: Readonly<Record<string, unknown>>;
  readonly externalEffects?: readonly Readonly<Record<string, unknown>>[];
  readonly readback?: Readonly<Record<string, unknown>>;
  readonly auditEvidence?: Readonly<Record<string, unknown>>;
};

export type RecoverOperationInput = {
  readonly operationId: string;
  readonly expectedRevision: number;
  readonly outcome: NonNullable<SignificantOperation['recovery_outcome']>;
  readonly evidence: Readonly<Record<string, unknown>>;
};

export type FailOperationInput = {
  readonly operationId: string;
  readonly expectedRevision: number;
  readonly failureCode: string;
  readonly retryable: boolean;
  readonly evidence: Readonly<Record<string, unknown>>;
};

export function operationRpc(client: RpcClient): OperationRpc {
  return async (name, parameters) => {
    const result = rpcResultSchema.safeParse(await client.rpc(name, parameters));
    if (!result.success) throw new OperationPersistenceError('operation RPC returned an invalid result');
    return result.data;
  };
}

function parseOperationResult(result: Awaited<ReturnType<OperationRpc>>): SignificantOperation {
  if (result.error) throw new OperationPersistenceError(result.error.message);
  const candidate = Array.isArray(result.data) ? result.data[0] : result.data;
  const parsed = significantOperationSchema.safeParse(candidate);
  if (!parsed.success) throw new OperationPersistenceError('invalid operation row');
  return parsed.data;
}

export async function prepareSignificantOperation(
  rpc: OperationRpc,
  input: PrepareOperationInput,
): Promise<SignificantOperation> {
  const operation = SignificantOperationRequestSchema.parse(input);
  return parseOperationResult(await rpc('prepare_significant_operation', {
    p_operation_id: operation.id,
    p_guild_id: operation.guildId,
    p_source_surface: operation.source,
    p_idempotency_key: operation.idempotencyKey,
    p_domain: operation.domain,
    p_action: operation.action,
    p_actor_type: operation.actor.type,
    p_actor_id: operation.actor.id,
    p_lifecycle_stages: operation.lifecycle,
    p_recovery_strategy: operation.recovery,
    p_request_payload: operation.request,
    p_configuration_generation: operation.configurationGeneration,
  }));
}

export async function advanceSignificantOperation(
  rpc: OperationRpc,
  input: AdvanceOperationInput,
): Promise<SignificantOperation> {
  return parseOperationResult(await rpc('advance_significant_operation', {
    p_operation_id: input.operationId,
    p_expected_revision: input.expectedRevision,
    p_completed_stage: input.completedStage,
    p_evidence: input.evidence,
    p_conflicts: input.conflicts ?? null,
    p_blast_radius: input.blastRadius ?? null,
    p_external_effects: input.externalEffects ?? null,
    p_readback: input.readback ?? null,
    p_audit_evidence: input.auditEvidence ?? null,
  }));
}

export async function recoverSignificantOperation(
  rpc: OperationRpc,
  input: RecoverOperationInput,
): Promise<SignificantOperation> {
  return parseOperationResult(await rpc('recover_significant_operation', {
    p_operation_id: input.operationId,
    p_expected_revision: input.expectedRevision,
    p_recovery_outcome: input.outcome,
    p_recovery_evidence: input.evidence,
  }));
}

export async function recordSignificantOperationFailure(
  rpc: OperationRpc,
  input: FailOperationInput,
): Promise<SignificantOperation> {
  return parseOperationResult(await rpc('record_significant_operation_failure', {
    p_operation_id: input.operationId,
    p_expected_revision: input.expectedRevision,
    p_failure_code: input.failureCode,
    p_retryable: input.retryable,
    p_evidence: input.evidence,
  }));
}
