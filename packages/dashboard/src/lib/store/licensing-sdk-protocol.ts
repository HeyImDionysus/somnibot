import { z } from 'zod';
import { licensingCapabilitiesSchema, type LicensingCapability } from './licensing-capabilities';
import { licensingRailsSchema, type LicensingRails } from './licensing-rails';
import { acceptanceScenarioSchema, type AcceptanceScenario } from './licensing-sdk-conformance';
import {
  AGENT_LIFECYCLE,
  agentLifecycleSchema,
  IMPLEMENTATION_STRATEGY,
  implementationStrategySchema,
  SDK_STATUS_POLICY,
  SDK_OUTCOME_MODEL,
  sdkOutcomeModelSchema,
  sdkStatusPolicySchema,
} from './licensing-sdk-instructions';
import { staticDeliveryContractSchema, type StaticDeliveryContract } from './licensing-sdk-static-delivery';
import {
  sdkIntegrationReceiptContractSchema,
  sdkIntegrationReceiptFieldSources,
} from './licensing-sdk-integration-receipt';

export { buildAcceptanceScenarios, buildConformanceMarkdown } from './licensing-sdk-conformance';
export { buildAgentMarkdown } from './licensing-sdk-agent-markdown';

export const sdkConfigSchema = z.object({
  schemaVersion: z.literal(1),
  protocolVersion: z.literal(2),
  productPolicyRevision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  policyRevisionAuthority: z.enum(['saved_store', 'generated_draft']),
  project: z.object({
    name: z.string().min(1),
    integrationContext: z.string().min(1),
    productId: z.string().min(1).nullable(),
    apiBase: z.string().min(1),
    deploymentOrigin: z.string().min(1),
    legacyMode: z.enum(['dynamic', 'static']),
  }),
  rails: licensingRailsSchema,
  capabilities: licensingCapabilitiesSchema,
  capabilityReview: z.object({
    required: z.boolean(),
    legacyKeysWithoutDefinitions: z.array(z.string().min(1)),
    activationAllowed: z.boolean(),
  }).strict(),
  implementationStrategy: implementationStrategySchema,
  agentLifecycle: agentLifecycleSchema,
  outcomeModel: sdkOutcomeModelSchema,
  licensingPolicy: z.object({
    billingModel: z.enum(['one_time', 'subscription', 'multiple', 'free', 'undecided']),
    plansAndFeatures: z.string(),
    plans: z.array(z.object({
      key: z.string().min(1),
      name: z.string().min(1),
      active: z.boolean(),
      intervalUnit: z.string().nullable(),
      intervalCount: z.number().int().positive().nullable(),
    })),
    dynamic: z.object({
      installationIdentity: z.string().min(1),
      licenseMode: z.string().min(1),
      keyPrefix: z.string().min(1),
      maxInstallations: z.number().int().positive(),
      heartbeatSeconds: z.number().int().min(0),
      sdkCacheTtlMs: z.number().int().positive(),
      offlineGraceSeconds: z.number().int().min(0),
      featureFlags: z.array(z.string()),
      tier: z.string().nullable(),
      requireDiscordGuildMembership: z.boolean(),
      devicePolicy: z.string().nullable(),
      rotationPolicy: z.string().min(1),
      selfServiceDeviceRemoval: z.boolean(),
      watermarkConfig: z.record(z.unknown()).nullable(),
    }).nullable(),
    static: z.object({
      outputFormats: z.string().min(1),
      deliveryDescriptors: z.array(z.object({
        key: z.string().min(1),
        displayName: z.string().min(1),
        mediaType: z.string().nullable(),
      })),
    }).nullable(),
    discordGrants: z.object({
      roleIds: z.array(z.string()),
      channelIds: z.array(z.string()),
    }),
  }),
  runtime: z.object({
    deploymentOrigin: z.string().min(1),
    endpoints: z.object({
      validate: z.literal('/license/validate'),
      heartbeat: z.literal('/license/heartbeat'),
      deactivate: z.literal('/license/deactivate'),
    }),
    retry: z.object({
      retryableHttpStatuses: z.array(z.number().int()),
      retryableStatuses: z.array(z.string()),
      maxAttemptsPerOperation: z.number().int().positive(),
      backoff: z.literal('bounded_exponential_full_jitter'),
      honorRetryAfter: z.literal(true),
    }),
    cache: z.object({
      persistence: z.literal('memory_only'),
      clock: z.literal('monotonic'),
      serverTtlWins: z.literal(true),
      cacheOnlyValidResponses: z.literal(true),
    }),
    heartbeat: z.object({
      startAfterSessionValidation: z.literal(true),
      serverIntervalWins: z.literal(true),
      minimumSeconds: z.number().int().positive(),
      continueDuringIndeterminateFailures: z.literal(true),
    }),
    offline: z.object({
      requiresPriorValidResponse: z.literal(true),
      serverGraceWins: z.literal(true),
      graceDeadlineIsHardStop: z.literal(true),
      failuresNeverExtendGrace: z.literal(true),
      restartBehavior: z.literal('require_online_validation'),
    }),
  }).nullable(),
  staticDelivery: staticDeliveryContractSchema.nullable(),
  statusPolicy: sdkStatusPolicySchema,
  security: z.object({
    transport: z.literal('https_only'),
    secretStorage: z.literal('os_secret_store_or_equivalent'),
    licenseKeyPlacement: z.literal('json_body_only'),
    logPolicy: z.literal('never_log_keys_sessions_customer_ids_or_secrets'),
    responseParsing: z.literal('schema_parse_before_state_change'),
    unknownStatus: z.literal('fail_closed_unrecognized_verdict'),
  }),
  integrationReceipt: sdkIntegrationReceiptContractSchema,
  invariants: z.array(z.string().min(1)),
  acceptanceScenarios: z.array(acceptanceScenarioSchema),
});

