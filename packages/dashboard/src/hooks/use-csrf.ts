/**
 * useCsrf — Fetch and manage CSRF token for dashboard API calls.
 *
 * V53 Phase 1.8
 *
 * Usage:
 *   const { csrfToken, csrfHeaders } = useCsrf();
 *
 *   // Use with fetch:
 *   fetch('/api/economy/config', {
 *     method: 'POST',
 *     headers: { ...csrfHeaders, 'Content-Type': 'application/json' },
 *     body: JSON.stringify(data),
 *   });
 */
'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';

let cachedToken: string | null = null;
let tokenFetchPromise: Promise<string | null> | null = null;

async function fetchCsrfToken(): Promise<string | null> {
  try {
    const res = await fetch('/api/csrf', { credentials: 'same-origin' });
    if (!res.ok) return null;
    const { token } = await res.json();
    cachedToken = token;
    return token;
  } catch {
    return null;
  }
}

export function useCsrf() {
  const [token, setToken] = useState<string | null>(cachedToken);

  useEffect(() => {
    if (cachedToken) {
      setToken(cachedToken);
      return;
    }

    // Deduplicate concurrent fetches
    if (!tokenFetchPromise) {
      tokenFetchPromise = fetchCsrfToken();
    }

    tokenFetchPromise.then((t) => {
      setToken(t);
      tokenFetchPromise = null;
    });
  }, []);

  const refresh = useCallback(async () => {
    cachedToken = null;
    const t = await fetchCsrfToken();
    setToken(t);
    return t;
  }, []);

  const csrfHeaders = useMemo(() => {
    return token ? { 'X-CSRF-Token': token } : {};
  }, [token]);

  return { csrfToken: token, csrfHeaders, refreshCsrf: refresh };
}

/**
 * Standalone function to get CSRF headers (for non-hook contexts).
 * Will fetch token if not cached.
 */
export async function getCsrfHeaders(): Promise<Record<string, string>> {
  if (!cachedToken) {
    await fetchCsrfToken();
  }
  return cachedToken ? { 'X-CSRF-Token': cachedToken } : {};
}
