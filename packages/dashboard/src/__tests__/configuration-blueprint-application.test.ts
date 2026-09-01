import { describe, expect, it, vi } from 'vitest';
import { applyConfigurationBlueprint } from '@/lib/experience/configuration-blueprint-application';
import type { OperationRpc } from '@/lib/operations/repository';

const operationStages = [
  'draft',
  'validated',
  'conflict_checked',
  'previewed',
  'committed',
  'executed',
  'read_back',
  'audited',
] as const;

function successfulOperationRpc(calls: string[]): OperationRpc {
  let revision = 0;
  let stageIndex = 0;
  const operationRow = () => ({
    id: '11111111-1111-4111-8111-111111111111',
    guild_id: '12345678901234567',
    idempotency_key: 'blueprint:moderation-strict:3',
    domain: 'moderation',
    action: 'configuration_blueprint.apply',
    actor_type: 'owner',
    actor_id: '22345678901234567',
    source_surface: 'dashboard',
    lifecycle_stages: operationStages,
    current_stage: operationStages[stageIndex],
    recovery_strategy: 'rollback',
    outcome: stageIndex === operationStages.length - 1 && revision === operationStages.length
      ? 'completed'
      : 'active',
    request_payload: {
      blueprintId: 'moderation-strict',
      blueprintRevision: 3,
      configuration: { enabled: true },
    },
    conflicts: [],
    blast_radius: {},
    external_effects: [],
    readback: null,
    audit_evidence: null,
    recovery_evidence: null,
    recovery_outcome: null,
    failure_code: null,
    configuration_generation: 3,
    revision,
    created_at: '2026-08-23T12:00:00.000Z',
    updated_at: '2026-08-23T12:00:00.000Z',
    completed_at: stageIndex === operationStages.length - 1 && revision === operationStages.length
      ? '2026-08-23T12:00:01.000Z'
      : null,
  });
  const releaseRow = {
    id: '33333333-3333-4333-8333-333333333333',
    operation_id: '11111111-1111-4111-8111-111111111111',
    guild_id: '12345678901234567',
    config_domain: 'moderation',
    base_revision: 2,
    target_revision: 3,
    base_snapshot: { enabled: false },
    target_snapshot: { enabled: true },
    config_diff: [{ path: 'enabled', kind: 'changed', before: false, after: true }],
    validation: { valid: true, errors: [] },
    recovery_kind: 'rollback',
    recovery_payload: { enabled: false },
    status: 'applied',
    readback: null,
    recovered_readback: null,
    activated_at: '2026-08-23T12:00:01.000Z',
    created_at: '2026-08-23T12:00:00.000Z',
  };
  return async (name) => {
    calls.push(name);
    if (name === 'prepare_significant_operation') return { data: [operationRow()], error: null };
    if (name === 'advance_significant_operation') {
      revision += 1;
      if (stageIndex < operationStages.length - 1) stageIndex += 1;
      return { data: [operationRow()], error: null };
    }
    if (name === 'prepare_configuration_release') return { data: [releaseRow], error: null };
    if (name === 'activate_configuration_release') return { data: [releaseRow], error: null };
    if (name === 'record_configuration_release_readback') return { data: [{ ...releaseRow, status: 'read_back' }], error: null };
    return { data: null, error: { message: `Unexpected RPC: ${name}` } };
  };
}

describe('configuration blueprint application', () => {
  it('stops before persistence when conflict preview is blocking', async () => {
    const rpc = vi.fn();

    const result = await applyConfigurationBlueprint(rpc, {
      operationId: '11111111-1111-4111-8111-111111111111',
      idempotencyKey: 'blueprint:moderation-strict:3',
      guildId: '12345678901234567',
      actor: { type: 'owner', id: '22345678901234567' },
      blueprint: {
        schemaVersion: 1,
        id: 'moderation-strict',
        name: 'Strict moderation',
        domain: 'moderation',
        revision: 3,
        configuration: { enabled: true },
        rules: [{
          kind: 'requires_permission',
          feature: 'moderation',
          permission: 'manage_messages',
        }],
        impacts: [],
      },
      currentConfiguration: { enabled: false },
      environment: {
        activeFeatures: ['moderation'],
        grantedPermissions: [],
        readyProviders: ['discord'],
        activeClaims: [],
      },
    });

    expect(result.kind).toBe('blocked');
    expect(result.preview.impact.conflicts).toHaveLength(1);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('persists, activates, reads back, and audits a conflict-free blueprint release', async () => {
    const calls: string[] = [];

    const result = await applyConfigurationBlueprint(successfulOperationRpc(calls), {
      operationId: '11111111-1111-4111-8111-111111111111',
      idempotencyKey: 'blueprint:moderation-strict:3',
      guildId: '12345678901234567',
      actor: { type: 'owner', id: '22345678901234567' },
      blueprint: {
        schemaVersion: 1,
        id: 'moderation-strict',
        name: 'Strict moderation',
        domain: 'moderation',
        revision: 3,
        configuration: { enabled: true },
        rules: [],
        impacts: [],
      },
      currentConfiguration: { enabled: false },
      environment: {
        activeFeatures: ['moderation'],
        grantedPermissions: ['manage_messages'],
        readyProviders: ['discord'],
        activeClaims: [],
      },
    });

    expect(result.kind).toBe('applied');
    expect(calls).toEqual([
      'prepare_significant_operation',
      'advance_significant_operation',
      'advance_significant_operation',
      'advance_significant_operation',
      'prepare_configuration_release',
      'advance_significant_operation',
      'advance_significant_operation',
      'activate_configuration_release',
      'record_configuration_release_readback',
      'advance_significant_operation',
      'advance_significant_operation',
      'advance_significant_operation',
    ]);
  });
});
