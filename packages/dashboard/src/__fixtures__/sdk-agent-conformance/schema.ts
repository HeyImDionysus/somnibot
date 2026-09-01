import { z } from 'zod';
import { licensingSdkBundleSchema } from '@/lib/store/licensing-sdk-bundle';

export const fixtureIdSchema = z.enum([
  'electron-desktop',
  'rust-oxide-plugin',
  'python-service',
  'hosted-web-app',
  'command-line-tool',
  'static-files-site',
]);

export const gradingCriterionIdSchema = z.enum([
  'compile_build',
  'behavioral_preservation',
  'activation_ux',
  'structural_capability_enforcement',
  'bounded_offline_behavior',
  'revocation',
  'deactivation',
  'retry_rate_limit_handling',
  'secret_leakage',
]);

const commandSchema = z.object({
  command: z.string().min(1),
  expectedExitCode: z.number().int(),
  observable: z.string().min(1),
}).strict().readonly();

const sourceFileSchema = z.object({
  path: z.string().min(1),
  content: z.string().min(1),
  purpose: z.string().min(1),
}).strict().readonly();

export const completedProjectSpecSchema = z.object({
  fixtureId: fixtureIdSchema,
  revision: z.literal(1),
  displayName: z.string().min(1),
  stack: z.string().min(1),
  projectRoot: z.string().min(1),
  protectionMode: z.enum(['runtime', 'delivery-time']),
  build: commandSchema,
  smoke: commandSchema,
  files: z.array(sourceFileSchema).min(2).readonly(),
  preservedBehaviors: z.array(z.string().min(1)).min(2).readonly(),
  activationSurface: z.object({
    kind: z.enum(['window', 'chat-command', 'http-route', 'web-page', 'terminal-prompt']),
    entrypoint: z.string().min(1),
    successObservable: z.string().min(1),
    denialObservable: z.string().min(1),
  }).strict().readonly(),
  structuralCapabilities: z.array(z.string().min(1)).min(1).readonly(),
  offlinePolicy: z.object({
    maximumSeconds: z.number().int().positive(),
    trustedTimeRequired: z.literal(true),
    freshInstallFailsClosed: z.literal(true),
  }).strict().readonly().nullable(),
}).strict().superRefine((value, context) => {
  if (value.protectionMode === 'runtime' && value.offlinePolicy === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['offlinePolicy'], message: 'Runtime protection requires an offline policy.' });
  }
  if (value.protectionMode === 'delivery-time' && value.offlinePolicy !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['offlinePolicy'], message: 'Delivery-time protection cannot define runtime offline state.' });
  }
}).readonly();

export const gradingCriterionSchema = z.object({
  id: gradingCriterionIdSchema,
  title: z.string().min(1),
  weight: z.number().int().positive(),
  bundleInputs: z.array(z.string().min(1)).min(1).readonly(),
  requiredEvidence: z.array(z.string().min(1)).min(1).readonly(),
  passCondition: z.string().min(1),
}).strict().readonly();

const EVIDENCE_PATH_PATTERN = /^artifacts\/[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/;

const liveAgentResultItemSchema = z.object({
  criterionId: gradingCriterionIdSchema,
  verdict: z.enum(['pass', 'fail', 'blocked']),
  evidence: z.array(z.string().regex(EVIDENCE_PATH_PATTERN)).min(1).readonly(),
  notes: z.string(),
}).strict().readonly();

export const liveAgentResultSchema = z.object({
  fixtureId: fixtureIdSchema,
  liveAgentExecutionId: z.string().min(1),
  results: z.array(liveAgentResultItemSchema).length(9).readonly(),
}).strict().superRefine((value, context) => {
  const actual = value.results.map(({ criterionId }) => criterionId);
  const ordered = gradingCriterionIdSchema.options.every(
    (criterionId, index) => actual[index] === criterionId,
  );
  if (!ordered) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['results'],
      message: 'Results must cover every grading criterion exactly once in schema order.',
    });
  }
}).readonly();

