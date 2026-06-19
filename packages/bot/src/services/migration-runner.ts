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

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
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

// ── SQL Execution ───────────────────────────────────────────

async function executeSql(
  supabaseUrl: string,
  serviceRoleKey: string,
  sql: string,
  _migrationName: string,
): Promise<{ success: boolean; error?: string }> {
  // Strategy 1: Supabase Management API
  const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
  const projectRef = extractProjectRef(supabaseUrl);

  if (accessToken && projectRef) {
    const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: sql }),
    });

    if (res.ok) return { success: true };
    const errText = await res.text();
    return { success: false, error: `Management API error (${res.status}): ${errText}` };
  }

  // Strategy 2: Direct connection via postgres package + SUPABASE_DB_URL
  const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
  if (dbUrl) {
    try {
      const { default: postgres } = await import('postgres');
      const sqlClient = postgres(dbUrl);
      await sqlClient.unsafe(sql);
      await sqlClient.end();
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
): Promise<void> {
  await fetch(`${supabaseUrl}/rest/v1/schema_migrations`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({ filename, checksum, duration_ms: durationMs, success }),
  });
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

    if (existing) {
      // Already applied — check for checksum drift
      if (existing.checksum !== checksum) {
        log.warn(`️  Checksum drift: ${file} (applied: ${existing.checksum.slice(0, 8)}… current: ${checksum.slice(0, 8)}…)`);
        result.checksumDrift.push(file);
      }
      result.skipped.push(file);
      continue;
    }

    // Run this migration
    log.info(`Running ${file}...`);
    result.ran = true;
    const startMs = Date.now();

    const execResult = await executeSql(supabaseUrl, serviceRoleKey, sql, file);
    const durationMs = Date.now() - startMs;

    if (execResult.success) {
      result.applied.push(file);
      await recordMigration(supabaseUrl, serviceRoleKey, file, checksum, durationMs, true);
      log.info(`${file} (${durationMs}ms)`);
    } else {
      result.errors.push(`${file}: ${execResult.error}`);
      await recordMigration(supabaseUrl, serviceRoleKey, file, checksum, durationMs, false);
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
