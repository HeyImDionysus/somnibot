/**
 * Executable legacy-data fixture for the phased fraud observation-clock
 * migrations.
 *
 * The normal integration database is already fully migrated before Vitest
 * starts. This harness therefore creates the authoritative legacy table shape
 * in an isolated schema, seeds nullable historical timestamps, rewrites only
 * the migrations' explicit `public.` qualifier, and executes the real SQL
 * files in production order. The index fixture also reproduces a canceled
 * `CREATE INDEX CONCURRENTLY`: one backend holds a pre-build write open while a
 * second backend starts the real index statement, then the build is canceled
 * after PostgreSQL publishes its invalid catalog entry. Production tables and
 * migration history are never touched.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTestDbUrl } from './helpers.js';

const FIXTURE_SCHEMA = 'fraud_observation_migration_fixture';
const PRE_INDEX_MIGRATIONS = [
  '20260727034000_fraud_signal_observation_clock.sql',
  '20260727034100_fraud_signal_observation_backfill.sql',
  '20260727034200_fraud_signal_observation_not_null_guard.sql',
  '20260727034300_fraud_signal_observation_not_null_validate.sql',
] as const;
const INDEX_MIGRATION =
  '20260727034400_fraud_signal_observation_index.sql';

const CREATED_ROW_ID = '10000000-0000-4000-8000-000000000001';
const UPDATED_ONLY_ROW_ID = '10000000-0000-4000-8000-000000000002';
const UNKNOWN_TIME_ROW_ID = '10000000-0000-4000-8000-000000000003';
const CREATED_AT = '2020-01-02T03:04:05.000Z';
const RECENT_OPERATOR_EDIT = '2026-07-27T12:00:00.000Z';
const CONSERVATIVE_SENTINEL = '1970-01-01T00:00:00.000Z';

let sql: Sql;
let invalidIndexBeforeRetry: IndexCatalogRow;
let fixtureIndexAfterRecovery: IndexCatalogRow;
let fixtureIndexAfterValidRetry: IndexCatalogRow;

interface IndexCatalogRow {
  oid: string;
  indisvalid: boolean;
  indisready: boolean;
  indislive: boolean;
  indisexclusion: boolean;
  indisunique: boolean;
  access_method: string;
  key_columns: string[];
  key_options: string;
  opclasses: string[];
  index_collations: string[];
  table_collations: string[];
  index_definition: string;
  predicate: string | null;
}

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

function indexMigrationFragments(): {
  preflight: string;
  create: string;
  postflight: string;
} {
  const source = isolatedMigration(INDEX_MIGRATION);
  const createStart = source.search(/^CREATE INDEX CONCURRENTLY/m);
  const createEnd = source.indexOf(';', createStart);
  if (createStart < 0 || createEnd < 0) {
    throw new Error(
      `${INDEX_MIGRATION} must contain one CREATE INDEX CONCURRENTLY statement`,
    );
  }

  return {
    preflight: source.slice(0, createStart).trim(),
    create: source.slice(createStart, createEnd + 1).trim(),
    postflight: source.slice(createEnd + 1).trim(),
  };
}

function hasExecutableSql(source: string): boolean {
  return source.replace(/^--.*$/gm, '').trim().length > 0;
}

async function applyIndexMigration(): Promise<void> {
  const fragments = indexMigrationFragments();
  for (const statement of [
    fragments.preflight,
    fragments.create,
    fragments.postflight,
  ]) {
    if (hasExecutableSql(statement)) {
      // Supabase CLI >=2.110 flushes the transaction batch around the
      // pipeline-incompatible CREATE INDEX CONCURRENTLY statement. Executing
      // these fragments separately reproduces that boundary without touching
      // the real migration history table.
      await sql.unsafe(statement);
    }
  }
}

async function indexCatalog(
  schema: string,
): Promise<IndexCatalogRow | undefined> {
  const [index] = await sql.unsafe<IndexCatalogRow[]>(`
    SELECT c.oid::TEXT AS oid,
           i.indisvalid,
           i.indisready,
           i.indislive,
           i.indisexclusion,
           i.indisunique,
           am.amname AS access_method,
           ARRAY(
             SELECT a.attname
               FROM unnest(i.indkey) WITH ORDINALITY AS key(attnum, position)
              JOIN pg_catalog.pg_attribute a
                 ON a.attrelid = i.indrelid
                AND a.attnum = key.attnum
              WHERE key.position <= i.indnkeyatts
              ORDER BY key.position
           ) AS key_columns,
           i.indoption::TEXT AS key_options,
           ARRAY(
             SELECT opclass.opcname
               FROM unnest(i.indclass)
                 WITH ORDINALITY AS key(opclass_oid, position)
               JOIN pg_catalog.pg_opclass opclass
                 ON opclass.oid = key.opclass_oid
              ORDER BY key.position
           ) AS opclasses,
           ARRAY(
             SELECT key.collation_oid::TEXT
               FROM unnest(i.indcollation)
                 WITH ORDINALITY AS key(collation_oid, position)
              ORDER BY key.position
           ) AS index_collations,
           ARRAY(
             SELECT table_column.attcollation::TEXT
               FROM unnest(i.indkey)
                 WITH ORDINALITY AS key(attnum, position)
               JOIN pg_catalog.pg_attribute table_column
                 ON table_column.attrelid = i.indrelid
                AND table_column.attnum = key.attnum
              ORDER BY key.position
           ) AS table_collations,
           pg_catalog.pg_get_indexdef(i.indexrelid) AS index_definition,
           pg_catalog.pg_get_expr(i.indpred, i.indrelid, true) AS predicate
      FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_am am ON am.oid = c.relam
     WHERE n.nspname = '${schema}'
       AND c.relname = 'idx_fraud_signals_critical_observation'
  `);
  return index;
}

async function waitForIndexState(
  observer: Sql,
  predicate: (index: IndexCatalogRow | undefined) => boolean,
): Promise<IndexCatalogRow | undefined> {
  let lastIndex: IndexCatalogRow | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    [lastIndex] = await observer.unsafe<IndexCatalogRow[]>(`
      SELECT c.oid::TEXT AS oid,
             i.indisvalid,
             i.indisready,
             i.indislive,
             i.indisexclusion,
             i.indisunique,
             am.amname AS access_method,
             ARRAY(
               SELECT a.attname
                 FROM unnest(i.indkey) WITH ORDINALITY AS key(attnum, position)
                 JOIN pg_catalog.pg_attribute a
                   ON a.attrelid = i.indrelid
                  AND a.attnum = key.attnum
                WHERE key.position <= i.indnkeyatts
                ORDER BY key.position
             ) AS key_columns,
             i.indoption::TEXT AS key_options,
             ARRAY[]::TEXT[] AS opclasses,
             ARRAY[]::TEXT[] AS index_collations,
             ARRAY[]::TEXT[] AS table_collations,
             pg_catalog.pg_get_indexdef(i.indexrelid) AS index_definition,
             pg_catalog.pg_get_expr(i.indpred, i.indrelid, true) AS predicate
        FROM pg_catalog.pg_index i
        JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_catalog.pg_am am ON am.oid = c.relam
       WHERE n.nspname = '${FIXTURE_SCHEMA}'
         AND c.relname = 'idx_fraud_signals_critical_observation'
    `);
    if (predicate(lastIndex)) return lastIndex;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(
    `Timed out waiting for expected index state: ${JSON.stringify(lastIndex)}`,
  );
}

async function waitForBackendWait(
  observer: Sql,
  pid: number,
  waitEventType: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [activity] = await observer.unsafe<Array<{
      state: string;
      wait_event_type: string | null;
      wait_event: string | null;
    }>>(`
      SELECT state, wait_event_type, wait_event
        FROM pg_catalog.pg_stat_activity
       WHERE pid = ${pid}
    `);
    if (activity?.wait_event_type === waitEventType) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`Timed out waiting for backend ${pid} to wait on ${waitEventType}`);
}

async function seedInvalidIndex(): Promise<IndexCatalogRow> {
  await dropFixtureTargetIndex();
  const blocker = postgres(getTestDbUrl(), { max: 1 });
  const builder = postgres(getTestDbUrl(), { max: 1 });
  let releaseBlocker = (): void => {};
  let markBlockerReady = (): void => {};
  const holdBlocker = new Promise<void>((resolvePromise) => {
    releaseBlocker = resolvePromise;
  });
  const blockerReady = new Promise<void>((resolvePromise) => {
    markBlockerReady = resolvePromise;
  });
  const blockerOutcome = blocker.begin(async (transaction) => {
    await transaction.unsafe(`
      UPDATE ${FIXTURE_SCHEMA}.fraud_signals
         SET description = description
       WHERE id = '${CREATED_ROW_ID}'
    `);
    markBlockerReady();
    await holdBlocker;
  }).then(
    () => undefined,
    (error: unknown) => error,
  );
  let buildOutcome: Promise<unknown> | undefined;
  let builderPid: number | undefined;
  try {
    await Promise.race([
      blockerReady,
      blockerOutcome.then((error) => {
        if (error !== undefined) throw error;
        throw new Error('Fixture blocker ended before index build started');
      }),
    ]);
    const [backend] = await builder.unsafe<Array<{ pid: number }>>(
      'SELECT pg_catalog.pg_backend_pid() AS pid',
    );
    builderPid = backend?.pid;
    expect(builderPid).toBeDefined();
    buildOutcome = builder.unsafe(`
      CREATE INDEX CONCURRENTLY idx_fraud_signals_critical_observation
        ON ${FIXTURE_SCHEMA}.fraud_signals (guild_id, last_observed_at DESC)
       WHERE status = 'open' AND severity = 'critical'
    `).catch((error: unknown) => error);
    let invalidIndex: IndexCatalogRow | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      invalidIndex = await indexCatalog(FIXTURE_SCHEMA);
      if (invalidIndex && !invalidIndex.indisvalid) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    expect(invalidIndex).toBeDefined();
    await sql.unsafe(
      `SELECT pg_catalog.pg_cancel_backend(${builderPid})`,
    );
    await buildOutcome;
    expect(invalidIndex).toMatchObject({
      indisvalid: false,
      key_columns: ['guild_id', 'last_observed_at'],
    });
    return invalidIndex!;
  } finally {
    releaseBlocker();
    const blockerError = await blockerOutcome;
    if (buildOutcome) await buildOutcome;
    await builder.end();
    await blocker.end();
    if (blockerError !== undefined) throw blockerError;
  }
}

async function dropFixtureTargetIndex(): Promise<void> {
  await sql.unsafe(
    `DROP INDEX IF EXISTS ${FIXTURE_SCHEMA}.idx_fraud_signals_critical_observation`,
  );
}

async function restoreFixtureTargetIndex(): Promise<void> {
  await dropFixtureTargetIndex();
  await applyIndexMigration();
}

async function expectDefinitionMutantRejected(
  createMutantSql: string,
  assertMutant: (index: IndexCatalogRow) => void,
  cleanupMutantSql?: string,
): Promise<void> {
  const fragments = indexMigrationFragments();
  await dropFixtureTargetIndex();
  try {
    await sql.unsafe(createMutantSql);
    const mutantIndex = await indexCatalog(FIXTURE_SCHEMA);
    expect(mutantIndex).toBeDefined();
    assertMutant(mutantIndex!);

    await expect(sql.unsafe(fragments.preflight)).rejects.toThrow(
      /unexpected definition/,
    );
    expect((await indexCatalog(FIXTURE_SCHEMA))?.oid).toBe(mutantIndex!.oid);

    await expect(sql.unsafe(fragments.postflight)).rejects.toThrow(
      /unexpected definition/,
    );
    expect((await indexCatalog(FIXTURE_SCHEMA))?.oid).toBe(mutantIndex!.oid);
  } finally {
    if (cleanupMutantSql) {
      await sql.unsafe(cleanupMutantSql);
    }
    await restoreFixtureTargetIndex();
  }
}

function expectTargetIndex(index: IndexCatalogRow | undefined): void {
  expect(index).toBeDefined();
  expect(index).toMatchObject({
    indisvalid: true,
    indisready: true,
    indislive: true,
    indisexclusion: false,
    indisunique: false,
    access_method: 'btree',
    key_columns: ['guild_id', 'last_observed_at'],
    key_options: '0 3',
    opclasses: ['text_ops', 'timestamptz_ops'],
  });
  expect(index!.index_collations).toEqual(index!.table_collations);
  expect(index!.index_definition).toContain(
    'USING btree (guild_id, last_observed_at DESC)',
  );
  expect(index!.predicate).toBe(
    "status = 'open'::text AND severity = 'critical'::text",
  );
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
    sql = postgres(getTestDbUrl(), { max: 1 });
    await sql.unsafe('SELECT 1');

    await sql.unsafe(`DROP SCHEMA IF EXISTS ${FIXTURE_SCHEMA} CASCADE`);
    await sql.unsafe(LEGACY_SCHEMA_AND_ROWS);
    for (const migration of PRE_INDEX_MIGRATIONS) {
      await sql.unsafe(isolatedMigration(migration));
    }

    invalidIndexBeforeRetry = await seedInvalidIndex();
    await applyIndexMigration();
    fixtureIndexAfterRecovery = (await indexCatalog(FIXTURE_SCHEMA))!;

    // A safe retry against an already-valid exact index must not replace it.
    await applyIndexMigration();
    fixtureIndexAfterValidRetry = (await indexCatalog(FIXTURE_SCHEMA))!;
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

  it('finishes with a defaulted NOT NULL column', async () => {
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
  });

  it('recovers an invalid unique-build artifact and preserves a valid retry', () => {
    expect(invalidIndexBeforeRetry.indisvalid).toBe(false);
    expectTargetIndex(fixtureIndexAfterRecovery);
    expectTargetIndex(fixtureIndexAfterValidRetry);
    expect(fixtureIndexAfterValidRetry.oid).toBe(
      fixtureIndexAfterRecovery.oid,
    );
  });

  it('rejects and preserves a valid wrong-definition index', async () => {
    const fragments = indexMigrationFragments();
    await dropFixtureTargetIndex();
    try {
      await sql.unsafe(
        `CREATE INDEX idx_fraud_signals_critical_observation
           ON ${FIXTURE_SCHEMA}.fraud_signals (guild_id, severity DESC)
          WHERE status = 'open' AND severity = 'critical'`,
      );
      const wrongIndex = await indexCatalog(FIXTURE_SCHEMA);
      expect(wrongIndex).toMatchObject({
        indisvalid: true,
        key_columns: ['guild_id', 'severity'],
        key_options: '0 3',
        predicate:
          "status = 'open'::text AND severity = 'critical'::text",
      });

      const preflightError = await sql.unsafe(fragments.preflight).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(preflightError).toMatchObject({ code: '55000' });
      expect(String(preflightError)).toMatch(/unexpected definition/);

      const preservedIndex = await indexCatalog(FIXTURE_SCHEMA);
      expect(preservedIndex).toMatchObject({
        oid: wrongIndex!.oid,
        indisvalid: true,
        key_columns: ['guild_id', 'severity'],
      });
    } finally {
      await restoreFixtureTargetIndex();
    }
  });

  it('holds the migration table lock without blocking ordinary row writes', async () => {
    const locker = postgres(getTestDbUrl(), { max: 1 });
    const writer = postgres(getTestDbUrl(), { max: 1 });
    const [lockerBackend] = await locker.unsafe<Array<{ pid: number }>>(
      'SELECT pg_catalog.pg_backend_pid() AS pid',
    );
    if (!lockerBackend) {
      throw new Error('Could not resolve the migration-lock backend');
    }

    let releaseMigrationTransaction = (): void => {};
    let markLockAcquired = (): void => {};
    const holdMigrationTransaction = new Promise<void>((resolvePromise) => {
      releaseMigrationTransaction = resolvePromise;
    });
    const lockAcquired = new Promise<void>((resolvePromise) => {
      markLockAcquired = resolvePromise;
    });
    const transactionOutcome = locker.begin(async (transaction) => {
      await transaction.unsafe(indexMigrationFragments().preflight);
      markLockAcquired();
      await holdMigrationTransaction;
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    let transactionError: unknown | undefined;
    try {
      await Promise.race([
        lockAcquired,
        transactionOutcome.then((error) => {
          if (error !== undefined) {
            throw error;
          }
          throw new Error(
            'Migration-lock transaction ended before its lock was inspected',
          );
        }),
      ]);

      const locks = await sql.unsafe<Array<{ mode: string }>>(`
        SELECT mode
          FROM pg_catalog.pg_locks
         WHERE pid = ${lockerBackend.pid}
           AND relation =
             '${FIXTURE_SCHEMA}.fraud_signals'::pg_catalog.regclass
           AND granted
      `);
      expect(locks.map((lock) => lock.mode)).toContain(
        'ShareUpdateExclusiveLock',
      );

      await writer.unsafe(`SET statement_timeout = '2s'`);
      const [updatedRow] = await writer.unsafe<Array<{ id: string }>>(`
        UPDATE ${FIXTURE_SCHEMA}.fraud_signals
           SET description = description
         WHERE id = '${CREATED_ROW_ID}'
        RETURNING id::TEXT
      `);
      expect(updatedRow?.id).toBe(CREATED_ROW_ID);
    } finally {
      releaseMigrationTransaction();
      transactionError = await transactionOutcome;
      await writer.end();
      await locker.end();
    }
    if (transactionError !== undefined) {
      throw transactionError;
    }
  });

  it('requires the concurrent index batch to remain outside a transaction', async () => {
    const fragments = indexMigrationFragments();
    await dropFixtureTargetIndex();
    try {
      await expect(sql.begin(async (transaction) => {
        await transaction.unsafe(fragments.create);
      })).rejects.toMatchObject({ code: '25001' });
      expect(await indexCatalog(FIXTURE_SCHEMA)).toBeUndefined();
    } finally {
      await restoreFixtureTargetIndex();
    }
  });

  it('converges after an independent concurrent builder and preserves its valid index', async () => {
    const blocker = postgres(getTestDbUrl(), { max: 1 });
    const builder = postgres(getTestDbUrl(), { max: 1 });
    const runner = postgres(getTestDbUrl(), { max: 1 });
    const observer = postgres(getTestDbUrl(), { max: 1 });
    const fragments = indexMigrationFragments();
    let releaseBlocker = (): void => {};
    let markBlockerReady = (): void => {};
    const holdBlocker = new Promise<void>((resolvePromise) => {
      releaseBlocker = resolvePromise;
    });
    const blockerReady = new Promise<void>((resolvePromise) => {
      markBlockerReady = resolvePromise;
    });
    let builderPid: number | undefined;
    let runnerPid: number | undefined;
    let buildOutcome: Promise<unknown> | undefined;
    let preflightOutcome: Promise<unknown> | undefined;

    await dropFixtureTargetIndex();
    const blockerOutcome = blocker.begin(async (transaction) => {
      await transaction.unsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await transaction.unsafe(`
        SELECT id
          FROM ${FIXTURE_SCHEMA}.fraud_signals
         WHERE id = '${CREATED_ROW_ID}'
      `);
      markBlockerReady();
      await holdBlocker;
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    try {
      await blockerReady;
      const [builderBackend] = await builder.unsafe<Array<{ pid: number }>>(
        'SELECT pg_catalog.pg_backend_pid() AS pid',
      );
      builderPid = builderBackend!.pid;
      buildOutcome = builder.unsafe(`
        CREATE INDEX CONCURRENTLY idx_fraud_signals_critical_observation
          ON ${FIXTURE_SCHEMA}.fraud_signals (guild_id, last_observed_at DESC)
         WHERE status = 'open' AND severity = 'critical'
      `).catch((error: unknown) => error);

      const inProgress = await waitForIndexState(
        observer,
        (index) => Boolean(index?.indisready && !index.indisvalid),
      );
      expect(inProgress).toBeDefined();

      const [runnerBackend] = await runner.unsafe<Array<{ pid: number }>>(
        'SELECT pg_catalog.pg_backend_pid() AS pid',
      );
      runnerPid = runnerBackend!.pid;
      preflightOutcome = runner.unsafe(fragments.preflight).catch(
        (error: unknown) => error,
      );
      await waitForBackendWait(observer, runnerPid, 'Lock');

      releaseBlocker();
      const buildError = await buildOutcome;
      expect(buildError).toEqual([]);
      let preflightError = await preflightOutcome;
      if (preflightError instanceof Error) {
        // PostgreSQL can briefly release the table lock between concurrent
        // index-build phases. A waiter may then observe the still-invalid
        // catalog row and lose a catalog delete race as the builder commits.
        // The migration is deliberately retryable, so pin that exact database
        // race and prove the retry converges without replacing the valid index.
        expect(preflightError).toMatchObject({
          code: 'XX000',
          message: 'tuple concurrently updated',
        });
        preflightError = await runner.unsafe(fragments.preflight).catch(
          (error: unknown) => error,
        );
      }
      expect(preflightError).toEqual([]);

      const survivingIndex = await indexCatalog(FIXTURE_SCHEMA);
      expectTargetIndex(survivingIndex);
      expect(survivingIndex!.oid).toBe(inProgress!.oid);
    } finally {
      releaseBlocker();
      if (builderPid !== undefined) {
        await sql.unsafe(`SELECT pg_catalog.pg_cancel_backend(${builderPid})`).catch(
          () => undefined,
        );
      }
      if (runnerPid !== undefined) {
        await sql.unsafe(`SELECT pg_catalog.pg_cancel_backend(${runnerPid})`).catch(
          () => undefined,
        );
      }
      const blockerError = await blockerOutcome;
      if (buildOutcome) await buildOutcome;
      if (preflightOutcome) await preflightOutcome;
      await observer.end();
      await runner.end();
      await builder.end();
      await blocker.end();
      await restoreFixtureTargetIndex();
      if (blockerError !== undefined) throw blockerError;
    }
  }, 30_000);

  it('rejects a valid index whose quoted predicate literal contains whitespace', async () => {
    await expectDefinitionMutantRejected(
      `CREATE INDEX idx_fraud_signals_critical_observation
         ON ${FIXTURE_SCHEMA}.fraud_signals
           (guild_id, last_observed_at DESC)
        WHERE status = 'op en' AND severity = 'critical'`,
      (mutantIndex) => {
        expect(mutantIndex.predicate).toBe(
          "status = 'op en'::text AND severity = 'critical'::text",
        );
      },
    );
  });

  it('rejects a valid index with a compatible nondefault btree opclass', async () => {
    await expectDefinitionMutantRejected(
      `CREATE INDEX idx_fraud_signals_critical_observation
         ON ${FIXTURE_SCHEMA}.fraud_signals
           (
             guild_id pg_catalog.text_pattern_ops,
             last_observed_at DESC
           )
        WHERE status = 'open' AND severity = 'critical'`,
      (mutantIndex) => {
        expect(mutantIndex.opclasses).toEqual([
          'text_pattern_ops',
          'timestamptz_ops',
        ]);
      },
    );
  });

  it('rejects a valid index with a nondefault compatible collation', async () => {
    await expectDefinitionMutantRejected(
      `CREATE INDEX idx_fraud_signals_critical_observation
         ON ${FIXTURE_SCHEMA}.fraud_signals
           (
             guild_id COLLATE pg_catalog."C",
             last_observed_at DESC
           )
        WHERE status = 'open' AND severity = 'critical'`,
      (mutantIndex) => {
        expect(mutantIndex.index_collations[0]).not.toBe(
          mutantIndex.table_collations[0],
        );
      },
    );
  });

  it('rejects and preserves a same-name btree exclusion constraint', async () => {
    await sql.unsafe(`
      UPDATE ${FIXTURE_SCHEMA}.fraud_signals
         SET guild_id = 'fixture-guild-unknown'
       WHERE id = '${UNKNOWN_TIME_ROW_ID}'
    `);
    try {
      await expectDefinitionMutantRejected(
        `ALTER TABLE ${FIXTURE_SCHEMA}.fraud_signals
           ADD CONSTRAINT idx_fraud_signals_critical_observation
           EXCLUDE USING btree
             (
               guild_id WITH =,
               last_observed_at DESC WITH =
             )
           WHERE (status = 'open' AND severity = 'critical')`,
        (mutantIndex) => {
          expect(mutantIndex).toMatchObject({
            indisvalid: true,
            indisready: true,
            indislive: true,
            indisexclusion: true,
            indisunique: false,
            access_method: 'btree',
            key_columns: ['guild_id', 'last_observed_at'],
            key_options: '0 3',
            opclasses: ['text_ops', 'timestamptz_ops'],
            predicate:
              "status = 'open'::text AND severity = 'critical'::text",
          });
          expect(mutantIndex.index_collations).toEqual(
            mutantIndex.table_collations,
          );
        },
        `ALTER TABLE ${FIXTURE_SCHEMA}.fraud_signals
           DROP CONSTRAINT IF EXISTS idx_fraud_signals_critical_observation`,
      );
    } finally {
      await sql.unsafe(`
        UPDATE ${FIXTURE_SCHEMA}.fraud_signals
           SET guild_id = 'fixture-guild'
         WHERE id = '${UNKNOWN_TIME_ROW_ID}'
      `);
    }
  });

  it('keeps both the public and isolated indexes valid with the exact keys and predicate', async () => {
    expectTargetIndex(await indexCatalog('public'));
    expectTargetIndex(await indexCatalog(FIXTURE_SCHEMA));
  });

  it('guards IF NOT EXISTS with invalid-index recovery and a fail-closed postflight', () => {
    const indexMigration = migrationSource(INDEX_MIGRATION);
    const executableSql = indexMigration.replace(/^\s*--.*$/gm, '');
    const createPosition = indexMigration.indexOf(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS',
    );
    const preflightSql = indexMigration.slice(0, createPosition);
    expect(createPosition).toBeGreaterThan(0);
    expect(preflightSql).toContain(
      'target_index_valid',
    );
    expect(preflightSql).toContain(
      'DROP INDEX public.idx_fraud_signals_critical_observation',
    );
    const rejectWrongDefinition = preflightSql.indexOf(
      'ELSIF NOT target_index_definition_matches',
    );
    const preserveValidIndex = preflightSql.indexOf(
      'ELSIF target_index_valid',
    );
    expect(rejectWrongDefinition).toBeGreaterThan(0);
    expect(rejectWrongDefinition).toBeLessThan(preserveValidIndex);
    expect(indexMigration.slice(createPosition)).toContain('indisvalid');
    expect(indexMigration.slice(createPosition)).toContain('RAISE EXCEPTION');
    expect(executableSql.match(
      /LOCK TABLE public\.fraud_signals IN SHARE UPDATE EXCLUSIVE MODE/g,
    )).toHaveLength(2);
    expect(executableSql).toContain('i.indclass');
    expect(executableSql).toContain('i.indcollation');
    expect(executableSql.match(/NOT i\.indisexclusion/g)).toHaveLength(2);
    expect(executableSql).not.toContain('regexp_replace');
    expect(executableSql).not.toContain('DROP INDEX CONCURRENTLY');
    expect(executableSql.match(/\bCREATE\s+INDEX\b/gi)).toHaveLength(1);
    expect(migrationSource(
      '20260727034000_fraud_signal_observation_clock.sql',
    )).toContain('ADD COLUMN IF NOT EXISTS last_observed_at');
  });
});
