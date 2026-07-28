/**
 * Executable legacy-data fixture for the phased fraud observation-clock
 * migrations.
 *
 * The normal integration database is already fully migrated before Vitest
 * starts. This harness therefore creates the authoritative legacy table shape
 * in an isolated schema, seeds nullable historical timestamps, rewrites only
 * the migrations' explicit `public.` qualifier, and executes the real SQL
 * files in production order. Production tables and migration history are never
 * touched.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTestDbUrl, requireSupabase } from './helpers.js';

const FIXTURE_SCHEMA = 'fraud_observation_migration_fixture';
const MIGRATIONS = [
  '20260727034000_fraud_signal_observation_clock.sql',
  '20260727034100_fraud_signal_observation_backfill.sql',
  '20260727034200_fraud_signal_observation_not_null_guard.sql',
  '20260727034300_fraud_signal_observation_not_null_validate.sql',
  '20260727034400_fraud_signal_observation_index.sql',
] as const;

const CREATED_ROW_ID = '10000000-0000-4000-8000-000000000001';
const UPDATED_ONLY_ROW_ID = '10000000-0000-4000-8000-000000000002';
const UNKNOWN_TIME_ROW_ID = '10000000-0000-4000-8000-000000000003';
const CREATED_AT = '2020-01-02T03:04:05.000Z';
const RECENT_OPERATOR_EDIT = '2026-07-27T12:00:00.000Z';
const CONSERVATIVE_SENTINEL = '1970-01-01T00:00:00.000Z';

let sql: Sql;

function migrationSource(filename: string): string {
  const testDir = dirname(fileURLToPath(import.meta.url));
  return readFileSync(
    resolve(testDir, '../../../../supabase/migrations', filename),
    'utf8',
  );
}

function isolatedMigration(filename: string): string {
  return migrationSource(filename).replaceAll('public.', `${FIXTURE_SCHEMA}.`);
}

const LEGACY_SCHEMA_AND_ROWS = `
  CREATE SCHEMA ${FIXTURE_SCHEMA};

  CREATE TABLE ${FIXTURE_SCHEMA}.fraud_signals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    guild_id TEXT NOT NULL,
    signal_type TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'medium',
    entity_type TEXT,
    entity_id TEXT,
    discord_id TEXT,
    description TEXT,
    evidence JSONB NOT NULL DEFAULT '{}'::JSONB,
    status TEXT NOT NULL DEFAULT 'open',
    auto_action TEXT,
    resolution_note TEXT,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ
  );

  CREATE UNIQUE INDEX fraud_observation_fixture_open_identity
    ON ${FIXTURE_SCHEMA}.fraud_signals (
      guild_id,
      signal_type,
      entity_type,
      entity_id
    )
    WHERE status = 'open';

  INSERT INTO ${FIXTURE_SCHEMA}.fraud_signals (
    id,
    guild_id,
    signal_type,
    severity,
    entity_type,
    entity_id,
    description,
    created_at,
    updated_at
  ) VALUES
    (
      '${CREATED_ROW_ID}',
      'fixture-guild',
      'created-clock',
      'critical',
      'customer',
      'customer-created',
      'legacy row with a trustworthy creation time',
      '${CREATED_AT}',
      '${RECENT_OPERATOR_EDIT}'
    ),
    (
      '${UPDATED_ONLY_ROW_ID}',
      'fixture-guild',
      'operator-clock-only',
      'critical',
      'customer',
      'customer-updated-only',
      'legacy row whose only timestamp is an operator edit',
      NULL,
      '${RECENT_OPERATOR_EDIT}'
    ),
    (
      '${UNKNOWN_TIME_ROW_ID}',
      'fixture-guild',
      'unknown-clock',
      'critical',
      'customer',
      'customer-unknown',
      'legacy row with no trustworthy timestamp',
      NULL,
      NULL
    );
`;

describe('phased fraud observation-clock legacy migration', () => {
  beforeAll(async () => {
    await requireSupabase();
    sql = postgres(getTestDbUrl(), { max: 1 });

    await sql.unsafe(`DROP SCHEMA IF EXISTS ${FIXTURE_SCHEMA} CASCADE`);
    await sql.unsafe(LEGACY_SCHEMA_AND_ROWS);
    for (const migration of MIGRATIONS) {
      // The concurrent-index migration is intentionally its own one-statement
      // file, so postgres executes it outside an explicit transaction here just
      // as Supabase CLI >=2.110 does in production.
      await sql.unsafe(isolatedMigration(migration));
    }
  }, 60_000);

  afterAll(async () => {
    if (sql) {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${FIXTURE_SCHEMA} CASCADE`);
      await sql.end();
    }
  });

  it('backfills only from detector creation time and never from an operator edit or migration time', async () => {
    const rows = await sql.unsafe<Array<{
      id: string;
      last_observed_at: Date;
    }>>(`
      SELECT id::TEXT, last_observed_at
        FROM ${FIXTURE_SCHEMA}.fraud_signals
       ORDER BY id
    `);

    expect(rows.map((row) => ({
      id: row.id,
      lastObservedAt: row.last_observed_at.toISOString(),
    }))).toEqual([
      { id: CREATED_ROW_ID, lastObservedAt: CREATED_AT },
      { id: UPDATED_ONLY_ROW_ID, lastObservedAt: CONSERVATIVE_SENTINEL },
      { id: UNKNOWN_TIME_ROW_ID, lastObservedAt: CONSERVATIVE_SENTINEL },
    ]);
    expect(rows.some(
      (row) => row.last_observed_at.toISOString() === RECENT_OPERATOR_EDIT,
    )).toBe(false);
  });

  it('finishes with a defaulted NOT NULL column and a valid partial index', async () => {
    const [column] = await sql.unsafe<Array<{
      is_nullable: string;
      column_default: string | null;
    }>>(`
      SELECT is_nullable, column_default
        FROM information_schema.columns
       WHERE table_schema = '${FIXTURE_SCHEMA}'
         AND table_name = 'fraud_signals'
         AND column_name = 'last_observed_at'
    `);
    expect(column).toBeDefined();
    expect(column!.is_nullable).toBe('NO');
    expect(column!.column_default).toContain('now()');

    const [index] = await sql.unsafe<Array<{ indisvalid: boolean }>>(`
      SELECT i.indisvalid
        FROM pg_catalog.pg_index i
        JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = '${FIXTURE_SCHEMA}'
         AND c.relname = 'idx_fraud_signals_critical_observation'
    `);
    expect(index).toEqual({ indisvalid: true });
  });

  it('keeps the concurrent index isolated and every DDL create idempotent', () => {
    const indexMigration = migrationSource(
      '20260727034400_fraud_signal_observation_index.sql',
    );
    const executableSql = indexMigration.replace(/^--.*$/gm, '');
    expect(indexMigration).toContain('CREATE INDEX CONCURRENTLY IF NOT EXISTS');
    expect(executableSql.match(/\bCREATE\s+INDEX\b/gi)).toHaveLength(1);
    expect(migrationSource(
      '20260727034000_fraud_signal_observation_clock.sql',
    )).toContain('ADD COLUMN IF NOT EXISTS last_observed_at');
  });
});
