#!/usr/bin/env node

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

let migrationHistory = [{
  filename: migrationName,
  checksum: 'failed-attempt',
  success: false,
}];
const migrationQueries = [];

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
      return jsonResponse(migrationHistory);
    }

    const record = JSON.parse(String(init.body));
    migrationHistory = [
      ...migrationHistory.filter((row) => row.filename !== record.filename),
      record,
    ];
    return okResponse();
  }
  if (url.includes('/database/query')) {
    const { query } = JSON.parse(String(init.body));
    if (!query.includes('CREATE TABLE IF NOT EXISTS schema_migrations')) {
      migrationQueries.push(query);
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
  const { runMigrations } = await import(migrationRunnerUrl);
  const recovered = await runMigrations();
  if (recovered.errors.some((error) => error.includes('__dirname'))) {
    throw new Error(`Built migration runner still references __dirname: ${recovered.errors.join('; ')}`);
  }
  if (recovered.errors.length > 0) {
    throw new Error(`Built migration runner returned errors: ${recovered.errors.join('; ')}`);
  }
  if (recovered.applied.length !== 1 || recovered.applied[0] !== migrationName) {
    throw new Error(`Built migration runner did not retry ${migrationName}`);
  }
  if (migrationQueries.length !== 3) {
    throw new Error(`Built migration runner sent ${migrationQueries.length} migration queries instead of 3`);
  }
  if (!migrationQueries[0].includes('DO $fraud_index_recovery$')) {
    throw new Error('Built migration runner did not preserve the recovery DO batch');
  }
  if (!migrationQueries[1].trimStart().startsWith('CREATE INDEX CONCURRENTLY')) {
    throw new Error('Built migration runner did not isolate CREATE INDEX CONCURRENTLY');
  }
  if (!migrationQueries[2].includes('DO $fraud_index_postflight$')) {
    throw new Error('Built migration runner did not preserve the postflight DO batch');
  }
  if (migrationHistory[0]?.success !== true) {
    throw new Error('Built migration runner did not upsert failed history to success');
  }

  const migrationQueryCount = migrationQueries.length;
  const secondRun = await runMigrations();
  if (secondRun.errors.length > 0) {
    throw new Error(`Built migration runner second run returned errors: ${secondRun.errors.join('; ')}`);
  }
  if (secondRun.ran || secondRun.applied.length > 0 || secondRun.skipped[0] !== migrationName) {
    throw new Error(`Built migration runner did not skip successful history on the second run`);
  }
  if (migrationQueries.length !== migrationQueryCount) {
    throw new Error('Built migration runner re-executed a successful migration');
  }

  console.log(
    `Built migration runner smoke passed: recovered=${recovered.applied.length}, ` +
    `batches=${migrationQueries.length}, secondRunSkipped=${secondRun.skipped.length}`,
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
