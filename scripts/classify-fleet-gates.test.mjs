import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const databaseProofCases = [
  ...['DEF', 'SET-A', 'SET-B', 'DEPFAIL', 'RETRY', 'RESTART', 'XGUILD'].map((scenario) => ({
    id: 'game-economy-gathering', scenario,
  })),
  { id: 'game-economy-crafting', scenario: 'RETRY' },
  { id: 'game-economy-shop-market', scenario: 'RETRY' },
  { id: 'game-economy-wallet-rewards', scenario: 'RETRY' },
  { id: 'game-economy-wallet-rewards', scenario: 'XGUILD' },
  { id: 'commerce-paypal', scenario: 'RETRY' },
  { id: 'moderation-automod', scenario: 'RETRY' },
  { id: 'moderation-infractions-appeals', scenario: 'RETRY' },
  { id: 'moderation-infractions-appeals', scenario: 'RACE' },
  { id: 'community-profiles', scenario: 'RETRY' },
].map((fixture) => ({
  ...fixture,
  class: 'audit',
  channel: 'audit-row',
  reason: 'requires the owning durable operation proof; this gate remains unresolved',
  expectedRoute: 'database-proof-adapter',
}));

const nonMusicLavalinkCases = [
  ...['DEF', 'SET-A', 'SET-B', 'UNAUTH', 'DEPFAIL', 'RETRY', 'REPLAY', 'RESTART', 'RACE', 'XGUILD', 'CLEANUP']
    .map((scenario) => ({
      id: 'community-statistics-channels', scenario, class: 'Discord',
    })),
  { id: 'community-temporary-channels', scenario: 'CLEANUP', class: 'Discord' },
  { id: 'infrastructure-launcher', scenario: 'SET-A', class: 'database-RLS' },
  { id: 'infrastructure-launcher', scenario: 'SET-A', class: 'Discord' },
].map((fixture) => ({
  ...fixture,
  channel: 'discord-readback',
  reason: 'requires a live voice channel and Lavalink sidecar; the owning surface remains unresolved',
  expectedRoute: fixture.class === 'database-RLS' ? 'database-proof-adapter' : 'live-discord-readback',
}));

const dashboardUnauthorizedDomains = [
  'administration-audit',
  'administration-automations',
  'administration-diagnostics',
  'administration-incidents',
  'administration-rbac',
  'commerce-product-store',
  'community-reaction-roles',
  'community-scheduled-messages',
  'community-starboard',
  'community-statistics-channels',
  'community-welcome-onboarding',
  'game-economy-achievements-prestige',
  'game-economy-adventures',
  'game-economy-casino',
  'game-economy-crafting',
  'game-economy-farming',
  'game-economy-fishing',
  'game-economy-gathering',
  'game-economy-heist',
  'game-economy-lottery',
  'game-economy-pets',
  'game-economy-shop-market',
  'game-economy-trivia',
  'moderation-anti-raid',
  'moderation-automod',
  'moderation-infractions-appeals',
  'moderation-message-logging',
  'music-collaborative-queue',
];
assert.equal(dashboardUnauthorizedDomains.length, 28);

const dashboardCases = dashboardUnauthorizedDomains.map((id) => ({
  id,
  scenario: 'UNAUTH',
  class: 'audit',
  channel: 'discord-readback',
  reason: 'requires the dashboard session-auth lane for the denied request',
  expectedRoute: 'dashboard-browser',
}));

const directory = mkdtempSync(path.join(tmpdir(), 'somnibot-fleet-gate-test-'));
try {
  const gateChannels = ['discord-readback', 'captured-reply', 'paypal-sandbox', 'audit-row', 'db-observable', 'db-rls', 'redis-dependency'];
  const baselineCases = [
    ...gateChannels.map((channel) => ({
      id: 'example-domain', scenario: 'DEF', class: 'Discord', channel, reason: 'example',
      expectedRoute: {
        'discord-readback': 'live-discord-readback',
        'captured-reply': 'live-discord-interaction',
        'paypal-sandbox': 'paypal-sandbox',
        'audit-row': 'audit-persistence',
        'db-observable': 'database-proof-adapter',
        'db-rls': 'database-proof-adapter',
        'redis-dependency': 'valkey-proof-adapter',
      }[channel],
    })),
    {
      id: 'example-dashboard', scenario: 'SET-A', class: 'audit', channel: 'discord-readback',
      reason: 'The dashboard /api/team invitation flow is unimplemented.', expectedRoute: 'product-implementation',
    },
    {
      id: 'example-portal', scenario: 'SET-B', class: 'branding', channel: 'captured-reply',
      reason: 'Requires the rendered portal browser snapshot.', expectedRoute: 'dashboard-browser',
    },
    {
      id: 'example-lavalink', scenario: 'RESTART', class: 'Discord', channel: 'discord-readback',
      reason: 'Requires Lavalink and audible playback in a voice channel.', expectedRoute: 'lavalink-voice',
    },
    {
      id: 'example-sdk', scenario: 'XGUILD', class: 'database-RLS', channel: 'db-observable',
      reason: 'Requires the @somnibot/license-sdk validation surface.', expectedRoute: 'license-sdk',
    },
  ];
  const expectedFixtures = [...baselineCases, ...databaseProofCases, ...nonMusicLavalinkCases, ...dashboardCases];
  const results = expectedFixtures.map(({ id, expectedRoute, ...gate }) => ({ id, gates: [gate], expectedRoute }));
  for (let shard = 1; shard <= 4; shard += 1) {
    writeFileSync(path.join(directory, `fleet-shard-${shard}.json`), JSON.stringify({
      schemaVersion: 2,
      shard: `${shard}/4`,
      results: shard === 1 ? results.map(({ expectedRoute, ...result }) => result) : [],
    }));
  }

  const outputPath = path.join(directory, 'classification.json');
  const run = spawnSync(process.execPath, ['scripts/classify-fleet-gates.mjs', directory, outputPath], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);

  const output = JSON.parse(readFileSync(outputPath, 'utf8'));
  assert.equal(output.totalGates, expectedFixtures.length);
  assert.deepEqual(output.sourceManifests, [
    'fleet-shard-1.json',
    'fleet-shard-2.json',
    'fleet-shard-3.json',
    'fleet-shard-4.json',
  ]);
  assert.equal(output.records.filter((record) => record.status !== 'unresolved').length, 0);

  for (const fixture of expectedFixtures) {
    const matches = output.records.filter((record) => (
      record.domainId === fixture.id
      && record.scenario === fixture.scenario
      && record.assertionClass === fixture.class
      && record.channel === fixture.channel
    ));
    assert.equal(matches.length, 1, `missing fixture ${fixture.id}/${fixture.scenario}/${fixture.class}`);
    assert.equal(matches[0].route, fixture.expectedRoute, `wrong route for ${fixture.id}/${fixture.scenario}/${fixture.class}`);
  }

  const dashboardRecords = output.records.filter((record) => (
    record.scenario === 'UNAUTH' && record.assertionClass === 'audit' && dashboardUnauthorizedDomains.includes(record.domainId)
  ));
  assert.equal(dashboardRecords.length, 28);
  assert.deepEqual(
    dashboardRecords.map((record) => record.domainId).sort(),
    [...dashboardUnauthorizedDomains].sort(),
  );
  assert.ok(dashboardRecords.every((record) => record.route === 'dashboard-browser'));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
