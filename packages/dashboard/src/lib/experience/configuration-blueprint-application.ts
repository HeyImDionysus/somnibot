import {
  ConfigurationBlueprintSchema,
  previewBlueprintApplication,
  type ConfigurationBlueprint,
  type ConfigurationRelease,
  type OperationEnvironment,
} from '@somnibot/shared';
import {
  activateConfigurationRelease,
  saveConfigurationRelease,
} from '@/lib/operations/configuration-release';
import {
  advanceSignificantOperation,
  prepareSignificantOperation,
  type OperationRpc,
  type SignificantOperation,
} from '@/lib/operations/repository';

type BlueprintActor = {
  readonly type: 'owner' | 'administrator';
  readonly id: string;
};

export type BlueprintApplicationInput = {
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly guildId: string;
  readonly actor: BlueprintActor;
  readonly blueprint: ConfigurationBlueprint;
  readonly currentConfiguration: Readonly<Record<string, unknown>>;
  readonly environment: OperationEnvironment;
};

export type BlueprintApplicationResult =
  | {
    readonly kind: 'unchanged';
    readonly preview: ReturnType<typeof previewBlueprintApplication>;
  }
  | {
    readonly kind: 'blocked';
    readonly preview: ReturnType<typeof previewBlueprintApplication>;
  }
  | {
    readonly kind: 'applied';
    readonly operationId: string;
    readonly releaseId: string;
    readonly revision: number;
    readonly preview: ReturnType<typeof previewBlueprintApplication>;
  };

export class BlueprintApplicationError extends Error {
  readonly name = 'BlueprintApplicationError';
}

function releaseDiff(
  changes: ReturnType<typeof previewBlueprintApplication>['changes'],
): ConfigurationRelease['diff'] {
  return changes.map((change) => {
    if (change.before === undefined) {
      return { path: change.key, kind: 'added', after: change.after };
    }
    if (change.after === undefined) {
      return { path: change.key, kind: 'removed', before: change.before };
    }
    return { path: change.key, kind: 'changed', before: change.before, after: change.after };
  });
}

async function advance(
  rpc: OperationRpc,
  operation: SignificantOperation,
  evidence: Readonly<Record<string, unknown>>,
): Promise<SignificantOperation> {
  return advanceSignificantOperation(rpc, {
    operationId: operation.id,
    expectedRevision: operation.revision,
    completedStage: operation.current_stage,
    evidence,
  });
}

export async function applyConfigurationBlueprint(
  rpc: OperationRpc,
  input: BlueprintApplicationInput,
): Promise<BlueprintApplicationResult> {
  const blueprint = ConfigurationBlueprintSchema.parse(input.blueprint);
  const preview = previewBlueprintApplication({
    blueprint,
    currentConfiguration: input.currentConfiguration,
    operationId: input.operationId,
    environment: input.environment,
  });
  if (preview.impact.blocking) return { kind: 'blocked', preview };
  if (preview.changes.length === 0) return { kind: 'unchanged', preview };

  let operation = await prepareSignificantOperation(rpc, {
    id: input.operationId,
    guildId: input.guildId,
    idempotencyKey: input.idempotencyKey,
    domain: blueprint.domain,
    action: 'configuration_blueprint.apply',
    actor: input.actor,
    source: 'dashboard',
    lifecycle: [
      'draft',
      'validated',
      'conflict_checked',
      'previewed',
      'committed',
      'executed',
      'read_back',
      'audited',
    ],
    recovery: 'rollback',
    request: {
      blueprintId: blueprint.id,
      blueprintRevision: blueprint.revision,
      configuration: blueprint.configuration,
    },
    configurationGeneration: blueprint.revision,
  });
  operation = await advance(rpc, operation, { blueprintId: blueprint.id });
  operation = await advance(rpc, operation, { schemaVersion: blueprint.schemaVersion });
  operation = await advanceSignificantOperation(rpc, {
    operationId: operation.id,
    expectedRevision: operation.revision,
    completedStage: operation.current_stage,
    evidence: { conflictCount: 0 },
    conflicts: [],
    blastRadius: preview.impact.blastRadius,
  });

  const release = await saveConfigurationRelease(rpc, {
    operationId: operation.id,
    guildId: input.guildId,
    release: {
      schemaVersion: 1,
      domain: blueprint.domain,
      baseRevision: Math.max(0, blueprint.revision - 1),
      targetRevision: blueprint.revision,
      baseSnapshot: input.currentConfiguration,
      targetSnapshot: blueprint.configuration,
      diff: releaseDiff(preview.changes),
      validation: { valid: true, errors: [] },
      recovery: { kind: 'rollback', snapshot: input.currentConfiguration },
    },
  });
  operation = await advance(rpc, operation, { releaseId: release.id });
  operation = await advance(rpc, operation, { configurationCommitted: true });
  const activated = await activateConfigurationRelease(rpc, operation.id, operation.revision);
  const releaseReadback = await rpc('record_configuration_release_readback', {
    p_operation_id: operation.id,
    p_readback: blueprint.configuration,
  });
  if (releaseReadback.error) throw new BlueprintApplicationError(releaseReadback.error.message);
  operation = await advance(rpc, operation, { activatedAt: activated.activated_at });
  operation = await advanceSignificantOperation(rpc, {
    operationId: operation.id,
    expectedRevision: operation.revision,
    completedStage: operation.current_stage,
    evidence: { readback: 'configuration_release' },
    readback: {
      releaseId: activated.id,
      blueprintId: blueprint.id,
      revision: blueprint.revision,
    },
  });
  await advanceSignificantOperation(rpc, {
    operationId: operation.id,
    expectedRevision: operation.revision,
    completedStage: operation.current_stage,
    evidence: { audit: 'operation_events' },
    auditEvidence: { operationId: operation.id, releaseId: activated.id },
  });

  return {
    kind: 'applied',
    operationId: operation.id,
    releaseId: activated.id,
    revision: blueprint.revision,
    preview,
  };
}
