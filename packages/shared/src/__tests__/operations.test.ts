import { describe, expect, it } from 'vitest';
import {
  OperationDefinitionSchema,
  SignificantOperationRequestSchema,
  evaluateOperationImpact,
  nextOperationStage,
  assertSurfaceAuthority,
  surfaceAuthorityFor,
  type OperationEnvironment,
} from '../operations/index.js';

const environment: OperationEnvironment = {
  activeFeatures: ['store', 'license_delivery'],
  grantedPermissions: ['manage_roles'],
  readyProviders: ['discord'],
  activeClaims: [
    {
      operationId: '11111111-1111-4111-8111-111111111111',
      feature: 'paid_roles',
      resource: { kind: 'discord_role', id: 'supporter' },
      access: 'exclusive',
    },
  ],
};

describe('significant operation contracts', () => {
  it('accepts an operation-specific lifecycle and advances only through included stages', () => {
    const definition = OperationDefinitionSchema.parse({
      domain: 'deployment',
      action: 'server_structure.publish',
      lifecycle: ['draft', 'validated', 'conflict_checked', 'previewed', 'committed', 'executed', 'read_back', 'audited'],
      recovery: 'rollback',
    });

    expect(nextOperationStage(definition.lifecycle, 'validated')).toBe('conflict_checked');
    expect(nextOperationStage(definition.lifecycle, 'audited')).toBeNull();
  });

  it('allows an inapplicable preview stage to be omitted without changing canonical order', () => {
    const definition = OperationDefinitionSchema.parse({
      domain: 'moderation',
      action: 'member.timeout',
      lifecycle: ['validated', 'conflict_checked', 'committed', 'executed', 'read_back', 'audited'],
      recovery: 'compensation',
    });

    expect(nextOperationStage(definition.lifecycle, 'conflict_checked')).toBe('committed');
  });

  it('rejects duplicate or out-of-order lifecycle stages', () => {
    expect(OperationDefinitionSchema.safeParse({
      domain: 'commerce',
      action: 'refund.issue',
      lifecycle: ['draft', 'committed', 'validated'],
      recovery: 'compensation',
    }).success).toBe(false);
  });

  it('parses the universal actor, source, request, and idempotency identity together', () => {
    const request = SignificantOperationRequestSchema.parse({
      id: '55555555-5555-4555-8555-555555555555',
      guildId: 'guild-1',
      idempotencyKey: 'dashboard:deploy:5',
      domain: 'deployment',
      action: 'server_structure.publish',
      actor: { type: 'owner', id: 'owner-1' },
      source: 'dashboard',
      lifecycle: ['validated', 'committed', 'executed', 'read_back', 'audited'],
      recovery: 'rollback',
      request: { targetRevision: 5 },
    });

    expect(request.configurationGeneration).toBeNull();
    expect(request.actor).toEqual({ type: 'owner', id: 'owner-1' });
  });
});

describe('surface authority', () => {
  it('assigns one authoritative owner while allowing declared interaction surfaces', () => {
    expect(surfaceAuthorityFor('configuration')).toEqual(expect.objectContaining({
      authority: 'dashboard',
      allowedSources: ['dashboard'],
    }));
    expect(surfaceAuthorityFor('community_behavior')).toEqual(expect.objectContaining({
      authority: 'discord',
      allowedSources: ['discord', 'dashboard'],
    }));
  });

  it('rejects a source that attempts to take ownership from another surface', () => {
    expect(() => assertSurfaceAuthority('deployment', 'dashboard')).toThrow(
      'dashboard cannot own deployment; launcher is authoritative',
    );
    expect(() => assertSurfaceAuthority('agent_contract', 'portal')).toThrow(
      'portal cannot own agent_contract; sdk is authoritative',
    );
  });
});

describe('cross-feature impact evaluation', () => {
  it('reports missing dependencies and exclusive-resource conflicts with exact blast radius', () => {
    const result = evaluateOperationImpact({
      operationId: '22222222-2222-4222-8222-222222222222',
      feature: 'store_role_delivery',
      rules: [
        { kind: 'requires_feature', feature: 'store', requiredFeature: 'role_management' },
        { kind: 'requires_provider', feature: 'store', provider: 'paypal' },
      ],
      impacts: [
        {
          resource: { kind: 'discord_role', id: 'supporter' },
          effect: 'update',
          reversible: true,
          downstream: [{ kind: 'discord_channel', id: 'supporter-lounge' }],
        },
      ],
    }, environment);

    expect(result.blocking).toBe(true);
    expect(result.conflicts.map((conflict) => conflict.kind).sort()).toEqual([
      'exclusive_resource',
      'missing_feature',
      'provider_unavailable',
    ]);
    expect(result.blastRadius.resources).toEqual([
      { kind: 'discord_role', id: 'supporter' },
      { kind: 'discord_channel', id: 'supporter-lounge' },
    ]);
    expect(result.blastRadius.reversibility).toBe('reversible');
  });

  it('detects automation recursion without treating shared read access as a conflict', () => {
    const result = evaluateOperationImpact({
      operationId: '33333333-3333-4333-8333-333333333333',
      feature: 'automations',
      rules: [
        { kind: 'automation_edge', feature: 'automations', from: 'rule-a', to: 'rule-b' },
        { kind: 'automation_edge', feature: 'automations', from: 'rule-b', to: 'rule-a' },
      ],
      impacts: [{
        resource: { kind: 'discord_channel', id: 'logs' },
        effect: 'read',
        reversible: true,
        downstream: [],
      }],
    }, {
      ...environment,
      activeClaims: [{
        operationId: '44444444-4444-4444-8444-444444444444',
        feature: 'moderation',
        resource: { kind: 'discord_channel', id: 'logs' },
        access: 'shared',
      }],
    });

    expect(result.conflicts).toEqual([
      expect.objectContaining({ kind: 'automation_recursion', blocking: true }),
    ]);
  });
});
