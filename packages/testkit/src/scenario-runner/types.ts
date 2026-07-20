/**
 * scenario-runner/types — the vocabulary that binds a DECLARATIVE catalog
 * scenario to an EXECUTABLE real-stack proof.
 *
 * The 46-domain catalog (packages/e2e/catalog/v1.json) declares, per domain, 12
 * scenario classes (DEF … CLEANUP) each carrying 7 assertion classes (Discord,
 * database-RLS, audit, owner-notification, branding, replay-safety, cleanup) and
 * real-stack EVIDENCE — but with NO concrete command/customId/option mapping. The
 * runner supplies that mapping as a PROOF SCRIPT per (domain, scenarioClass), runs
 * it against the booted live stack, and records a structured EVIDENCE result per
 * assertion class: PASS (proven now), GATED (deferred behind a credential/dependency
 * that is absent — never faked, never silently skipped), or FAIL (the real bot
 * behaves differently from the catalog's contracted intent — a behavior-bug finding
 * for the owner to adjudicate, NOT something to force green).
 */
import type {
  AssertionClass,
  DomainContract,
  ScenarioClass,
} from '@somnibot/e2e';
import type { LiveClientHandle, BootstrapLiveOptions } from '../live-runner.js';
import type { CapturedResponse } from '../captured-response.js';
import type { SyntheticInteraction } from '../interaction-builders.js';

/**
 * A capability-token-bound injector: the scenario context mints and holds the
 * token, so scripts drive interactions without ever handling the raw credential.
 */
export interface BoundInjector {
  inject(interaction: SyntheticInteraction): Promise<CapturedResponse>;
}

/**
 * The outcome of one assertion against the live stack.
 *  - PASS  : observed to satisfy the contracted intent, NOW, against real state.
 *  - GATED : NOT run because a required credential or local dependency is absent;
 *            recorded as pending (loud), never faked and never silently skipped.
 *  - FAIL  : the real behavior contradicts the catalog's contracted intent — a
 *            behavior-bug finding surfaced for owner adjudication.
 */
export type AssertionStatus = 'PASS' | 'GATED' | 'FAIL';

/**
 * WHERE the observation was made / WHAT it depends on. This is how the harness
 * honors the gating boundary: `discord-readback` and `paypal-sandbox` are the
 * credentialed lanes; `redis-dependency` is the local-service lane. The rest run
 * NOW against local Supabase.
 */
export type ObservationChannel =
  | 'db-observable' // a real row/state in local Supabase — runs now
  | 'captured-reply' // the in-process ephemeral reply bubble — runs now
  | 'db-rls' // an RLS / guild-scoping isolation probe — runs now
  | 'audit-row' // an append-only ledger row — runs now
  | 'discord-readback' // a real role/message/channel in the live guild — GATED
  | 'paypal-sandbox' // a real PayPal sandbox effect — GATED
  | 'redis-dependency'; // needs a running Valkey/Redis (cooldown SET NX) — GATED when absent

/** One recorded assertion, always tagged with its catalog assertion class. */
export interface AssertionRecord {
  /** The catalog assertion class this evidence belongs to. */
  readonly assertionClass: AssertionClass;
  /** Where/how it was observed (and therefore whether it could run now). */
  readonly channel: ObservationChannel;
  readonly status: AssertionStatus;
  /** The catalog-contracted intent this assertion checks (the promise). */
  readonly promise: string;
  /** What was actually observed against the live stack. */
  readonly observation: string;
  /** For FAIL only: why the divergence matters (the behavior-bug impact). */
  readonly impact?: string;
  /** For GATED only: the exact missing credential/dependency. */
  readonly gateReason?: string;
}

/** Aggregate evidence for a single assertion class within one scenario. */
export interface ClassEvidence {
  readonly assertionClass: AssertionClass;
  /** FAIL if any record failed; else PASS if any passed; else GATED. */
  readonly status: AssertionStatus;
  readonly records: readonly AssertionRecord[];
}

/** Evidence for one scenario (one of the 12 classes), across all 7 assertion classes. */
export interface ScenarioEvidence {
  readonly scenarioClass: ScenarioClass;
  readonly scenarioId: string;
  readonly promise: string;
  /** One entry per catalog assertion class (all 7 always present). */
  readonly classes: readonly ClassEvidence[];
  /** Set if the script threw before completing (records what ran anyway). */
  readonly error?: string;
}

/** A behavior-bug finding: the real bot diverged from the contracted intent. */
export interface Finding {
  readonly domainId: string;
  readonly scenarioClass: ScenarioClass;
  readonly assertionClass: AssertionClass;
  readonly promise: string;
  readonly observation: string;
  readonly impact: string;
}

/** The full result of running a domain's 12 scenario scripts. */
export interface DomainReport {
  readonly domainId: string;
  readonly domainName: string;
  readonly runPrefix: string;
  readonly capabilities: Capabilities;
  readonly scenarios: readonly ScenarioEvidence[];
  /** Every FAIL, hoisted for a single owner-facing findings list. */
  readonly findings: readonly Finding[];
}

/**
 * Which credentials/dependencies are present for THIS run. Absent ones cause the
 * dependent assertions to be GATED rather than failed or faked.
 */
