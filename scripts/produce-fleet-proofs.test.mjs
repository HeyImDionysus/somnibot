import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const candidateSha = 'a'.repeat(40);

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'somnibot-fleet-producer-'));
  const manifests = path.join(root, 'manifests');
  const output = path.join(root, 'proofs');
  const ledger = path.join(root, 'operator-acceptance.json');
  const artifactPath = 'artifacts/dashboard/team-users-route.json';
  const artifactBody = '{"route":"team-users","result":"observed"}\n';
  const artifactSha256 = createHash('sha256').update(artifactBody).digest('hex');
  const domainId = 'administration-team-management';
  mkdirSync(manifests);
  mkdirSync(path.join(root, 'artifacts', 'dashboard'), { recursive: true });
  writeFileSync(path.join(root, ...artifactPath.split('/')), artifactBody);
  for (let shard = 1; shard <= 4; shard += 1) {
    const result = shard === 1
      ? {
        id: domainId,
        pass: 83,
        gated: 1,
        fail: 0,
        gates: [{ scenario: 'DEF', class: 'audit', channel: 'audit-row', reason: 'operator evidence required' }],
      }
      : { id: `domain-${shard}`, pass: 84, gated: 0, fail: 0, gates: [] };
    writeFileSync(path.join(manifests, `fleet-shard-${shard}.json`), JSON.stringify({
      schemaVersion: 2,
      candidateSha,
      shard: `${shard}/4`,
      assignedDomainIds: [result.id],
      results: [result],
    }));
  }
  writeFileSync(ledger, JSON.stringify({
    schemaVersion: 1,
    candidateSha,
    entries: [{
      domainId,
      scenario: 'DEF',
      assertionClass: 'audit',
      sensor: 'dashboard-live-route:team-users-route.live.test.ts',
      observedResult: 'The real dashboard route created the expected audit row.',
      observedAt: '2026-08-18T12:00:00.000Z',
      artifact: {
        path: artifactPath,
        sha256: artifactSha256,
      },
    }],
  }));
  return { root, manifests, ledger, output, domainId, artifactPath, artifactSha256 };
}

function run({ manifests, ledger, output, expectedSha = candidateSha }) {
  return spawnSync(process.execPath, [
    'scripts/produce-fleet-proofs.mjs', manifests, ledger, output, expectedSha,
  ], { cwd: process.cwd(), encoding: 'utf8' });
}

