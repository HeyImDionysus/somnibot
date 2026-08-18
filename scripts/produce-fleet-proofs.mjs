#!/usr/bin/env node
/**
 * Turn operator acceptance observations into strict fleet-proof receipts.
 *
 * This is deliberately a producer, not an aggregate or status updater: a
 * GATED assertion remains GATED in the source manifests.  Every receipt is
 * bound to the exact candidate and to a key that those manifests actually
 * declared.
 */

import {
  mkdirSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  candidateSha,
  collectGatedKeys,
  copyObservationArtifacts,
  fail,
  gateKey,
  readJson,
  requireString,
  validateObservationEntry,
} from './fleet-proof-contract.mjs';

const RECEIPT_RE = /^fleet-proof-.+\.json$/;

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

function validateEntries(entries, gated, artifactRoot) {
  const seen = new Set();
  const grouped = new Map();
  const observations = [];
  for (const entry of entries) {
    const domainId = requireString(entry?.domainId, 'ledger domainId');
    const scenario = requireString(entry?.scenario, `ledger ${domainId} scenario`);
    const assertionClass = requireString(entry?.assertionClass ?? entry?.class, `ledger ${domainId}/${scenario} assertionClass`);
    const key = gateKey(domainId, scenario, assertionClass);
    if (!gated.has(key)) fail(`operator evidence is not for a GATED key: ${domainId}/${scenario}/${assertionClass}`);
    if (seen.has(key)) fail(`duplicate operator evidence: ${domainId}/${scenario}/${assertionClass}`);
    seen.add(key);

    const verified = validateObservationEntry(entry, {
      label: `ledger ${domainId}/${scenario}/${assertionClass}`,
      artifactRoot,
    });
    observations.push(verified);
    const proof = { scenario, assertionClass, ...verified.proof };
    if (!grouped.has(domainId)) grouped.set(domainId, []);
    grouped.get(domainId).push(proof);
  }
  if (seen.size !== gated.size) {
    const missing = [...gated.keys()].filter((key) => !seen.has(key));
    fail(`operator acceptance ledger is incomplete; missing GATED evidence: ${missing.map((key) => key.replaceAll('\0', '/')).join(', ')}`);
  }
  return { grouped, observations };
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
  const { grouped, observations } = validateEntries(entries, gated, path.dirname(ledgerPath));
  mkdirSync(outputDirectory, { recursive: true });
  const existingByDomain = new Map();
  const existing = readdirSync(outputDirectory).filter((file) => RECEIPT_RE.test(file)).sort();
  for (const file of existing) {
    const receipt = readJson(path.join(outputDirectory, file), `existing receipt ${file}`);
    const receiptSha = candidateSha(receipt?.candidateSha, `existing receipt ${file} candidateSha`);
    if (receiptSha !== expectedSha) fail(`existing receipt candidate mismatch: ${file}`);
    const domainId = requireString(receipt?.domainId, `existing receipt ${file} domainId`);
    if (!grouped.has(domainId)) fail(`unexpected existing fleet proof receipt: ${file}`);
    if (existingByDomain.has(domainId)) fail(`multiple existing receipts for domain ${domainId}`);
    existingByDomain.set(domainId, file);
  }
  const names = new Set();
  const receipts = [];
  for (const [domainId, proofs] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const file = existingByDomain.get(domainId) ?? receiptName(domainId);
    if (names.has(file)) fail(`receipt filename collision for domain ${domainId}`);
    names.add(file);
    receipts.push({ domainId, file, body: {
      schemaVersion: 1,
      candidateSha: expectedSha,
      domainId,
      proofs: proofs.sort((a, b) => `${a.scenario}\0${a.assertionClass}`.localeCompare(`${b.scenario}\0${b.assertionClass}`)),
    } });
  }
  copyObservationArtifacts(observations, outputDirectory);
  for (const receipt of receipts) {
    writeFileSync(
      path.join(outputDirectory, receipt.file),
      `${JSON.stringify(receipt.body, null, 2)}\n`,
      'utf8',
    );
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
