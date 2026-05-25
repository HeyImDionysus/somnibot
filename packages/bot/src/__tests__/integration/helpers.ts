/**
 * Shared helpers for integration tests.
 *
 * Provides a Supabase client and a connection guard that skips tests
 * gracefully when the local Supabase instance isn't reachable (e.g.
 * Docker Hub rate limiting prevented image pull in CI).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

let _client: SupabaseClient | null = null;
let _connected: boolean | null = null;

/** Get a shared Supabase client for integration tests. */
export function getTestClient(): SupabaseClient {
  if (!_client) {
    _client = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return _client;
}

/** Small helper to sleep for ms milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Check whether Supabase is reachable by querying a core table.
 * Retries a few times with back-off to handle slow CI startup.
 * Caches the result for the entire test run.
 */
export async function isSupabaseAvailable(): Promise<boolean> {
  if (_connected !== null) return _connected;

  const maxRetries = 5;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const client = getTestClient();
      const { error } = await client.from('guild').select('id').limit(1);
      if (!error) {
        _connected = true;
        return true;
      }
      // Got an error — wait and retry
      if (attempt < maxRetries - 1) await sleep(2000);
    } catch {
      if (attempt < maxRetries - 1) await sleep(2000);
    }
  }

  _connected = false;
  return false;
}

/**
 * Call in beforeAll — skips the entire suite if Supabase is unreachable.
 * Returns the client if available, or null if not.
 * When null is returned, tests should be skipped (not failed).
 */
export async function requireSupabase(): Promise<SupabaseClient | null> {
  const available = await isSupabaseAvailable();
  if (!available) {
    console.warn('⚠️  Supabase not reachable — integration tests will be skipped');
    return null;
  }
  return getTestClient();
}
