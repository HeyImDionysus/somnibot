import { z } from 'zod';
import {
  DependencyRuleSchema,
  ResourceImpactSchema,
  evaluateOperationImpact,
  type OperationEnvironment,
  type OperationImpactResult,
} from '../operations/index.js';

export const ConfigurationBlueprintSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().trim().min(1).max(120),
  domain: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  revision: z.number().int().positive(),
  configuration: z.record(z.unknown()),
  rules: z.array(DependencyRuleSchema),
  impacts: z.array(ResourceImpactSchema),
}).strict();

export type ConfigurationBlueprint = z.infer<typeof ConfigurationBlueprintSchema>;
export type BlueprintChange = {
  readonly key: string;
  readonly before: unknown;
  readonly after: unknown;
};
export type BlueprintPreview = {
  readonly blueprintId: string;
  readonly revision: number;
  readonly changes: readonly BlueprintChange[];
  readonly impact: OperationImpactResult;
};
export type BlueprintPreviewInput = {
  readonly blueprint: ConfigurationBlueprint;
  readonly currentConfiguration: Readonly<Record<string, unknown>>;
  readonly operationId: string;
  readonly environment: OperationEnvironment;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isPlainRecord(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

export function previewBlueprintApplication(input: BlueprintPreviewInput): BlueprintPreview {
  const blueprint = ConfigurationBlueprintSchema.parse(input.blueprint);
  const keys = new Set([
    ...Object.keys(input.currentConfiguration),
    ...Object.keys(blueprint.configuration),
  ]);
  const changes: BlueprintChange[] = [];
  for (const key of [...keys].sort()) {
    const before = input.currentConfiguration[key];
    const after = blueprint.configuration[key];
    if (canonical(before) !== canonical(after)) changes.push({ key, before, after });
  }
  return {
    blueprintId: blueprint.id,
    revision: blueprint.revision,
    changes,
    impact: evaluateOperationImpact({
      operationId: input.operationId,
      feature: blueprint.domain,
      rules: blueprint.rules,
      impacts: blueprint.impacts,
    }, input.environment),
  };
}
