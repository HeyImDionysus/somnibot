#!/usr/bin/env node
/** Validate four isolated fleet-shard manifests before CI can turn green. */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const manifestDirectory = process.argv[2];
const proofDirectory = process.argv[3];
const expectedCandidateSha = process.argv[4]?.trim()
  || process.env.SOMNIBOT_CANDIDATE_SHA?.trim();
if (!manifestDirectory) {
  throw new Error('Usage: node scripts/aggregate-fleet-manifests.mjs <manifest-directory> [proof-directory] [expected-candidate-sha]');
}
assert.match(
  expectedCandidateSha ?? '',
  /^[0-9a-f]{40}$/i,
  'fleet aggregate requires the expected exact 40-character candidate SHA',
);

const files = readdirSync(manifestDirectory)
  .filter((file) => /^(?:fleet-)?shard-[1-4]\.json$/.test(file))
  .sort();
assert.equal(files.length, 4, `expected exactly four shard manifests, found ${files.length}`);

const manifests = files.map((file) => JSON.parse(readFileSync(path.join(manifestDirectory, file), 'utf8')));
const candidateShas = new Set(manifests.map((manifest) => manifest.candidateSha));
assert.equal(candidateShas.size, 1, 'all fleet manifests must identify the same candidate SHA');
const [candidateSha] = candidateShas;
assert.equal(typeof candidateSha, 'string', 'fleet manifests must identify their candidate SHA');
assert.match(candidateSha, /^[0-9a-f]{40}$/i, 'fleet manifests must identify an exact 40-character candidate SHA');
assert.equal(candidateSha.toLowerCase(), expectedCandidateSha.toLowerCase(), 'fleet manifests do not match the expected candidate SHA');

const receiptFiles = proofDirectory
  ? readdirSync(proofDirectory).filter((file) => /^fleet-proof-.+\.json$/.test(file)).sort()
  : [];
const receipts = receiptFiles.map((file) => JSON.parse(readFileSync(path.join(proofDirectory, file), 'utf8')));
const provenGateKeys = new Set();
for (const receipt of receipts) {
  assert.equal(receipt.schemaVersion, 1, 'unsupported fleet proof receipt');
  assert.equal(receipt.candidateSha, candidateSha, `proof receipt candidate mismatch for ${receipt.domainId}`);
  assert.equal(typeof receipt.domainId, 'string', 'proof receipt is missing domainId');
  assert.ok(Array.isArray(receipt.proofs), `proof receipt for ${receipt.domainId} is missing proofs`);
  for (const proof of receipt.proofs) {
    assert.equal(typeof proof.scenario, 'string', `proof receipt for ${receipt.domainId} has no scenario`);
    assert.equal(typeof proof.assertionClass, 'string', `proof receipt for ${receipt.domainId} has no assertionClass`);
    assert.equal(typeof proof.sensor, 'string', `proof receipt for ${receipt.domainId} has no sensor`);
    assert.equal(typeof proof.observation, 'string', `proof receipt for ${receipt.domainId} has no observation`);
    assert.ok(proof.sensor.trim().length > 0, `proof receipt for ${receipt.domainId} has an empty sensor`);
    assert.ok(proof.observation.trim().length > 0, `proof receipt for ${receipt.domainId} has an empty observation`);
    const key = `${receipt.domainId}\0${proof.scenario}\0${proof.assertionClass}`;
    assert.ok(!provenGateKeys.has(key), `duplicate fleet proof for ${receipt.domainId}/${proof.scenario}/${proof.assertionClass}`);
    provenGateKeys.add(key);
  }
}
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(readFileSync(path.join(repositoryRoot, 'packages/e2e/catalog/v1.json'), 'utf8'));
const expectedDomainIds = catalog.categories.flatMap((category) =>
  category.domains.map((domain) => domain.id),
);
const expectedShardLabels = new Set(['1/4', '2/4', '3/4', '4/4']);
const seenShardLabels = new Set(manifests.map((manifest) => manifest.shard));
assert.deepEqual(seenShardLabels, expectedShardLabels, 'manifests must be one each for shards 1/4 through 4/4');

const domainIds = [];
const invalidResults = [];
const availableGateKeys = new Set();
const expectedAssertionCellsPerDomain = 84;
for (const manifest of manifests) {
  assert.equal(manifest.schemaVersion, 2, `unsupported manifest from shard ${manifest.shard}`);
  assert.ok(Array.isArray(manifest.assignedDomainIds), `missing assignment for shard ${manifest.shard}`);
  assert.ok(Array.isArray(manifest.results), `missing results for shard ${manifest.shard}`);
  assert.deepEqual(
    manifest.results.map((result) => result.id),
    manifest.assignedDomainIds,
    `shard ${manifest.shard} must report exactly its assigned domains in order`,
  );
  domainIds.push(...manifest.assignedDomainIds);
  for (const result of manifest.results) {
    for (const count of [result.pass, result.gated, result.fail]) {
      assert.ok(Number.isInteger(count) && count >= 0, `${manifest.shard}/${result.id} has an invalid assertion count`);
    }
    assert.equal(
      result.pass + result.gated + result.fail,
      expectedAssertionCellsPerDomain,
      `${manifest.shard}/${result.id} must report exactly ${expectedAssertionCellsPerDomain} assertion cells`,
    );
    const gates = Array.isArray(result.gates) ? result.gates : [];
    const gateKeys = new Set(gates.map((gate) => `${result.id}\0${gate.scenario}\0${gate.class}`));
    assert.equal(
      gateKeys.size,
      result.gated,
      `${manifest.shard}/${result.id} gate inventory does not match its gated class count`,
    );
    for (const key of gateKeys) availableGateKeys.add(key);
    const unresolvedGateKeys = [...gateKeys].filter((key) => !provenGateKeys.has(key));
    if (
      result.fail !== 0
      || unresolvedGateKeys.length > 0
      || result.hang
      || result.error
      || (Array.isArray(result.errored) && result.errored.length > 0)
      || (Array.isArray(result.findings) && result.findings.length > 0)
    ) {
      invalidResults.push(`${manifest.shard}/${result.id}`);
    }
  }
}

for (const key of provenGateKeys) {
  assert.ok(availableGateKeys.has(key), `fleet proof does not match an unresolved gate: ${key.replaceAll('\0', '/')}`);
}

assert.equal(domainIds.length, 46, `expected exactly 46 domain reports, found ${domainIds.length}`);
assert.equal(new Set(domainIds).size, 46, 'fleet manifests contain duplicate domain reports');
assert.equal(expectedDomainIds.length, 46, 'the catalog must contain exactly 46 domains');
assert.deepEqual(new Set(domainIds), new Set(expectedDomainIds), 'fleet manifests omit or add catalog domains');
assert.deepEqual(invalidResults, [], `fleet has failed, gated, errored, or unresolved domains: ${invalidResults.join(', ')}`);

console.log(`Fleet aggregate passed: 46 unique domains across ${files.length} shards with ${provenGateKeys.size} external proof receipt(s).`);
