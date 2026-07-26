'use client';

/**
 * Installs the global CSRF fetch wrapper for every dashboard page.
 *
 * Mounted once in the root layout so no page ever again depends on remembering
 * to attach the token by hand — see lib/csrf-fetch.ts for why that mattered.
 */
import { useEffect } from 'react';
import { installCsrfFetch } from '@/lib/csrf-fetch';

// Install at module scope, not just on mount: a click landing in the window
// between hydration starting and the effect running would otherwise go out
// through the native fetch and hard-403. The function is SSR-guarded and
// idempotent, so evaluating this on the server is a no-op and the useEffect
// below is only belt-and-braces.
installCsrfFetch();

export function CsrfBoundary() {
  useEffect(() => {
    installCsrfFetch();
  }, []);

  return null;
}
