/**
 * Tracked Migration Runner — Phase C rewrite.
 *
 * Replaces the first-boot-only runner with per-file tracking:
 *  • schema_migrations table tracks every applied file + SHA-256 checksum
 *  • Self-bootstraps: creates the tracking table if missing
 *  • Only runs migrations not yet recorded
 *  • Detects checksum drift (file changed after it was applied)
 *  • Records duration and success/failure per migration
 *  • Stops on first error (ordered migrations)
 */

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '@somnibot/shared';

const log = createLogger('MigrationRunner');
const moduleDir = dirname(fileURLToPath(import.meta.url));

// ── Types ───────────────────────────────────────────────────

interface MigrationResult {
  ran: boolean;
  applied: string[];
  skipped: string[];
  errors: string[];
  checksumDrift: string[];
}

interface AppliedMigration {
  filename: string;
  checksum: string;
  success: boolean;
  applied_at?: string | null;
  duration_ms?: number | null;
}

interface LexedSqlStatement {
  sql: string;
  tokens: string[];
}

interface MigrationSqlPlan {
  executionMode: 'ordinary' | 'outer-transaction' | 'approved-nontransactional';
  batches: string[];
  completion:
    | { mode: 'append-to-last-batch' }
    | {
      mode: 'before-final-commit';
      statements: LexedSqlStatement[];
      finalCommitIndex: number;
    };
}

interface HistoryReadResult {
  success: boolean;
  row?: AppliedMigration;
  error?: string;
}

interface TargetBindingResult {
  success: boolean;
  error?: string;
}

interface ClaimAcquired {
  status: 'acquired';
  token: string;
}

interface ClaimNotAcquired {
  status: 'success' | 'busy' | 'drift' | 'error';
  error?: string;
}

type ClaimResult = ClaimAcquired | ClaimNotAcquired;

const APPROVED_NONTRANSACTIONAL_MIGRATION =
  '20260727034400_fraud_signal_observation_index.sql';
const APPROVED_NONTRANSACTIONAL_SHA256 =
  '37a5e24dd8740bdfc49309bed8082f8f655467ea03b3c03c38583149cfb6e1ae';
const CLAIM_PREFIX = 'claim:v1:';
const CLAIM_LEASE_MS = 5 * 60 * 1000;
const CLAIM_HEARTBEAT_MS = 60 * 1000;
const TARGET_BINDING_PROBE_FILENAME_PREFIX =
  '__somnibot_migration_target_probe_v1__:';
const TARGET_BINDING_PROBE_CHECKSUM_PREFIX =
  'target-binding-probe:v1:';
const TARGET_BINDING_PROBE_STALE_MINUTES = 10;

// ── Helpers ─────────────────────────────────────────────────

/**
 * Checksum a migration by its CONTENT, not its bytes on this particular disk.
 *
 * Git checks these files out with CRLF on Windows and LF elsewhere, so hashing
 * raw bytes made the checksum platform-dependent: a migration applied from a
 * Linux container or WSL recorded one hash, and the same untouched file read
 * from a Windows clone produced another. Every Windows operator was greeted
 * with "N file(s) changed after being applied — review manually" for files
 * nobody had edited.
 *
 * That is worse than noise. This warning exists to catch a migration being
 * altered after the fact; one that fires constantly on a clean checkout trains
 * people to ignore the real thing.
 *
 * Normalising to LF also matches what is already stored: existing databases
 * recorded the LF hash, so they keep verifying without a reset.
 */
function sha256(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n');
  return createHash('sha256').update(normalized, 'utf-8').digest('hex');
}

/**
 * Find the migrations directory relative to CWD or known paths.
 * When launched from the Electron launcher, MIGRATIONS_DIR is set explicitly.
 */
function findMigrationsDir(): string {
  // V11 Audit M-7: Validate MIGRATIONS_DIR to prevent path traversal.
  // resolve() normalises the path and we verify it doesn't escape /app
  // or the CWD tree by checking the resolved prefix.
  const envDir = process.env.MIGRATIONS_DIR;
  const sanitizedEnvDir = envDir ? (() => {
    const resolved = resolve(envDir);
    const cwd = process.cwd();
    // Only accept paths under CWD, /app (Docker), or absolute paths
    // that don't traverse upward past known roots.
    if (resolved.startsWith(cwd) || resolved.startsWith('/app') || resolved.startsWith(join(process.cwd(), 'resources'))) {
      return resolved;
    }
    log.warn(`MIGRATIONS_DIR "${envDir}" resolves outside allowed roots, ignoring`);
    return null;
  })() : null;

  const candidates = [
    // Explicit path from launcher or deploy config — always check first
    ...(sanitizedEnvDir ? [sanitizedEnvDir] : []),
    // Standard monorepo layout (dev or Docker)
    join(process.cwd(), 'packages', 'supabase', 'migrations'),
    // Relative to bot dist/ (Docker: /app/packages/bot/dist → /app/packages/supabase)
    resolve(moduleDir, '..', '..', '..', 'supabase', 'migrations'),
    resolve(moduleDir, '..', '..', '..', '..', 'packages', 'supabase', 'migrations'),
    // Electron packaged app: bot is staged at resources/bot/ and migrations
    // are copied alongside at resources/supabase/migrations/
    join(process.cwd(), 'resources', 'supabase', 'migrations'),
  ];

  for (const candidate of candidates) {
    try {
      const files = readdirSync(candidate);
      if (files.some((f) => f.endsWith('.sql'))) return candidate;
    } catch {
      // Not found, try next
    }
  }

  throw new Error(
    `[Migration] Could not find migrations directory. Tried:\n${candidates.map((c) => `  - ${c}`).join('\n')}`,
  );
}

/**
 * Extract Supabase project ref from URL.
 */
function extractProjectRef(url: string): string | null {
  const match = url.match(/https:\/\/([a-z0-9]+)\.supabase\.co/);
  return match?.[1] ?? null;
}

function dollarQuoteDelimiterAt(sql: string, index: number): string | null {
  if (sql[index] !== '$') return null;
  if (/[A-Za-z0-9_$]/.test(sql[index - 1] ?? '')) return null;

  const closingDollar = sql.indexOf('$', index + 1);
  if (closingDollar < 0) return null;

  const tag = sql.slice(index + 1, closingDollar);
  if (tag.length > 0 && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tag)) {
    return null;
  }

  return sql.slice(index, closingDollar + 1);
}

function isEscapeStringStart(sql: string, quoteIndex: number): boolean {
  const previous = sql[quoteIndex - 1];
  const beforePrevious = sql[quoteIndex - 2];
  const identifierBeforePrevious = sql[quoteIndex - 2]?.match(/[A-Za-z0-9_$]/);
  const identifierBeforeUnicodePrefix = sql[quoteIndex - 3]?.match(/[A-Za-z0-9_$]/);

  return (
    ((previous === 'E' || previous === 'e') && !identifierBeforePrevious)
    || (
      previous === '&'
      && (beforePrevious === 'U' || beforePrevious === 'u')
      && !identifierBeforeUnicodePrefix
    )
  );
}

/**
 * Split at SQL statement terminators without treating semicolons inside
 * PostgreSQL lexical constructs as boundaries. Collecting keyword tokens in
 * the same pass keeps classification subject to exactly the same lexer.
 */
