import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  const domainId = 'administration-team-management';
  mkdirSync(manifests);
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
    }],
  }));
  return { root, manifests, ledger, output, domainId };
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
      }],
    });
    const manifest = JSON.parse(readFileSync(path.join(paths.manifests, 'fleet-shard-1.json'), 'utf8'));
    assert.equal(manifest.results[0].gated, 1, 'producer must not convert GATED to PASS');
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
