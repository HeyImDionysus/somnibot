import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getConfig } from '../config.js';

let _client: SupabaseClient | null = null;

/**
 * Get the Supabase client (service role — full access).
 * The bot uses the secret key for unrestricted DB access.
 */
export function getSupabase(): SupabaseClient {
  if (_client) return _client;

  const config = getConfig();
  // Use the legacy service_role JWT key — the sb_secret format doesn't grant table access
  _client = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  return _client;
}
