/**
 * all-domains-scenario.live.test — runs the CATALOG SCENARIO RUNNER across ALL 46
 * domains against LOCAL Supabase through the REAL production dispatcher.
 *
 * This is the fleet proof: for every domain it runs the 12 declarative catalog
 * scenarios and records PASS / GATED / FAIL evidence per assertion class. It
 * asserts the FRAMEWORK completeness bar (every domain × scenario × class
 * resolved, nothing threw, every GATE carries a reason) and SURFACES every
 * behavior-bug FINDING (a real intent-vs-implementation gap) for owner
 * adjudication — findings are reported loudly, never hidden and never force-green.
 *
 * The per-domain wallet-rewards live test remains the strict reference for that
 * one domain (documented MUST_PASS cells + a zero-findings gate). This suite is
 * the breadth complement across the whole catalog.
 *
 * ⚠️  LIVE: requires a running local Supabase (with Realtime). Runs only via
 *     `test:live`. If the database is unreachable the runner throws — FAILS LOUD.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  runDomainProof,
  detectCapabilities,
  formatReport,
  summarize,
  collectFindings,
  ALL_DOMAIN_PROOFS,
  type DomainReport,
  type Finding,
} from '../../scenario-runner/index.js';
import { ASSERTION_CLASSES, SCENARIO_CLASSES } from '@somnibot/e2e';

let reports: DomainReport[] = [];
let allFindings: Finding[] = [];

beforeAll(async () => {
  // Probe capabilities ONCE, then run every domain against the shared local stack.
  // Distinct per-run prefixes keep concurrent domains isolated; run sequentially
  // for stable, low-memory boots (46 × 12 real inits).
  const capabilities = await detectCapabilities();
  for (const proof of ALL_DOMAIN_PROOFS) {
    const report = await runDomainProof(proof, { capabilities });
    reports.push(report);
  }
  allFindings = reports.flatMap((r) => r.findings);

  // Print the full evidence table per domain + a consolidated findings list.
  // eslint-disable-next-line no-console
  for (const report of reports) console.warn(`\n${formatReport(report)}\n`);
  // eslint-disable-next-line no-console
  console.warn(
    `\n═══ FLEET FINDINGS (${allFindings.length}) — owner adjudication ═══\n` +
      (allFindings.length === 0
        ? '(none)\n'
        : allFindings
            .map(
              (f) =>
                `• ${f.domainId} / ${f.scenarioClass} / ${f.assertionClass}\n` +
                `    promise: ${f.promise}\n    observed: ${f.observation}\n    impact: ${f.impact}`,
            )
            .join('\n')),
  );
}, 1_800_000);

describe('LIVE fleet scenario runner — all 46 catalog domains', () => {
  it('ran every domain (46) with a complete report', () => {
    expect(reports).toHaveLength(ALL_DOMAIN_PROOFS.length);
    expect(new Set(reports.map((r) => r.domainId)).size).toBe(ALL_DOMAIN_PROOFS.length);
  });

  it('produced every scenario × assertion class per domain, and no scenario script threw', () => {
    const errors: string[] = [];
    for (const report of reports) {
      if (report.scenarios.length !== SCENARIO_CLASSES.length) {
        errors.push(`${report.domainId}: ${report.scenarios.length}/${SCENARIO_CLASSES.length} scenarios`);
      }
      for (const scenario of report.scenarios) {
        if (scenario.error) {
          errors.push(`${report.domainId}/${scenario.scenarioClass} THREW: ${scenario.error}`);
        }
        const classes = scenario.classes.map((c) => c.assertionClass).sort();
        if (JSON.stringify(classes) !== JSON.stringify([...ASSERTION_CLASSES].sort())) {
          errors.push(`${report.domainId}/${scenario.scenarioClass}: classes ${classes.join(',')}`);
        }
        for (const cls of scenario.classes) {
          if (!['PASS', 'GATED', 'FAIL'].includes(cls.status)) {
            errors.push(`${report.domainId}/${scenario.scenarioClass}/${cls.assertionClass}: status ${cls.status}`);
          }
        }
      }
    }
    expect(errors, `framework/authoring errors:\n${errors.join('\n')}`).toEqual([]);
  });

  it('every GATED record carries an explicit reason (nothing silently skipped)', () => {
    const missing: string[] = [];
    for (const report of reports) {
      for (const scenario of report.scenarios) {
        for (const cls of scenario.classes) {
          for (const record of cls.records) {
            if (record.status === 'GATED' && !record.gateReason) {
              missing.push(`${report.domainId}/${scenario.scenarioClass}/${cls.assertionClass}`);
            }
          }
        }
      }
    }
    expect(missing, `GATED without a reason: ${missing.join(', ')}`).toEqual([]);
  });

  it('proved real DB-observable evidence across the fleet (not all-gated)', () => {
    // Every domain must have surfaced at least ONE genuine PASS somewhere — a
    // domain that is entirely GATED/FAIL proved nothing and needs a real
    // DB-observable or captured-reply assertion added.
    const provedNothing: string[] = [];
    let totalPass = 0;
    for (const report of reports) {
      const s = summarize(report);
      totalPass += s.pass;
      if (s.pass === 0) provedNothing.push(report.domainId);
    }
    expect(provedNothing, `domains that proved nothing (0 PASS): ${provedNothing.join(', ')}`).toEqual([]);
    expect(totalPass).toBeGreaterThan(ALL_DOMAIN_PROOFS.length); // > 1 PASS/domain avg
  });

  it('surfaces every behavior-bug finding for owner adjudication (findings are reported, not hidden)', () => {
    // Findings are the DELIVERABLE for owner triage, not an automatic failure:
    // this asserts the framework recorded each one well-formed (with an impact),
    // and re-derives them from the reports so none is silently dropped.
    for (const report of reports) {
      const rederived = collectFindings(report.domainId, report.scenarios);
      expect(rederived.length, `${report.domainId} findings mismatch`).toBe(report.findings.length);
      for (const f of report.findings) {
        expect(f.impact, `${report.domainId}/${f.scenarioClass}/${f.assertionClass} finding has no impact`).toBeTruthy();
      }
    }
  });
});
