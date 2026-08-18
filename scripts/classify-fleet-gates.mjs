#!/usr/bin/env node
/**
 * Preserve every strict-fleet GATED assertion as a release-proof work item.
 * This never converts a gate to a pass: it assigns each record to the concrete
 * live or local proof lane that must close it.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [manifestDirectory, outputPath] = process.argv.slice(2);
if (!manifestDirectory || !outputPath) {
  throw new Error('Usage: node scripts/classify-fleet-gates.mjs <manifest-directory> <output-json>');
}

const databaseProofAuditCases = new Set([
  ...['DEF', 'SET-A', 'SET-B', 'DEPFAIL', 'RETRY', 'RESTART', 'XGUILD'].map(
    (scenario) => `game-economy-gathering:${scenario}:audit`,
  ),
  'game-economy-crafting:RETRY:audit',
  'game-economy-shop-market:RETRY:audit',
  'game-economy-wallet-rewards:RETRY:audit',
  'game-economy-wallet-rewards:XGUILD:audit',
  'commerce-paypal:RETRY:audit',
  'moderation-automod:RETRY:audit',
  'moderation-infractions-appeals:RETRY:audit',
  'moderation-infractions-appeals:RACE:audit',
  'community-profiles:RETRY:audit',
].map((key) => key.toLowerCase()));
const statisticsDiscordScenarios = new Set([
  'DEF', 'SET-A', 'SET-B', 'UNAUTH', 'DEPFAIL', 'RETRY', 'REPLAY', 'RESTART', 'RACE', 'XGUILD', 'CLEANUP',
]);

function routeGate({ channel, reason = '', promise = '', class: assertionClass, scenario }, domainId) {
  const exactCase = `${domainId}:${scenario}:${assertionClass}`.toLowerCase();
  if (databaseProofAuditCases.has(exactCase)) {
    return 'database-proof-adapter';
  }

  // Statistics and temporary-channel records sometimes mention a voice
  // channel, but their required proof is Discord channel readback, not
  // Lavalink playback. The launcher has two distinct proof surfaces.
  if (
    domainId === 'community-statistics-channels'
    && assertionClass === 'Discord'
    && statisticsDiscordScenarios.has(scenario)
  ) {
    return 'live-discord-readback';
  }
  if (
    domainId === 'community-temporary-channels'
    && scenario === 'CLEANUP'
    && assertionClass === 'Discord'
  ) {
    return 'live-discord-readback';
  }
  if (
    domainId === 'infrastructure-launcher'
    && scenario === 'SET-A'
    && (assertionClass === 'database-RLS' || assertionClass === 'Discord')
  ) {
    return assertionClass === 'database-RLS' ? 'database-proof-adapter' : 'live-discord-readback';
  }

  const detail = `${domainId} ${reason} ${promise}`.toLowerCase();

  // Route by the surface that must actually be exercised before falling back
  // to the recorder's observation channel. Several scenario scripts use a
  // placeholder channel for an unavailable surface; channel-only routing sent
  // dashboard, SDK, Lavalink, and known implementation gaps to Discord.
  if (/unimplemented|code gap|no backing|not backed|contract is unmet|does not exist|writes no audit|no audit_logs row/.test(detail)) {
    return 'product-implementation';
  }
  if (/dashboard|browser|oauth session|rendered portal|portal render|http api|\/api\//.test(detail)) {
    return 'dashboard-browser';
  }
  if (/license-sdk|@somnibot\/license-sdk/.test(detail)) {
    return 'license-sdk';
  }
  if (/lavalink|shoukaku|voice channel|audible playback/.test(detail)) {
    return 'lavalink-voice';
  }

  switch (channel) {
    case 'discord-readback':
      return 'live-discord-readback';
    case 'captured-reply':
      return 'live-discord-interaction';
    case 'paypal-sandbox':
      return 'paypal-sandbox';
    case 'audit-row':
      return 'audit-persistence';
    case 'db-observable':
    case 'db-rls':
      return 'database-proof-adapter';
    case 'redis-dependency':
      return 'valkey-proof-adapter';
    default:
      return 'manual-triage';
  }
}

const files = readdirSync(manifestDirectory)
  .filter((file) => /^(?:fleet-)?shard-[1-4]\.json$/.test(file))
  .sort();
assert.equal(files.length, 4, `expected exactly four shard manifests, found ${files.length}`);

const records = [];
const shardLabels = new Set();
for (const file of files) {
  const manifest = JSON.parse(readFileSync(path.join(manifestDirectory, file), 'utf8'));
  assert.equal(manifest.schemaVersion, 2, `unsupported manifest schema in ${file}`);
  assert.match(manifest.shard, /^[1-4]\/4$/, `invalid shard label in ${file}`);
  shardLabels.add(manifest.shard);
  for (const result of manifest.results ?? []) {
    for (const gate of result.gates ?? []) {
      records.push({
        shard: manifest.shard,
        domainId: result.id,
        scenario: gate.scenario,
        assertionClass: gate.class,
        channel: gate.channel,
        reason: gate.reason,
        route: routeGate(gate, result.id),
        status: 'unresolved',
      });
    }
  }
}
assert.equal(shardLabels.size, 4, 'manifests must represent shards 1/4 through 4/4 exactly once');

const byRoute = Object.fromEntries(
  [...new Set(records.map((record) => record.route))]
    .sort()
    .map((route) => [route, records.filter((record) => record.route === route).length]),
);

writeFileSync(outputPath, `${JSON.stringify({
  schemaVersion: 1,
  sourceManifests: files,
  totalGates: records.length,
  byRoute,
  records,
}, null, 2)}\n`, 'utf8');

console.log(`Classified ${records.length} unresolved fleet gates into ${Object.keys(byRoute).length} proof lanes.`);
