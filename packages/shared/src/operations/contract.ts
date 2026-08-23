import { z } from 'zod';

export const OPERATION_STAGES = [
  'draft',
  'validated',
  'conflict_checked',
  'previewed',
  'committed',
  'executed',
  'read_back',
  'audited',
] as const;

export const OperationStageSchema = z.enum(OPERATION_STAGES);
export type OperationStage = z.infer<typeof OperationStageSchema>;

const STAGE_INDEX = new Map<OperationStage, number>(
  OPERATION_STAGES.map((stage, index) => [stage, index]),
);

export const OperationLifecycleSchema = z.array(OperationStageSchema)
  .min(1)
  .superRefine((stages, context) => {
    let prior = -1;
    for (const stage of stages) {
      const current = STAGE_INDEX.get(stage);
      if (current === undefined || current <= prior) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Operation lifecycle stages must be unique and in canonical order',
        });
        return;
      }
      prior = current;
    }
  });

export const OperationDefinitionSchema = z.object({
  domain: z.string().trim().min(1).max(80),
  action: z.string().trim().min(1).max(160),
  lifecycle: OperationLifecycleSchema,
  recovery: z.enum(['none', 'rollback', 'compensation']),
});
export type OperationDefinition = z.infer<typeof OperationDefinitionSchema>;

export const OperationActorSchema = z.object({
  type: z.enum(['owner', 'administrator', 'moderator', 'finance', 'support', 'system', 'customer']),
  id: z.string().trim().min(1).max(160),
});

export const OperationSourceSchema = z.enum(['dashboard', 'discord', 'launcher', 'portal', 'sdk', 'system']);

export const SignificantOperationRequestSchema = OperationDefinitionSchema.extend({
  id: z.string().uuid(),
  guildId: z.string().trim().min(1).max(40),
  idempotencyKey: z.string().trim().min(1).max(200),
  actor: OperationActorSchema,
  source: OperationSourceSchema,
  request: z.record(z.unknown()),
  configurationGeneration: z.number().int().nonnegative().nullable().default(null),
});
export type SignificantOperationRequest = z.infer<typeof SignificantOperationRequestSchema>;

export const ResourceReferenceSchema = z.object({
  kind: z.string().trim().min(1).max(80),
  id: z.string().trim().min(1).max(200),
});
export type ResourceReference = z.infer<typeof ResourceReferenceSchema>;

export const ResourceImpactSchema = z.object({
  resource: ResourceReferenceSchema,
  effect: z.enum(['read', 'create', 'update', 'delete', 'activate', 'deactivate', 'grant', 'revoke', 'refund']),
  reversible: z.boolean(),
  downstream: z.array(ResourceReferenceSchema).default([]),
});
export type ResourceImpact = z.infer<typeof ResourceImpactSchema>;

export const ConfigurationDiffEntrySchema = z.object({
  path: z.string().trim().min(1).max(240),
  kind: z.enum(['added', 'changed', 'removed']),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
}).superRefine((entry, context) => {
  if (entry.kind !== 'added' && entry.before === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['before'], message: 'Existing values require a before snapshot' });
  }
  if (entry.kind !== 'removed' && entry.after === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['after'], message: 'Resulting values require an after snapshot' });
  }
});

export const ConfigurationReleaseSchema = z.object({
  schemaVersion: z.literal(1),
  domain: z.string().trim().min(1).max(80),
  baseRevision: z.number().int().nonnegative(),
  targetRevision: z.number().int().positive(),
  baseSnapshot: z.record(z.unknown()),
  targetSnapshot: z.record(z.unknown()),
  diff: z.array(ConfigurationDiffEntrySchema).min(1),
  validation: z.object({
    valid: z.boolean(),
    errors: z.array(z.string().trim().min(1).max(240)),
  }),
  recovery: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('rollback'), snapshot: z.record(z.unknown()) }),
    z.object({ kind: z.literal('compensation'), instructions: z.record(z.unknown()) }),
    z.object({ kind: z.literal('forward_fix'), instructions: z.record(z.unknown()) }),
  ]),
}).refine((release) => release.targetRevision > release.baseRevision, {
  message: 'Configuration target revision must advance the base revision',
  path: ['targetRevision'],
}).superRefine((release, context) => {
  if (release.validation.valid && release.validation.errors.length > 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['validation', 'errors'], message: 'Valid releases cannot contain validation errors' });
  }
  if (!release.validation.valid && release.validation.errors.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['validation', 'errors'], message: 'Invalid releases require validation errors' });
  }
});
export type ConfigurationRelease = z.infer<typeof ConfigurationReleaseSchema>;

export function nextOperationStage(
  lifecycle: readonly OperationStage[],
  completedStage: OperationStage,
): OperationStage | null {
  const index = lifecycle.indexOf(completedStage);
  return index >= 0 ? lifecycle[index + 1] ?? null : null;
}
