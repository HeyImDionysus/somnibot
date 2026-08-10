#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const migrationRunnerUrl = new URL('../packages/bot/dist/services/migration-runner.js', import.meta.url);
const migrationName = '20260727034400_fraud_signal_observation_index.sql';
const migrationSource = readFileSync(
  new URL(`../packages/supabase/migrations/${migrationName}`, import.meta.url),
  'utf8',
);
const migrationsDir = mkdtempSync(join(process.cwd(), '.tmp-migration-runner-smoke-'));
writeFileSync(join(migrationsDir, migrationName), migrationSource);
const migrationChecksum = createHash('sha256')
  .update(migrationSource.replace(/\r\n/g, '\n'), 'utf8')
  .digest('hex');

let migrationHistory = [{
  filename: migrationName,
  checksum: migrationChecksum,
  applied_at: '2026-07-28T00:00:00.000Z',
  duration_ms: 1,
  success: true,
}];
const migrationQueries = [];
const databaseQueries = [];

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function okResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => '',
  };
}

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url.includes('/rest/v1/schema_migrations?')) {
    if ((init.method ?? 'GET') === 'GET') {
      const parsed = new URL(url);
      const filenameFilter = parsed.searchParams.get('filename');
      const selected = filenameFilter?.startsWith('eq.')
        ? migrationHistory.filter((row) => row.filename === filenameFilter.slice(3))
        : migrationHistory;
      return jsonResponse(selected);
    }

    return okResponse();
  }
  if (url.includes('/database/query')) {
    const { query } = JSON.parse(String(init.body));
    databaseQueries.push(query);

    const claimToken = query.match(/claim:v1:[a-f0-9]{64}:[0-9a-f-]{36}/i)?.[0];
    const targetProbeFilename = query.match(
      /__somnibot_migration_target_probe_v1__:[0-9a-f-]{36}/i,
    )?.[0];
    const targetProbeChecksum = query.match(
      /target-binding-probe:v1:[0-9a-f-]{36}/i,
    )?.[0];
    if (
      query.includes('$migration_runner_target_probe_write$')
      && targetProbeFilename
      && targetProbeChecksum
    ) {
      if (!migrationHistory.some((row) => row.filename === targetProbeFilename)) {
        migrationHistory.push({
          filename: targetProbeFilename,
          checksum: targetProbeChecksum,
          applied_at: '2026-07-28T00:00:02.000Z',
          duration_ms: 0,
          success: false,
        });
      }
      return okResponse();
    }

    if (
      query.includes('$migration_runner_target_probe_cleanup$')
      && targetProbeFilename
      && targetProbeChecksum
    ) {
      migrationHistory = migrationHistory.filter((row) => !(
        row.filename === targetProbeFilename
        && row.checksum === targetProbeChecksum
        && row.success === false
      ));
      return okResponse();
    }

    if (
      claimToken
      && query.includes('UPDATE public.schema_migrations')
      && !query.includes('$migration_runner_history$')
    ) {
      const expected = [...query.matchAll(/checksum\s*=\s*'([^']+)'/gi)].at(-1)?.[1];
      if (
        migrationHistory[0]?.checksum === expected
        && migrationHistory[0]?.success === false
      ) {
        migrationHistory[0].checksum = claimToken;
        migrationHistory[0].applied_at = '2026-07-28T00:00:01.000Z';
      }
      return okResponse();
    }

    if (query.includes('$migration_runner_claim_proof$')) {
      if (migrationHistory[0]?.checksum !== claimToken) {
        return {
          ok: false,
          status: 400,
          text: async () => 'claim proof failed',
        };
      }
      return okResponse();
    }

    if (
      query.includes('DO $fraud_index_recovery$')
      || query.trimStart().startsWith('CREATE INDEX CONCURRENTLY')
      || query.includes('DO $fraud_index_postflight$')
    ) {
      migrationQueries.push(query);
    }

    if (query.includes('$migration_runner_history$')) {
      const checksums = [...query.matchAll(/checksum\s*=\s*'([^']+)'/gi)]
        .map((match) => match[1]);
      const expected = checksums.at(-1);
      if (
        migrationHistory[0]?.checksum === expected
        && migrationHistory[0]?.success === false
      ) {
        migrationHistory[0].checksum = checksums.at(-2);
        migrationHistory[0].success = true;
      }
    }
    return okResponse();
  }
  throw new Error(`Unexpected built migration runner request: ${url}`);
};

