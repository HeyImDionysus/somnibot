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
let _adminClientConfig: { url: string; secretKey: string } | null = null;

export function createAdminSupabase(): SupabaseClient {
  const { url, secretKey } = requireAdminSupabaseConfig();

  if (_adminClient && _adminClientConfig?.url === url && _adminClientConfig.secretKey === secretKey) {
    return _adminClient;
  }

  _adminClient = createClient(url, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  _adminClientConfig = { url, secretKey };
  return _adminClient;
}
