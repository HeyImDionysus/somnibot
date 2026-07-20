/**
 * all-domains-scenario.live.test — the FLEET proof across ALL 46 catalog domains.
 *
 * Each domain's 12 scenarios are run through the REAL production dispatcher against
 * LOCAL Supabase — but in an ISOLATED child process per domain (run-one-domain.mjs),
 * because booting the real stack 46×12 times in ONE process accumulates realtime
 * connections/timers and hangs. Fresh process per domain = no accumulation, and a
 * hard per-process timeout isolates any single hang.
 *
 * It asserts the FRAMEWORK bar (every domain ran; each resolved all 84 cells =
 * 12 scenarios × 7 assertion classes; no hang, no crash) and SURFACES every
 * behavior-bug FINDING for owner adjudication — findings are printed, never hidden
 * and never an automatic failure (they are the audit deliverable, triaged
 * separately). The per-domain wallet-rewards test remains the strict zero-findings
 * reference for that one domain.
 *
 * ⚠️  LIVE: requires a running local Supabase (with Realtime) AND the built testkit
 *     dist (the child runner imports ./dist). Runs only via `test:live`.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ALL_DOMAIN_PROOFS } from '../../scenario-runner/index.js';

const execFileP = promisify(execFile);
const TESTKIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const RUNNER = path.join(TESTKIT_ROOT, 'run-one-domain.mjs');
const PER_DOMAIN_TIMEOUT_MS = 170_000;
// Sequential: a fresh process per domain already removes cross-domain connection
// accumulation (the hang cause); running one at a time additionally avoids
// concurrent domains colliding on shared Supabase state (e.g. two commerce
// domains racing the same tables), which is deterministic and CI-stable.
const CONCURRENCY = 1;

interface DomainResult {
  id: string;
  pass: number;
  gated: number;
  fail: number;
  findings: Array<{ scenario: string; class: string; impact: string }>;
  errored?: string[];
  hang?: boolean;
  error?: string;
}

async function runDomain(id: string): Promise<DomainResult> {
  try {
    const { stdout } = await execFileP('node', [RUNNER, id], {
      cwd: TESTKIT_ROOT,
      timeout: PER_DOMAIN_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    const line = stdout.split(/\r?\n/).find((l) => l.startsWith('RESULT '));
    if (!line) return { id, pass: 0, gated: 0, fail: 0, findings: [], error: 'no RESULT line emitted' };
    return { pass: 0, gated: 0, fail: 0, findings: [], ...JSON.parse(line.slice('RESULT '.length)) };
  } catch (err) {
    const e = err as { killed?: boolean; message?: string };
    const timedOut = Boolean(e.killed) || /timed out|ETIMEDOUT/i.test(e.message ?? '');
    return { id, pass: 0, gated: 0, fail: 0, findings: [], hang: timedOut, error: e.message ?? String(err) };
  }
}

let results: DomainResult[] = [];

beforeAll(async () => {
  const ids = ALL_DOMAIN_PROOFS.map((p) => p.domainId);
  // Bounded-concurrency worker pool over the 46 domains.
  const queue = [...ids];
  const collected: DomainResult[] = [];
  async function worker(): Promise<void> {
    for (;;) {
      const id = queue.shift();
      if (!id) return;
      collected.push(await runDomain(id));
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  // Stable catalog order.
  results = ids.map((id) => collected.find((r) => r.id === id)!).filter(Boolean);

  const totals = results.reduce(
    (a, r) => ({ pass: a.pass + r.pass, gated: a.gated + r.gated, fail: a.fail + r.fail }),
    { pass: 0, gated: 0, fail: 0 },
  );
  const findings = results.flatMap((r) => r.findings.map((f) => ({ id: r.id, ...f })));
  // eslint-disable-next-line no-console
  console.warn(
    `\n═══ FLEET: 46 domains ═══  PASS=${totals.pass} GATED=${totals.gated} FAIL=${totals.fail}  findings=${findings.length}\n` +
      results
        .map((r) => `  ${r.id.padEnd(40)} P=${String(r.pass).padStart(3)} G=${String(r.gated).padStart(3)} F=${String(r.fail).padStart(2)}${r.hang ? '  HANG' : r.error ? `  ERR:${r.error}` : ''}`)
        .join('\n') +
      `\n\n─── FINDINGS (${findings.length}) — owner adjudication ───\n` +
      findings.map((f) => `• ${f.id} / ${f.scenario} / ${f.class}: ${f.impact}`).join('\n'),
  );
}, 1_800_000);

describe('LIVE fleet scenario runner — all 46 catalog domains', () => {
  it('ran every domain (46), each in an isolated process with no hang or crash', () => {
    expect(results).toHaveLength(ALL_DOMAIN_PROOFS.length);
    const broken = results
      .filter((r) => r.hang || r.error || (r.errored && r.errored.length))
      .map((r) => `${r.id}: ${r.hang ? 'HANG' : r.error ? r.error : `scenario-threw(${r.errored!.length})`}`);
    expect(broken, `domains that hung / errored / threw:\n${broken.join('\n')}`).toEqual([]);
  });

  it('resolved all 84 cells per domain (12 scenarios × 7 assertion classes)', () => {
    const incomplete = results
      .map((r) => ({ id: r.id, total: r.pass + r.gated + r.fail }))
      .filter((r) => r.total !== 84)
      .map((r) => `${r.id}=${r.total}/84`);
    expect(incomplete, `domains with unresolved cells: ${incomplete.join(', ')}`).toEqual([]);
  });

  it('proved real DB-observable evidence in every domain (none all-gated)', () => {
    const provedNothing = results.filter((r) => r.pass === 0).map((r) => r.id);
    expect(provedNothing, `domains that proved nothing (0 PASS): ${provedNothing.join(', ')}`).toEqual([]);
  });

  it('surfaces every behavior-bug finding, well-formed, for owner adjudication', () => {
    // Findings are the audit deliverable (triaged separately), NOT an auto-failure.
    // This guards that each recorded finding carries a concrete impact.
    for (const r of results) {
      for (const f of r.findings) {
        expect(f.impact, `${r.id}/${f.scenario}/${f.class} finding has no impact`).toBeTruthy();
      }
    }
  });
});
