/**
 * Supabase admin client for API routes.
 * Uses the service role key for elevated access.
 */
import { createClient } from '@supabase/supabase-js';

export function createAdminSupabase() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '';
  // Prefer the new sb_secret key, fall back to legacy service_role
  const serviceKey = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

  return createClient(supabaseUrl, serviceKey);
}
