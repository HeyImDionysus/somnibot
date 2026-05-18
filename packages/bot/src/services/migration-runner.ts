/**
 * Auto-Migration Runner — executes SQL migrations on first boot.
 *
 * Checks if the database has been initialized by looking for the `guild` table.
 * If not found, runs all migrations from packages/supabase/migrations/ in order.
 * Uses the Supabase service role key to execute raw SQL via the REST API.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

interface MigrationResult {
  ran: boolean;
  migrations: string[];
  errors: string[];
}

/**
 * Find the migrations directory relative to the current working directory or known paths.
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
 * Check if the database already has tables (specifically the `guild` table).
 */
async function isDatabaseInitialized(supabaseUrl: string, serviceRoleKey: string): Promise<boolean> {
  const res = await fetch(`${supabaseUrl}/rest/v1/guild?select=id&limit=0`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
  });

  // 200 = table exists (may be empty). 404/4xx = table doesn't exist.
  return res.ok;
}

/**
 * Execute a SQL statement via Supabase's RPC (pg function) or REST SQL endpoint.
 * Uses the /rest/v1/rpc endpoint with a raw SQL wrapper, or the management API.
 * Falls back to splitting by statement if needed.
 */
async function executeSql(
  supabaseUrl: string,
  serviceRoleKey: string,
  sql: string,
  migrationName: string,
): Promise<{ success: boolean; error?: string }> {
  // Use Supabase's PostgREST RPC if a helper function exists, otherwise try the SQL endpoint
  // The most reliable approach: use the pg_net extension or direct SQL execution
  // For Supabase hosted, we can use the management API with the access token,
  // but for simplicity, we'll create an RPC function first, then use it.

  // Strategy: Try executing via Supabase's built-in SQL execution endpoint
  // POST /rest/v1/rpc with a custom function, or use the raw SQL endpoint

  // Supabase exposes a SQL endpoint at /pg/query for the service role
  // Actually, the simplest approach: use fetch to call the Supabase Management API
  // But that requires SUPABASE_ACCESS_TOKEN which we may not have.

  // Best approach for hosted Supabase: create a temporary RPC function
  // Actually, Supabase service role key has full access via PostgREST.
  // The trick is we need to execute DDL, which PostgREST doesn't support directly.

  // Solution: Use the Supabase client library's `rpc` with a PLpgSQL wrapper,
  // or better, use the Supabase Management API's SQL endpoint.

  // For maximum compatibility, let's try the /pg endpoint (Supabase v2+)
  const sqlEndpoint = `${supabaseUrl}/rest/v1/rpc/exec_sql`;

  // First, try to create the exec_sql function if it doesn't exist
  // This is a bootstrap problem. Let's use a different approach.

  // Use Supabase's REST API to check, and the Management API for DDL.
  // Actually, the cleanest solution for self-hosted Supabase or Railway:
  // Just use the DATABASE_URL directly with pg. But we want zero extra deps.

  // Final approach: Use the Supabase client's `from('').rpc()` pattern won't work for DDL.
  // Let's use the fetch-based approach with Supabase's /sql endpoint (if available)
  // or fall back to management API.

  // Try the Supabase Management API SQL endpoint first
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

    if (res.ok) {
      return { success: true };
    }

    const errText = await res.text();
    return { success: false, error: `Management API error (${res.status}): ${errText}` };
  }

  // Fallback: try the database URL directly if available
  const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
  if (dbUrl) {
    try {
      // Dynamic import to avoid hard dependency
      const { default: postgres } = await import('postgres' as string).catch(() => ({ default: null }));
      if (postgres) {
        const sql_client = postgres(dbUrl);
        await sql_client.unsafe(sql);
        await sql_client.end();
        return { success: true };
      }
    } catch (err) {
      return { success: false, error: `Direct DB error: ${err}` };
    }
  }

  // If we have neither, warn and skip
  return {
    success: false,
    error: `No database access method available for DDL execution. Set SUPABASE_ACCESS_TOKEN (+ Supabase project URL) or SUPABASE_DB_URL / DATABASE_URL to enable auto-migration. Migration: ${migrationName}`,
  };
}

/**
 * Extract the Supabase project ref from the URL.
 * e.g., https://YOUR_PROJECT.supabase.co → YOUR_PROJECT_REF
 */
function extractProjectRef(url: string): string | null {
  const match = url.match(/https:\/\/([a-z0-9]+)\.supabase\.co/);
  return match?.[1] ?? null;
}

/**
 * Run all pending migrations.
 *
 * @returns Migration result with list of applied migrations and any errors.
 */
export async function runMigrations(): Promise<MigrationResult> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    console.log('[Migration] ⏭️  Skipping — SUPABASE_URL or SUPABASE_SECRET_KEY not set');
    return { ran: false, migrations: [], errors: [] };
  }

  // Check if database is already initialized
  const initialized = await isDatabaseInitialized(supabaseUrl, serviceRoleKey);
  if (initialized) {
    console.log('[Migration] ✅ Database already initialized — skipping migrations');
    return { ran: false, migrations: [], errors: [] };
  }

  console.log('[Migration] 🔄 Database not initialized — running migrations...');

  let migrationsDir: string;
  try {
    migrationsDir = findMigrationsDir();
  } catch (err) {
    console.error('[Migration] ❌', err);
    return { ran: false, migrations: [], errors: [(err as Error).message] };
  }

  // Get sorted migration files
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  console.log(`[Migration] Found ${files.length} migration files`);

  const applied: string[] = [];
  const errors: string[] = [];

  for (const file of files) {
    console.log(`[Migration] Running ${file}...`);
    const sql = readFileSync(join(migrationsDir, file), 'utf-8');

    const result = await executeSql(supabaseUrl, serviceRoleKey, sql, file);
    if (result.success) {
      applied.push(file);
      console.log(`[Migration] ✅ ${file}`);
    } else {
      errors.push(`${file}: ${result.error}`);
      console.error(`[Migration] ❌ ${file}: ${result.error}`);
      // Don't continue on error — migrations are ordered
      break;
    }
  }

  if (errors.length === 0) {
    console.log(`[Migration] ✅ All ${applied.length} migrations applied successfully`);
  } else {
    console.error(`[Migration] ⚠️ ${applied.length}/${files.length} migrations applied, ${errors.length} errors`);
  }

  return { ran: true, migrations: applied, errors };
}
