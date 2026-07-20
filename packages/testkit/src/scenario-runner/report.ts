/**
 * scenario-runner/report — render a DomainReport as a human-readable evidence
 * table (12 scenarios × 7 assertion classes) plus a findings section, and derive
 * simple summary counts.
 */
import { ASSERTION_CLASSES, SCENARIO_CLASSES } from '@somnibot/e2e';

import type { AssertionStatus, DomainReport, ScenarioEvidence } from './types.js';

/** Short glyphs so a wide table stays readable in a terminal / CI log. */
const STATUS_GLYPH: Record<AssertionStatus, string> = {
  PASS: 'PASS',
  GATED: 'GATE',
  FAIL: 'FAIL',
};

/** Short header labels for the 7 assertion classes. */
const CLASS_HEADER: Record<string, string> = {
  Discord: 'Discord',
  'database-RLS': 'db-RLS',
  audit: 'audit',
  'owner-notification': 'ownerN',
  branding: 'brand',
  'replay-safety': 'replay',
  cleanup: 'cleanup',
};

export interface ReportSummary {
  readonly scenarios: number;
  readonly assertionCells: number;
  readonly pass: number;
  readonly gated: number;
  readonly fail: number;
}

export function summarize(report: DomainReport): ReportSummary {
  let pass = 0;
  let gated = 0;
  let fail = 0;
  for (const scenario of report.scenarios) {
    for (const cls of scenario.classes) {
      if (cls.status === 'PASS') pass += 1;
      else if (cls.status === 'GATED') gated += 1;
      else fail += 1;
    }
  }
  return {
    scenarios: report.scenarios.length,
    assertionCells: report.scenarios.length * ASSERTION_CLASSES.length,
    pass,
    gated,
    fail,
  };
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function statusFor(scenario: ScenarioEvidence, assertionClass: string): AssertionStatus {
  return (
    scenario.classes.find((c) => c.assertionClass === assertionClass)?.status ?? 'GATED'
  );
}

/** A fixed-width evidence grid: rows = scenarios, columns = assertion classes. */
export function formatReport(report: DomainReport): string {
  const lines: string[] = [];
  const cap = report.capabilities;

  lines.push(
    `═══ SCENARIO-RUNNER REPORT · ${report.domainId} (${report.domainName}) ═══`,
  );
  lines.push(`run-prefix: ${report.runPrefix}`);
  lines.push(
    `capabilities: supabase-local=${cap.supabaseLocal} redis=${cap.redis} ` +
      `discord-readback=${cap.discordReadback} paypal-sandbox=${cap.paypalSandbox} ` +
      `anon-key=${cap.anonKey ? 'present' : 'absent'}`,
  );
  lines.push('');

  const scenarioColWidth = 9;
  const cellWidth = 8;
  const header =
    pad('scenario', scenarioColWidth) +
    ASSERTION_CLASSES.map((c) => pad(CLASS_HEADER[c] ?? c, cellWidth)).join('');
  lines.push(header);
  lines.push('-'.repeat(header.length));

  for (const scenarioClass of SCENARIO_CLASSES) {
    const scenario = report.scenarios.find((s) => s.scenarioClass === scenarioClass);
    if (!scenario) continue;
    const row =
      pad(scenarioClass, scenarioColWidth) +
      ASSERTION_CLASSES.map((c) => pad(STATUS_GLYPH[statusFor(scenario, c)], cellWidth)).join('');
    lines.push(scenario.error ? `${row}  [script-error: ${scenario.error}]` : row);
  }

  const summary = summarize(report);
  lines.push('');
  lines.push(
    `totals: ${summary.pass} PASS · ${summary.gated} GATED · ${summary.fail} FAIL ` +
      `of ${summary.assertionCells} cells (${summary.scenarios} scenarios × ${ASSERTION_CLASSES.length} classes)`,
  );

  if (report.findings.length > 0) {
    lines.push('');
    lines.push(`─── BEHAVIOR-BUG FINDINGS (${report.findings.length}) — owner adjudicates ───`);
    report.findings.forEach((f, i) => {
      lines.push(`  ${i + 1}. [${f.scenarioClass}/${f.assertionClass}]`);
      lines.push(`     promise:     ${f.promise}`);
      lines.push(`     observation: ${f.observation}`);
      lines.push(`     impact:      ${f.impact}`);
    });
  } else {
    lines.push('');
    lines.push('findings: none');
  }

  return lines.join('\n');
}
