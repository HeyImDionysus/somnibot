/**
 * scenario-runner/runner — turns a domain's declarative catalog scenarios into an
 * executed, evidence-bearing report.
 *
 * For the requested domain it: loads the validated catalog (so it asserts against
 * the REAL declared controls/defaults/messages/state, not a copy), runs each of
 * the 12 scenario scripts against a freshly booted live stack, aggregates the
 * per-assertion-class evidence (PASS / GATED / FAIL), sweeps every run-prefixed
 * row, and returns a structured `DomainReport`. Behavior-bug FAILs are hoisted
 * into a single `findings` list for owner adjudication — never hidden, never
 * forced green.
 */
import { randomUUID } from 'node:crypto';

import {
  SCENARIO_CLASSES,
  findDomain,
  loadDefaultCatalog,
  type DomainCatalog,
} from '@somnibot/e2e';

import { detectCapabilities } from './capabilities.js';
import { restoreAllFaults } from '../fault-proxy.js';
import { ScenarioContextImpl } from './context.js';
import type {
  Capabilities,
  DomainProof,
  DomainReport,
  Finding,
  ScenarioEvidence,
} from './types.js';

export interface RunDomainOptions {
  /** Override the per-run prefix (defaults to a fresh `e2e-scn-<uuid8>-`). */
  runPrefix?: string;
  /** Inject probed capabilities (defaults to a live probe). */
  capabilities?: Capabilities;
  /** Supply an already-loaded catalog (defaults to the built-in v1 catalog). */
  catalog?: DomainCatalog;
}

/** Run one domain's 12 scenario scripts and return its evidence report. */
export async function runDomainProof(
  proof: DomainProof,
  options: RunDomainOptions = {},
): Promise<DomainReport> {
  const catalog = options.catalog ?? (await loadDefaultCatalog());
  const domain = findDomain(catalog, proof.domainId);
  if (!domain) {
    throw new Error(`Catalog has no domain "${proof.domainId}"`);
  }

  const runPrefix = options.runPrefix ?? `e2e-scn-${randomUUID().slice(0, 8)}-`;
  const capabilities = options.capabilities ?? (await detectCapabilities());

  const scenarios: ScenarioEvidence[] = [];
  for (const scenarioClass of SCENARIO_CLASSES) {
    const ctx = new ScenarioContextImpl({
      domain,
      scenarioClass,
      runPrefix,
      capabilities,
      guildScopedTables: proof.guildScopedTables,
    });

    let error: string | undefined;
    const script = proof.scripts[scenarioClass];
    if (script) {
      try {
        await script(ctx);
      } catch (err) {
        error =
          err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      }
    }
    // Safety net: a fault script that threw mid-outage must never leave the
    // stack severed for teardown or the next scenario — force-close every
    // open outage window before touching the DB again.
    await restoreAllFaults();
    // Always tear down (dispose handles + sweep run-prefixed rows), even on throw.
    await ctx.teardown();
    scenarios.push(ctx.buildEvidence(error));
  }

  return {
    domainId: domain.id,
    domainName: domain.name,
    runPrefix,
    capabilities,
    scenarios,
    findings: collectFindings(domain.id, scenarios),
  };
}

/** Hoist every FAIL record into a flat findings list for the owner. */
export function collectFindings(
  domainId: string,
  scenarios: readonly ScenarioEvidence[],
): Finding[] {
  const findings: Finding[] = [];
  for (const scenario of scenarios) {
    for (const cls of scenario.classes) {
      for (const record of cls.records) {
        if (record.status === 'FAIL') {
          findings.push({
            domainId,
            scenarioClass: scenario.scenarioClass,
            assertionClass: record.assertionClass,
            promise: record.promise,
            observation: record.observation,
            impact: record.impact ?? '(no impact recorded)',
          });
        }
      }
    }
  }
  return findings;
}
