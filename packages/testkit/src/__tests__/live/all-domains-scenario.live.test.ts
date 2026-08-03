/**
 * all-domains-scenario.live.test — the FLEET proof across ALL 46 catalog domains.
 *
 * Each domain's 12 scenarios are run through the REAL production dispatcher against
 * LOCAL Supabase — but in an ISOLATED child process per domain (run-one-domain.mjs),
 * because booting the real stack 46×12 times in ONE process accumulates realtime
 * connections/timers and hangs. Fresh process per domain = no accumulation, and a
 * hard per-process timeout isolates any single hang.
 *
 * It asserts the FUNCTIONAL bar (every assigned domain ran; each resolved all 84
 * cells = 12 scenarios × 7 assertion classes; no hang, no crash, no failed cell,
 * and no behavior-bug finding). CI shards the catalog across four independent
 * local stacks; domains remain sequential inside each stack so they cannot race
 * shared database state.
 *
 * ⚠️  LIVE: requires a running local Supabase (with Realtime) AND the built testkit
 *     dist (the child runner imports ./dist). Runs only via `test:live`.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ALL_DOMAIN_PROOFS } from '../../scenario-runner/index.js';
import { resolveFleetCandidateSha } from '../../fleet-manifest.js';

const execFileP = promisify(execFile);
const TESTKIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const RUNNER = path.join(TESTKIT_ROOT, 'run-one-domain.mjs');
// The heist proof boots and tears down the complete production stack repeatedly
// across restart and race lanes. Keep a hard bound, but leave enough room for
// all 12 lanes on a loaded hosted runner. The child emits the active lane if it
// reaches its own 300-second stop, so a larger budget never hides a stall.
const PER_DOMAIN_TIMEOUT_MS = 320_000;
// Sequential: a fresh process per domain already removes cross-domain connection
// accumulation (the hang cause); running one at a time additionally avoids
// concurrent domains colliding on shared Supabase state (e.g. two commerce
// domains racing the same tables), which is deterministic and CI-stable.
const CONCURRENCY = 1;

function assignedDomainIds(): { ids: string[]; label: string } {
  const allIds = ALL_DOMAIN_PROOFS.map((proof) => proof.domainId);
  const raw = process.env.SOMNIBOT_FLEET_SHARD?.trim();
  if (!raw) return { ids: allIds, label: 'all domains' };
  const match = /^(\d+)\/(\d+)$/.exec(raw);
  if (!match) throw new Error(`invalid SOMNIBOT_FLEET_SHARD: ${raw}`);
  const index = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isInteger(index) || !Number.isInteger(total) || total < 1 || index < 1 || index > total) {
    throw new Error(`invalid SOMNIBOT_FLEET_SHARD: ${raw}`);
  }
  const ids = allIds.filter((_id, position) => position % total === index - 1);
  if (ids.length === 0) throw new Error(`SOMNIBOT_FLEET_SHARD ${raw} selects no domains`);
  return { ids, label: `shard ${index}/${total}` };
}

const assignment = assignedDomainIds();
// Every child may legitimately consume its hard timeout. Keep the hook budget
// derived from the assigned work instead of a stale wall-clock guess.
const FLEET_TIMEOUT_MS = assignment.ids.length * PER_DOMAIN_TIMEOUT_MS + 60_000;

interface DomainResult {
  id: string;
  pass: number;
  gated: number;
  fail: number;
  findings: Array<{
    scenario: string;
    class: string;
    promise: string;
    observation: string;
    impact: string;
  }>;
  gates?: Array<{
    scenario: string;
    class: string;
    channel: string;
    promise: string;
    reason: string;
  }>;
  capabilities?: {
    redis: boolean;
    discordReadback: boolean;
    paypalSandbox: boolean;
  };
  errored?: string[];
  hang?: boolean;
  error?: string;
  activeScenario?: string;
  completedScenarios?: Array<{ scenarioClass: string; elapsedMs: number }>;
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

function writeShardManifest(): void {
  const manifestPath = process.env.SOMNIBOT_FLEET_MANIFEST;
  if (!manifestPath) return;

  const totals = results.reduce(
    (accumulator, result) => ({
      pass: accumulator.pass + result.pass,
      gated: accumulator.gated + result.gated,
      fail: accumulator.fail + result.fail,
    }),
    { pass: 0, gated: 0, fail: 0 },
  );
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify({
    // Schema v2 retains every unresolved assertion and its precise missing
    // capability. CI artifacts can therefore drive a real gate-closure plan
    // rather than reducing hundreds of functional gaps to opaque counts.
    schemaVersion: 2,
    candidateSha: resolveFleetCandidateSha(),
    shard: process.env.SOMNIBOT_FLEET_SHARD ?? 'all',
    assignedDomainIds: assignment.ids,
    totals,
    results,
  }, null, 2)}\n`, 'utf8');
}

beforeAll(async () => {
  const ids = assignment.ids;
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
  writeShardManifest();

  const totals = results.reduce(
    (a, r) => ({ pass: a.pass + r.pass, gated: a.gated + r.gated, fail: a.fail + r.fail }),
    { pass: 0, gated: 0, fail: 0 },
  );
  const findings = results.flatMap((r) => r.findings.map((f) => ({ id: r.id, ...f })));
  // eslint-disable-next-line no-console
  console.warn(
    `\n═══ FLEET: ${assignment.label} (${ids.length} domains) ═══  PASS=${totals.pass} GATED=${totals.gated} FAIL=${totals.fail}  findings=${findings.length}\n` +
      results
        .map((r) => `  ${r.id.padEnd(40)} P=${String(r.pass).padStart(3)} G=${String(r.gated).padStart(3)} F=${String(r.fail).padStart(2)}${r.hang ? `  HANG:${r.activeScenario ?? 'unknown'}` : r.error ? `  ERR:${r.error}` : ''}`)
        .join('\n') +
      `\n\n─── STRICT FINDINGS (${findings.length}) ───\n` +
      findings.map((f) => `• ${f.id} / ${f.scenario} / ${f.class}: ${f.impact}`).join('\n'),
  );
}, FLEET_TIMEOUT_MS);

describe(`LIVE fleet scenario runner — ${assignment.label}`, () => {
  it('ran every assigned domain, each in an isolated process with no hang or crash', () => {
    expect(results).toHaveLength(assignment.ids.length);
    const broken = results
      .filter((r) => r.hang || r.error || (r.errored && r.errored.length))
      .map((r) => `${r.id}: ${r.hang ? `HANG in ${r.activeScenario ?? 'unknown'} after [${(r.completedScenarios ?? []).map((scenario) => `${scenario.scenarioClass}=${scenario.elapsedMs}ms`).join(', ')}]` : r.error ? r.error : `scenario-threw(${r.errored!.length})`}`);
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

  it('has zero failed functional cells and zero behavior-bug findings', () => {
    const failedDomains = results
      .filter((result) => result.fail !== 0)
      .map((result) => `${result.id}=${result.fail}`);
    const findings = results.flatMap((result) =>
      result.findings.map((finding) => `${result.id}/${finding.scenario}/${finding.class}: ${finding.impact}`),
    );
    expect(failedDomains, `domains with failed cells: ${failedDomains.join(', ')}`).toEqual([]);
    expect(findings, `behavior-bug findings:\n${findings.join('\n')}`).toEqual([]);
  });
});
