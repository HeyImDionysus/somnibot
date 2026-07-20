/**
 * wallet-rewards-scenario.live.test — proves the CATALOG SCENARIO RUNNER end-to-end
 * on the FIRST domain (game-economy-wallet-rewards).
 *
 * It runs all 12 declarative catalog scenarios (DEF … CLEANUP) as concrete real-stack
 * proofs against LOCAL Supabase through the REAL production dispatcher, then asserts:
 *   1. the FRAMEWORK ran every scenario × every assertion class (a complete report),
 *   2. the DB-observable proofs that MUST pass DO pass (the genuine live evidence),
 *   3. every discovered behavior-bug FINDING fails the suite — this domain is
 *      expected to surface ZERO findings now that the /pay double-spend was fixed
 *      in PR #301 (economy_pay is idempotent on the interaction id); any NEW
 *      finding is a real regression to adjudicate.
 *
 * ⚠️  LIVE: requires a running local Supabase (with Realtime). Excluded from the
 *     fast `vitest run`; runs only via `test:live` (vitest.live.config.ts). If the
 *     database is unreachable the runner throws — it FAILS LOUD, never skips.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  runDomainProof,
  formatReport,
  summarize,
  gameEconomyWalletRewardsProof,
  type DomainReport,
  type AssertionStatus,
} from '../../scenario-runner/index.js';
import { ASSERTION_CLASSES, SCENARIO_CLASSES } from '@somnibot/e2e';

/**
 * DOCUMENTED behavior-bug findings this domain is EXPECTED to surface. Keys are
 * `SCENARIO/assertion-class`. Each is a REAL intent-vs-implementation gap for the
 * owner to adjudicate — reported, never hidden. A finding OUTSIDE this set fails
 * the suite (an undocumented regression); the set is deliberately small.
 */
// PR #301 made economy_pay idempotent on the interaction id, fixing the /pay
// double-spend this domain previously surfaced. So the domain is now expected to
// surface ZERO findings; any finding fails the suite as an undocumented regression.
const KNOWN_FINDINGS: ReadonlySet<string> = new Set<string>();

/** Cells that MUST be PASS — the genuine DB-observable live proofs. */
const MUST_PASS: ReadonlyArray<[string, string]> = [
  ['DEF', 'Discord'],
  ['DEF', 'audit'],
  ['DEF', 'database-RLS'],
  ['DEF', 'owner-notification'],
  ['DEF', 'branding'],
  ['DEF', 'cleanup'],
  ['SET-A', 'Discord'],
  ['SET-A', 'audit'],
  ['SET-B', 'Discord'],
  ['SET-B', 'audit'],
  ['INVALID', 'database-RLS'],
  ['UNAUTH', 'Discord'], // the two-economies wall
  ['UNAUTH', 'audit'],
  ['RESTART', 'Discord'],
  ['RESTART', 'audit'],
  ['RACE', 'Discord'], // first-touch wallet-creation race
  ['XGUILD', 'Discord'],
  ['XGUILD', 'database-RLS'],
  ['CLEANUP', 'cleanup'],
  // Post-#301: re-delivering one /pay interaction id now transfers exactly once,
  // so the replay-safety cells that previously FAILED (the double-spend finding)
  // must now PASS. REPLAY/audit covers the /collect-income exactly-once ledger.
  ['REPLAY', 'replay-safety'],
  ['REPLAY', 'audit'],
  ['RACE', 'replay-safety'],
];

function cellStatus(report: DomainReport, scenarioClass: string, assertionClass: string): AssertionStatus | undefined {
  const scenario = report.scenarios.find((s) => s.scenarioClass === scenarioClass);
  return scenario?.classes.find((c) => c.assertionClass === assertionClass)?.status;
}

let report: DomainReport;

beforeAll(async () => {
  // Boots the real stack per scenario against LOCAL Supabase. Throws LOUDLY (never
  // a silent skip) if the database is unreachable.
  report = await runDomainProof(gameEconomyWalletRewardsProof);
  // Print the full evidence table + findings (visible with --reporter=verbose).
  // eslint-disable-next-line no-console
  console.warn(`\n${formatReport(report)}\n`);
}, 300_000);

