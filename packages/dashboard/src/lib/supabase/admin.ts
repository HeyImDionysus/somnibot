/**
 * Supabase admin client for API routes.
 * Uses the service role key for elevated access.
 */
import { createClient } from '@supabase/supabase-js';

export function createAdminSupabase() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '';
  // Use the legacy service_role JWT key — the sb_secret format doesn't grant table access
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY ?? '';

  return createClient(supabaseUrl, serviceKey);
}
