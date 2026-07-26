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
 *  - everything else (GETs, cross-origin, explicit tokens) passes through
 *    untouched.
 *
 * Security is unchanged: the token still comes from `/api/csrf` under the
 * session cookie and is still validated server-side. A cross-origin attacker
 * can neither read the token nor trigger this injection.
 */

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const HEADER = 'x-csrf-token';

let cachedToken: string | null = null;
let inflight: Promise<string | null> | null = null;
let installed = false;

async function getToken(baseFetch: typeof fetch, force = false): Promise<string | null> {
  if (cachedToken && !force) return cachedToken;
  if (!inflight) {
    inflight = (async () => {
      try {
        const res = await baseFetch('/api/csrf', { credentials: 'same-origin' });
        if (!res.ok) return null;
        const { token } = (await res.json()) as { token?: string };
        cachedToken = token ?? null;
        return cachedToken;
      } catch {
        return null;
      } finally {
        inflight = null;
      }
    })();
  }
  return inflight;
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof Request !== 'undefined' && input instanceof Request) return input.method.toUpperCase();
  return 'GET';
}

/** Same-origin dashboard API call? (Relative "/api/…" or absolute on this origin.) */
function isOwnApi(input: RequestInfo | URL): boolean {
  const raw = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
  if (raw.startsWith('/api/')) return true;
  try {
    const url = new URL(raw, window.location.origin);
    return url.origin === window.location.origin && url.pathname.startsWith('/api/');
  } catch {
    return false;
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
    if (!MUTATING.has(method) || !isOwnApi(input)) {
      return baseFetch(input, init);
    }

    const existing = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    if (existing.has(HEADER)) {
      // The page manages its own token — do not second-guess it.
      return baseFetch(input, init);
    }

    const send = async (token: string | null): Promise<Response> => {
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      if (token) headers.set(HEADER, token);
      return baseFetch(input, { ...init, headers });
    };

    let res = await send(await getToken(baseFetch));

    if (await isCsrfRejection(res)) {
      // Token expired, rotated, or the middleware rebound the session —
      // refresh once and retry. The middleware's rebind response has already
      // set a fresh cookie, so this retry is expected to succeed.
      cachedToken = null;
      res = await send(await getToken(baseFetch, true));
    }

    return res;
  };
}
