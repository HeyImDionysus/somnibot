/**
 * Shared helpers for integration tests.
 *
 * Provides a Supabase client and a connection guard that fails the
 * suite when the local Supabase instance isn't reachable — integration
 * tests must run against a real database, never silently pass.
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

  const maxRetries = 10;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const client = getTestClient();
      const { error } = await client.from('guild').select('id').limit(1);
      if (!error) {
        _connected = true;
        return true;
      }
      // Got an error — wait and retry
      if (attempt < maxRetries - 1) await sleep(3000);
    } catch {
      if (attempt < maxRetries - 1) await sleep(3000);
    }
  }

  _connected = false;
  return false;
}

/**
 * Call in beforeAll — fails the entire suite if Supabase is unreachable.
 * Integration tests must run against a real database. If Supabase isn't
 * available, the suite should fail loudly, not silently pass.
 */
export async function requireSupabase(): Promise<SupabaseClient> {
  const available = await isSupabaseAvailable();
  if (!available) {
    throw new Error(
      'Supabase is not reachable at ' + SUPABASE_URL + '. ' +
      'Integration tests require a running Supabase instance. ' +
      'Run "supabase start" in packages/ before running integration tests.'
    );
  }
  return getTestClient();
}