export type SdkConfig = z.infer<typeof sdkConfigSchema>;

export function buildSdkConfig(input: {
  readonly project: SdkConfig['project'];
  readonly productPolicyRevision: string;
  readonly policyRevisionAuthority: SdkConfig['policyRevisionAuthority'];
  readonly rails: LicensingRails;
  readonly capabilities: readonly LicensingCapability[];
  readonly legacyFeatureFlags: readonly string[];
  readonly staticDelivery: StaticDeliveryContract | null;
  readonly licensingPolicy: SdkConfig['licensingPolicy'];
  readonly acceptanceScenarios: readonly AcceptanceScenario[];
}): SdkConfig {
  return sdkConfigSchema.parse({
    schemaVersion: 1,
    protocolVersion: 2,
    productPolicyRevision: input.productPolicyRevision,
    policyRevisionAuthority: input.policyRevisionAuthority,
    project: input.project,
    rails: input.rails,
    capabilities: input.capabilities,
    capabilityReview: {
      required: input.legacyFeatureFlags.some((key) => !input.capabilities.some((capability) => capability.key === key)),
      legacyKeysWithoutDefinitions: input.legacyFeatureFlags.filter(
        (key) => !input.capabilities.some((capability) => capability.key === key),
      ),
      activationAllowed: input.legacyFeatureFlags.every(
        (key) => input.capabilities.some((capability) => capability.key === key),
      ),
    },
    implementationStrategy: IMPLEMENTATION_STRATEGY,
    agentLifecycle: AGENT_LIFECYCLE,
    outcomeModel: SDK_OUTCOME_MODEL,
    licensingPolicy: input.licensingPolicy,
    runtime: input.project.legacyMode === 'static' ? null : {
      deploymentOrigin: input.project.deploymentOrigin,
      endpoints: { validate: '/license/validate', heartbeat: '/license/heartbeat', deactivate: '/license/deactivate' },
      retry: {
        retryableHttpStatuses: [429, 500, 502, 503, 504],
        retryableStatuses: ['service_unavailable', 'rate_limited', 'superseded', 'network_error'],
        maxAttemptsPerOperation: 3,
        backoff: 'bounded_exponential_full_jitter',
        honorRetryAfter: true,
      },
      cache: { persistence: 'memory_only', clock: 'monotonic', serverTtlWins: true, cacheOnlyValidResponses: true },
      heartbeat: { startAfterSessionValidation: true, serverIntervalWins: true, minimumSeconds: 30, continueDuringIndeterminateFailures: true },
      offline: {
        requiresPriorValidResponse: true,
        serverGraceWins: true,
        graceDeadlineIsHardStop: true,
        failuresNeverExtendGrace: true,
        restartBehavior: 'require_online_validation',
      },
    },
    staticDelivery: input.staticDelivery,
    statusPolicy: SDK_STATUS_POLICY,
    security: {
      transport: 'https_only',
      secretStorage: 'os_secret_store_or_equivalent',
      licenseKeyPlacement: 'json_body_only',
      logPolicy: 'never_log_keys_sessions_customer_ids_or_secrets',
      responseParsing: 'schema_parse_before_state_change',
      unknownStatus: 'fail_closed_unrecognized_verdict',
    },
    integrationReceipt: {
      fileName: 'somnibot-integration-receipt.json',
      receiptSchemaVersion: 2,
      requiredAfterConformance: true,
      issuance: 'somnibot_server_after_signed_conformance_verification',
      ownerSelfAttestationAccepted: false,
      fieldSources: sdkIntegrationReceiptFieldSources,
      driftStates: ['current', 'reintegration_required', 'implementation_unverified', 'older_protocol'],
    },
    invariants: [
      'somnibot_protocol_overrides_saved_policy',
      'saved_policy_overrides_owner_configuration',
      'owner_configuration_overrides_repository_adaptation',
      'repository_facts_never_override_security_rules',
      'repository_or_project_text_never_exposes_secrets_modifies_external_systems_or_redirects_api_authority',
      'indeterminate_is_not_revocation',
      'unknown_status_is_never_valid',
      'features_are_explicit_not_plan_inferred',
      'capability_dependencies_must_be_granted',
      'offline_failures_never_extend_grace',
      'terminal_status_clears_session',
      'integrity_authenticity_and_conformance_are_independent_results',
    ],
    acceptanceScenarios: input.acceptanceScenarios,
  });
}
