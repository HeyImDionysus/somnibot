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

import { createHash } from 'node:crypto';
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
}

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
): Array<{ sql: string; tokens: string[] }> {
  const statements: Array<{ sql: string; tokens: string[] }> = [];
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

function unsupportedTransactionStatement(tokens: string[]): string | null {
  const [first, second] = tokens;

  if (first === 'VACUUM' || first === 'CLUSTER' || first === 'REINDEX' || first === 'CHECKPOINT') {
    return tokens.slice(0, 4).join(' ');
  }
  if (first === 'DISCARD' && second === 'ALL') return 'DISCARD ALL';
  if (first === 'ALTER' && second === 'SYSTEM') return 'ALTER SYSTEM';
  if (first === 'CREATE' && (second === 'DATABASE' || second === 'TABLESPACE' || second === 'SUBSCRIPTION')) {
    return `CREATE ${second}`;
  }
  if (first === 'DROP' && (second === 'DATABASE' || second === 'TABLESPACE' || second === 'SUBSCRIPTION')) {
    return `DROP ${second}`;
  }
  if (first === 'DROP' && second === 'INDEX' && tokens.includes('CONCURRENTLY')) {
    return 'DROP INDEX CONCURRENTLY';
  }
  if (
    first === 'CREATE'
    && (
      second === 'INDEX'
      || (second === 'UNIQUE' && tokens[2] === 'INDEX')
    )
    && tokens.includes('CONCURRENTLY')
  ) {
    return tokens.slice(0, 4).join(' ');
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
 * Preserve the existing one-query implicit transaction for ordinary migration
 * files. Only files containing CREATE INDEX CONCURRENTLY are segmented, with
 * each concurrent index build sent alone and surrounding statements kept in
 * the largest possible transaction batches.
 */
export function planMigrationSql(sql: string): string[] {
  const statements = lexTopLevelSqlStatements(sql);
  const hasConcurrentIndex = statements.some(({ tokens }) => (
    isCreateIndexConcurrently(tokens)
  ));
  const classified = statements.map((statement) => {
    const { tokens } = statement;
    const concurrentIndex = isCreateIndexConcurrently(tokens);
    const unsupported = concurrentIndex ? null : unsupportedTransactionStatement(tokens);
    if (unsupported) {
      throw new Error(`Unsupported transaction-incompatible statement: ${unsupported}`);
    }
    const transactionControl = hasConcurrentIndex
      ? explicitTransactionControlStatement(tokens)
      : null;
    if (transactionControl) {
      throw new Error(
        `Unsupported explicit transaction control in concurrent-index migration: ${transactionControl}`,
      );
    }
    return { ...statement, concurrentIndex, executable: tokens.length > 0 };
  });

  if (!hasConcurrentIndex) {
    return [sql];
  }

  const batches: string[] = [];
  let transactionalBatch = '';
  let transactionalBatchExecutable = false;

  const flushTransactionalBatch = (): void => {
    if (transactionalBatchExecutable) {
      batches.push(transactionalBatch);
    }
    transactionalBatch = '';
    transactionalBatchExecutable = false;
  };

  for (const item of classified) {
    if (item.concurrentIndex) {
      flushTransactionalBatch();
      batches.push(item.sql);
    } else {
      transactionalBatch += item.sql;
      transactionalBatchExecutable ||= item.executable;
    }
  }
  flushTransactionalBatch();

  return batches;
}

// ── SQL Execution ───────────────────────────────────────────

async function executeSql(
  supabaseUrl: string,
  serviceRoleKey: string,
  sql: string,
  migrationName: string,
): Promise<{ success: boolean; error?: string }> {
  let batches: string[];
  try {
    batches = planMigrationSql(sql);
  } catch (err) {
    return { success: false, error: `Migration SQL planning error: ${String(err)}` };
  }

  // Strategy 1: Supabase Management API
  const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
  const projectRef = extractProjectRef(supabaseUrl);

  if (accessToken && projectRef) {
    try {
      for (let index = 0; index < batches.length; index += 1) {
        const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ query: batches[index] }),
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

  // Strategy 2: Direct connection via postgres package + SUPABASE_DB_URL
  const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
  if (dbUrl) {
    try {
      const { default: postgres } = await import('postgres');
      // One backend for every batch preserves session-scoped settings and
      // advisory locks across the ordinary / CIC / ordinary sequence.
      const sqlClient = postgres(dbUrl, { max: 1 });
      try {
        for (const batch of batches) {
          await sqlClient.unsafe(batch);
        }
      } finally {
        await sqlClient.end();
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: `Direct DB error: ${err}` };
    }
  }

  return {
    success: false,
    error: `No database access method available. Set SUPABASE_ACCESS_TOKEN or SUPABASE_DB_URL / DATABASE_URL.`,
  };
}

// ── Tracking Table Bootstrap ────────────────────────────────

const BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
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

async function getAppliedMigrations(
  supabaseUrl: string,
  serviceRoleKey: string,
): Promise<AppliedMigration[]> {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/schema_migrations?select=filename,checksum,success&order=filename.asc`,
    {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
    },
  );

  if (!res.ok) {
    // Table might not exist yet (pre-bootstrap)
    return [];
  }

  return (await res.json()) as AppliedMigration[];
}

// ── Record Migration ────────────────────────────────────────

async function recordMigration(
  supabaseUrl: string,
  serviceRoleKey: string,
  filename: string,
  checksum: string,
  durationMs: number,
  success: boolean,
): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/schema_migrations?on_conflict=filename`, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({ filename, checksum, duration_ms: durationMs, success }),
    });

    if (res.ok) return { success: true };

    const details = await res.text();
    return {
      success: false,
      error: `Migration history upsert failed (${res.status}): ${details}`,
    };
  } catch (err) {
    return { success: false, error: `Migration history upsert failed: ${String(err)}` };
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

  // Bootstrap tracking table
  const bootstrapped = await ensureTrackingTable(supabaseUrl, serviceRoleKey);
  if (!bootstrapped) {
    log.warn('️  Could not bootstrap tracking table — falling back to legacy check');
    return await runLegacyMigrations(supabaseUrl, serviceRoleKey);
  }

  // Load already-applied migrations
  const applied = await getAppliedMigrations(supabaseUrl, serviceRoleKey);
  const appliedMap = new Map(applied.map((m) => [m.filename, m]));

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
    const checksum = sha256(sql);

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
        const legacyHashes = [
          createHash('sha256').update(sql, 'utf-8').digest('hex'),
          createHash('sha256').update(sql.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'), 'utf-8').digest('hex'),
        ];
        if (legacyHashes.includes(existing.checksum)) {
          const historyResult = await recordMigration(
            supabaseUrl,
            serviceRoleKey,
            file,
            checksum,
            0,
            true,
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

    if (existing) {
      log.warn(`Retrying previously failed migration: ${file}`);
    }

    // Run this migration
    log.info(`Running ${file}...`);
    result.ran = true;
    const startMs = Date.now();

    const execResult = await executeSql(supabaseUrl, serviceRoleKey, sql, file);
    const durationMs = Date.now() - startMs;

    if (execResult.success) {
      const historyResult = await recordMigration(
        supabaseUrl,
        serviceRoleKey,
        file,
        checksum,
        durationMs,
        true,
      );
      if (historyResult.success) {
        result.applied.push(file);
        log.info(`${file} (${durationMs}ms)`);
      } else {
        const error = `${file}: migration applied but ${historyResult.error}`;
        result.errors.push(error);
        log.error(error);
        break;
      }
    } else {
      result.errors.push(`${file}: ${execResult.error}`);
      const historyResult = await recordMigration(
        supabaseUrl,
        serviceRoleKey,
        file,
        checksum,
        durationMs,
        false,
      );
      if (!historyResult.success) {
        result.errors.push(`${file}: ${historyResult.error}`);
      }
      log.error(`${file}: ${execResult.error}`);
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

// ── Legacy Fallback ─────────────────────────────────────────

/**
 * Fallback migration runner for when the tracking table can't be created.
 * Checks for guild table existence (original behavior) but runs ALL migrations
 * if the DB appears uninitialized.
 */
async function runLegacyMigrations(
  supabaseUrl: string,
  serviceRoleKey: string,
): Promise<MigrationResult> {
  const res = await fetch(`${supabaseUrl}/rest/v1/guild?select=id&limit=0`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
  });

  if (res.ok) {
    log.info('Database already initialized (legacy check) — skipping');
    return { ran: false, applied: [], skipped: [], errors: [], checksumDrift: [] };
  }

  let migrationsDir: string;
  try {
    migrationsDir = findMigrationsDir();
  } catch (err) {
    return { ran: false, applied: [], skipped: [], errors: [(err as Error).message], checksumDrift: [] };
  }

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const result: MigrationResult = { ran: true, applied: [], skipped: [], errors: [], checksumDrift: [] };

  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), 'utf-8');
    const execResult = await executeSql(supabaseUrl, serviceRoleKey, sql, file);

    if (execResult.success) {
      result.applied.push(file);
      log.info(`${file}`);
    } else {
      result.errors.push(`${file}: ${execResult.error}`);
      log.error(`${file}: ${execResult.error}`);
      break;
    }
  }

  return result;
}
