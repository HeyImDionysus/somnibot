import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const candidateSha = 'a'.repeat(40);

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'somnibot-fleet-observations-'));
  const manifests = path.join(root, 'manifests');
  const fragments = path.join(root, 'fragments');
  const output = path.join(root, 'operator-ledger.json');
  mkdirSync(manifests);
  mkdirSync(fragments);
  mkdirSync(path.join(fragments, 'artifacts'));
  const gates = [
    { domainId: 'domain-z', scenario: 'RETRY', assertionClass: 'audit' },
    { domainId: 'domain-a', scenario: 'DEF', assertionClass: 'Discord' },
  ];
  for (let shard = 1; shard <= 4; shard += 1) {
    const shardGates = shard <= 2 ? [gates[shard - 1]] : [];
    const id = shardGates[0]?.domainId ?? `domain-${shard}`;
    writeFileSync(path.join(manifests, `fleet-shard-${shard}.json`), JSON.stringify({
      schemaVersion: 2,
      candidateSha,
      shard: `${shard}/4`,
      assignedDomainIds: [id],
      results: [{
        id,
        pass: 84 - shardGates.length,
        gated: shardGates.length,
        fail: 0,
        gates: shardGates.map((gate) => ({ scenario: gate.scenario, class: gate.assertionClass })),
      }],
    }));
  }
  const entry = (gate, sensor, digit) => {
    const artifactPath = `artifacts/${gate.domainId}.json`;
    const body = `${JSON.stringify({ domainId: gate.domainId, observed: true })}\n`;
    writeFileSync(path.join(fragments, ...artifactPath.split('/')), body);
    return {
      ...gate,
      sensor,
      observedResult: `Real candidate behavior observed for ${gate.domainId}.`,
      observedAt: `2026-08-18T12:00:0${digit}.000Z`,
      artifact: {
        path: artifactPath,
        sha256: createHash('sha256').update(body).digest('hex'),
      },
    };
  };
  writeFileSync(path.join(fragments, 'z-lane.json'), JSON.stringify({
    schemaVersion: 1,
    candidateSha,
    lane: 'discord-live',
    entries: [entry(gates[1], 'discord-live-readback', '2')],
  }));
  writeFileSync(path.join(fragments, 'a-lane.json'), JSON.stringify({
    schemaVersion: 1,
    candidateSha,
    lane: 'dashboard-live',
    entries: [entry(gates[0], 'dashboard-live-route', '1')],
  }));
  return { root, manifests, fragments, output, gates };
}

function run(paths, expectedSha = candidateSha) {
  return spawnSync(process.execPath, [
    'scripts/merge-fleet-observations.mjs',
    paths.manifests,
    paths.fragments,
    paths.output,
    expectedSha,
  ], { cwd: process.cwd(), encoding: 'utf8' });
}

