import { describe, expect, it, vi } from 'vitest';

vi.mock('@somnibot/shared', async () => import('../../../shared/src/operations/index'));
import type { OperationStage } from '../../../shared/src/operations/index';
import {
  advanceSignificantOperation,
  operationRpc,
  prepareSignificantOperation,
  recordSignificantOperationFailure,
  recoverSignificantOperation,
  type OperationRpc,
} from '@/lib/operations/repository';
import {
  discordOperationReason,
  internalOperationHeaders,
  operationAuditFields,
  paypalOperationHeaders,
  withOperationIdentity,
} from '@/lib/operations/correlation';
import {
  activateConfigurationRelease,
  recordConfigurationReleaseReadback,
  saveConfigurationRelease,
} from '@/lib/operations/configuration-release';

const operationId = '11111111-1111-4111-8111-111111111111';
const lifecycleStages = [
  'validated',
  'conflict_checked',
  'previewed',
  'committed',
  'executed',
  'read_back',
  'audited',
] satisfies OperationStage[];

const row = {
  id: operationId,
  guild_id: 'guild-1',
  idempotency_key: 'deploy-1',
  domain: 'deployment',
  action: 'server_structure.publish',
  actor_type: 'owner',
  actor_id: 'owner-1',
  source_surface: 'dashboard',
  lifecycle_stages: lifecycleStages,
  current_stage: 'validated',
  recovery_strategy: 'rollback',
  outcome: 'active',
  request_payload: { roleCount: 2 },
  conflicts: [],
  blast_radius: { resources: [], reversibility: 'reversible' },
  external_effects: [],
  readback: null,
  audit_evidence: null,
  recovery_evidence: null,
  recovery_outcome: null,
  failure_code: null,
  configuration_generation: 3,
  revision: 0,
  created_at: '2026-08-23T12:00:00.000Z',
  updated_at: '2026-08-23T12:00:00.000Z',
  completed_at: null,
};

describe('significant operation repository', () => {
  it('prepares a durable operation with a caller-owned idempotency identity', async () => {
    const calls: Array<{ name: string; parameters: Readonly<Record<string, unknown>> }> = [];
    const rpc: OperationRpc = async (name, parameters) => {
      calls.push({ name, parameters });
      return { data: [row], error: null };
    };

    const operation = await prepareSignificantOperation(rpc, {
      id: operationId,
      guildId: 'guild-1',
      idempotencyKey: 'deploy-1',
      domain: 'deployment',
      action: 'server_structure.publish',
      actor: { type: 'owner', id: 'owner-1' },
      source: 'dashboard',
      lifecycle: row.lifecycle_stages,
      recovery: 'rollback',
      request: { roleCount: 2 },
      configurationGeneration: 3,
    });

    expect(operation.id).toBe(operationId);
    expect(calls).toEqual([expect.objectContaining({
      name: 'prepare_significant_operation',
      parameters: expect.objectContaining({ p_operation_id: operationId, p_idempotency_key: 'deploy-1' }),
    })]);
  });

  it('uses optimistic revision checks for advancement and recovery', async () => {
    const names: string[] = [];
    const rpc: OperationRpc = async (name) => {
      names.push(name);
      return { data: [{ ...row, revision: name === 'advance_significant_operation' ? 1 : 2 }], error: null };
    };

    await advanceSignificantOperation(rpc, {
      operationId,
      expectedRevision: 0,
      completedStage: 'validated',
      evidence: { checks: ['schema'] },
    });
    await recordSignificantOperationFailure(rpc, {
      operationId,
      expectedRevision: 1,
      failureCode: 'discord_timeout',
      retryable: false,
      evidence: { attempt: 2 },
    });
    await recoverSignificantOperation(rpc, {
      operationId,
      expectedRevision: 2,
      outcome: 'rolled_back',
      evidence: { restoredRevision: 2 },
    });

    expect(names).toEqual([
      'advance_significant_operation',
      'record_significant_operation_failure',
      'recover_significant_operation',
    ]);
  });

  it('fails closed when persistence returns malformed lifecycle evidence', async () => {
    const rpc: OperationRpc = async () => ({ data: [{ ...row, revision: -1 }], error: null });

    await expect(advanceSignificantOperation(rpc, {
      operationId,
      expectedRevision: 0,
      completedStage: 'validated',
      evidence: {},
    })).rejects.toThrow('invalid operation row');
  });

  it('accepts PostgreSQL offset timestamps from the real persistence boundary', async () => {
    const rpc: OperationRpc = async () => ({
      data: [{
        ...row,
        created_at: '2026-08-23T12:00:00+00:00',
        updated_at: '2026-08-23T12:00:01+00:00',
      }],
      error: null,
    });

    await expect(advanceSignificantOperation(rpc, {
      operationId,
      expectedRevision: 0,
      completedStage: 'validated',
      evidence: {},
    })).resolves.toEqual(expect.objectContaining({ id: operationId }));
  });

  it('adapts a Supabase client without exposing it to the domain contract', async () => {
    const rpc = operationRpc({
      rpc: async () => ({ data: [row], error: null }),
    });

    await expect(prepareSignificantOperation(rpc, {
      id: operationId,
      guildId: 'guild-1',
      idempotencyKey: 'deploy-1',
      domain: 'deployment',
      action: 'server_structure.publish',
      actor: { type: 'owner', id: 'owner-1' },
      source: 'dashboard',
      lifecycle: ['validated'],
      recovery: 'none',
      request: {},
    })).resolves.toEqual(expect.objectContaining({ id: operationId }));
  });
});

