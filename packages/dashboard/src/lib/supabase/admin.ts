/**
 * Supabase admin client for API routes.
 * Uses the service role key for elevated access.
 *
 * V11 Audit C-2: Cached as a module-level singleton to avoid creating a
 * new client (and new connection) on every API route invocation.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let _adminClient: SupabaseClient | null = null;

export function createAdminSupabase(): SupabaseClient {
  if (_adminClient) return _adminClient;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '';
  // Prefer the new sb_secret key, fall back to legacy service_role
  const serviceKey = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

  _adminClient = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return _adminClient;
}