process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'test-service-role-key';
process.env.SUPABASE_ACCESS_TOKEN = 'test-management-token';
process.env.MIGRATIONS_DIR = migrationsDir;
delete process.env.SUPABASE_DB_URL;
delete process.env.DATABASE_URL;

let failed = false;
try {
  const { planMigrationSql, runMigrations } = await import(migrationRunnerUrl);
  const plannedBatches = planMigrationSql(migrationSource, migrationName);
  if (plannedBatches.length !== 3) {
    throw new Error(`Built migration runner planned ${plannedBatches.length} migration batches instead of 3`);
  }
  const [recoverySql, indexSql, postflightSql] = plannedBatches;
  if (!recoverySql?.includes('DO $fraud_index_recovery$')) {
    throw new Error('Built migration runner did not preserve the recovery DO batch');
  }
  if (!indexSql?.trimStart().startsWith('CREATE INDEX CONCURRENTLY')) {
    throw new Error('Built migration runner did not preserve the concurrent index batch');
  }
  if (!postflightSql?.includes('DO $fraud_index_postflight$')) {
    throw new Error('Built migration runner did not preserve the postflight DO batch');
  }

  for (const unsupportedSql of [
    'VACUUM public.example;',
    "CREATE SUBSCRIPTION example CONNECTION 'host=example' PUBLICATION example;",
  ]) {
    let rejected = false;
    try {
      planMigrationSql(unsupportedSql, 'unsupported.sql');
    } catch (error) {
      rejected = String(error).includes('Transaction-incompatible SQL');
    }
    if (!rejected) {
      throw new Error(`Built migration runner accepted unsupported standalone SQL: ${unsupportedSql}`);
    }
  }

  const successful = await runMigrations();
  if (successful.errors.some((error) => error.includes('__dirname'))) {
    throw new Error(`Built migration runner still references __dirname: ${successful.errors.join('; ')}`);
  }
  if (successful.errors.length > 0) {
    throw new Error(`Built migration runner returned errors for successful history: ${successful.errors.join('; ')}`);
  }
  if (successful.ran || successful.applied.length > 0 || successful.skipped[0] !== migrationName) {
    throw new Error('Built migration runner did not skip canonical successful history');
  }
  if (migrationQueries.length !== 0) {
    throw new Error('Built migration runner executed migration source for successful history');
  }
  if (migrationHistory.some((row) => (
    row.filename.startsWith('__somnibot_migration_target_probe_v1__:')
  ))) {
    throw new Error('Built migration runner left a target-binding probe row behind');
  }

  migrationHistory[0].success = false;
  migrationHistory[0].applied_at = '2026-07-28T00:00:03.000Z';
  const databaseQueryBaseline = databaseQueries.length;
  const pending = await runMigrations();
  if (pending.ran || pending.applied.length > 0) {
    throw new Error('Built migration runner executed a pending migration without a direct database connection');
  }
  if (
    pending.errors.length !== 1
    || !pending.errors[0].includes('A direct database connection is required')
  ) {
    throw new Error(`Built migration runner did not reject Management-only pending source: ${pending.errors.join('; ')}`);
  }
  const pendingQueries = databaseQueries.slice(databaseQueryBaseline);
  if (pendingQueries.some((query) => (
    query.includes('claim:v1:')
    || query.includes('$migration_runner_claim_proof$')
    || query.includes('$migration_runner_history$')
  ))) {
    throw new Error('Built migration runner claimed or completed history before rejecting Management-only source');
  }
  if (migrationQueries.length !== 0) {
    throw new Error('Built migration runner sent source SQL through the Management API');
  }
  if (migrationHistory.some((row) => (
    row.filename.startsWith('__somnibot_migration_target_probe_v1__:')
  ))) {
    throw new Error('Built migration runner pending rejection left a target-binding probe row behind');
  }

  console.log(
    `Built migration runner smoke passed: plannerBatches=${plannedBatches.length}, ` +
    `managementSkipped=${successful.skipped.length}, pendingRejected=${pending.errors.length}`,
  );
} catch (error) {
  failed = true;
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  rmSync(migrationsDir, { recursive: true, force: true });
}

if (failed) {
  process.exitCode = 1;
}
