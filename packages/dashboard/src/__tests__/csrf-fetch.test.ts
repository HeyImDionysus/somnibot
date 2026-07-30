/**
 * Tests for the global CSRF fetch wrapper (lib/csrf-fetch.ts).
 *
 * Covers the P2 batch fixes:
 * - A1: mutations to CSRF-exempt prefixes pass through with no token preflight;
 * - A2: Request-typed inputs are cloned per attempt so the 403 retry never
 *   re-sends an already-consumed body;
 * - A2-bonus: a force refresh never reuses a stale in-flight token fetch.
 */
import { describe, it, expect, vi, afterEach, type Mock } from 'vitest';
import { CSRF_EXEMPT_PREFIXES } from '@/lib/csrf-exempt';

const ORIGIN = 'https://dash.example.com';
const HEADER = 'x-csrf-token';

type WrappedFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Drain microtasks + one macrotask so promise chains between steps settle. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * The module keeps `installed`/token state at module scope, so every test gets
 * a fresh module registry plus a fake `window` carrying the base fetch mock.
 */
async function install(baseFetch: Mock): Promise<WrappedFetch> {
  vi.resetModules();
  (globalThis as { window?: unknown }).window = {
    location: { origin: ORIGIN },
    fetch: baseFetch,
  };
  const { installCsrfFetch } = await import('@/lib/csrf-fetch');
  installCsrfFetch();
  const win = (globalThis as { window?: { fetch: WrappedFetch } }).window!;
  expect(win.fetch).not.toBe(baseFetch); // wrapper actually installed
  return (input, init) => win.fetch(input, init);
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('csrf-fetch exempt-prefix passthrough (A1)', () => {
  it('passes mutations to every exempt prefix through untouched — no preflight, no header injection', async () => {
    const baseFetch = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => json({ ok: true }));
    const wrapped = await install(baseFetch);

    const paths = CSRF_EXEMPT_PREFIXES.map((prefix) =>
      prefix.endsWith('/') ? `${prefix}callback` : prefix,
    );
    for (const path of paths) {
      const init = { method: 'POST', body: 'payload' };
      await wrapped(path, init);
      const [input, passedInit] = baseFetch.mock.calls.at(-1)!;
      expect(input).toBe(path);
      expect(passedInit).toBe(init); // identity — wrapper did not rebuild init
    }

    // Exactly one base call per exempt mutation: no /api/csrf preflights.
    expect(baseFetch).toHaveBeenCalledTimes(paths.length);
  });

  it('still injects the token for non-exempt mutations (sanity contrast)', async () => {
    const baseFetch = vi.fn(async (
      input: RequestInfo | URL,
      _init?: RequestInit,
    ) => {
      if (String(input).includes('/api/csrf')) return json({ token: 'tok-1' });
      return json({ ok: true });
    });
    const wrapped = await install(baseFetch);

    await wrapped('/api/guild', { method: 'PATCH', body: '{}' });

    expect(baseFetch).toHaveBeenCalledTimes(2);
    expect(String(baseFetch.mock.calls[0][0])).toBe('/api/csrf');
    const init = baseFetch.mock.calls[1][1] as RequestInit;
    expect(new Headers(init.headers).get(HEADER)).toBe('tok-1');
  });
});

describe('csrf-fetch Request-body cloning (A2)', () => {
  it('re-sends a Request body on the CSRF retry by cloning per attempt', async () => {
    const seenBodies: string[] = [];
    const seenTokens: (string | null)[] = [];
    const tokens = ['tok-1', 'tok-2'];
    const baseFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof input === 'string' && input.includes('/api/csrf')) {
        return json({ token: tokens.shift() });
      }
      // Consume the body — proves each attempt arrives with a readable stream.
      seenBodies.push(await (input as Request).text());
      seenTokens.push(new Headers(init?.headers).get(HEADER));
      return seenBodies.length === 1 ? json({ error: 'Invalid CSRF token' }, 403) : json({ ok: true });
    });
    const wrapped = await install(baseFetch);

    const request = new Request(`${ORIGIN}/api/economy/trivia`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'q' }),
    });
    const res = await wrapped(request);

    expect(res.status).toBe(200);
    expect(seenBodies).toEqual(['{"question":"q"}', '{"question":"q"}']);
    expect(seenTokens).toEqual(['tok-1', 'tok-2']);
    // The caller's original Request was never consumed — only clones were sent.
    expect(request.bodyUsed).toBe(false);
  });
});

describe('csrf-fetch force token refresh (A2-bonus)', () => {
  it('refreshes the token after a CSRF 403 instead of reusing the cache', async () => {
    const tokens = ['tok-old', 'tok-new'];
    const postTokens: (string | null)[] = [];
    const baseFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/api/csrf')) return json({ token: tokens.shift() });
      const token = new Headers(init?.headers).get(HEADER);
      postTokens.push(token);
      return token === 'tok-new' ? json({ ok: true }) : json({ error: 'Invalid CSRF token' }, 403);
    });
    const wrapped = await install(baseFetch);

    const res = await wrapped('/api/guild', { method: 'POST', body: '{}' });

    expect(res.status).toBe(200);
    expect(postTokens).toEqual(['tok-old', 'tok-new']);
    const csrfCalls = baseFetch.mock.calls.filter(([i]) => String(i).includes('/api/csrf'));
    expect(csrfCalls).toHaveLength(2);
  });

  it('force refresh starts a fresh fetch instead of adopting a stale in-flight one', async () => {
    const csrfResolvers: Array<(token: string) => void> = [];
    const postResolvers: Array<(res: Response) => void> = [];
    const postTokens: (string | null)[] = [];
    const baseFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (String(input).includes('/api/csrf')) {
        return new Promise((resolve) => {
          csrfResolvers.push((token) => resolve(json({ token })));
        });
      }
      postTokens.push(new Headers(init?.headers).get(HEADER));
      return new Promise((resolve) => {
        postResolvers.push(resolve);
      });
    });
    const wrapped = await install(baseFetch);

    // Mutations A and B start concurrently: A begins token fetch #1, B joins it.
    const a = wrapped('/api/guild', { method: 'POST' });
    const b = wrapped('/api/guild', { method: 'POST' });
    await tick();
    expect(csrfResolvers).toHaveLength(1);

    // Fetch #1 resolves — both mutations POST with the (soon-stale) token.
    csrfResolvers[0]('tok-stale');
    await tick();
    expect(postTokens).toEqual(['tok-stale', 'tok-stale']);

    // A's POST 403s; its force refresh starts token fetch #2. Leave #2 pending:
    // this is exactly the in-flight promise a buggy force path would hand out.
    postResolvers[0](json({ error: 'Invalid CSRF token' }, 403));
    await tick();
    expect(csrfResolvers).toHaveLength(2);

    // B's POST 403s while #2 is still pending — its force refresh must start
    // fetch #3 rather than adopt #2.
    postResolvers[1](json({ error: 'Invalid CSRF token' }, 403));
    await tick();
    expect(csrfResolvers).toHaveLength(3);

    // Each retry carries the token from its own fetch.
    csrfResolvers[1]('tok-a-retry');
    csrfResolvers[2]('tok-b-retry');
    await tick();
    expect(postTokens.slice(2)).toEqual(['tok-a-retry', 'tok-b-retry']);

    postResolvers[2](json({ ok: true }));
    postResolvers[3](json({ ok: true }));
    const [resA, resB] = await Promise.all([a, b]);
    expect(resA.ok).toBe(true);
    expect(resB.ok).toBe(true);
  });
});