test('merges lane fragments into one deterministic complete operator ledger', () => {
  const paths = fixture();
  try {
    const result = run(paths);
    assert.equal(result.status, 0, result.stderr);
    const ledger = JSON.parse(readFileSync(paths.output, 'utf8'));
    assert.equal(ledger.candidateSha, candidateSha);
    assert.deepEqual(ledger.entries.map((entry) => `${entry.domainId}/${entry.scenario}/${entry.assertionClass}`), [
      'domain-a/DEF/Discord',
      'domain-z/RETRY/audit',
    ]);
    for (const entry of ledger.entries) {
      assert.equal(
        createHash('sha256').update(readFileSync(path.join(paths.root, ...entry.artifact.path.split('/')))).digest('hex'),
        entry.artifact.sha256,
      );
    }
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('rejects wrong-candidate fragments and absent manifest keys', () => {
  const paths = fixture();
  try {
    const file = path.join(paths.fragments, 'a-lane.json');
    const fragment = JSON.parse(readFileSync(file, 'utf8'));
    fragment.candidateSha = 'b'.repeat(40);
    writeFileSync(file, JSON.stringify(fragment));
    const mismatch = run(paths);
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /fragment candidate SHA does not match/);

    fragment.candidateSha = candidateSha;
    fragment.entries[0].scenario = 'NOT-IN-MANIFEST';
    writeFileSync(file, JSON.stringify(fragment));
    const absent = run(paths);
    assert.notEqual(absent.status, 0);
    assert.match(absent.stderr, /not for a GATED key/);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('rejects duplicate tuples across fragments', () => {
  const paths = fixture();
  try {
    const source = JSON.parse(readFileSync(path.join(paths.fragments, 'a-lane.json'), 'utf8'));
    writeFileSync(path.join(paths.fragments, 'duplicate.json'), JSON.stringify({
      ...source,
      lane: 'duplicate-live-lane',
    }));
    const result = run(paths);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /duplicate operator evidence/);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('rejects incomplete, synthetic, and artifact-free claims', () => {
  const paths = fixture();
  try {
    const file = path.join(paths.fragments, 'a-lane.json');
    const fragment = JSON.parse(readFileSync(file, 'utf8'));
    fragment.entries[0].observedResult = 'mock fixture result';
    delete fragment.entries[0].observedAt;
    delete fragment.entries[0].artifact;
    writeFileSync(file, JSON.stringify(fragment));
    const result = run(paths);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /synthetic\/mock\/fake\/fixture|observedAt|artifact/);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('rejects artifact hash mismatch and path escape', () => {
  const paths = fixture();
  try {
    const file = path.join(paths.fragments, 'a-lane.json');
    const fragment = JSON.parse(readFileSync(file, 'utf8'));
    fragment.entries[0].artifact.sha256 = '0'.repeat(64);
    writeFileSync(file, JSON.stringify(fragment));
    const mismatch = run(paths);
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /artifact SHA-256 mismatch/);

    fragment.entries[0].artifact.path = '../outside.json';
    writeFileSync(file, JSON.stringify(fragment));
    const escaped = run(paths);
    assert.notEqual(escaped.status, 0);
    assert.match(escaped.stderr, /portable relative path/);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('rejects artifact symlinks and symlink chains that escape the artifact root', () => {
  const paths = fixture();
  const outside = mkdtempSync(path.join(tmpdir(), 'somnibot-fleet-outside-'));
  try {
    const file = path.join(paths.fragments, 'a-lane.json');
    const fragment = JSON.parse(readFileSync(file, 'utf8'));
    const outsideArtifact = path.join(outside, 'outside.json');
    writeFileSync(outsideArtifact, '{"outside":true}\n');
    const linkedArtifact = path.join(paths.fragments, 'artifacts', 'linked.json');
    symlinkSync(outsideArtifact, linkedArtifact, 'file');
    fragment.entries[0].artifact.path = 'artifacts/linked.json';
    fragment.entries[0].artifact.sha256 = createHash('sha256').update(readFileSync(outsideArtifact)).digest('hex');
    writeFileSync(file, JSON.stringify(fragment));
    const direct = run(paths);
    assert.notEqual(direct.status, 0);
    assert.match(direct.stderr, /must not contain symlinks|real path must remain/);

    rmSync(linkedArtifact);
    const outsideDirectory = path.join(outside, 'chain-target');
    mkdirSync(outsideDirectory);
    writeFileSync(path.join(outsideDirectory, 'linked.json'), '{"outside":"chain"}\n');
    symlinkSync(outsideDirectory, path.join(paths.fragments, 'artifacts', 'chain'), 'junction');
    fragment.entries[0].artifact.path = 'artifacts/chain/linked.json';
    fragment.entries[0].artifact.sha256 = createHash('sha256')
      .update(readFileSync(path.join(outsideDirectory, 'linked.json')))
      .digest('hex');
    writeFileSync(file, JSON.stringify(fragment));
    const chained = run(paths);
    assert.notEqual(chained.status, 0);
    assert.match(chained.stderr, /must not contain symlinks|real path must remain/);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
