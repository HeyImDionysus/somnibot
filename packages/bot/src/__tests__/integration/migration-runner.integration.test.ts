/**
 * Exact-file and state-machine proof for the production migration runner.
 *
 * Run this file alone. It creates one isolated PostgreSQL database, bridges
 * the runner's PostgREST reads to that database, and exercises the actual
 * direct-SQL claim/CAS and source paths.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../services/migration-runner.js';
import { getTestDbUrl } from './helpers.js';

const APPROVED_MIGRATION =
  '20260727034400_fraud_signal_observation_index.sql';

interface HistoryRow {
  filename: string;
  checksum: string;
  success: boolean;
  applied_at: string;
  duration_ms: number;
}

function canonical(sql: string): string {
  return createHash('sha256')
    .update(sql.replace(/\r\n/g, '\n'), 'utf8')
    .digest('hex');
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
  const migrationDirs: string[] = [];
  let adminSql: Sql | undefined;
  let sql: Sql | undefined;
  let approvedSource = '';

  function selectMigration(filename: string, source: string): void {
    const dir = mkdtempSync(
      join(process.cwd(), '.tmp-migration-runner-integration-'),
    );
    migrationDirs.push(dir);
    writeFileSync(join(dir, filename), source);
    process.env.MIGRATIONS_DIR = dir;
  }

  async function seedFailed(filename: string, source: string): Promise<void> {
    if (!sql) throw new Error('Isolated database was not initialized');
    await sql`
      INSERT INTO public.schema_migrations (
        filename,
        checksum,
        applied_at,
        duration_ms,
        success
      )
      VALUES (${filename}, ${canonical(source)}, now(), ${1}, ${false})
      ON CONFLICT (filename) DO UPDATE
        SET checksum = EXCLUDED.checksum,
            applied_at = EXCLUDED.applied_at,
            duration_ms = EXCLUDED.duration_ms,
            success = EXCLUDED.success
    `;
  }

  beforeAll(async () => {
    adminSql = postgres(getTestDbUrl(), { max: 1 });
    await adminSql.unsafe(`CREATE DATABASE "${databaseName}"`);
    await adminSql.unsafe(
      `ALTER DATABASE "${databaseName}" SET statement_timeout TO '15s'`,
    );

    const isolatedDbUrl = new URL(getTestDbUrl());
    isolatedDbUrl.pathname = `/${databaseName}`;
    sql = postgres(isolatedDbUrl.toString(), { max: 4 });

    await sql.unsafe(`
      CREATE TABLE public.fraud_signals (
        id UUID PRIMARY KEY,
        guild_id TEXT NOT NULL,
        last_observed_at TIMESTAMPTZ NOT NULL,
        status TEXT NOT NULL,
        severity TEXT NOT NULL
      )
    `);
    await sql.unsafe(`
      CREATE TABLE public.schema_migrations (
        filename    TEXT PRIMARY KEY,
        checksum    TEXT NOT NULL,
        applied_at  TIMESTAMPTZ DEFAULT now(),
        duration_ms INTEGER DEFAULT 0,
        success     BOOLEAN DEFAULT true
      )
    `);

    const testDir = dirname(fileURLToPath(import.meta.url));
    approvedSource = readFileSync(
      resolve(
        testDir,
        '../../../../supabase/migrations',
        APPROVED_MIGRATION,
      ),
      'utf8',
    );

    process.env.SUPABASE_URL = 'https://runner-proof.invalid';
    process.env.SUPABASE_SECRET_KEY = 'integration-proof-not-used';
    process.env.SUPABASE_DB_URL = isolatedDbUrl.toString();
    delete process.env.SUPABASE_ACCESS_TOKEN;
    delete process.env.DATABASE_URL;

    vi.stubGlobal('fetch', vi.fn(async (
      input: string | URL | Request,
      init: RequestInit = {},
    ) => {
      const url = String(input);
      if (!url.includes('/rest/v1/schema_migrations')) {
        throw new Error(`Unexpected migration-runner fetch: ${url}`);
      }
      if (!sql) throw new Error('Isolated database was not initialized');

      const method = init.method ?? 'GET';
      const parsed = new URL(url);
      const filenameFilter = parsed.searchParams.get('filename');
      const filename = filenameFilter?.startsWith('eq.')
        ? filenameFilter.slice(3)
        : undefined;

      if (method === 'PATCH') {
        const checksumFilter = parsed.searchParams.get('checksum');
        const storedChecksum = checksumFilter?.startsWith('eq.')
          ? checksumFilter.slice(3)
          : undefined;
        const body = JSON.parse(String(init.body)) as Partial<HistoryRow>;
        if (filename && storedChecksum && body.checksum) {
          await sql`
            UPDATE public.schema_migrations
               SET checksum = ${body.checksum}
             WHERE filename = ${filename}
               AND checksum = ${storedChecksum}
               AND success = true
          `;
        }
        if (
          filename
          && storedChecksum
          && body.duration_ms !== undefined
        ) {
          await sql`
            UPDATE public.schema_migrations
               SET duration_ms = ${body.duration_ms}
             WHERE filename = ${filename}
               AND checksum = ${storedChecksum}
               AND success = true
          `;
        }
        return okJson([]);
      }

      const history = filename
        ? await sql<Array<HistoryRow>>`
            SELECT filename,
                   checksum,
                   success,
                   applied_at::text,
                   duration_ms
              FROM public.schema_migrations
             WHERE filename = ${filename}
          `
        : await sql<Array<HistoryRow>>`
            SELECT filename,
                   checksum,
                   success,
                   applied_at::text,
                   duration_ms
              FROM public.schema_migrations
             ORDER BY filename ASC
          `;
      return okJson(history);
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
        await adminSql?.end();
        for (const dir of migrationDirs) {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

  it('retries exact 034400, records canonical success, and skips the second run', async () => {
    if (!sql) throw new Error('Isolated database was not initialized');
    selectMigration(APPROVED_MIGRATION, approvedSource);
    await seedFailed(APPROVED_MIGRATION, approvedSource);

    const recovered = await runMigrations();

    expect(recovered.errors).toEqual([]);
    expect(recovered.applied).toEqual([APPROVED_MIGRATION]);
    const [history] = await sql<Array<Pick<HistoryRow, 'checksum' | 'success'>>>`
      SELECT checksum, success
        FROM public.schema_migrations
       WHERE filename = ${APPROVED_MIGRATION}
    `;
    expect(history).toEqual({
      checksum: canonical(approvedSource),
      success: true,
    });

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
    expect(secondRun.skipped).toEqual([APPROVED_MIGRATION]);
  });

  it('rolls back ordinary side effects when the in-query success CAS cannot complete, across two runs', async () => {
    if (!sql) throw new Error('Isolated database was not initialized');
    const filename = '20260728000100_runner_atomic_failure.sql';
    const source = `
CREATE TABLE public.runner_atomic_probe (id bigint PRIMARY KEY);
DELETE FROM public.schema_migrations
 WHERE filename = '${filename}';
`;
    selectMigration(filename, source);
    await seedFailed(filename, source);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await runMigrations();
      expect(result.applied).toEqual([]);
      expect(result.errors[0]).toMatch(/claim was lost before commit/i);

      const table = await sql`
        SELECT 1
          FROM pg_catalog.pg_class relation
          JOIN pg_catalog.pg_namespace namespace
            ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'public'
           AND relation.relname = 'runner_atomic_probe'
      `;
      expect(table).toHaveLength(0);

      const [history] = await sql<Array<Pick<HistoryRow, 'checksum' | 'success'>>>`
        SELECT checksum, success
          FROM public.schema_migrations
         WHERE filename = ${filename}
      `;
      expect(history).toEqual({ checksum: canonical(source), success: false });
    }
  });

  it('allows only one concurrent runner to execute a source side effect', async () => {
    if (!sql) throw new Error('Isolated database was not initialized');
    const filename = '20260728000200_runner_concurrency.sql';
    const source = `
INSERT INTO public.runner_execution_log (marker) VALUES ('executed');
`;
    await sql.unsafe(`
      CREATE TABLE public.runner_execution_log (
        id bigserial PRIMARY KEY,
        marker text NOT NULL
      )
    `);
    selectMigration(filename, source);

    const [first, second] = await Promise.all([
      runMigrations(),
      runMigrations(),
    ]);

    const [{ count }] = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
        FROM public.runner_execution_log
    `;
    expect(count).toBe(1);
    expect([...first.applied, ...second.applied]).toEqual([filename]);
    expect(
      first.errors.some((error) => /claimed by another runner/i.test(error))
      || second.errors.some((error) => /claimed by another runner/i.test(error))
      || first.skipped.includes(filename)
      || second.skipped.includes(filename),
    ).toBe(true);
  });

  it('uses database timestamps to fence a fresh claim and take over a stale claim', async () => {
    if (!sql) throw new Error('Isolated database was not initialized');
    const filename = '20260728000300_runner_clock_skew.sql';
    const source = 'CREATE TABLE public.runner_clock_probe (id bigint);';
    const checksum = canonical(source);
    const otherClaim =
      `claim:v1:${checksum}:00000000-0000-4000-8000-000000000001`;
    selectMigration(filename, source);

    await sql`
      INSERT INTO public.schema_migrations (
        filename,
        checksum,
        applied_at,
        duration_ms,
        success
      )
      VALUES (${filename}, ${otherClaim}, now() - interval '1 minute', ${0}, ${false})
    `;
    const fresh = await runMigrations();
    expect(fresh.applied).toEqual([]);
    expect(fresh.errors[0]).toMatch(/claimed by another runner/i);

    await sql`
      UPDATE public.schema_migrations
         SET applied_at = now() - interval '6 minutes'
       WHERE filename = ${filename}
    `;
    const stale = await runMigrations();
    expect(stale.errors).toEqual([]);
    expect(stale.applied).toEqual([filename]);
    const probe = await sql`
      SELECT 1
        FROM pg_catalog.pg_class relation
        JOIN pg_catalog.pg_namespace namespace
          ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'public'
         AND relation.relname = 'runner_clock_probe'
    `;
    expect(probe).toHaveLength(1);
  });
});
