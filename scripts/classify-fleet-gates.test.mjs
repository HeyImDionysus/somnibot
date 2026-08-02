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
        })),
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
  assert.equal(output.totalGates, gateChannels.length);
  assert.deepEqual(output.sourceManifests, [
    'fleet-shard-1.json',
    'fleet-shard-2.json',
    'fleet-shard-3.json',
    'fleet-shard-4.json',
  ]);
  assert.deepEqual(output.byRoute, {
    'audit-persistence': 1,
    'database-proof-adapter': 2,
    'live-discord-interaction': 1,
    'live-discord-readback': 1,
    'paypal-sandbox': 1,
    'valkey-proof-adapter': 1,
  });
} finally {
  rmSync(directory, { recursive: true, force: true });
}
