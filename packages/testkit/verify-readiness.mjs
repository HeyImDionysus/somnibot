import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createCapacityFixture, generateCapacityDataset } from './dist/readiness/capacity-model.js';
import { buildReliabilityProof } from './dist/readiness/proof.js';
import { buildDomainAcceptanceContracts } from './dist/readiness/domain-acceptance.js';

const catalog = JSON.parse(await readFile(new URL('../e2e/catalog/v1.json', import.meta.url), 'utf8'));
const contracts = buildDomainAcceptanceContracts(catalog);
const fixture = createCapacityFixture();
const dataset = generateCapacityDataset(fixture);
const proof = await buildReliabilityProof();
const syntheticPass = proof.observations.filter((observation) => observation.status === 'SYNTHETIC_PASS');
const liveGated = proof.observations.filter((observation) => observation.status === 'LIVE_GATED');
const failures = proof.observations.filter((observation) => observation.status === 'FAIL');

assert.equal(contracts.length, 46);
assert.equal(new Set(contracts.map((contract) => contract.domainId)).size, 46);
assert.equal(dataset.members.length, 10_000);
assert.equal(new Set(dataset.members.map((member) => member.id)).size, 10_000);
assert.equal(dataset.members.filter((member) => member.active).length, 1_000);
assert.equal(proof.capacityDimensions.length, 13);
assert.equal(proof.serviceObjectives.length, 10);
assert.ok(syntheticPass.length >= 20);
assert.ok(liveGated.length >= 8);
assert.equal(failures.length, 0);
assert.ok(proof.observations.every((observation) => observation.requiredLiveEvidence !== ''));

console.log(JSON.stringify({
  verdict: 'PASS',
  domainContracts: contracts.length,
  generatedMembers: dataset.members.length,
  generatedEvents: dataset.eventIds.length,
  generatedInteractions: dataset.interactionIds.length,
  webhookDeliveries: dataset.webhookDeliveryIds.length,
  capacityDimensions: proof.capacityDimensions.length,
  serviceObjectives: proof.serviceObjectives.length,
  syntheticPass: syntheticPass.length,
  liveGated: liveGated.length,
  fail: failures.length,
}, null, 2));
