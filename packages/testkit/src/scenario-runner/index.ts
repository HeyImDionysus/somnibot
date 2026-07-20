/**
 * scenario-runner — the CATALOG SCENARIO RUNNER: the framework that turns the
 * 46-domain catalog's declarative scenarios into executable real-stack proofs.
 *
 * Add a domain by authoring a `DomainProof` (its guild-scoped tables + its 12
 * scenario scripts) and passing it to `runDomainProof`. The runner loads the
 * validated catalog, boots the live stack per scenario, records per-assertion-class
 * evidence (PASS / GATED / FAIL), sweeps run-prefixed rows, and returns a report.
 */
export type {
  AssertionStatus,
  ObservationChannel,
  AssertionRecord,
  ClassEvidence,
  ScenarioEvidence,
  Finding,
  DomainReport,
  Capabilities,
  BootGuildOptions,
  ScenarioContext,
  RunSlashParams,
  ScenarioScript,
  DomainScriptMap,
  DomainProof,
} from './types.js';

export { detectCapabilities, probeRedis } from './capabilities.js';
export { ScenarioContextImpl, sweepGuild, countGuildRows } from './context.js';
export { runDomainProof, collectFindings, type RunDomainOptions } from './runner.js';
export { formatReport, summarize, type ReportSummary } from './report.js';

export { gameEconomyWalletRewardsProof } from './scripts/game-economy-wallet-rewards.js';