test('writes one schemaVersion 1 receipt for every real gated observation', () => {
  const paths = fixture();
  try {
    const result = run(paths);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(readFileSync(path.join(paths.output, 'fleet-proof-administration-team-management.json'), 'utf8'));
    assert.deepEqual(receipt, {
      schemaVersion: 1,
      candidateSha,
      domainId: paths.domainId,
      proofs: [{
        scenario: 'DEF',
        assertionClass: 'audit',
        sensor: 'dashboard-live-route:team-users-route.live.test.ts',
        observation: 'The real dashboard route created the expected audit row.',
        observedAt: '2026-08-18T12:00:00.000Z',
        artifact: {
          path: paths.artifactPath,
          sha256: paths.artifactSha256,
        },
      }],
    });
    const manifest = JSON.parse(readFileSync(path.join(paths.manifests, 'fleet-shard-1.json'), 'utf8'));
    assert.equal(manifest.results[0].gated, 1, 'producer must not convert GATED to PASS');
    assert.equal(
      createHash('sha256').update(readFileSync(path.join(paths.output, ...paths.artifactPath.split('/')))).digest('hex'),
      paths.artifactSha256,
    );
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('accepts real Supabase/Postgres and Valkey sensor families', () => {
  const paths = fixture();
  try {
    const ledger = JSON.parse(readFileSync(paths.ledger, 'utf8'));
    ledger.entries[0].sensor = 'supabase-live-rls-audit-readback';
    writeFileSync(paths.ledger, JSON.stringify(ledger));
    const result = run(paths);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('rejects a candidate mismatch before writing receipts', () => {
  const paths = fixture();
  try {
    const result = run({ ...paths, expectedSha: 'b'.repeat(40) });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /candidate SHA does not match expected candidate/);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('rejects evidence for a key that is not GATED', () => {
  const paths = fixture();
  try {
    const ledger = JSON.parse(readFileSync(paths.ledger, 'utf8'));
    ledger.entries[0].scenario = 'NOT-GATED';
    writeFileSync(paths.ledger, JSON.stringify(ledger));
    const result = run(paths);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not for a GATED key/);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('rejects duplicate evidence for one domain/scenario/assertionClass key', () => {
  const paths = fixture();
  try {
    const ledger = JSON.parse(readFileSync(paths.ledger, 'utf8'));
    ledger.entries.push({ ...ledger.entries[0], observedResult: 'second real observation' });
    writeFileSync(paths.ledger, JSON.stringify(ledger));
    const result = run(paths);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /duplicate operator evidence/);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('rejects synthetic, mock, fake, or fixture evidence', () => {
  const paths = fixture();
  try {
    const ledger = JSON.parse(readFileSync(paths.ledger, 'utf8'));
    ledger.entries[0].observedResult = 'synthetic fixture output';
    writeFileSync(paths.ledger, JSON.stringify(ledger));
    const result = run(paths);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /synthetic\/mock\/fake\/fixture evidence/);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('rejects evidence without a timestamp and content-addressed artifact', () => {
  const paths = fixture();
  try {
    const ledger = JSON.parse(readFileSync(paths.ledger, 'utf8'));
    delete ledger.entries[0].observedAt;
    delete ledger.entries[0].artifact;
    writeFileSync(paths.ledger, JSON.stringify(ledger));
    const result = run(paths);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /observedAt/);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('replaces an existing same-candidate receipt instead of colliding in CI', () => {
  const paths = fixture();
  try {
    mkdirSync(paths.output);
    const existingName = 'fleet-proof-administration-team-management-def-audit.json';
    writeFileSync(path.join(paths.output, existingName), JSON.stringify({
      schemaVersion: 1,
      candidateSha,
      domainId: paths.domainId,
      proofs: [],
    }));
    const result = run(paths);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(readFileSync(path.join(paths.output, existingName), 'utf8'));
    assert.equal(receipt.proofs.length, 1);
    assert.equal(existsSync(path.join(paths.output, 'fleet-proof-administration-team-management.json')), false);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('rejects an existing receipt collision from another candidate', () => {
  const paths = fixture();
  try {
    mkdirSync(paths.output);
    writeFileSync(path.join(paths.output, 'fleet-proof-administration-team-management-def-audit.json'), JSON.stringify({
      schemaVersion: 1,
      candidateSha: 'b'.repeat(40),
      domainId: paths.domainId,
      proofs: [],
    }));
    const result = run(paths);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /existing receipt candidate mismatch/);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('rejects artifact hash mismatch and portable-path escape', () => {
  const paths = fixture();
  try {
    const ledger = JSON.parse(readFileSync(paths.ledger, 'utf8'));
    ledger.entries[0].artifact.sha256 = '0'.repeat(64);
    writeFileSync(paths.ledger, JSON.stringify(ledger));
    const mismatch = run(paths);
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /artifact SHA-256 mismatch/);

    ledger.entries[0].artifact.sha256 = paths.artifactSha256;
    ledger.entries[0].artifact.path = '../outside.json';
    writeFileSync(paths.ledger, JSON.stringify(ledger));
    const escaped = run(paths);
    assert.notEqual(escaped.status, 0);
    assert.match(escaped.stderr, /portable relative path/);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('rejects multiple existing receipts for the same domain', () => {
  const paths = fixture();
  try {
    mkdirSync(paths.output);
    for (const suffix of ['def-audit', 'retry-audit']) {
      writeFileSync(path.join(paths.output, `fleet-proof-administration-team-management-${suffix}.json`), JSON.stringify({
        schemaVersion: 1,
        candidateSha,
        domainId: paths.domainId,
        proofs: [],
      }));
    }
    const result = run(paths);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /multiple existing receipts/);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test('rejects a symlink in the output artifact path before copying', () => {
  const paths = fixture();
  const outside = mkdtempSync(path.join(tmpdir(), 'somnibot-fleet-output-outside-'));
  try {
    mkdirSync(paths.output);
    symlinkSync(outside, path.join(paths.output, 'artifacts'), 'junction');
    const result = run(paths);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /output artifact path must not contain symlinks|real path must remain/);
    assert.equal(existsSync(path.join(outside, 'dashboard', 'team-users-route.json')), false);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
