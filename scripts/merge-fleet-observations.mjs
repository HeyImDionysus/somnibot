#!/usr/bin/env node
/** Merge partial live-surface observations into one exact-candidate ledger. */

import { existsSync, readdirSync, writeFileSync } from 'node:fs';
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

const FRAGMENT_RE = /\.json$/i;

export function mergeFleetObservations({
  manifestDirectory,
  fragmentDirectory,
  outputPath,
  expectedCandidateSha,
}) {
  const expectedSha = candidateSha(expectedCandidateSha, 'expected candidate SHA');
  const gated = collectGatedKeys(manifestDirectory, expectedSha);
  if (!existsSync(fragmentDirectory)) fail(`fragment directory does not exist: ${fragmentDirectory}`);
  const files = readdirSync(fragmentDirectory).filter((file) => FRAGMENT_RE.test(file)).sort();
  const entries = [];
  const observations = [];
  const seen = new Set();
  for (const file of files) {
    const fragment = readJson(path.join(fragmentDirectory, file), `observation fragment ${file}`);
    if (fragment?.schemaVersion !== 1) fail(`observation fragment ${file} must use schemaVersion 1`);
    const fragmentSha = candidateSha(fragment?.candidateSha, `observation fragment ${file} candidateSha`);
    if (fragmentSha !== expectedSha) fail(`observation fragment candidate SHA does not match: ${file}`);
    const lane = requireString(fragment?.lane, `observation fragment ${file} lane`);
    if (!Array.isArray(fragment?.entries)) fail(`observation fragment ${file} is missing entries`);
    for (const entry of fragment.entries) {
      const domainId = requireString(entry?.domainId, `${file} domainId`);
      const scenario = requireString(entry?.scenario, `${file}/${domainId} scenario`);
      const assertionClass = requireString(
        entry?.assertionClass ?? entry?.class,
        `${file}/${domainId}/${scenario} assertionClass`,
      );
      const key = gateKey(domainId, scenario, assertionClass);
      if (!gated.has(key)) fail(`operator evidence is not for a GATED key: ${domainId}/${scenario}/${assertionClass}`);
      if (seen.has(key)) fail(`duplicate operator evidence: ${domainId}/${scenario}/${assertionClass}`);
      seen.add(key);
      const verified = validateObservationEntry(entry, {
        label: `${file}/${domainId}/${scenario}/${assertionClass}`,
        artifactRoot: fragmentDirectory,
      });
      observations.push(verified);
      entries.push({
        domainId,
        scenario,
        assertionClass,
        lane,
        ...verified.proof,
      });
    }
  }
  if (seen.size !== gated.size) {
    const missing = [...gated.keys()].filter((key) => !seen.has(key));
    fail(`operator observation fragments are incomplete; missing GATED evidence: ${missing.map((key) => key.replaceAll('\0', '/')).join(', ')}`);
  }
  entries.sort((a, b) => gateKey(a.domainId, a.scenario, a.assertionClass)
    .localeCompare(gateKey(b.domainId, b.scenario, b.assertionClass)));
  copyObservationArtifacts(observations, path.dirname(outputPath));
  writeFileSync(outputPath, `${JSON.stringify({
    schemaVersion: 1,
    candidateSha: expectedSha,
    entries,
  }, null, 2)}\n`, 'utf8');
  return { candidateSha: expectedSha, fragmentCount: files.length, entryCount: entries.length };
}

function main() {
  const [manifestDirectory, fragmentDirectory, outputPath, positionalSha] = process.argv.slice(2);
  if (!manifestDirectory || !fragmentDirectory || !outputPath) {
    fail('Usage: node scripts/merge-fleet-observations.mjs <manifest-directory> <fragment-directory> <operator-ledger.json> [expected-candidate-sha]');
  }
  const expectedCandidateSha = positionalSha?.trim() || process.env.SOMNIBOT_CANDIDATE_SHA?.trim();
  const result = mergeFleetObservations({
    manifestDirectory,
    fragmentDirectory,
    outputPath,
    expectedCandidateSha,
  });
  console.log(`Merged ${result.fragmentCount} observation fragment(s) into ${result.entryCount} exact-candidate ledger entries.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`fleet observation merger: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