describe('LIVE catalog scenario runner — game-economy-wallet-rewards', () => {
  it('ran every scenario × every assertion class (framework produced a complete report)', () => {
    expect(report.scenarios).toHaveLength(SCENARIO_CLASSES.length);
    for (const scenarioClass of SCENARIO_CLASSES) {
      const scenario = report.scenarios.find((s) => s.scenarioClass === scenarioClass);
      expect(scenario, `missing scenario ${scenarioClass}`).toBeDefined();
      // No script threw before completing.
      expect(scenario!.error, `scenario ${scenarioClass} errored: ${scenario!.error}`).toBeUndefined();
      // All 7 assertion classes are present with a resolved status.
      expect(scenario!.classes.map((c) => c.assertionClass).sort()).toEqual([...ASSERTION_CLASSES].sort());
      for (const cls of scenario!.classes) {
        expect(['PASS', 'GATED', 'FAIL']).toContain(cls.status);
      }
    }
  });

  it('proved the DB-observable MUST-PASS cells (genuine live evidence)', () => {
    const failures: string[] = [];
    for (const [scenarioClass, assertionClass] of MUST_PASS) {
      const status = cellStatus(report, scenarioClass, assertionClass);
      if (status !== 'PASS') {
        failures.push(`${scenarioClass}/${assertionClass}=${status ?? 'MISSING'}`);
      }
    }
    expect(failures, `expected these cells to be PASS but they were not: ${failures.join(', ')}`).toEqual([]);
  });

  it('surfaced the two-economies-wall proof (commerce-held role earns ZERO game income)', () => {
    // The strongest live proof in this domain: /collect-income credits only the
    // normal game-earned role; the active-commerce-entitlement role pays zero.
    expect(cellStatus(report, 'UNAUTH', 'Discord')).toBe('PASS');
    const unauth = report.scenarios.find((s) => s.scenarioClass === 'UNAUTH')!;
    const wall = unauth.classes
      .find((c) => c.assertionClass === 'Discord')!
      .records.find((r) => r.promise.includes('commerce entitlement earns ZERO'));
    expect(wall?.status).toBe('PASS');
  });

  it('reports only DOCUMENTED behavior-bug findings (no undocumented regressions)', () => {
    const undocumented = report.findings
      .map((f) => `${f.scenarioClass}/${f.assertionClass}`)
      .filter((key) => !KNOWN_FINDINGS.has(key));
    expect(
      undocumented,
      `UNDOCUMENTED behavior-bug finding(s) surfaced — a real regression to adjudicate: ${undocumented.join(', ')}`,
    ).toEqual([]);

    // PR #301 added the /pay idempotency key, so the previously-documented /pay
    // double-spend finding must NO LONGER appear — its replay-safety cells PASS
    // now. This guards against the fix silently regressing back into a finding.
    const payFinding = report.findings.find((f) => f.scenarioClass === 'REPLAY' && f.assertionClass === 'replay-safety');
    expect(payFinding, 'the /pay non-idempotency finding should be gone after PR #301 (economy_pay is idempotent)').toBeUndefined();
  });

  it('honored gating: reward-cooldown (/daily) and Discord/PayPal readback are GATED, never faked', () => {
    // With no Redis in the local rig, the /daily reward-amount proof must be GATED
    // (recorded pending, loudly), never a silent skip or a fabricated pass.
    const summary = summarize(report);
    expect(summary.gated, 'expected some GATED cells (credential/dependency lanes deferred)').toBeGreaterThan(0);
    // Every GATED record carries an explicit reason (nothing silently skipped).
    for (const scenario of report.scenarios) {
      for (const cls of scenario.classes) {
        for (const record of cls.records) {
          if (record.status === 'GATED') {
            expect(record.gateReason, `${scenario.scenarioClass}/${cls.assertionClass} gated without a reason`).toBeTruthy();
          }
        }
      }
    }
  });
});
