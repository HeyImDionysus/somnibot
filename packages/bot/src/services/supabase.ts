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
  _client = createClient(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  return _client;
}
