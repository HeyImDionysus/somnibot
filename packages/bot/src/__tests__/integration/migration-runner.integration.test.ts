/**
 * Real-Postgres proof for the production migration runner.
 *
 * The exact 034400 file must pass through runMigrations(), including its
 * DO / CREATE INDEX CONCURRENTLY / DO boundaries. A failed history row is
 * persisted in the real test database first, then the runner's REST calls are
 * bridged to that same table so recovery and the second-run skip are durable.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../services/migration-runner.js';
import { getTestDbUrl } from './helpers.js';

const MIGRATION =
  '20260727034400_fraud_signal_observation_index.sql';

interface HistoryRow {
  filename: string;
  checksum: string;
  success: boolean;
}

interface HistoryWrite {
  filename: string;
  checksum: string;
  duration_ms: number;
  success: boolean;
}

function okJson(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('migration runner against real Postgres', () => {
  const originalEnv = { ...process.env };
  const databaseName = `somnibot_runner_${process.pid}_${Date.now()}`;
  let adminSql: Sql | undefined;
  let sql: Sql | undefined;
  let migrationsDir: string | undefined;

  beforeAll(async () => {
    adminSql = postgres(getTestDbUrl(), { max: 1 });
    await adminSql.unsafe(`CREATE DATABASE "${databaseName}"`);
    await adminSql.unsafe(
      `ALTER DATABASE "${databaseName}" SET statement_timeout TO '15s'`,
    );

    const isolatedDbUrl = new URL(getTestDbUrl());
    isolatedDbUrl.pathname = `/${databaseName}`;
    const isolatedSql = postgres(isolatedDbUrl.toString(), { max: 1 });
    sql = isolatedSql;

    await isolatedSql.unsafe(`
      CREATE TABLE public.fraud_signals (
        id UUID PRIMARY KEY,
        guild_id TEXT NOT NULL,
        last_observed_at TIMESTAMPTZ NOT NULL,
        status TEXT NOT NULL,
        severity TEXT NOT NULL
      )
    `);
    await isolatedSql.unsafe(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename    TEXT PRIMARY KEY,
        checksum    TEXT NOT NULL,
        applied_at  TIMESTAMPTZ DEFAULT now(),
        duration_ms INTEGER DEFAULT 0,
        success     BOOLEAN DEFAULT true
      )
    `);

    await isolatedSql`
      INSERT INTO public.schema_migrations (
        filename,
        checksum,
        duration_ms,
        success
      )
      VALUES (${MIGRATION}, ${'failed-attempt'}, ${1}, ${false})
      ON CONFLICT (filename) DO UPDATE
        SET checksum = EXCLUDED.checksum,
            duration_ms = EXCLUDED.duration_ms,
            success = EXCLUDED.success
    `;

    const testDir = dirname(fileURLToPath(import.meta.url));
    const migrationSource = readFileSync(
      resolve(
        testDir,
        '../../../../supabase/migrations',
        MIGRATION,
      ),
      'utf8',
    );
    migrationsDir = mkdtempSync(join(process.cwd(), '.tmp-migration-runner-integration-'));
    writeFileSync(join(migrationsDir, MIGRATION), migrationSource);

    process.env.SUPABASE_URL = 'https://runner-proof.invalid';
    process.env.SUPABASE_SECRET_KEY = 'integration-proof-not-used';
    process.env.SUPABASE_DB_URL = isolatedDbUrl.toString();
    process.env.MIGRATIONS_DIR = migrationsDir;
    delete process.env.SUPABASE_ACCESS_TOKEN;
    delete process.env.DATABASE_URL;

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes('/rest/v1/schema_migrations')) {
        throw new Error(`Unexpected migration-runner fetch: ${url}`);
      }

      if ((init?.method ?? 'GET') === 'GET') {
        const history = await isolatedSql<Array<Pick<HistoryRow, 'filename' | 'checksum' | 'success'>>>`
          SELECT filename, checksum, success
            FROM public.schema_migrations
           ORDER BY filename ASC
        `;
        return okJson(history);
      }

      const body = JSON.parse(String(init?.body)) as HistoryWrite;
      await isolatedSql`
        INSERT INTO public.schema_migrations (
          filename,
          checksum,
          duration_ms,
          success
        )
        VALUES (
          ${body.filename},
          ${body.checksum},
          ${body.duration_ms},
          ${body.success}
        )
        ON CONFLICT (filename) DO UPDATE
          SET checksum = EXCLUDED.checksum,
              duration_ms = EXCLUDED.duration_ms,
              success = EXCLUDED.success
      `;
      return okJson({});
    }));
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    process.env = { ...originalEnv };

    try {
      await sql?.end();
    } finally {
      try {
        if (adminSql) {
          await adminSql.unsafe(
            `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
          );
        }
      } finally {
        try {
          await adminSql?.end();
        } finally {
          if (migrationsDir) {
            rmSync(migrationsDir, { recursive: true, force: true });
          }
        }
      }
    }
  });

  it('retries 034400, records success, and skips it on the second run', async () => {
    if (!sql) throw new Error('Isolated migration-runner database was not initialized');

    const indexBefore = await sql`
      SELECT 1
        FROM pg_catalog.pg_class index_relation
        JOIN pg_catalog.pg_namespace index_schema
          ON index_schema.oid = index_relation.relnamespace
       WHERE index_schema.nspname = 'public'
         AND index_relation.relname =
             'idx_fraud_signals_critical_observation'
    `;
    expect(indexBefore).toHaveLength(0);

    const recovered = await runMigrations();

    expect(recovered.errors).toEqual([]);
    expect(recovered.applied).toEqual([MIGRATION]);
    expect(recovered.skipped).toEqual([]);

    const [history] = await sql<Array<Pick<HistoryRow, 'checksum' | 'success'>>>`
      SELECT checksum, success
        FROM public.schema_migrations
       WHERE filename = ${MIGRATION}
    `;
    expect(history?.success).toBe(true);
    expect(history?.checksum).toMatch(/^[a-f0-9]{64}$/);

    const [createdIndex] = await sql<Array<{
      indisvalid: boolean;
      indisready: boolean;
      indislive: boolean;
    }>>`
      SELECT migration_index.indisvalid,
             migration_index.indisready,
             migration_index.indislive
        FROM pg_catalog.pg_index migration_index
        JOIN pg_catalog.pg_class index_relation
          ON index_relation.oid = migration_index.indexrelid
        JOIN pg_catalog.pg_namespace index_schema
          ON index_schema.oid = index_relation.relnamespace
       WHERE index_schema.nspname = 'public'
         AND index_relation.relname =
             'idx_fraud_signals_critical_observation'
    `;
    expect(createdIndex).toEqual({
      indisvalid: true,
      indisready: true,
      indislive: true,
    });

    const secondRun = await runMigrations();

    expect(secondRun.errors).toEqual([]);
    expect(secondRun.ran).toBe(false);
    expect(secondRun.applied).toEqual([]);
    expect(secondRun.skipped).toEqual([MIGRATION]);
  });
});