function lexTopLevelSqlStatements(
  sql: string,
): LexedSqlStatement[] {
  const statements: LexedSqlStatement[] = [];
  let statementStart = 0;
  let tokens: string[] = [];
  let index = 0;
  let state: 'normal' | 'single-quote' | 'double-quote' | 'dollar-quote' | 'line-comment' | 'block-comment' = 'normal';
  let escapeString = false;
  let dollarDelimiter = '';
  let blockCommentDepth = 0;

  while (index < sql.length) {
    const current = sql[index];
    const next = sql[index + 1];

    if (state === 'line-comment') {
      if (current === '\n' || current === '\r') state = 'normal';
      index += 1;
      continue;
    }

    if (state === 'block-comment') {
      if (current === '/' && next === '*') {
        blockCommentDepth += 1;
        index += 2;
      } else if (current === '*' && next === '/') {
        blockCommentDepth -= 1;
        index += 2;
        if (blockCommentDepth === 0) state = 'normal';
      } else {
        index += 1;
      }
      continue;
    }

    if (state === 'single-quote') {
      if (current === '\'' && next === '\'') {
        index += 2;
      } else if (escapeString && current === '\\') {
        index += Math.min(2, sql.length - index);
      } else if (current === '\'') {
        state = 'normal';
        index += 1;
      } else {
        index += 1;
      }
      continue;
    }

    if (state === 'double-quote') {
      if (current === '"' && next === '"') {
        index += 2;
      } else if (current === '"') {
        state = 'normal';
        index += 1;
      } else {
        index += 1;
      }
      continue;
    }

    if (state === 'dollar-quote') {
      if (sql.startsWith(dollarDelimiter, index)) {
        index += dollarDelimiter.length;
        state = 'normal';
      } else {
        index += 1;
      }
      continue;
    }

    if (current === '-' && next === '-') {
      state = 'line-comment';
      index += 2;
    } else if (current === '/' && next === '*') {
      state = 'block-comment';
      blockCommentDepth = 1;
      index += 2;
    } else if (current === '\'') {
      state = 'single-quote';
      escapeString = isEscapeStringStart(sql, index);
      index += 1;
    } else if (current === '"') {
      state = 'double-quote';
      index += 1;
    } else if (current === '$') {
      const delimiter = dollarQuoteDelimiterAt(sql, index);
      if (delimiter) {
        state = 'dollar-quote';
        dollarDelimiter = delimiter;
        index += delimiter.length;
      } else {
        index += 1;
      }
    } else if (current === ';') {
      statements.push({ sql: sql.slice(statementStart, index + 1), tokens });
      statementStart = index + 1;
      tokens = [];
      index += 1;
    } else if (/[A-Za-z_]/.test(current ?? '')) {
      const tokenStart = index;
      index += 1;
      while (/[A-Za-z0-9_$]/.test(sql[index] ?? '')) index += 1;
      tokens.push(sql.slice(tokenStart, index).toUpperCase());
    } else {
      index += 1;
    }
  }

  if (state === 'single-quote') throw new Error('Unterminated SQL string literal');
  if (state === 'double-quote') throw new Error('Unterminated quoted SQL identifier');
  if (state === 'dollar-quote') {
    throw new Error(`Unterminated dollar-quoted string ${dollarDelimiter}`);
  }
  if (state === 'block-comment') throw new Error('Unterminated SQL block comment');

  if (statementStart < sql.length) {
    statements.push({ sql: sql.slice(statementStart), tokens });
  }

  return statements;
}

function isCreateIndexConcurrently(tokens: string[]): boolean {
  if (tokens[0] !== 'CREATE') return false;

  let indexKeyword = 1;
  if (tokens[indexKeyword] === 'UNIQUE') indexKeyword += 1;

  return tokens[indexKeyword] === 'INDEX'
    && tokens[indexKeyword + 1] === 'CONCURRENTLY';
}

function transactionIncompatibleStatement(tokens: string[]): string | null {
  const [first, second] = tokens;

  if (first === 'VACUUM') return 'VACUUM';
  if (first === 'CLUSTER') {
    // Database-wide CLUSTER and CLUSTER on a partitioned table cannot run in
    // a transaction. Whether a named relation is partitioned is live catalog
    // state, so the closed migration profile rejects the whole command family.
    return 'CLUSTER';
  }
  if (first === 'DISCARD' && second === 'ALL') return 'DISCARD ALL';
  if (
    (first === 'CREATE' || first === 'DROP')
    && (second === 'DATABASE' || second === 'TABLESPACE')
  ) {
    return `${first} ${second}`;
  }
  if (first === 'ALTER' && second === 'SYSTEM') return 'ALTER SYSTEM';
  if (
    first === 'ALTER'
    && second === 'DATABASE'
    && tokens.some((token, index) => token === 'SET' && tokens[index + 1] === 'TABLESPACE')
  ) {
    return 'ALTER DATABASE SET TABLESPACE';
  }
  if (
    first === 'DROP'
    && second === 'INDEX'
    && tokens.includes('CONCURRENTLY')
  ) {
    return 'DROP INDEX CONCURRENTLY';
  }
  if (first === 'REINDEX') {
    // REINDEX SCHEMA/DATABASE/SYSTEM and every concurrent form are always
    // nontransactional. INDEX/TABLE also become nontransactional when their
    // target is partitioned, which cannot be proven from migration text.
    return 'REINDEX';
  }
  if (
    (first === 'CREATE' || first === 'ALTER' || first === 'DROP')
    && second === 'SUBSCRIPTION'
  ) {
    // Subscription transaction safety depends on options and live catalog
    // state (replication slots and refresh behavior), so the closed migration
    // profile rejects the whole command family before a claim is acquired.
    return `${first} SUBSCRIPTION`;
  }
  if (
    first === 'ALTER'
    && second === 'TABLE'
    && tokens.some((token, index) => (
      token === 'DETACH'
      && tokens[index + 1] === 'PARTITION'
      && tokens.slice(index + 2).includes('CONCURRENTLY')
    ))
  ) {
    return 'ALTER TABLE DETACH PARTITION CONCURRENTLY';
  }

  return null;
}

function explicitTransactionControlStatement(tokens: string[]): string | null {
  const [first, second, third, fourth] = tokens;

  if (
    first === 'BEGIN'
    || first === 'COMMIT'
    || first === 'END'
    || first === 'ROLLBACK'
    || first === 'ABORT'
    || first === 'SAVEPOINT'
    || first === 'RELEASE'
  ) {
    return tokens.slice(0, 2).join(' ');
  }
  if (first === 'START' && second === 'TRANSACTION') return 'START TRANSACTION';
  if (first === 'PREPARE' && second === 'TRANSACTION') return 'PREPARE TRANSACTION';
  if (first === 'SET' && second === 'TRANSACTION') return 'SET TRANSACTION';
  if (
    first === 'SET'
    && second === 'SESSION'
    && third === 'CHARACTERISTICS'
    && fourth === 'AS'
    && tokens[4] === 'TRANSACTION'
  ) {
    return 'SET SESSION CHARACTERISTICS AS TRANSACTION';
  }

  return null;
}

/**
 * The only nontransactional migration this runner accepts is the exact 034400
 * recovery file reviewed with this release. A keyword blacklist is not a
 * safety boundary: PostgreSQL has many statements that cannot share a
 * transaction, and accepting an unrecognised one before a later CIC batch can
 * commit a side effect before the migration is recorded.
 *
 * Ordinary files run inside an explicit runner-owned transaction. Existing
 * migrations with one outer BEGIN/COMMIT envelope keep that exact boundary;
 * the history CAS is inserted before their final COMMIT.
 */
