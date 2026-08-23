import { z } from 'zod';
import { ResourceImpactSchema, ResourceReferenceSchema, type ResourceReference } from './contract.js';

const FeatureNameSchema = z.string().trim().min(1).max(100);

export const DependencyRuleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('requires_feature'), feature: FeatureNameSchema, requiredFeature: FeatureNameSchema }),
  z.object({ kind: z.literal('conflicts_with_feature'), feature: FeatureNameSchema, conflictingFeature: FeatureNameSchema }),
  z.object({ kind: z.literal('requires_permission'), feature: FeatureNameSchema, permission: z.string().trim().min(1).max(100) }),
  z.object({ kind: z.literal('requires_provider'), feature: FeatureNameSchema, provider: z.string().trim().min(1).max(100) }),
  z.object({ kind: z.literal('automation_edge'), feature: FeatureNameSchema, from: z.string().trim().min(1), to: z.string().trim().min(1) }),
]);
export type DependencyRule = z.infer<typeof DependencyRuleSchema>;

export const OperationImpactRequestSchema = z.object({
  operationId: z.string().uuid(),
  feature: FeatureNameSchema,
  rules: z.array(DependencyRuleSchema),
  impacts: z.array(ResourceImpactSchema),
});
export type OperationImpactRequest = z.infer<typeof OperationImpactRequestSchema>;

export type ResourceClaim = {
  readonly operationId: string;
  readonly feature: string;
  readonly resource: ResourceReference;
  readonly access: 'shared' | 'exclusive';
};

export type OperationEnvironment = {
  readonly activeFeatures: readonly string[];
  readonly grantedPermissions: readonly string[];
  readonly readyProviders: readonly string[];
  readonly activeClaims: readonly ResourceClaim[];
};

export type OperationConflict = {
  readonly kind: 'missing_feature' | 'feature_conflict' | 'missing_permission' | 'provider_unavailable' | 'exclusive_resource' | 'automation_recursion';
  readonly blocking: true;
  readonly subject: string;
  readonly relatedOperationId?: string;
};

export type OperationImpactResult = {
  readonly blocking: boolean;
  readonly conflicts: readonly OperationConflict[];
  readonly blastRadius: {
    readonly resources: readonly ResourceReference[];
    readonly impacts: OperationImpactRequest['impacts'];
    readonly reversibility: 'reversible' | 'mixed' | 'irreversible';
  };
};

class UnexpectedDependencyRuleError extends Error {
  readonly name = 'UnexpectedDependencyRuleError';

  constructor(rule: never) {
    super(`Unexpected dependency rule: ${JSON.stringify(rule)}`);
  }
}

function referenceKey(reference: ResourceReference): string {
  return `${reference.kind}:${reference.id}`;
}

function hasAutomationCycle(rules: readonly DependencyRule[]): boolean {
  const adjacency = new Map<string, string[]>();
  for (const rule of rules) {
    if (rule.kind !== 'automation_edge') continue;
    const destinations = adjacency.get(rule.from) ?? [];
    destinations.push(rule.to);
    adjacency.set(rule.from, destinations);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string): boolean => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const next of adjacency.get(node) ?? []) {
      if (visit(next)) return true;
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  };
  return [...adjacency.keys()].some(visit);
}

function ruleConflicts(
  rules: readonly DependencyRule[],
  environment: OperationEnvironment,
): OperationConflict[] {
  const conflicts: OperationConflict[] = [];
  for (const rule of rules) {
    switch (rule.kind) {
      case 'requires_feature':
        if (!environment.activeFeatures.includes(rule.requiredFeature)) conflicts.push({ kind: 'missing_feature', blocking: true, subject: rule.requiredFeature });
        break;
      case 'conflicts_with_feature':
        if (environment.activeFeatures.includes(rule.conflictingFeature)) conflicts.push({ kind: 'feature_conflict', blocking: true, subject: rule.conflictingFeature });
        break;
      case 'requires_permission':
        if (!environment.grantedPermissions.includes(rule.permission)) conflicts.push({ kind: 'missing_permission', blocking: true, subject: rule.permission });
        break;
      case 'requires_provider':
        if (!environment.readyProviders.includes(rule.provider)) conflicts.push({ kind: 'provider_unavailable', blocking: true, subject: rule.provider });
        break;
      case 'automation_edge':
        break;
      default:
        throw new UnexpectedDependencyRuleError(rule);
    }
  }
  if (hasAutomationCycle(rules)) conflicts.push({ kind: 'automation_recursion', blocking: true, subject: 'automation_graph' });
  return conflicts;
}

export function evaluateOperationImpact(
  unparsedRequest: unknown,
  environment: OperationEnvironment,
): OperationImpactResult {
  const request = OperationImpactRequestSchema.parse(unparsedRequest);
  const conflicts = ruleConflicts(request.rules, environment);
  const impacted = new Map<string, ResourceReference>();
  let reversible = 0;

  for (const impact of request.impacts) {
    impacted.set(referenceKey(impact.resource), impact.resource);
    for (const downstream of impact.downstream) impacted.set(referenceKey(downstream), downstream);
    if (impact.reversible) reversible += 1;

    if (impact.effect === 'read') continue;
    for (const claim of environment.activeClaims) {
      if (claim.operationId === request.operationId || referenceKey(claim.resource) !== referenceKey(impact.resource)) continue;
      if (claim.access === 'exclusive') {
        conflicts.push({
          kind: 'exclusive_resource',
          blocking: true,
          subject: referenceKey(impact.resource),
          relatedOperationId: claim.operationId,
        });
      }
    }
  }

  const reversibility = request.impacts.length === 0 || reversible === request.impacts.length
    ? 'reversible'
    : reversible === 0 ? 'irreversible' : 'mixed';
  const uniqueConflicts = new Map<string, OperationConflict>();
  for (const conflict of conflicts) {
    uniqueConflicts.set(`${conflict.kind}:${conflict.subject}:${conflict.relatedOperationId ?? ''}`, conflict);
  }
  return {
    blocking: uniqueConflicts.size > 0,
    conflicts: [...uniqueConflicts.values()],
    blastRadius: { resources: [...impacted.values()], impacts: request.impacts, reversibility },
  };
}

export const ParsedResourceReferenceSchema = ResourceReferenceSchema;