export interface Capabilities {
  /** Local Supabase reachable (a hard precondition — boot fails loudly if not). */
  readonly supabaseLocal: boolean;
  /** A Valkey/Redis is reachable, so cooldown (SET NX) reward paths can run. */
  readonly redis: boolean;
  /** DISCORD_TOKEN + a live gateway are present for role/message/channel readback. */
  readonly discordReadback: boolean;
  /** PayPal sandbox credentials are present for commerce proofs. */
  readonly paypalSandbox: boolean;
  /** An anon Supabase key is present, so the anon-denial RLS sub-probe can run. */
  readonly anonKey: string | null;
}

/** Options a script passes to boot a guild handle (superset of the runner's). */
export interface BootGuildOptions extends BootstrapLiveOptions {
  /**
   * A stable label for THIS booted guild within the scenario (e.g. 'A', 'B').
   * Only used to derive a deterministic, scenario-scoped guild id when `guildId`
   * is not given, so per-scenario guilds never collide or bleed config.
   */
  label?: string;
}

/**
 * The live context handed to every scenario script. It exposes exactly the levers
 * a proof needs — boot guilds, drive interactions, record evidence — while the
 * runner owns teardown (run-prefixed rows removed) and evidence aggregation.
 */
export interface ScenarioContext {
  /** The domain contract being proven (its declared controls/defaults/messages/state). */
  readonly domain: DomainContract;
  /** Which of the 12 scenario classes this script proves. */
  readonly scenarioClass: ScenarioClass;
  /** The catalog scenario entry for this class (promise, expectedOutcome, assertions). */
  readonly scenario: DomainContract['scenarios'][number];
  /** Unique per-run prefix. Every row/guild a script creates MUST carry it so
   *  cleanup is surgical and the CLEANUP scenario can prove zero leftovers. */
  readonly runPrefix: string;
  /** The credentials/dependencies present for this run. */
  readonly capabilities: Capabilities;

  /** Boot a live guild handle; the runner disposes it and sweeps its rows. */
  bootGuild(options?: BootGuildOptions): Promise<LiveClientHandle>;
  /** A per-scenario, per-label deterministic guild id (run-prefixed). */
  scenarioGuildId(label?: string): string;
  /** A run-prefixed user id for a stable label (e.g. 'a', 'b'). */
  userId(label: string): string;
  /** Create an injector bound to a booted handle (mints its own capability token). */
  injectorFor(handle: LiveClientHandle): BoundInjector;

  /** Drive a slash command through the REAL dispatcher and return its recorder. */
  runSlash(
    handle: LiveClientHandle,
    params: RunSlashParams,
  ): Promise<CapturedResponse>;

  /**
   * Delete every run-prefixed / scenario-guild-scoped row for a booted handle's
   * guild across the domain's tables (and its guild_config + guild rows). Used by
   * the CLEANUP scenario to prove the sweep leaves zero leftovers; also run by the
   * runner during teardown so no scenario bleeds into the next.
   */
  sweepGuildRows(handle: LiveClientHandle): Promise<void>;

  /** Record a raw assertion. */
  record(record: AssertionRecord): void;
  /** Record a PASS. */
  pass(
    assertionClass: AssertionClass,
    channel: ObservationChannel,
    promise: string,
    observation: string,
  ): void;
  /** Record a FAIL (a behavior-bug finding). */
  fail(
    assertionClass: AssertionClass,
    channel: ObservationChannel,
    promise: string,
    observation: string,
    impact: string,
  ): void;
  /** Record a GATED assertion (missing credential/dependency — loud, never faked). */
  gate(
    assertionClass: AssertionClass,
    channel: ObservationChannel,
    promise: string,
    gateReason: string,
  ): void;
  /** Assert a boolean: PASS when true, FAIL (finding) when false. */
  expect(
    condition: boolean,
    args: {
      assertionClass: AssertionClass;
      channel: ObservationChannel;
      promise: string;
      observation: string;
      impact: string;
    },
  ): boolean;
}

/** Parameters for driving one slash command. */
export interface RunSlashParams {
  readonly commandName: string;
  readonly userId: string;
  readonly userLabel?: string;
  readonly options?: Record<string, unknown>;
  readonly member?: unknown;
  /** Override the interaction id (used to prove replay: same id twice). */
  readonly interactionId?: string;
  /** Display name for the acting user (defaults to a run-prefixed label). */
  readonly displayName?: string;
}

/** A single scenario's proof: given the live context, produce assertions. */
export type ScenarioScript = (ctx: ScenarioContext) => Promise<void>;

/** The 12 scripts for a domain (any missing class is recorded as unbound-GATED). */
export type DomainScriptMap = Partial<Record<ScenarioClass, ScenarioScript>>;

/**
 * A domain's complete proof binding: its id, the guild_id-scoped tables to sweep
 * for run-prefixed cleanup (child→parent order — guild_config + guild are always
 * swept in addition), and the 12 scenario scripts. Adding domains #2..46 is just
 * authoring another `DomainProof` — the runner and gating are shared.
 */
export interface DomainProof {
  readonly domainId: string;
  readonly guildScopedTables: readonly string[];
  readonly scripts: DomainScriptMap;
}
