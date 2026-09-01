import { gradingCriterionIdSchema, gradingSchema } from './schema';

const RESULT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['fixtureId', 'liveAgentExecutionId', 'results'],
  properties: {
    fixtureId: { const: 'electron-desktop' },
    liveAgentExecutionId: { type: 'string', minLength: 1 },
    results: {
      type: 'array',
      minItems: 9,
      maxItems: 9,
      prefixItems: gradingCriterionIdSchema.options.map((criterionId) => ({
        type: 'object',
        additionalProperties: false,
        required: ['criterionId', 'verdict', 'evidence', 'notes'],
        properties: {
          criterionId: { const: criterionId },
          verdict: { enum: ['pass', 'fail', 'blocked'] },
          evidence: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'string',
              minLength: 1,
              pattern: '^artifacts/[A-Za-z0-9_-][A-Za-z0-9_.-]*(/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$',
            },
          },
          notes: { type: 'string' },
        },
      })),
      items: false,
    },
  },
} as const;

export const GRADING_SCHEMA = gradingSchema.parse({
  schemaVersion: 1,
  criteria: [
    { id: 'compile_build', title: 'Compile and build', weight: 12, bundleInputs: ['/fixture/build', '/fixture/files', '/sdkBundle/files/AGENT.md/content'], requiredEvidence: ['command transcript', 'built artifact inventory'], passCondition: 'The fixture build command exits with the expected code and produces its declared runnable artifact.' },
    { id: 'behavioral_preservation', title: 'Behavioral preservation', weight: 12, bundleInputs: ['/fixture/smoke', '/fixture/preservedBehaviors', '/sdkBundle/files/CONFORMANCE.md/content'], requiredEvidence: ['pre/post smoke observations'], passCondition: 'Every declared completed-project behavior still works after integration.' },
    { id: 'activation_ux', title: 'Activation experience', weight: 12, bundleInputs: ['/fixture/activationSurface', '/sdkBundle/files/somnibot-sdk.json/content/acceptanceScenarios', '/sdkBundle/files/license-api.openapi.json/content/paths'], requiredEvidence: ['activation success and denial capture'], passCondition: 'The stack-native activation surface accepts a key, reports success clearly, and presents actionable branded denials.' },
    { id: 'structural_capability_enforcement', title: 'Structural capability enforcement', weight: 14, bundleInputs: ['/fixture/structuralCapabilities', '/sdkBundle/files/somnibot-sdk.json/content/invariants'], requiredEvidence: ['protected-entrypoint execution probes'], passCondition: 'Each protected capability is enforced at its executable entrypoint and cannot be bypassed by direct invocation.' },
    { id: 'bounded_offline_behavior', title: 'Bounded offline behavior', weight: 12, bundleInputs: ['/fixture/offlinePolicy', '/sdkBundle/files/somnibot-sdk.json/content/runtime/offline'], requiredEvidence: ['fresh-install and deadline probes'], passCondition: 'Fresh installs fail closed and prior validation works offline only within the trusted bounded deadline.' },
    { id: 'revocation', title: 'Revocation', weight: 10, bundleInputs: ['/sdkBundle/files/somnibot-sdk.json/content/statusPolicy/revoked', '/sdkBundle/files/somnibot-sdk.json/content/acceptanceScenarios'], requiredEvidence: ['revoked-session readback and denial'], passCondition: 'A revoked session loses all protected capabilities on the next validation or heartbeat.' },
    { id: 'deactivation', title: 'Deactivation', weight: 10, bundleInputs: ['/sdkBundle/files/license-api.openapi.json/content/paths/~1license~1deactivate', '/sdkBundle/files/somnibot-sdk.json/content/runtime'], requiredEvidence: ['deactivation request and local-state inspection'], passCondition: 'Deactivation disables access and removes all stored license material without deleting unrelated application state.' },
    { id: 'retry_rate_limit_handling', title: 'Retry and rate-limit handling', weight: 10, bundleInputs: ['/sdkBundle/files/somnibot-sdk.json/content/runtime/retry', '/sdkBundle/files/somnibot-sdk.json/content/statusPolicy/rate_limited'], requiredEvidence: ['408/429/5xx retry transcript'], passCondition: 'Only retryable failures retry, Retry-After is honored, attempts are bounded, and no duplicate activation/session is created.' },
    { id: 'secret_leakage', title: 'Secret leakage', weight: 8, bundleInputs: ['/sdkBundle/files/somnibot-sdk.json/content/security', '/sdkBundle/externalDependencies', '/sdkBundle/files/AGENT.md/content'], requiredEvidence: ['source, artifact, and log secret scan'], passCondition: 'No forbidden secret is requested, embedded, persisted, printed, or present in built artifacts.' },
  ],
  evidenceContract: {
    baseDirectory: 'artifacts', relativePathsOnly: true, nonEmptyFilesRequired: true,
    secretScanArtifact: {
      kind: 'secret_scan', command: 'non_empty_string', exitCode: 0,
      scannedPaths: 'non_empty_string_array', findings: [],
    },
  },
  resultSchema: RESULT_SCHEMA,
});

