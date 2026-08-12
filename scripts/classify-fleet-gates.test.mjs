import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const directory = mkdtempSync(path.join(tmpdir(), 'somnibot-fleet-gate-test-'));
try {
  const gateChannels = ['discord-readback', 'captured-reply', 'paypal-sandbox', 'audit-row', 'db-observable', 'db-rls', 'redis-dependency'];
  for (let shard = 1; shard <= 4; shard += 1) {
    writeFileSync(path.join(directory, `fleet-shard-${shard}.json`), JSON.stringify({
      schemaVersion: 2,
      shard: `${shard}/4`,
      results: shard === 1 ? [{
        id: 'example-domain',
        gates: gateChannels.map((channel) => ({
          scenario: 'DEF',
          class: 'Discord',
          channel,
          reason: 'example',
        })).concat([
          {
            scenario: 'SET-A',
            class: 'audit',
            channel: 'discord-readback',
            reason: 'The dashboard /api/team invitation flow is unimplemented.',
          },
          {
            scenario: 'SET-B',
            class: 'branding',
            channel: 'captured-reply',
            reason: 'Requires the rendered portal browser snapshot.',
          },
          {
            scenario: 'RESTART',
            class: 'Discord',
            channel: 'discord-readback',
            reason: 'Requires Lavalink and audible playback in a voice channel.',
          },
          {
            scenario: 'XGUILD',
            class: 'database-RLS',
            channel: 'db-observable',
            reason: 'Requires the @somnibot/license-sdk validation surface.',
          },
        ]),
      }] : [],
    }));
  }

  const outputPath = path.join(directory, 'classification.json');
  const run = spawnSync(process.execPath, ['scripts/classify-fleet-gates.mjs', directory, outputPath], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);

  const output = JSON.parse(readFileSync(outputPath, 'utf8'));
  assert.equal(output.totalGates, gateChannels.length + 4);
  assert.deepEqual(output.sourceManifests, [
    'fleet-shard-1.json',
    'fleet-shard-2.json',
    'fleet-shard-3.json',
    'fleet-shard-4.json',
  ]);
  assert.deepEqual(output.byRoute, {
    'audit-persistence': 1,
    'dashboard-browser': 1,
    'database-proof-adapter': 2,
    'lavalink-voice': 1,
    'license-sdk': 1,
    'live-discord-interaction': 1,
    'live-discord-readback': 1,
    'paypal-sandbox': 1,
    'product-implementation': 1,
    'valkey-proof-adapter': 1,
  });
} finally {
  rmSync(directory, { recursive: true, force: true });
}
