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

function writeFleet(directory, hiddenGate = false) {
  writeFileSync(path.join(directory, 'unrelated-diagnostic.json'), '{}');
  for (let shard = 1; shard <= 4; shard += 1) {
    const assignedDomainIds = domainIds.filter((_id, position) => position % 4 === shard - 1);
    writeFileSync(path.join(directory, `fleet-shard-${shard}.json`), JSON.stringify({
      schemaVersion: 2,
      shard: `${shard}/4`,
      assignedDomainIds,
      results: assignedDomainIds.map((id, position) => ({
        id,
        pass: 84,
        gated: 0,
        fail: 0,
        findings: [],
        gates: hiddenGate && shard === 1 && position === 0
          ? [{ scenario: 'DEF', class: 'Discord', channel: 'discord-readback', reason: 'pending live proof' }]
          : [],
      })),
    }));
  }
}

function runAggregate(directory) {
  return spawnSync(process.execPath, ['scripts/aggregate-fleet-manifests.mjs', directory], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

test('accepts exactly 46 clean domain manifests across four shards', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'somnibot-fleet-aggregate-clean-'));
  try {
    writeFleet(directory);
    const run = runAggregate(directory);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Fleet aggregate passed: 46 unique domains across 4 shards\./);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects a hidden gate record even when the class-level gated count is zero', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'somnibot-fleet-aggregate-gated-'));
  try {
    writeFleet(directory, true);
    const run = runAggregate(directory);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /fleet has failed, gated, errored, or unresolved domains/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
