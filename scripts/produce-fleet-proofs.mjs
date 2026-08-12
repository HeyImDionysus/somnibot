#!/usr/bin/env node
/**
 * Turn operator acceptance observations into strict fleet-proof receipts.
 *
 * This is deliberately a producer, not an aggregate or status updater: a
 * GATED assertion remains GATED in the source manifests.  Every receipt is
 * bound to the exact candidate and to a key that those manifests actually
 * declared.
 */

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SHA_RE = /^[0-9a-f]{40}$/i;
const MANIFEST_RE = /^(?:fleet-)?shard-[1-4]\.json$/;
const RECEIPT_RE = /^fleet-proof-.+\.json$/;
const SYNTHETIC_RE = /(?:synthetic|mock(?:ed)?|fake|fixture)/i;
// Sensor names must identify a concrete live surface. Keep this allowlist
// explicit so an arbitrary string cannot masquerade as operator evidence.
const REAL_SENSOR_RE = /(?:discord|dashboard|paypal|launcher|supabase|postgres(?:ql)?|database|\bdb\b|\brls\b|audit|valkey|redis|lavalink|tailscale|https?|webhook|process|ssh|caddy|files?system)/i;

function fail(message) {
  throw new Error(message);
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`could not read ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function candidateSha(value, label) {
  const sha = requireString(value, label);
  if (!SHA_RE.test(sha)) fail(`${label} must be an exact 40-character candidate SHA`);
  return sha.toLowerCase();
}

function gateKey(domainId, scenario, assertionClass) {
  return `${domainId}\0${scenario}\0${assertionClass}`;
}

function collectGatedKeys(manifestDirectory, expectedSha) {
  if (!existsSync(manifestDirectory)) fail(`manifest directory does not exist: ${manifestDirectory}`);
  const files = readdirSync(manifestDirectory).filter((file) => MANIFEST_RE.test(file)).sort();
  if (files.length !== 4) fail(`expected exactly four shard manifests, found ${files.length}`);

  const expectedShards = new Set(['1/4', '2/4', '3/4', '4/4']);
  const seenShards = new Set();
  const gated = new Map();
  for (const file of files) {
    const manifest = readJson(path.join(manifestDirectory, file), file);
    if (manifest?.schemaVersion !== 2) fail(`unsupported manifest schema in ${file}`);
    const manifestSha = candidateSha(manifest.candidateSha, `${file} candidateSha`);
    if (manifestSha !== expectedSha) fail(`${file} candidate SHA does not match expected candidate`);
    const shard = requireString(manifest.shard, `${file} shard`);
    if (!/^\d\/4$/.test(shard) || !expectedShards.has(shard) || seenShards.has(shard)) {
      fail(`manifests must contain one each of shards 1/4 through 4/4 (invalid or duplicate ${shard})`);
    }
    seenShards.add(shard);
    if (!Array.isArray(manifest.results)) fail(`${file} is missing results`);
    for (const result of manifest.results) {
      const domainId = requireString(result?.id, `${file} result id`);
      const gates = Array.isArray(result?.gates) ? result.gates : [];
      if (Number.isInteger(result?.gated) && result.gated !== gates.length) {
        fail(`${file}/${domainId} gate inventory does not match its gated count`);
      }
      for (const gate of gates) {
        const scenario = requireString(gate?.scenario, `${file}/${domainId} gate scenario`);
        const assertionClass = requireString(gate?.class ?? gate?.assertionClass, `${file}/${domainId} gate assertionClass`);
        const key = gateKey(domainId, scenario, assertionClass);
        if (gated.has(key)) fail(`duplicate GATED key in fleet manifests: ${domainId}/${scenario}/${assertionClass}`);
        gated.set(key, { domainId, scenario, assertionClass });
      }
    }
  }
  assert.deepEqual(seenShards, expectedShards, 'manifests must contain one each of shards 1/4 through 4/4');
  return gated;
}

function readLedger(ledgerPath, expectedSha) {
  const ledger = readJson(ledgerPath, 'operator acceptance ledger');
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) fail('operator acceptance ledger must be an object');
  if (ledger.schemaVersion !== 1) fail('operator acceptance ledger must use schemaVersion 1');
  const ledgerSha = candidateSha(ledger.candidateSha, 'operator ledger candidateSha');
  if (ledgerSha !== expectedSha) fail('operator acceptance ledger candidate SHA does not match expected candidate');
  const entries = ledger.entries ?? ledger.acceptances ?? ledger.records ?? ledger.proofs;
  if (!Array.isArray(entries)) fail('operator acceptance ledger is missing entries');
  return entries;
}

function validateEntries(entries, gated) {
  const seen = new Set();
  const grouped = new Map();
  for (const entry of entries) {
    const domainId = requireString(entry?.domainId, 'ledger domainId');
    const scenario = requireString(entry?.scenario, `ledger ${domainId} scenario`);
    const assertionClass = requireString(entry?.assertionClass ?? entry?.class, `ledger ${domainId}/${scenario} assertionClass`);
    const key = gateKey(domainId, scenario, assertionClass);
    if (!gated.has(key)) fail(`operator evidence is not for a GATED key: ${domainId}/${scenario}/${assertionClass}`);
    if (seen.has(key)) fail(`duplicate operator evidence: ${domainId}/${scenario}/${assertionClass}`);
    seen.add(key);

    const sensor = requireString(entry?.sensor, `ledger ${domainId}/${scenario}/${assertionClass} sensor`);
    const observation = requireString(entry?.observedResult ?? entry?.observation ?? entry?.result ?? entry?.observed, `ledger ${domainId}/${scenario}/${assertionClass} observed result`);
    if (!REAL_SENSOR_RE.test(sensor)) fail(`ledger sensor is not a recognized real fleet sensor: ${sensor}`);
    if (SYNTHETIC_RE.test(sensor) || SYNTHETIC_RE.test(observation)) {
      fail(`synthetic/mock/fake/fixture evidence is not accepted for ${domainId}/${scenario}/${assertionClass}`);
    }
    const proof = { scenario, assertionClass, sensor, observation };
    if (!grouped.has(domainId)) grouped.set(domainId, []);
    grouped.get(domainId).push(proof);
  }
  if (seen.size !== gated.size) {
    const missing = [...gated.keys()].filter((key) => !seen.has(key));
    fail(`operator acceptance ledger is incomplete; missing GATED evidence: ${missing.map((key) => key.replaceAll('\0', '/')).join(', ')}`);
  }
  return grouped;
}

function receiptName(domainId) {
  const slug = domainId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!slug) fail(`cannot derive receipt filename for domain ${domainId}`);
  return `fleet-proof-${slug}.json`;
}

export function produceFleetProofs({ manifestDirectory, ledgerPath, outputDirectory, expectedCandidateSha }) {
  const expectedSha = candidateSha(expectedCandidateSha, 'expected candidate SHA');
  const gated = collectGatedKeys(manifestDirectory, expectedSha);
  const entries = readLedger(ledgerPath, expectedSha);
  const grouped = validateEntries(entries, gated);
  mkdirSync(outputDirectory, { recursive: true });
  const existing = readdirSync(outputDirectory).filter((file) => RECEIPT_RE.test(file));
  if (existing.length > 0) fail(`output directory already contains fleet proof receipts: ${existing.join(', ')}`);
  const names = new Set();
  for (const [domainId, proofs] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const file = receiptName(domainId);
    if (names.has(file)) fail(`receipt filename collision for domain ${domainId}`);
    names.add(file);
    writeFileSync(path.join(outputDirectory, file), `${JSON.stringify({
      schemaVersion: 1,
      candidateSha: expectedSha,
      domainId,
      proofs: proofs.sort((a, b) => `${a.scenario}\0${a.assertionClass}`.localeCompare(`${b.scenario}\0${b.assertionClass}`)),
    }, null, 2)}\n`, 'utf8');
  }
  return { candidateSha: expectedSha, gatedCount: gated.size, receiptCount: grouped.size };
}

function main() {
  const [manifestDirectory, ledgerPath, outputDirectory, positionalSha] = process.argv.slice(2);
  if (!manifestDirectory || !ledgerPath || !outputDirectory) {
    fail('Usage: node scripts/produce-fleet-proofs.mjs <manifest-directory> <operator-ledger.json> <output-directory> [expected-candidate-sha]');
  }
  const expectedSha = positionalSha?.trim() || process.env.SOMNIBOT_CANDIDATE_SHA?.trim();
  const result = produceFleetProofs({ manifestDirectory, ledgerPath, outputDirectory, expectedCandidateSha: expectedSha });
  console.log(`Wrote ${result.receiptCount} fleet-proof receipt(s) for ${result.gatedCount} GATED assertion(s) at candidate ${result.candidateSha}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`fleet proof producer: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
