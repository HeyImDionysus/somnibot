/**
 * @somnibot/testkit — loopback E2E harness for driving SomniBot's production
 * interaction router against a disposable guild + local Supabase.
 *
 * ⚠️  TEST-BUILD-ONLY. Never import from production code. This package is a
 *     devDependency of the E2E tooling only; the shipped bot bundle has no
 *     import edge to it. See guard.ts for the runtime defense-in-depth.
 */

export {
  assertLoopbackAllowed,
  isLoopbackAllowed,
  LoopbackGuardError,
  LOOPBACK_E2E_CONFIRMATION,
  type LoopbackEnv,
} from './guard.js';

export {
  mintCapabilityToken,
  tokensMatch,
  type CapabilityToken,
} from './capability.js';

export {
  CapturedResponse,
  createCapturedResponse,
  CapturedResponseStateError,
  type CapturedMethod,
  type CapturedCall,
  type CapturedMessageStub,
} from './captured-response.js';

export {
  buildSlashInteraction,
  buildButtonInteraction,
  buildSelectInteraction,
  buildModalInteraction,
  buildAutocompleteInteraction,
  buildUserContextMenuInteraction,
  buildMessageContextMenuInteraction,
  type SyntheticInteraction,
  type SyntheticUser,
  type SyntheticGuild,
  type SyntheticOptions,
  type SyntheticFields,
  type OptionValue,
  type BaseInteractionParams,
  type SlashExtras,
  type BuildSlashParams,
  type BuildButtonParams,
  type BuildSelectParams,
  type BuildModalParams,
  type BuildAutocompleteParams,
  type BuildContextMenuParams,
} from './interaction-builders.js';

export {
  createInteractionInjector,
  InjectorAuthError,
  type InteractionInjector,
  type CreateInjectorOptions,
  type InjectOptions,
} from './inject.js';

export {
  buildSyntheticMessage,
  type SyntheticMessage,
  type SyntheticMessageAuthor,
  type SyntheticMessageMember,
  type SyntheticMessageChannel,
  type SyntheticMessageGuild,
  type GatewaySend,
  type BuildMessageParams,
} from './gateway-builders.js';

export {
  createGatewayInjector,
  GatewayInjectorAuthError,
  type GatewayInjector,
  type CreateGatewayInjectorOptions,
  type GatewayInjectOptions,
} from './gateway-inject.js';

export {
  startFaultProxy,
  registerFaultControls,
  getFaultControls,
  restoreAllFaults,
  type FaultProxy,
  type FaultControls,
} from './fault-proxy.js';

export {
  bootstrapLiveClient,
  LiveRunnerError,
  type BootstrapLiveOptions,
  type LiveClientHandle,
  type SeededEconomy,
  type ExposedCommand,
} from './live-runner.js';

export {
  runDomainProof,
  collectFindings,
  formatReport,
  summarize,
  detectCapabilities,
  probeRedis,
  gameEconomyWalletRewardsProof,
  type RunDomainOptions,
  type ReportSummary,
  type AssertionStatus,
  type ObservationChannel,
  type AssertionRecord,
  type ClassEvidence,
  type ScenarioEvidence,
  type Finding,
  type DomainReport,
  type Capabilities,
  type BootGuildOptions,
  type ScenarioContext,
  type RunSlashParams,
  type RunMessageParams,
  type ScenarioScript,
  type DomainScriptMap,
  type DomainProof,
} from './scenario-runner/index.js';

export {
  CAPACITY_DIMENSIONS,
  PROOF_STATUSES,
  SERVICE_OBJECTIVES,
  type CapacityDimension,
  type ProofObservation,
  type ProofStatus,
  type ReliabilityProof,
  type ServiceObjective,
} from './readiness/contracts.js';
export {
  buildDomainAcceptanceContracts,
  type DomainAcceptanceContract,
} from './readiness/domain-acceptance.js';
export {
  CROSS_DOMAIN_JOURNEYS,
  crossDomainJourneyObservations,
  type CrossDomainJourney,
} from './readiness/cross-domain-journeys.js';
export { FAILURE_CASES, runExecutableFailureMatrix, type FailureCaseId } from './readiness/failure-injection.js';
export {
  buildCapacityMetrics,
  capacityObservations,
  createCapacityFixture,
  generateCapacityDataset,
  runCapacityReplay,
  type CapacityDataset,
  type CapacityFixture,
  type CapacityMetric,
  type CapacityReplayMetrics,
} from './readiness/capacity-model.js';
export {
  WORKLOAD_CLASSES,
  fairnessObservation,
  runFairScheduling,
  type FairnessResult,
  type WorkloadClass,
} from './readiness/fairness-model.js';
export {
  STORAGE_AUDIT_REQUIREMENTS,
  STORAGE_SURFACES,
  storageAuditObservations,
  type StorageAuditRequirement,
  type StorageSurface,
} from './readiness/storage-audit.js';
export { buildReliabilityProof } from './readiness/proof.js';
export {
  CapabilitySurfaceDiscoveryError,
  discoverCapabilitySurfaces,
  type CapabilitySurfaceInventory,
} from './capability-manifests/discover-surfaces.js';
