/**
 * Supabase admin client for API routes.
 * Uses the service role key for elevated access.
 *
 * V11 Audit C-2: Cached as a module-level singleton to avoid creating a
 * new client (and new connection) on every API route invocation.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { requireAdminSupabaseConfig } from './runtime-config';

let _adminClient: SupabaseClient | null = null;

export function createAdminSupabase(): SupabaseClient {
  if (_adminClient) return _adminClient;

  const { url, secretKey } = requireAdminSupabaseConfig();

  _adminClient = createClient(url, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return _adminClient;
}
