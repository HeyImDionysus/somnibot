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

/**
 * Well-known local-dev demo JWTs (signed with the Supabase CLI default
 * secret, same issuer/expiry as the service_role key CI uses).
 * Only valid against a local `supabase start` instance — not secrets.
 */
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SUPABASE_AUTHENTICATED_JWT =
  process.env.SUPABASE_AUTHENTICATED_JWT ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImF1dGhlbnRpY2F0ZWQiLCJzdWIiOiIwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDAiLCJleHAiOjE5ODM4MTI5OTZ9.gtnsf1op2LwTIjIxCAXFhdmPR1CndDznrJ-zD8GRGIY';

let _client: SupabaseClient | null = null;
let _anonClient: SupabaseClient | null = null;
let _authenticatedClient: SupabaseClient | null = null;
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
 * Client using the publishable (anon) key — what an unauthenticated
 * browser holds. Used to assert lockdown of sensitive tables.
 */
export function getAnonTestClient(): SupabaseClient {
  if (!_anonClient) {
    _anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return _anonClient;
}

/**
 * Client acting as the `authenticated` Postgres role — what a logged-in
 * dashboard browser session holds. The anon key passes the gateway;
 * the Authorization bearer switches PostgREST to role `authenticated`.
 */
export function getAuthenticatedTestClient(): SupabaseClient {
  if (!_authenticatedClient) {
    _authenticatedClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${SUPABASE_AUTHENTICATED_JWT}` } },
    });
  }
  return _authenticatedClient;
}

/**
 * Direct Postgres connection string for catalog-level assertions
 * (publication membership, role privileges) that PostgREST cannot
 * express. Defaults to the Supabase CLI local-dev database — the same
 * endpoint CI's db-security-audit job queries via psql.
 */
export function getTestDbUrl(): string {
  return (
    process.env.SUPABASE_DB_URL ??
    process.env.DATABASE_URL ??
    'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
  );
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