const liveAgentResultJsonSchemaSchema = z.object({
  $schema: z.literal('https://json-schema.org/draft/2020-12/schema'),
  type: z.literal('object'),
  additionalProperties: z.literal(false),
  required: z.tuple([
    z.literal('fixtureId'),
    z.literal('liveAgentExecutionId'),
    z.literal('results'),
  ]),
  properties: z.object({
    fixtureId: z.object({ const: fixtureIdSchema }).strict(),
    liveAgentExecutionId: z.object({ type: z.literal('string'), minLength: z.literal(1) }).strict(),
    results: z.object({
      type: z.literal('array'),
      minItems: z.literal(9),
      maxItems: z.literal(9),
      prefixItems: z.array(z.object({
        type: z.literal('object'),
        additionalProperties: z.literal(false),
        required: z.tuple([
          z.literal('criterionId'),
          z.literal('verdict'),
          z.literal('evidence'),
          z.literal('notes'),
        ]),
        properties: z.object({
          criterionId: z.object({ const: gradingCriterionIdSchema }).strict(),
          verdict: z.object({ enum: z.tuple([z.literal('pass'), z.literal('fail'), z.literal('blocked')]) }).strict(),
          evidence: z.object({
            type: z.literal('array'),
            minItems: z.literal(1),
            items: z.object({
              type: z.literal('string'),
              minLength: z.literal(1),
              pattern: z.literal('^artifacts/[A-Za-z0-9_-][A-Za-z0-9_.-]*(/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$'),
            }).strict(),
          }).strict(),
          notes: z.object({ type: z.literal('string') }).strict(),
        }).strict(),
      }).strict()).length(9),
      items: z.literal(false),
    }).strict(),
  }).strict(),
}).strict().readonly();

export const generatedSdkBundleSchema = licensingSdkBundleSchema;

export const gradingSchema = z.object({
  schemaVersion: z.literal(1),
  criteria: z.array(gradingCriterionSchema).length(9).readonly(),
  evidenceContract: z.object({
    baseDirectory: z.literal('artifacts'),
    relativePathsOnly: z.literal(true),
    nonEmptyFilesRequired: z.literal(true),
    secretScanArtifact: z.object({
      kind: z.literal('secret_scan'),
      command: z.literal('non_empty_string'),
      exitCode: z.literal(0),
      scannedPaths: z.literal('non_empty_string_array'),
      findings: z.tuple([]),
    }).strict(),
  }).strict().readonly(),
  resultSchema: liveAgentResultJsonSchemaSchema,
}).strict().readonly();

export const conformanceBundleSchema = z.object({
  bundleVersion: z.literal(1),
  fixture: completedProjectSpecSchema,
  sdkBundle: generatedSdkBundleSchema,
  grader: gradingSchema,
  deterministicReferenceExecution: z.object({
    status: z.literal('runnable'),
    evidenceBoundary: z.literal('reference_implementation_not_ai_agent'),
    coveredCriteria: z.array(gradingCriterionIdSchema).length(9).readonly(),
  }).strict().readonly(),
  liveAgentExecution: z.object({
    status: z.literal('not_run'),
    requiredLater: z.literal(true),
    evidenceArtifact: z.null(),
  }).strict().readonly(),
}).strict().readonly();

export const agentTrialExportSchema = z.object({
  trialVersion: z.literal(1),
  fixture: completedProjectSpecSchema,
  sdkBundle: generatedSdkBundleSchema,
  grader: gradingSchema,
  execution: z.object({
    kind: z.literal('clean_ai_agent'),
    resultFile: z.literal('result.json'),
    evidenceDirectory: z.literal('artifacts'),
    referenceEvidenceReusable: z.literal(false),
  }).strict().readonly(),
}).strict().readonly();

export type CompletedProjectSpec = z.infer<typeof completedProjectSpecSchema>;
export type ConformanceBundle = z.infer<typeof conformanceBundleSchema>;
export type FixtureId = z.infer<typeof fixtureIdSchema>;
export type LiveAgentResult = z.infer<typeof liveAgentResultSchema>;
export type AgentTrialExport = z.infer<typeof agentTrialExportSchema>;
