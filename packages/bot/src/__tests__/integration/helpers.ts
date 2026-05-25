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

/**
 * Check whether Supabase is reachable by querying a core table.
 * Caches the result for the entire test run.
 */
export async function isSupabaseAvailable(): Promise<boolean> {
  if (_connected !== null) return _connected;

  try {
    const client = getTestClient();
    // Simple query against a table that always exists after migrations
    const { error } = await client.from('guild').select('id').limit(1);
    _connected = !error;
  } catch {
    _connected = false;
  }
  return _connected;
}

/**
 * Call in beforeAll — skips the entire suite if Supabase is unreachable.
 * This prevents false failures from Docker Hub rate limits or missing infra.
 */
export async function requireSupabase(): Promise<SupabaseClient> {
  const available = await isSupabaseAvailable();
  if (!available) {
    // Vitest doesn't have suite-level skip, so we throw a descriptive message.
    // The test runner will mark tests as failed but the message is clear.
    console.warn('⚠️  Supabase not reachable — skipping integration tests');
    throw new Error(
      'Supabase local instance is not reachable. ' +
      'This usually means Docker Hub rate-limited the image pull during CI. ' +
      'Re-run the workflow to retry.'
    );
  }
  return getTestClient();
}