describe('external operation correlation', () => {
  it('uses the same safe identity for provider and internal HTTP effects', () => {
    expect(paypalOperationHeaders(operationId)).toEqual({ 'PayPal-Request-Id': operationId });
    expect(internalOperationHeaders(operationId)).toEqual({ 'X-SomniBot-Operation-Id': operationId });
  });

  it('keeps the operation identity visible in Discord reasons and queue payloads', () => {
    expect(discordOperationReason('SomniBot role grant', operationId)).toBe(
      `SomniBot role grant [operation:${operationId}]`,
    );
    expect(withOperationIdentity({ roleId: 'role-1' }, operationId)).toEqual({
      roleId: 'role-1',
      operation_id: operationId,
    });
    expect(operationAuditFields(operationId)).toEqual({
      operation_id: operationId,
      correlation_id: operationId,
    });
  });
});

describe('configuration releases', () => {
  const releaseRow = {
    id: '55555555-5555-4555-8555-555555555555',
    operation_id: operationId,
    guild_id: 'guild-1',
    config_domain: 'moderation',
    base_revision: 4,
    target_revision: 5,
    base_snapshot: { enabled: false },
    target_snapshot: { enabled: true },
    config_diff: [{ path: 'enabled', kind: 'changed', before: false, after: true }],
    validation: { valid: true, errors: [] },
    recovery_kind: 'rollback',
    recovery_payload: { enabled: false },
    status: 'prepared',
    readback: null,
    recovered_readback: null,
    activated_at: null,
    created_at: '2026-08-23T12:00:00.000Z',
  };

  it('stores authoritative snapshots, a machine-readable diff, validation, and recovery before activation', async () => {
    const calls: string[] = [];
    const rpc: OperationRpc = async (name) => {
      calls.push(name);
      return { data: [releaseRow], error: null };
    };

    await saveConfigurationRelease(rpc, {
      operationId,
      guildId: 'guild-1',
      release: {
        schemaVersion: 1,
        domain: 'moderation',
        baseRevision: 4,
        targetRevision: 5,
        baseSnapshot: { enabled: false },
        targetSnapshot: { enabled: true },
        diff: [{ path: 'enabled', kind: 'changed', before: false, after: true }],
        validation: { valid: true, errors: [] },
        recovery: { kind: 'rollback', snapshot: { enabled: false } },
      },
    });
    await activateConfigurationRelease(rpc, operationId, 5);
    await recordConfigurationReleaseReadback(rpc, operationId, { enabled: true });

    expect(calls).toEqual(['prepare_configuration_release', 'activate_configuration_release', 'record_configuration_release_readback']);
  });

  it('refuses to persist a release whose validation failed', async () => {
    const rpc: OperationRpc = async () => ({ data: [releaseRow], error: null });

    await expect(saveConfigurationRelease(rpc, {
      operationId,
      guildId: 'guild-1',
      release: {
        schemaVersion: 1,
        domain: 'moderation',
        baseRevision: 4,
        targetRevision: 5,
        baseSnapshot: { enabled: false },
        targetSnapshot: { enabled: true },
        diff: [{ path: 'enabled', kind: 'changed', before: false, after: true }],
        validation: { valid: false, errors: ['permission_missing'] },
        recovery: { kind: 'rollback', snapshot: { enabled: false } },
      },
    })).rejects.toThrow('Configuration release validation must pass before persistence');
  });
});