function createMigrationSqlPlan(
  sql: string,
  migrationName: string,
): MigrationSqlPlan {
  const statements = lexTopLevelSqlStatements(sql);
  const executable = statements
    .map((statement, index) => ({ statement, index }))
    .filter(({ statement }) => statement.tokens.length > 0);
  const concurrentIndexes = executable.filter(({ statement }) => (
    isCreateIndexConcurrently(statement.tokens)
  ));

  if (concurrentIndexes.length > 0) {
    const approvedShape = (
      migrationName === APPROVED_NONTRANSACTIONAL_MIGRATION
      && sha256(sql) === APPROVED_NONTRANSACTIONAL_SHA256
      && executable.length === 3
      && executable[0]?.statement.tokens[0] === 'DO'
      && isCreateIndexConcurrently(executable[1]?.statement.tokens ?? [])
      && executable[2]?.statement.tokens[0] === 'DO'
    );

    if (!approvedShape) {
      throw new Error(
        `SQL contains CREATE INDEX CONCURRENTLY outside the approved nontransactional migration profile`,
      );
    }

    return {
      executionMode: 'approved-nontransactional',
      batches: executable.map(({ statement }) => statement.sql),
      completion: { mode: 'append-to-last-batch' },
    };
  }

  const transactionIncompatible = executable
    .map(({ statement }) => transactionIncompatibleStatement(statement.tokens))
    .find((statement): statement is string => statement !== null);
  if (transactionIncompatible) {
    throw new Error(
      `Transaction-incompatible SQL (${transactionIncompatible}) is allowed only by the exact approved nontransactional migration profile`,
    );
  }

  const transactionControls = executable
    .map(({ statement, index }) => ({
      index,
      control: explicitTransactionControlStatement(statement.tokens),
      tokens: statement.tokens,
    }))
    .filter((item): item is typeof item & { control: string } => item.control !== null);

  if (transactionControls.length === 0) {
    return {
      executionMode: 'ordinary',
      batches: [sql],
      completion: { mode: 'append-to-last-batch' },
    };
  }

  const firstExecutableIndex = executable[0]?.index;
  const lastExecutableIndex = executable.at(-1)?.index;
  const [opening, closing] = transactionControls;
  const hasSoleOuterEnvelope = (
    transactionControls.length === 2
    && opening?.index === firstExecutableIndex
    && opening.tokens.length === 1
    && opening.tokens[0] === 'BEGIN'
    && closing?.index === lastExecutableIndex
    && closing.tokens.length === 1
    && closing.tokens[0] === 'COMMIT'
  );

  if (!hasSoleOuterEnvelope || closing === undefined) {
    const controls = transactionControls.map(({ control }) => control).join(', ');
    throw new Error(
      `Unsupported top-level transaction control shape: ${controls}`,
    );
  }

  return {
    executionMode: 'outer-transaction',
    batches: [sql],
    completion: {
      mode: 'before-final-commit',
      statements,
      finalCommitIndex: closing.index,
    },
  };
}

function materializeMigrationBatches(
  plan: MigrationSqlPlan,
  completionSql?: string,
): string[] {
  if (!completionSql) return [...plan.batches];

  if (plan.completion.mode === 'append-to-last-batch') {
    const batches = [...plan.batches];
    const finalIndex = batches.length - 1;
    if (finalIndex < 0) {
      throw new Error('Migration plan contains no executable SQL');
    }
    batches[finalIndex] = `${batches[finalIndex]}\n${completionSql}`;
    return batches;
  }

  const { statements, finalCommitIndex } = plan.completion;
  const beforeCommit = statements
    .slice(0, finalCommitIndex)
    .map((statement) => statement.sql)
    .join('');
  const finalCommitAndTrailing = statements
    .slice(finalCommitIndex)
    .map((statement) => statement.sql)
    .join('');

  return [`${beforeCommit}\n${completionSql}\n${finalCommitAndTrailing}`];
}

export function planMigrationSql(
  sql: string,
  migrationName = '',
): string[] {
  return createMigrationSqlPlan(sql, migrationName).batches;
}

// ── SQL Execution ───────────────────────────────────────────

function directDatabaseUrl(): string | undefined {
  return process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
}

function resolvedSessionDatabaseUrl(): { url?: string; error?: string } {
  const url = directDatabaseUrl();
  if (!url) return {};

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      error:
        'SUPABASE_DB_URL/DATABASE_URL must be a valid PostgreSQL connection URL',
    };
  }

  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    return {
      error:
        'SUPABASE_DB_URL/DATABASE_URL must use the postgres:// or postgresql:// protocol',
    };
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.+$/, '');
  const isSupabasePooler =
    hostname === 'pooler.supabase.com'
    || hostname.endsWith('.pooler.supabase.com');
  const isSupabaseProjectHost =
    /^db\.[a-z0-9-]+\.supabase\.co$/.test(hostname);
  const connectionOptions = new Map(
    [...parsed.searchParams.entries()]
      .map(([key, value]) => [key.toLowerCase(), value.toLowerCase()]),
  );
  const transactionModeMarker =
    connectionOptions.get('pgbouncer') === 'true'
    || connectionOptions.get('pool_mode') === 'transaction'
    || connectionOptions.get('poolmode') === 'transaction';

  if (
    (
      parsed.port === '6543'
      && (isSupabasePooler || isSupabaseProjectHost)
    )
    || transactionModeMarker
  ) {
    return {
      error:
        'SUPABASE_DB_URL/DATABASE_URL must use a direct PostgreSQL endpoint '
        + 'or a session-mode pooler; a transaction pool cannot pin the '
        + 'advisory-lock session required for migration execution',
    };
  }

  return { url };
}

