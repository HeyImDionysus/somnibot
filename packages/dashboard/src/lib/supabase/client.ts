import { createBrowserClient } from '@supabase/ssr';
import { requireBrowserSupabaseConfig } from './runtime-config';

/**
 * Supabase client for browser-side usage.
 * Uses the publishable (anon) key — RLS policies enforce access.
 */
export function createClient() {
  const { url, publishableKey } = requireBrowserSupabaseConfig();

  return createBrowserClient(url, publishableKey);
}
