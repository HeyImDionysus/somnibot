const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  expiresAt: number;
  value: unknown;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<unknown>>();

/**
 * Short-lived client read cache with in-flight deduplication. Fraud-page tab
 * switches no longer issue duplicate reads, while mutations explicitly
 * invalidate the affected endpoint before reloading.
 */
export async function fetchFraudJson<T>(
  url: string,
  options: { forceFresh?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<T> {
  const now = Date.now();
  if (!options.forceFresh) {
    const hit = cache.get(url);
    if (hit && hit.expiresAt > now) return hit.value as T;
    const pending = inflight.get(url);
    if (pending) return pending as Promise<T>;
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const request = fetchImpl(url, { cache: 'no-store' })
    .then(async (response) => {
      const body = await response.json();
      if (!response.ok) {
        throw new Error(
          typeof body?.error === 'string' ? body.error : `Fraud data request failed (${response.status})`,
        );
      }
      cache.set(url, { value: body, expiresAt: Date.now() + CACHE_TTL_MS });
      return body as T;
    })
    .finally(() => {
      if (inflight.get(url) === request) inflight.delete(url);
    });

  inflight.set(url, request);
  return request;
}

export function invalidateFraudCache(prefix?: string): void {
  if (!prefix) {
    cache.clear();
    inflight.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}