function migrationAdvisoryLockParts(migrationName: string): [number, number] {
  const digest = createHash('sha256')
    .update(`somnibot:migration-runner:${migrationName}`, 'utf8')
    .digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

function buildMigrationAdvisoryLockSql(migrationName: string): string {
  const [classId, objectId] = migrationAdvisoryLockParts(migrationName);
  return `SELECT pg_catalog.pg_advisory_lock(${classId}, ${objectId});`;
}

function buildMigrationAdvisoryUnlockSql(migrationName: string): string {
  const [classId, objectId] = migrationAdvisoryLockParts(migrationName);
  return `
DO $migration_runner_advisory_unlock$
BEGIN
  IF NOT pg_catalog.pg_advisory_unlock(${classId}, ${objectId}) THEN
    RAISE EXCEPTION 'Migration runner advisory lock was not held by this session';
  END IF;
END
$migration_runner_advisory_unlock$;
`.trim();
}

async function executeSql(
  supabaseUrl: string,
  serviceRoleKey: string,
  sql: string,
  migrationName: string,
  preparedPlan?: MigrationSqlPlan,
  completionSql?: string,
  claimProofSql?: string,
  assertClaimHealthy?: () => Promise<void>,
): Promise<{ success: boolean; error?: string }> {
  let plan: MigrationSqlPlan;
  let batches: string[];
  try {
    plan = preparedPlan ?? createMigrationSqlPlan(sql, migrationName);
    batches = materializeMigrationBatches(plan, completionSql);
  } catch (err) {
    return { success: false, error: `Migration SQL planning error: ${String(err)}` };
  }

  const isClaimedSource = completionSql !== undefined || claimProofSql !== undefined;
  if (isClaimedSource && (!completionSql || !claimProofSql)) {
    return {
      success: false,
      error: 'Claimed migration execution requires both ownership proof and completion CAS SQL',
    };
  }

  // Claimed source is deliberately direct-only. A reserved Postgres.js
  // connection pins one physical session so the session advisory lock covers
  // ownership proof, every source batch, and the success CAS.
  const directTarget = resolvedSessionDatabaseUrl();
  if (directTarget.error) {
    return { success: false, error: directTarget.error };
  }
  const dbUrl = directTarget.url;
  if (dbUrl) {
    try {
      const { default: postgres } = await import('postgres');
      const sqlClient = postgres(dbUrl, { max: 1 });
      try {
        if (!isClaimedSource) {
          for (const batch of batches) {
            await sqlClient.unsafe(batch);
          }
          return { success: true };
        }
        if (!claimProofSql || !completionSql) {
          throw new Error(
            'Claimed migration execution requires both ownership proof and completion CAS SQL',
          );
        }
        const ownershipProofSql = claimProofSql;
        const successCompletionSql = completionSql;

        const reserved = await sqlClient.reserve();
        let lockHeld = false;
        let transactionOpen = false;
        let executionError: unknown;
        let cleanupError: unknown;
        try {
          await reserved.unsafe(buildMigrationAdvisoryLockSql(migrationName));
          lockHeld = true;

          const proveCurrentOwnership = async (): Promise<void> => {
            await assertClaimHealthy?.();
            await reserved.unsafe(ownershipProofSql);
          };

          if (plan.executionMode === 'approved-nontransactional') {
            for (let index = 0; index < plan.batches.length; index += 1) {
              await proveCurrentOwnership();
              const batch = plan.batches[index];
              const isFinalBatch = index === plan.batches.length - 1;
              if (isFinalBatch) {
                await reserved.unsafe('BEGIN;');
                transactionOpen = true;
                await reserved.unsafe(batch);
                await proveCurrentOwnership();
                await reserved.unsafe(successCompletionSql);
                await reserved.unsafe('COMMIT;');
                transactionOpen = false;
              } else {
                await reserved.unsafe(batch);
              }
            }
          } else if (plan.executionMode === 'outer-transaction') {
            if (plan.completion.mode !== 'before-final-commit') {
              throw new Error('Outer transaction plan is missing its final COMMIT boundary');
            }
            const { statements, finalCommitIndex } = plan.completion;
            const sourceBeforeCommit = statements
              .slice(0, finalCommitIndex)
              .map((statement) => statement.sql)
              .join('');
            const finalCommitAndTrailing = statements
              .slice(finalCommitIndex)
              .map((statement) => statement.sql)
              .join('');

            await proveCurrentOwnership();
            transactionOpen = true;
            await reserved.unsafe(sourceBeforeCommit);
            await proveCurrentOwnership();
            await reserved.unsafe(successCompletionSql);
            await reserved.unsafe(finalCommitAndTrailing);
            transactionOpen = false;
          } else {
            await proveCurrentOwnership();
            await reserved.unsafe('BEGIN;');
            transactionOpen = true;
            await reserved.unsafe(plan.batches[0]);
            await proveCurrentOwnership();
            await reserved.unsafe(successCompletionSql);
            await reserved.unsafe('COMMIT;');
            transactionOpen = false;
          }
        } catch (err) {
          executionError = err;
          if (transactionOpen) {
            try {
              await reserved.unsafe('ROLLBACK;');
            } catch (rollbackError) {
              executionError = new Error(
                `${String(err)}; migration rollback failed: ${String(rollbackError)}`,
              );
            }
          }
        } finally {
          if (lockHeld) {
            try {
              await reserved.unsafe(buildMigrationAdvisoryUnlockSql(migrationName));
            } catch (err) {
              cleanupError = err;
            }
          }
          reserved.release();
        }

        if (executionError && cleanupError) {
          throw new Error(
            `${String(executionError)}; advisory unlock failed: ${String(cleanupError)}`,
          );
        }
        if (executionError) throw executionError;
        if (cleanupError) throw cleanupError;
        return { success: true };
      } finally {
        await sqlClient.end();
      }
    } catch (err) {
      return { success: false, error: `Direct DB error: ${String(err)}` };
    }
  }

  if (isClaimedSource) {
    return {
      success: false,
      error: 'A direct database connection is required for claimed migration source execution; set SUPABASE_DB_URL or DATABASE_URL',
    };
  }

  // The Management API remains available only for bootstrap and other
  // single-request, runner-owned control operations. Its Beta endpoint does
  // not contractually guarantee a pinned session or a multi-statement
  // transaction boundary for migration source plus history completion.
  const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
  const projectRef = extractProjectRef(supabaseUrl);

  if (accessToken && projectRef) {
    try {
      for (let index = 0; index < batches.length; index += 1) {
        const batch = batches[index];
        const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ query: batch }),
        });

        if (!res.ok) {
          const errText = await res.text();
          return {
            success: false,
            error: `Management API error (${res.status}) in ${migrationName} batch ${index + 1}/${batches.length}: ${errText}`,
          };
        }
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: `Management API request failed: ${String(err)}` };
    }
  }

  return {
    success: false,
    error: `No database access method available. Set SUPABASE_ACCESS_TOKEN or SUPABASE_DB_URL / DATABASE_URL.`,
  };
}

/**
 * Execute runner-owned control SQL against the same target selection used for
 * migration source. Direct SQL (preferred) or the Management SQL endpoint owns
 * the database-time CAS; the REST API is only the independent verification
 * read because an HTTP or socket outcome can be ambiguous after commit.
 */
