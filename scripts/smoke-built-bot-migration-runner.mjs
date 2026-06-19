#!/usr/bin/env node

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const migrationRunnerUrl = new URL('../packages/bot/dist/services/migration-runner.js', import.meta.url);
const migrationsDir = mkdtempSync(join(process.cwd(), '.tmp-migration-runner-smoke-'));
writeFileSync(join(migrationsDir, '001_smoke.sql'), 'SELECT 1;\n');

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

globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.includes('/rest/v1/schema_migrations?')) {
    return jsonResponse([]);
  }
  return okResponse();
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
  const result = await runMigrations();
  if (result.errors.some((error) => error.includes('__dirname'))) {
    throw new Error(`Built migration runner still references __dirname: ${result.errors.join('; ')}`);
  }
  if (result.errors.length > 0) {
    throw new Error(`Built migration runner returned errors: ${result.errors.join('; ')}`);
  }
  console.log(`Built migration runner smoke passed: applied=${result.applied.length}, skipped=${result.skipped.length}`);
} catch (error) {
  failed = true;
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  rmSync(migrationsDir, { recursive: true, force: true });
}

if (failed) {
  process.exitCode = 1;
}
