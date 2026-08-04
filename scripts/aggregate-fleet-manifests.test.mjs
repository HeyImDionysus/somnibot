import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const catalog = JSON.parse(readFileSync('packages/e2e/catalog/v1.json', 'utf8'));
const domainIds = catalog.categories.flatMap((category) =>
  category.domains.map((domain) => domain.id),
);

const candidateSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function writeFleet(directory, gateMode = 'none', sha = candidateSha) {
  writeFileSync(path.join(directory, 'unrelated-diagnostic.json'), '{}');
  for (let shard = 1; shard <= 4; shard += 1) {
    const assignedDomainIds = domainIds.filter((_id, position) => position % 4 === shard - 1);
    writeFileSync(path.join(directory, `fleet-shard-${shard}.json`), JSON.stringify({
      schemaVersion: 2,
      candidateSha: sha,
      shard: `${shard}/4`,
      assignedDomainIds,
      results: assignedDomainIds.map((id, position) => ({
        id,
        pass: gateMode === 'declared' && shard === 1 && position === 0 ? 83 : 84,
        gated: gateMode === 'declared' && shard === 1 && position === 0 ? 1 : 0,
        fail: 0,
        findings: [],
        gates: gateMode !== 'none' && shard === 1 && position === 0
          ? [{ scenario: 'DEF', class: 'Discord', channel: 'discord-readback', reason: 'pending live proof' }]
          : [],
      })),
    }));
  }
}

function writeReceipt(directory, sha = candidateSha) {
  writeFileSync(path.join(directory, 'fleet-proof-dashboard.json'), JSON.stringify({
    schemaVersion: 1,
    candidateSha: sha,
    domainId: domainIds[0],
    proofs: [{
      scenario: 'DEF',
      assertionClass: 'Discord',
      sensor: 'dashboard-live-route',
      observation: 'The exact candidate produced and read back the contracted dashboard effect.',
    }],
  }));
}

function runAggregate(directory, proofDirectory, expectedSha = candidateSha, extraArgs = []) {
  return spawnSync(process.execPath, [
    'scripts/aggregate-fleet-manifests.mjs',
    directory,
    ...(proofDirectory ? [proofDirectory] : []),
    ...extraArgs,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, SOMNIBOT_CANDIDATE_SHA: expectedSha },
  });
}

test('accepts exactly 46 clean domain manifests across four shards', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'somnibot-fleet-aggregate-clean-'));
  try {
    writeFleet(directory);
    const run = runAggregate(directory);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Fleet aggregate passed: 46 unique domains across 4 shards with 0 external proof receipt\(s\)\./);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects a hidden gate record even when the class-level gated count is zero', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'somnibot-fleet-aggregate-gated-'));
  try {
    writeFleet(directory, 'hidden');
    const run = runAggregate(directory);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /gate inventory does not match its gated class count/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects a declared gate until an exact external receipt exists', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'somnibot-fleet-aggregate-unproven-'));
  try {
    writeFleet(directory, 'declared');
    const run = runAggregate(directory);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /fleet has failed, gated, errored, or unresolved domains/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('machine validation preserves unresolved gates without calling them release proof', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'somnibot-fleet-aggregate-machine-'));
  try {
    writeFleet(directory, 'declared');
    const run = runAggregate(directory, directory, candidateSha, ['--allow-unresolved']);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Fleet structure validated: 46 unique domains/);
    assert.match(run.stdout, /1 external proof receipt\(s\) remain required before release/);
    assert.doesNotMatch(run.stdout, /Fleet aggregate passed/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('accepts an exact-candidate external receipt for a declared gate', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'somnibot-fleet-aggregate-proof-'));
  try {
    writeFleet(directory, 'declared');
    writeReceipt(directory);
    const run = runAggregate(directory, directory);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /with 1 external proof receipt\(s\)/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects a proof receipt from a different candidate', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'somnibot-fleet-aggregate-wrong-head-'));
  try {
    writeFleet(directory, 'declared');
    writeReceipt(directory, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    const run = runAggregate(directory, directory);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /proof receipt candidate mismatch/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects manifests that agree with each other but not the expected candidate', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'somnibot-fleet-aggregate-stale-head-'));
  try {
    writeFleet(directory, 'none', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    const run = runAggregate(directory);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /do not match the expected candidate SHA/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects incomplete domain results even when no failure is declared', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'somnibot-fleet-aggregate-incomplete-'));
  try {
    writeFleet(directory);
    const file = path.join(directory, 'fleet-shard-1.json');
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    manifest.results[0].pass = 0;
    writeFileSync(file, JSON.stringify(manifest));
    const run = runAggregate(directory);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /must report exactly 84 assertion cells/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
