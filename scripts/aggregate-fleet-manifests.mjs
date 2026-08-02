#!/usr/bin/env node
/** Validate four isolated fleet-shard manifests before CI can turn green. */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const manifestDirectory = process.argv[2];
if (!manifestDirectory) {
  throw new Error('Usage: node scripts/aggregate-fleet-manifests.mjs <manifest-directory>');
}

const files = readdirSync(manifestDirectory)
  .filter((file) => file.endsWith('.json'))
  .sort();
assert.equal(files.length, 4, `expected exactly four shard manifests, found ${files.length}`);

const manifests = files.map((file) => JSON.parse(readFileSync(path.join(manifestDirectory, file), 'utf8')));
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
    if (result.gated > 0) {
      assert.ok(Array.isArray(result.gates), `${manifest.shard}/${result.id} is gated but has no gate inventory`);
      assert.ok(
        result.gates.length >= result.gated,
        `${manifest.shard}/${result.id} gate inventory is smaller than its gated class count`,
      );
    }
    if (
      result.fail !== 0
      || result.gated !== 0
      || result.hang
      || result.error
      || (Array.isArray(result.errored) && result.errored.length > 0)
      || (Array.isArray(result.findings) && result.findings.length > 0)
    ) {
      invalidResults.push(`${manifest.shard}/${result.id}`);
    }
  }
}

assert.equal(domainIds.length, 46, `expected exactly 46 domain reports, found ${domainIds.length}`);
assert.equal(new Set(domainIds).size, 46, 'fleet manifests contain duplicate domain reports');
assert.equal(expectedDomainIds.length, 46, 'the catalog must contain exactly 46 domains');
assert.deepEqual(new Set(domainIds), new Set(expectedDomainIds), 'fleet manifests omit or add catalog domains');
assert.deepEqual(invalidResults, [], `fleet has failed, gated, errored, or unresolved domains: ${invalidResults.join(', ')}`);

console.log(`Fleet aggregate passed: 46 unique domains across ${files.length} shards.`);
