/**
 * Global CSRF injection for dashboard API calls.
 *
 * The middleware requires an `x-csrf-token` header on every mutating request —
 * correctly. The `useCsrf` hook existed to supply it, but 47 of the 48 pages
 * that mutate state never called it: they did a bare
 * `fetch('/api/…', { method: 'PATCH' })`, the middleware rejected it, and the
 * operator saw "Failed to save settings" on nearly every click, on every page,
 * always. A protection mechanism that each page must remember to opt into is a
 * bug generator; this makes it structural instead.
 *
 * `installCsrfFetch()` wraps `window.fetch` once:
 *  - same-origin `/api/` requests with a mutating method get the token added
 *    (fetched lazily from `/api/csrf`, cached, deduplicated);
 *  - a 403 whose body mentions CSRF refreshes the token and retries ONCE —
 *    this also absorbs the middleware's deliberate session-rebind 403;
 *  - everything else (GETs, cross-origin, explicit tokens, CSRF-exempt
 *    routes) passes through untouched.
 *
 * Security is unchanged: the token still comes from `/api/csrf` under the
 * session cookie and is still validated server-side. A cross-origin attacker
 * can neither read the token nor trigger this injection.
 */

import { CSRF_EXEMPT_PREFIXES } from './csrf-exempt';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const HEADER = 'x-csrf-token';

let cachedToken: string | null = null;
let inflight: Promise<string | null> | null = null;
let installed = false;

function startTokenFetch(baseFetch: typeof fetch): Promise<string | null> {
  // Definite-assignment assertion: the async body only reads fetchPromise
  // after its first await, by which point the assignment below has completed.
  let fetchPromise!: Promise<string | null>;
  fetchPromise = (async () => {
    try {
      const res = await baseFetch('/api/csrf', { credentials: 'same-origin' });
      if (!res.ok) return null;
      const { token } = (await res.json()) as { token?: string };
      const value = token ?? null;
      // Only publish to the cache while still the newest fetch — a force
      // refresh may have superseded this one mid-flight, and a late stale
      // token must not overwrite the fresh one.
      if (inflight === fetchPromise) cachedToken = value;
      return value;
    } catch {
      return null;
    } finally {
      if (inflight === fetchPromise) inflight = null;
    }
  })();
  return fetchPromise;
}

async function getToken(baseFetch: typeof fetch, force = false): Promise<string | null> {
  if (!force) {
    if (cachedToken) return cachedToken;
    if (inflight) return inflight;
  } else {
    // Force exists because the current token was just rejected: neither the
    // cache nor an already-running fetch (which may resolve to that same
    // rejected token) can satisfy it. Drop both and fetch fresh.
    cachedToken = null;
  }
  inflight = startTokenFetch(baseFetch);
  return inflight;
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof Request !== 'undefined' && input instanceof Request) return input.method.toUpperCase();
  return 'GET';
}

/**
 * Pathname of a same-origin dashboard API call (relative "/api/…" or absolute
 * on this origin), or null for anything else. Computed once so the wrapper can
 * both gate on it and match it against the exempt prefixes.
 */
function ownApiPathname(input: RequestInfo | URL): string | null {
  const raw = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
  try {
    const url = new URL(raw, window.location.origin);
    if (url.origin !== window.location.origin) return null;
    return url.pathname.startsWith('/api/') ? url.pathname : null;
  } catch {
    return null;
  }
}

async function isCsrfRejection(res: Response): Promise<boolean> {
  if (res.status !== 403) return false;
  try {
    const body = (await res.clone().json()) as { error?: string };
    return /csrf/i.test(body.error ?? '');
  } catch {
    return false;
  }
}

export function installCsrfFetch(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  const baseFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const method = requestMethod(input, init);
    if (!MUTATING.has(method)) {
      return baseFetch(input, init);
    }
    const pathname = ownApiPathname(input);
    if (pathname === null) {
      return baseFetch(input, init);
    }
    if (CSRF_EXEMPT_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
      // Exempt routes authenticate by other means (webhook signatures, API
      // keys, portal tokens…) and the middleware never CSRF-checks them —
      // skip the token preflight entirely.
      return baseFetch(input, init);
    }

    const requestInput =
      typeof Request !== 'undefined' && input instanceof Request ? input : null;

    const existing = new Headers(init?.headers ?? requestInput?.headers);
    if (existing.has(HEADER)) {
      // The page manages its own token — do not second-guess it.
      return baseFetch(input, init);
    }

    const send = async (token: string | null): Promise<Response> => {
      const headers = new Headers(init?.headers ?? requestInput?.headers);
      if (token) headers.set(HEADER, token);
      // A Request body is a one-shot stream: send a fresh clone per attempt
      // so the 403 retry never re-sends an already-consumed body.
      return baseFetch(requestInput ? requestInput.clone() : input, { ...init, headers });
    };

    let res = await send(await getToken(baseFetch));

    if (await isCsrfRejection(res)) {
      // Token expired, rotated, or the middleware rebound the session —
      // refresh once and retry (force drops the cache and any in-flight
      // fetch). The middleware's rebind response has already set a fresh
      // cookie, so this retry is expected to succeed.
      res = await send(await getToken(baseFetch, true));
    }

    return res;
  };
}
