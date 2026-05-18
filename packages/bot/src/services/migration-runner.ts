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
import { join, resolve } from 'node:path';

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
 */
function findMigrationsDir(): string {
  const candidates = [
    join(process.cwd(), 'packages', 'supabase', 'migrations'),
    resolve(__dirname, '..', '..', '..', 'supabase', 'migrations'),
    resolve(__dirname, '..', '..', '..', '..', 'packages', 'supabase', 'migrations'),
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

  // Strategy 2: Direct DATABASE_URL via postgres package
  const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
  if (dbUrl) {
    try {
      const { default: postgres } = await import('postgres' as string).catch(() => ({ default: null }));
      if (postgres) {
        const sqlClient = postgres(dbUrl);
        await sqlClient.unsafe(sql);
        await sqlClient.end();
        return { success: true };
      }
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
    console.warn('[Migration] Could not create tracking table:', result.error);
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
    console.log('[Migration] ⏭️  Skipping — SUPABASE_URL or SUPABASE_SECRET_KEY not set');
    return { ran: false, applied: [], skipped: [], errors: [], checksumDrift: [] };
  }

  // Bootstrap tracking table
  const bootstrapped = await ensureTrackingTable(supabaseUrl, serviceRoleKey);
  if (!bootstrapped) {
    console.warn('[Migration] ⚠️  Could not bootstrap tracking table — falling back to legacy check');
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
    console.error('[Migration] ❌', err);
    return { ran: false, applied: [], skipped: [], errors: [(err as Error).message], checksumDrift: [] };
  }

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  console.log(`[Migration] Found ${files.length} migration files, ${appliedMap.size} already applied`);

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
        console.warn(`[Migration] ⚠️  Checksum drift: ${file} (applied: ${existing.checksum.slice(0, 8)}… current: ${checksum.slice(0, 8)}…)`);
        result.checksumDrift.push(file);
      }
      result.skipped.push(file);
      continue;
    }

    // Run this migration
    console.log(`[Migration] Running ${file}...`);
    result.ran = true;
    const startMs = Date.now();

    const execResult = await executeSql(supabaseUrl, serviceRoleKey, sql, file);
    const durationMs = Date.now() - startMs;

    if (execResult.success) {
      result.applied.push(file);
      await recordMigration(supabaseUrl, serviceRoleKey, file, checksum, durationMs, true);
      console.log(`[Migration] ✅ ${file} (${durationMs}ms)`);
    } else {
      result.errors.push(`${file}: ${execResult.error}`);
      await recordMigration(supabaseUrl, serviceRoleKey, file, checksum, durationMs, false);
      console.error(`[Migration] ❌ ${file}: ${execResult.error}`);
      break; // Stop on first error — migrations are ordered
    }
  }

  if (result.applied.length > 0) {
    console.log(`[Migration] ✅ Applied ${result.applied.length} new migration(s)`);
  } else if (result.errors.length === 0) {
    console.log('[Migration] ✅ Database is up to date');
  }

  if (result.checksumDrift.length > 0) {
    console.warn(`[Migration] ⚠️  ${result.checksumDrift.length} file(s) changed after being applied — review manually`);
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
    console.log('[Migration] ✅ Database already initialized (legacy check) — skipping');
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
      console.log(`[Migration] ✅ ${file}`);
    } else {
      result.errors.push(`${file}: ${execResult.error}`);
      console.error(`[Migration] ❌ ${file}: ${execResult.error}`);
      break;
    }
  }

  return result;
}
