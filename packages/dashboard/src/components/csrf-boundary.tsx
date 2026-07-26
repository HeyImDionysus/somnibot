'use client';

/**
 * Installs the global CSRF fetch wrapper for every dashboard page.
 *
 * Mounted once in the root layout so no page ever again depends on remembering
 * to attach the token by hand — see lib/csrf-fetch.ts for why that mattered.
 */
import { useEffect } from 'react';
import { installCsrfFetch } from '@/lib/csrf-fetch';

export function CsrfBoundary() {
  useEffect(() => {
    installCsrfFetch();
  }, []);

  return null;
}
