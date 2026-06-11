import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { requireBrowserSupabaseConfig } from './runtime-config';

/**
 * Supabase client for server-side usage (Server Components, Route Handlers).
 * Reads auth cookies from the request.
 */
export async function createServerSupabase() {
  const cookieStore = await cookies();
  const { url, publishableKey } = requireBrowserSupabaseConfig();

  return createServerClient(
    url,
    publishableKey,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options as Parameters<typeof cookieStore.set>[2]),
            );
          } catch {
            // The `setAll` method was called from a Server Component.
            // This can be ignored if you have middleware refreshing sessions.
          }
        },
      },
    },
  );
}