async function executeControlSql(
  supabaseUrl: string,
  sql: string,
  operation: string,
): Promise<{ success: boolean; error?: string }> {
  const directTarget = resolvedSessionDatabaseUrl();
  if (directTarget.error) {
    return { success: false, error: `${operation}: ${directTarget.error}` };
  }
  const dbUrl = directTarget.url;
  if (dbUrl) {
    try {
      const { default: postgres } = await import('postgres');
      const client = postgres(dbUrl, { max: 1 });
      try {
        await client.unsafe(sql);
      } finally {
        await client.end();
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: `${operation} direct DB error: ${String(err)}` };
    }
  }

  const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
  const projectRef = extractProjectRef(supabaseUrl);
  if (accessToken && projectRef) {
    try {
      const res = await fetch(
        `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ query: sql }),
        },
      );
      if (res.ok) return { success: true };
      return {
        success: false,
        error: `${operation} Management API error (${res.status}): ${await responseDetails(res)}`,
      };
    } catch (err) {
      return {
        success: false,
        error: `${operation} Management API request failed: ${String(err)}`,
      };
    }
  }

  return {
    success: false,
    error: `${operation} has no SQL target; set SUPABASE_ACCESS_TOKEN or SUPABASE_DB_URL / DATABASE_URL`,
  };
}

// ── Tracking Table Bootstrap ────────────────────────────────

const BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS public.schema_migrations (
  filename    TEXT PRIMARY KEY,
  checksum    TEXT NOT NULL,
  applied_at  TIMESTAMPTZ DEFAULT now(),
  duration_ms INTEGER DEFAULT 0,
  success     BOOLEAN DEFAULT true
);
`;

async function ensureTrackingTable(
  supabaseUrl: string,
  serviceRoleKey: string,
): Promise<boolean> {
  const result = await executeSql(supabaseUrl, serviceRoleKey, BOOTSTRAP_SQL, '_bootstrap');
  if (!result.success) {
    log.warn('Could not create tracking table:', result.error);
    return false;
  }
  return true;
}

// ── Fetch Applied Migrations ────────────────────────────────

function historyHeaders(
  serviceRoleKey: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    ...extra,
  };
}

function historyUrl(
  supabaseUrl: string,
  params: Record<string, string> = {},
): string {
  const query = new URLSearchParams(params);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return `${supabaseUrl}/rest/v1/schema_migrations${suffix}`;
}

async function responseDetails(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

async function getAppliedMigrations(
  supabaseUrl: string,
  serviceRoleKey: string,
): Promise<{ success: boolean; rows: AppliedMigration[]; error?: string }> {
  try {
    const res = await fetch(
      historyUrl(supabaseUrl, {
        select: 'filename,checksum,success,applied_at,duration_ms',
        order: 'filename.asc',
      }),
      { headers: historyHeaders(serviceRoleKey) },
    );

    if (!res.ok) {
      return {
        success: false,
        rows: [],
        error: `Migration history read failed (${res.status}): ${await responseDetails(res)}`,
      };
    }

    const rows = (await res.json()) as AppliedMigration[];
    return {
      success: true,
      rows: rows.filter((row) => !isTargetBindingProbeFilename(row.filename)),
    };
  } catch (err) {
    return {
      success: false,
      rows: [],
      error: `Migration history read failed: ${String(err)}`,
    };
  }
}

async function readMigrationHistoryRow(
  supabaseUrl: string,
  serviceRoleKey: string,
  filename: string,
): Promise<HistoryReadResult> {
  try {
    const res = await fetch(
      historyUrl(supabaseUrl, {
        select: 'filename,checksum,success,applied_at,duration_ms',
        filename: `eq.${filename}`,
        limit: '1',
      }),
      { headers: historyHeaders(serviceRoleKey) },
    );

    if (!res.ok) {
      return {
        success: false,
        error: `Migration history row read failed (${res.status}): ${await responseDetails(res)}`,
      };
    }

    const rows = (await res.json()) as AppliedMigration[];
    if (rows.length > 1) {
      return {
        success: false,
        error: `Migration history row read returned ${rows.length} rows for ${filename}`,
      };
    }
    return { success: true, row: rows[0] };
  } catch (err) {
    return {
      success: false,
      error: `Migration history row read failed: ${String(err)}`,
    };
  }
}

function isTargetBindingProbeFilename(filename: string): boolean {
  return filename.startsWith(TARGET_BINDING_PROBE_FILENAME_PREFIX);
}

async function cleanupTargetBindingProbe(
  supabaseUrl: string,
  serviceRoleKey: string,
  filename: string,
  checksum: string,
  bindingWasVisible: boolean,
): Promise<TargetBindingResult> {
  const cleanupWrite = await executeControlSql(
    supabaseUrl,
    `
DO $migration_runner_target_probe_cleanup$
BEGIN
  DELETE FROM public.schema_migrations
   WHERE filename = ${sqlLiteral(filename)}
     AND checksum = ${sqlLiteral(checksum)}
     AND success = false;

  IF EXISTS (
    SELECT 1
      FROM public.schema_migrations
     WHERE filename = ${sqlLiteral(filename)}
       AND checksum = ${sqlLiteral(checksum)}
       AND success = false
  ) THEN
    RAISE EXCEPTION 'Migration target-binding probe cleanup failed';
  END IF;
END
$migration_runner_target_probe_cleanup$;
`,
    'Migration target-binding probe cleanup',
  );

  const cleanupRead = await readMigrationHistoryRow(
    supabaseUrl,
    serviceRoleKey,
    filename,
  );
  const restVerifiedAbsent = cleanupRead.success && cleanupRead.row === undefined;
  if (
    restVerifiedAbsent
    && (cleanupWrite.success || bindingWasVisible)
  ) {
    return { success: true };
  }

  const details = [
    cleanupWrite.success ? undefined : cleanupWrite.error,
    cleanupRead.success
      ? cleanupRead.row
        ? 'reserved probe row is still visible through REST'
        : 'cleanup outcome is ambiguous across unbound targets'
      : cleanupRead.error,
  ].filter((detail): detail is string => Boolean(detail));
  return {
    success: false,
    error: `Migration SQL/REST target-binding probe cleanup was not verified: ${details.join('; ')}`,
  };
}

/**
 * Bind the selected SQL executor to the REST history target before any
 * successful history row can be trusted. The random reserved row contains no
 * credentials, is never a migration filename, and is removed by an exact
 * token CAS. Old crashed probes are reaped only inside this reserved namespace
 * and only after a database-timed stale interval.
 */
async function verifySqlRestTargetBinding(
  supabaseUrl: string,
  serviceRoleKey: string,
): Promise<TargetBindingResult> {
  const probeId = randomUUID();
  const filename = `${TARGET_BINDING_PROBE_FILENAME_PREFIX}${probeId}`;
  const checksum = `${TARGET_BINDING_PROBE_CHECKSUM_PREFIX}${probeId}`;
  const write = await executeControlSql(
    supabaseUrl,
    `
DO $migration_runner_target_probe_write$
BEGIN
  DELETE FROM public.schema_migrations
   WHERE left(filename, ${TARGET_BINDING_PROBE_FILENAME_PREFIX.length})
           = ${sqlLiteral(TARGET_BINDING_PROBE_FILENAME_PREFIX)}
     AND left(checksum, ${TARGET_BINDING_PROBE_CHECKSUM_PREFIX.length})
           = ${sqlLiteral(TARGET_BINDING_PROBE_CHECKSUM_PREFIX)}
     AND success = false
     AND applied_at IS NOT NULL
     AND applied_at < now() - interval '${TARGET_BINDING_PROBE_STALE_MINUTES} minutes';

  INSERT INTO public.schema_migrations (
    filename,
    checksum,
    applied_at,
    duration_ms,
    success
  )
  VALUES (
    ${sqlLiteral(filename)},
    ${sqlLiteral(checksum)},
    now(),
    0,
    false
  )
  ON CONFLICT (filename) DO NOTHING;

  IF NOT EXISTS (
    SELECT 1
      FROM public.schema_migrations
     WHERE filename = ${sqlLiteral(filename)}
       AND checksum = ${sqlLiteral(checksum)}
       AND success = false
  ) THEN
    RAISE EXCEPTION 'Migration target-binding probe collision';
  END IF;
END
$migration_runner_target_probe_write$;
`,
    'Migration target-binding probe write',
  );

  // A failed transport can still mean the probe committed, so only the exact
  // REST reread decides whether the SQL and REST surfaces are bound.
  const read = await readMigrationHistoryRow(
    supabaseUrl,
    serviceRoleKey,
    filename,
  );
  const exactVisible = Boolean(
    read.success
    && read.row?.filename === filename
    && read.row.checksum === checksum
    && read.row.success === false,
  );
  const cleanup = await cleanupTargetBindingProbe(
    supabaseUrl,
    serviceRoleKey,
    filename,
    checksum,
    exactVisible,
  );

  if (!read.success) {
    return {
      success: false,
      error: `Migration SQL/REST target binding could not be read: ${read.error}${cleanup.success ? '' : `; ${cleanup.error}`}`,
    };
  }
  if (!exactVisible) {
    const mismatch = read.row
      ? 'REST returned a conflicting reserved probe row'
      : 'the SQL-written probe was not visible through REST';
    return {
      success: false,
      error: `Migration SQL/REST target binding failed: ${mismatch}${write.success ? '' : `; ${write.error}`}${cleanup.success ? '' : `; ${cleanup.error}`}`,
    };
  }
  if (!cleanup.success) return cleanup;

  return { success: true };
}

function checksumEncodings(sql: string): {
  canonical: string;
  compatible: Set<string>;
} {
  const canonical = sha256(sql);
  const raw = createHash('sha256').update(sql, 'utf-8').digest('hex');
  const crlf = createHash('sha256')
    .update(sql.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'), 'utf-8')
    .digest('hex');
  return { canonical, compatible: new Set([canonical, raw, crlf]) };
}

function parseClaimToken(
  checksum: string,
): { canonical: string; owner: string } | null {
  const match = checksum.match(
    /^claim:v1:([a-f0-9]{64}):([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i,
  );
  return match ? { canonical: match[1].toLowerCase(), owner: match[2] } : null;
}

async function writeHistoryClaim(
  supabaseUrl: string,
  filename: string,
  claimToken: string,
  expected?: AppliedMigration,
): Promise<string | undefined> {
  const existingClaim = expected ? parseClaimToken(expected.checksum) : null;
  const statement = expected
    ? `
UPDATE public.schema_migrations
   SET checksum = ${sqlLiteral(claimToken)},
       applied_at = now(),
       duration_ms = 0,
       success = false
 WHERE filename = ${sqlLiteral(filename)}
   AND checksum = ${sqlLiteral(expected.checksum)}
   AND success = false
   ${existingClaim ? `AND applied_at < now() - interval '${CLAIM_LEASE_MS / 60_000} minutes'` : ''};
`
    : `
INSERT INTO public.schema_migrations (
  filename,
  checksum,
  applied_at,
  duration_ms,
  success
)
VALUES (
  ${sqlLiteral(filename)},
  ${sqlLiteral(claimToken)},
  now(),
  0,
  false
)
ON CONFLICT (filename) DO NOTHING;
`;

  const result = await executeControlSql(
    supabaseUrl,
    statement,
    'Migration claim write',
  );
  return result.success ? undefined : result.error;
}

function classifyClaimVerification(
  row: AppliedMigration | undefined,
  canonical: string,
  compatible: Set<string>,
  ownedToken: string,
  writeError?: string,
): ClaimResult {
  if (row?.checksum === ownedToken && row.success === false) {
    return { status: 'acquired', token: ownedToken };
  }
  if (row?.success) {
    if (compatible.has(row.checksum)) return { status: 'success' };
    return {
      status: 'drift',
      error: `Successful migration history checksum does not match current content`,
    };
  }
  if (!row) {
    return {
      status: 'error',
      error: writeError ?? 'Migration claim was not persisted',
    };
  }

  const claim = parseClaimToken(row.checksum);
  if (claim) {
    if (claim.canonical !== canonical) {
      return {
        status: 'drift',
        error: `Claimed migration history checksum does not match current content`,
      };
    }
    return {
      status: 'busy',
      error: `Migration is claimed by another runner`,
    };
  }

  if (!compatible.has(row.checksum)) {
    return {
      status: 'drift',
      error: `Failed migration history checksum does not match current content`,
    };
  }

  return {
    status: 'error',
    error: writeError ?? 'Migration claim compare-and-set did not acquire the row',
  };
}

async function acquireMigrationClaim(
  supabaseUrl: string,
  serviceRoleKey: string,
  filename: string,
  canonical: string,
  compatible: Set<string>,
): Promise<ClaimResult> {
  const read = await readMigrationHistoryRow(supabaseUrl, serviceRoleKey, filename);
  if (!read.success) return { status: 'error', error: read.error };

  const current = read.row;
  if (current?.success) {
    return compatible.has(current.checksum)
      ? { status: 'success' }
      : {
        status: 'drift',
        error: `Successful migration history checksum does not match current content`,
      };
  }

  if (current) {
    const existingClaim = parseClaimToken(current.checksum);
    if (existingClaim) {
      if (existingClaim.canonical !== canonical) {
        return {
          status: 'drift',
          error: `Claimed migration history checksum does not match current content`,
        };
      }
    } else if (!compatible.has(current.checksum)) {
      return {
        status: 'drift',
        error: `Failed migration history checksum does not match current content`,
      };
    }
  }

  const ownedToken = `${CLAIM_PREFIX}${canonical}:${randomUUID()}`;
  const writeError = await writeHistoryClaim(
    supabaseUrl,
    filename,
    ownedToken,
    current,
  );

  // SQL-side claim writes are deliberately treated as ambiguous. A timeout can
  // arrive after the database committed the CAS, while a successful transport
  // response does not prove the predicate matched. Only an exact owner-token
  // REST reread authorizes source SQL execution.
  const verified = await readMigrationHistoryRow(
    supabaseUrl,
    serviceRoleKey,
    filename,
  );
  if (!verified.success) {
    return {
      status: 'error',
      error: `${writeError ? `${writeError}; ` : ''}${verified.error}`,
    };
  }

  return classifyClaimVerification(
    verified.row,
    canonical,
    compatible,
    ownedToken,
    writeError,
  );
}

function sqlLiteral(value: string): string {
  if (value.includes('\0')) {
    throw new Error('SQL literal cannot contain a NUL byte');
  }
  return `'${value.replace(/'/g, "''")}'`;
}

function buildMigrationCompletionSql(
  filename: string,
  canonical: string,
  claimToken: string,
): string {
  return `
DO $migration_runner_history$
BEGIN
  UPDATE public.schema_migrations
     SET checksum = ${sqlLiteral(canonical)},
         applied_at = now(),
         duration_ms = 0,
         success = true
   WHERE filename = ${sqlLiteral(filename)}
     AND checksum = ${sqlLiteral(claimToken)}
     AND success = false;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Migration history claim was lost before commit';
  END IF;
END
$migration_runner_history$;
`.trim();
}

function buildMigrationClaimProofSql(
  filename: string,
  claimToken: string,
): string {
  return `
DO $migration_runner_claim_proof$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.schema_migrations
     WHERE filename = ${sqlLiteral(filename)}
       AND checksum = ${sqlLiteral(claimToken)}
       AND success = false
  ) THEN
    RAISE EXCEPTION 'Migration claim is not present on the selected SQL target';
  END IF;
END
$migration_runner_claim_proof$;
`.trim();
}

async function renewMigrationClaim(
  supabaseUrl: string,
  serviceRoleKey: string,
  filename: string,
  claimToken: string,
  canonical: string,
): Promise<{ success: boolean; error?: string }> {
  const before = await readMigrationHistoryRow(
    supabaseUrl,
    serviceRoleKey,
    filename,
  );
  if (!before.success) {
    return { success: false, error: before.error };
  }
  if (before.row?.checksum === canonical && before.row.success === true) {
    return { success: true };
  }
  if (before.row?.checksum !== claimToken || before.row.success !== false) {
    return {
      success: false,
      error: 'Migration claim heartbeat lost ownership before renewal',
    };
  }
  const beforeLeaseMs = Date.parse(before.row.applied_at ?? '');
  if (!Number.isFinite(beforeLeaseMs)) {
    return {
      success: false,
      error: 'Migration claim heartbeat cannot prove the current lease timestamp',
    };
  }

  const write = await executeControlSql(
    supabaseUrl,
    `
DO $migration_runner_heartbeat$
BEGIN
  UPDATE public.schema_migrations
     SET applied_at = GREATEST(
       clock_timestamp(),
       applied_at + interval '1 millisecond'
     )
   WHERE filename = ${sqlLiteral(filename)}
     AND checksum = ${sqlLiteral(claimToken)}
     AND success = false;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Migration claim heartbeat lost ownership';
  END IF;
END
$migration_runner_heartbeat$;
`,
    'Migration claim heartbeat',
  );
  const writeError = write.success ? undefined : write.error;

  const verified = await readMigrationHistoryRow(
    supabaseUrl,
    serviceRoleKey,
    filename,
  );
  if (!verified.success) {
    return {
      success: false,
      error: `${writeError ? `${writeError}; ` : ''}${verified.error}`,
    };
  }
  if (verified.row?.checksum === canonical && verified.row.success === true) {
    return { success: true };
  }
  if (verified.row?.checksum === claimToken && verified.row.success === false) {
    const renewedLeaseMs = Date.parse(verified.row.applied_at ?? '');
    if (Number.isFinite(renewedLeaseMs) && renewedLeaseMs > beforeLeaseMs) {
      return { success: true };
    }
    return {
      success: false,
      error: `${writeError ? `${writeError}; ` : ''}Migration claim heartbeat lease timestamp did not advance`,
    };
  }
  return {
    success: false,
    error: writeError ?? 'Migration claim heartbeat lost ownership',
  };
}

function startClaimHeartbeat(
  supabaseUrl: string,
  serviceRoleKey: string,
  filename: string,
  claimToken: string,
  canonical: string,
): {
  assertHealthy: () => Promise<void>;
  stop: () => Promise<string | undefined>;
} {
  let heartbeatError: string | undefined;
  let heartbeatInFlight = Promise.resolve();
  const timer = setInterval(() => {
    heartbeatInFlight = heartbeatInFlight.then(async () => {
      if (heartbeatError) return;
      const renewed = await renewMigrationClaim(
        supabaseUrl,
        serviceRoleKey,
        filename,
        claimToken,
        canonical,
      );
      if (!renewed.success) heartbeatError = renewed.error;
    });
  }, CLAIM_HEARTBEAT_MS);
  timer.unref?.();

  return {
    assertHealthy: async () => {
      await heartbeatInFlight;
      if (heartbeatError) throw new Error(heartbeatError);
    },
    stop: async () => {
      clearInterval(timer);
      await heartbeatInFlight;
      return heartbeatError;
    },
  };
}

async function releaseMigrationClaim(
  supabaseUrl: string,
  serviceRoleKey: string,
  filename: string,
  canonical: string,
  claimToken: string,
  durationMs: number,
): Promise<{ status: 'released' | 'success' | 'lost' | 'error'; error?: string }> {
  const write = await executeControlSql(
    supabaseUrl,
    `
UPDATE public.schema_migrations
   SET checksum = ${sqlLiteral(canonical)},
       applied_at = now(),
       duration_ms = ${Math.max(0, Math.trunc(durationMs))},
       success = false
 WHERE filename = ${sqlLiteral(filename)}
   AND checksum = ${sqlLiteral(claimToken)}
   AND success = false;
`,
    'Migration claim release',
  );
  const writeError = write.success ? undefined : write.error;

  const verified = await readMigrationHistoryRow(
    supabaseUrl,
    serviceRoleKey,
    filename,
  );
  if (!verified.success) {
    return {
      status: 'error',
      error: `${writeError ? `${writeError}; ` : ''}${verified.error}`,
    };
  }
  if (verified.row?.success && verified.row.checksum === canonical) {
    return { status: 'success' };
  }
  if (!verified.row?.success && verified.row?.checksum === canonical) {
    return { status: 'released' };
  }
  if (verified.row?.checksum !== claimToken) {
    return {
      status: 'lost',
      error: writeError ?? 'Migration claim was replaced before failure could be recorded',
    };
  }
  return {
    status: 'error',
    error: writeError ?? 'Migration claim release compare-and-set affected no row',
  };
}

async function canonicalizeSuccessfulChecksum(
  supabaseUrl: string,
  serviceRoleKey: string,
  filename: string,
  storedChecksum: string,
  canonical: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch(
      historyUrl(supabaseUrl, {
        filename: `eq.${filename}`,
        checksum: `eq.${storedChecksum}`,
        success: 'eq.true',
      }),
      {
        method: 'PATCH',
        headers: historyHeaders(serviceRoleKey, {
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        }),
        body: JSON.stringify({ checksum: canonical }),
      },
    );
    if (res.ok) return { success: true };
    return {
      success: false,
      error: `Checksum canonicalization failed (${res.status}): ${await responseDetails(res)}`,
    };
  } catch (err) {
    return {
      success: false,
      error: `Checksum canonicalization failed: ${String(err)}`,
    };
  }
}

async function recordSuccessfulDuration(
  supabaseUrl: string,
  serviceRoleKey: string,
  filename: string,
  canonical: string,
  durationMs: number,
): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch(
      historyUrl(supabaseUrl, {
        filename: `eq.${filename}`,
        checksum: `eq.${canonical}`,
        success: 'eq.true',
      }),
      {
        method: 'PATCH',
        headers: historyHeaders(serviceRoleKey, {
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        }),
        body: JSON.stringify({
          duration_ms: Math.max(0, Math.trunc(durationMs)),
        }),
      },
    );
    if (res.ok) return { success: true };
    return {
      success: false,
      error: `Migration duration update failed (${res.status}): ${await responseDetails(res)}`,
    };
  } catch (err) {
    return {
      success: false,
      error: `Migration duration update failed: ${String(err)}`,
    };
  }
}

// ── Main Entry Point ────────────────────────────────────────

/**
 * Run all pending migrations with per-file tracking.
 *
 * - Bootstraps schema_migrations table if missing
 * - Checks each .sql file against the tracking table
 * - Skips already-applied files (warns on checksum drift)
 * - Runs pending files in filename order
 * - Records result of each migration
 */
export async function runMigrations(): Promise<MigrationResult> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    log.info('⏭️  Skipping — SUPABASE_URL or SUPABASE_SECRET_KEY not set');
    return { ran: false, applied: [], skipped: [], errors: [], checksumDrift: [] };
  }

  const directTarget = resolvedSessionDatabaseUrl();
  if (directTarget.error) {
    log.error(directTarget.error);
    return {
      ran: false,
      applied: [],
      skipped: [],
      errors: [directTarget.error],
      checksumDrift: [],
    };
  }

  // Bootstrap tracking table
  const bootstrapped = await ensureTrackingTable(supabaseUrl, serviceRoleKey);
  if (!bootstrapped) {
    const error = 'Could not bootstrap migration tracking table; refusing to execute untracked SQL';
    log.error(error);
    return { ran: false, applied: [], skipped: [], errors: [error], checksumDrift: [] };
  }

  // Prove that the selected SQL executor and REST history surface reach the
  // same database before trusting any success row or declaring "up to date".
  const targetBinding = await verifySqlRestTargetBinding(
    supabaseUrl,
    serviceRoleKey,
  );
  if (!targetBinding.success) {
    const error = `${targetBinding.error}; refusing to trust migration history`;
    log.error(error);
    return { ran: false, applied: [], skipped: [], errors: [error], checksumDrift: [] };
  }

  // Load already-applied migrations
  const appliedRead = await getAppliedMigrations(supabaseUrl, serviceRoleKey);
  if (!appliedRead.success) {
    const error = `${appliedRead.error}; refusing to execute SQL without durable history`;
    log.error(error);
    return { ran: false, applied: [], skipped: [], errors: [error], checksumDrift: [] };
  }
  const appliedMap = new Map(appliedRead.rows.map((m) => [m.filename, m]));

  // Find migration files
  let migrationsDir: string;
  try {
    migrationsDir = findMigrationsDir();
  } catch (err) {
    log.error('', { error: String(err) });
    return { ran: false, applied: [], skipped: [], errors: [(err as Error).message], checksumDrift: [] };
  }

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  log.info(`Found ${files.length} migration files, ${appliedMap.size} already applied`);

  const result: MigrationResult = {
    ran: false,
    applied: [],
    skipped: [],
    errors: [],
    checksumDrift: [],
  };

  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), 'utf-8');
    const { canonical: checksum, compatible: compatibleChecksums } =
      checksumEncodings(sql);

    const existing = appliedMap.get(file);

    if (existing?.success) {
      // Already applied — check for checksum drift.
      //
      // Stored checksums are a mix of historical formats: before hashing was
      // content-based, the hash depended on the line endings of whichever
      // checkout applied the migration, so one database can hold CRLF-derived
      // hashes (applied from Windows) next to LF-derived ones (applied from
      // WSL/CI). Normalising the CURRENT side alone therefore flipped the
      // false-positive around: a Windows-recorded history suddenly reported
      // every file as drifted. Seen live: "188 file(s) changed after being
      // applied" on a database nobody had touched.
      //
      // So on mismatch, check whether the stored value is one of the legacy
      // encodings of this exact content. If it is, the file has NOT changed —
      // quietly upgrade the record to the canonical hash so this resolves
      // itself once per database. Only content that matches no encoding of
      // itself is real drift, which keeps the warning meaning what it says.
      if (existing.checksum !== checksum) {
        if (compatibleChecksums.has(existing.checksum)) {
          const historyResult = await canonicalizeSuccessfulChecksum(
            supabaseUrl,
            serviceRoleKey,
            file,
            existing.checksum,
            checksum,
          );
          if (historyResult.success) {
            log.info(`Checksum record upgraded to canonical form: ${file}`);
          } else {
            log.warn(`Could not upgrade checksum record for ${file}: ${historyResult.error}`);
          }
        } else {
          log.warn(`️  Checksum drift: ${file} (applied: ${existing.checksum.slice(0, 8)}… current: ${checksum.slice(0, 8)}…)`);
          result.checksumDrift.push(file);
        }
      }
      result.skipped.push(file);
      continue;
    }

    let plan: MigrationSqlPlan;
    try {
      plan = createMigrationSqlPlan(sql, file);
    } catch (err) {
      const error = `${file}: Migration SQL planning error: ${String(err)}`;
      result.errors.push(error);
      log.error(error);
      break;
    }

    if (existing && !parseClaimToken(existing.checksum) && !compatibleChecksums.has(existing.checksum)) {
      const error = `${file}: Failed migration history checksum does not match current content`;
      result.checksumDrift.push(file);
      result.errors.push(error);
      log.error(error);
      break;
    }

    if (!directTarget.url) {
      const error =
        `${file}: A direct database connection is required for pending migration source execution; `
        + 'set SUPABASE_DB_URL or DATABASE_URL';
      result.errors.push(error);
      log.error(error);
      break;
    }

    const claim = await acquireMigrationClaim(
      supabaseUrl,
      serviceRoleKey,
      file,
      checksum,
      compatibleChecksums,
    );
    if (claim.status === 'success') {
      result.skipped.push(file);
      appliedMap.set(file, { filename: file, checksum, success: true });
      continue;
    }
    if (claim.status === 'drift') {
      const error = `${file}: ${claim.error ?? 'Migration history checksum drift'}`;
      result.checksumDrift.push(file);
      result.errors.push(error);
      log.error(error);
      break;
    }
    if (claim.status !== 'acquired') {
      const error = `${file}: ${claim.error ?? 'Could not acquire migration claim'}`;
      result.errors.push(error);
      log.error(error);
      break;
    }

    if (existing) log.warn(`Retrying previously failed migration: ${file}`);

    // Execute only after the exact owner token is visible. The completion CAS
    // is part of the final SQL transaction/batch, so ordinary migration
    // effects cannot commit without durable success history.
    log.info(`Running ${file}...`);
    result.ran = true;
    const startMs = Date.now();
    const heartbeat = startClaimHeartbeat(
      supabaseUrl,
      serviceRoleKey,
      file,
      claim.token,
      checksum,
    );
    const completionSql = buildMigrationCompletionSql(
      file,
      checksum,
      claim.token,
    );
    const claimProofSql = buildMigrationClaimProofSql(file, claim.token);
    const execResult = await executeSql(
      supabaseUrl,
      serviceRoleKey,
      sql,
      file,
      plan,
      completionSql,
      claimProofSql,
      heartbeat.assertHealthy,
    );
    const durationMs = Date.now() - startMs;
    const heartbeatError = await heartbeat.stop();

    if (execResult.success) {
      result.applied.push(file);
      appliedMap.set(file, { filename: file, checksum, success: true });
      log.info(`${file} (${durationMs}ms)`);
      const durationResult = await recordSuccessfulDuration(
        supabaseUrl,
        serviceRoleKey,
        file,
        checksum,
        durationMs,
      );
      if (!durationResult.success) {
        log.warn(`${file}: ${durationResult.error}`);
      }
      if (heartbeatError) {
        log.warn(`${file}: heartbeat reported before atomic completion: ${heartbeatError}`);
      }
    } else {
      const released = await releaseMigrationClaim(
        supabaseUrl,
        serviceRoleKey,
        file,
        checksum,
        claim.token,
        durationMs,
      );

      // A response can be lost after the final transaction commits. The exact
      // CAS reread distinguishes that from a real execution failure.
      if (released.status === 'success') {
        result.applied.push(file);
        appliedMap.set(file, { filename: file, checksum, success: true });
        log.info(`${file} (${durationMs}ms; success confirmed after ambiguous response)`);
        const durationResult = await recordSuccessfulDuration(
          supabaseUrl,
          serviceRoleKey,
          file,
          checksum,
          durationMs,
        );
        if (!durationResult.success) {
          log.warn(`${file}: ${durationResult.error}`);
        }
        continue;
      }

      const executionError = `${file}: ${execResult.error}`;
      result.errors.push(executionError);
      if (released.status === 'error') {
        result.errors.push(`${file}: ${released.error}`);
      } else if (released.status === 'lost') {
        result.errors.push(`${file}: ${released.error}`);
      }
      if (heartbeatError) {
        result.errors.push(`${file}: ${heartbeatError}`);
      }
      log.error(executionError);
      break; // Stop on first error — migrations are ordered
    }
  }

  if (result.applied.length > 0) {
    log.info(`Applied ${result.applied.length} new migration(s)`);
  } else if (result.errors.length === 0) {
    log.info('Database is up to date');
  }

  if (result.checksumDrift.length > 0) {
    log.warn(`️  ${result.checksumDrift.length} file(s) changed after being applied — review manually`);
  }

  return result;
}