export const STATIC_FILES_GRADING_SCHEMA = gradingSchema.parse({
  schemaVersion: 1,
  criteria: [
    { id: 'compile_build', title: 'Compile and package', weight: 12, bundleInputs: ['/fixture/build', '/fixture/files', '/sdkBundle/files/AGENT.md/content'], requiredEvidence: ['build transcript', 'packaged artifact inventory'], passCondition: 'The static project builds and packages without adding a runtime licensing client.' },
    { id: 'behavioral_preservation', title: 'Behavioral preservation', weight: 12, bundleInputs: ['/fixture/smoke', '/fixture/preservedBehaviors', '/sdkBundle/files/CONFORMANCE.md/content'], requiredEvidence: ['pre/post static smoke observations'], passCondition: 'Navigation and local note behavior remain intact in the protected derivative.' },
    { id: 'activation_ux', title: 'Authorized delivery experience', weight: 12, bundleInputs: ['/fixture/activationSurface', '/sdkBundle/files/somnibot-sdk.json/content/rails', '/sdkBundle/files/somnibot-sdk.json/content/acceptanceScenarios'], requiredEvidence: ['authorized and denied portal-delivery captures'], passCondition: 'SomniBot authorizes delivery outside the static project; the project contains no license-key entry or activation UI.' },
    { id: 'structural_capability_enforcement', title: 'Structural delivery enforcement', weight: 14, bundleInputs: ['/fixture/structuralCapabilities', '/sdkBundle/files/somnibot-sdk.json/content/licensingPolicy/static', '/sdkBundle/files/somnibot-sdk.json/content/invariants'], requiredEvidence: ['protected derivative and denied-master probes'], passCondition: 'Only an authorized delivery path can emit a customer derivative, and the unprotected master is never returned.' },
    { id: 'bounded_offline_behavior', title: 'Bounded delivery authorization', weight: 12, bundleInputs: ['/sdkBundle/files/somnibot-sdk.json/content/licensingPolicy/static', '/sdkBundle/files/somnibot-sdk.json/content/acceptanceScenarios'], requiredEvidence: ['expired and reused delivery-token probes'], passCondition: 'Delivery authorization expires, is single-use, and cannot be extended or replayed while offline.' },
    { id: 'revocation', title: 'Future-delivery revocation', weight: 10, bundleInputs: ['/sdkBundle/files/somnibot-sdk.json/content/rails', '/sdkBundle/files/somnibot-sdk.json/content/acceptanceScenarios'], requiredEvidence: ['revoked entitlement delivery denial'], passCondition: 'Revocation blocks future downloads and replacements without claiming to erase an already delivered file.' },
    { id: 'deactivation', title: 'No runtime deactivation surface', weight: 10, bundleInputs: ['/sdkBundle/files/somnibot-sdk.json/content/project/legacyMode', '/sdkBundle/files/somnibot-sdk.json/content/rails'], requiredEvidence: ['static artifact runtime-surface scan'], passCondition: 'The static artifact has no license session, heartbeat, key prompt, or deactivation control; entitlement removal remains a SomniBot delivery concern.' },
    { id: 'retry_rate_limit_handling', title: 'Delivery retry and idempotency', weight: 10, bundleInputs: ['/sdkBundle/files/somnibot-sdk.json/content/acceptanceScenarios', '/sdkBundle/files/CONFORMANCE.md/content'], requiredEvidence: ['rate-limit and duplicate-delivery transcript'], passCondition: 'Retryable portal failures remain bounded and cannot create multiple usable deliveries or expose the master.' },
    { id: 'secret_leakage', title: 'Secret leakage', weight: 8, bundleInputs: ['/sdkBundle/files/somnibot-sdk.json/content/security', '/sdkBundle/externalDependencies', '/sdkBundle/files/AGENT.md/content'], requiredEvidence: ['source, package, manifest, and output secret scan'], passCondition: 'The artifact contains no license key, session, customer identity, provider secret, or server-held delivery secret.' },
  ],
  evidenceContract: {
    baseDirectory: 'artifacts', relativePathsOnly: true, nonEmptyFilesRequired: true,
    secretScanArtifact: {
      kind: 'secret_scan', command: 'non_empty_string', exitCode: 0,
      scannedPaths: 'non_empty_string_array', findings: [],
    },
  },
  resultSchema: RESULT_SCHEMA,
});
