import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/rate-limit', () => ({ checkRateLimit: vi.fn() }));

import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { resetClientIpWarnings, TRUSTED_PROXY_HOPS_ENV } from '@/lib/api/client-ip';

const mockedCheckRateLimit = vi.mocked(checkRateLimit);

/** Bucket key `checkAdminRateLimit` passed to the limiter on its last call. */
function lastBucketKey(): string {
  const call = mockedCheckRateLimit.mock.calls.at(-1);
  return String(call?.[0]);
}

function allow() {
  mockedCheckRateLimit.mockResolvedValue({ limited: false, remaining: 59, retryAfterMs: 0 });
}

const originalHops = process.env[TRUSTED_PROXY_HOPS_ENV];

beforeEach(() => {
  vi.resetAllMocks();
  resetClientIpWarnings();
  // Production Compose explicitly opts into the shipped Caddy's canonical
  // single-entry X-Forwarded-For contract.
  process.env[TRUSTED_PROXY_HOPS_ENV] = '1';
});

afterEach(() => {
  if (originalHops === undefined) delete process.env[TRUSTED_PROXY_HOPS_ENV];
  else process.env[TRUSTED_PROXY_HOPS_ENV] = originalHops;
});

describe('checkAdminRateLimit', () => {
  it('allows requests and keys the standard preset by route and client IP', async () => {
    allow();

    const response = await checkAdminRateLimit(
      new Request('https://dashboard.test/api/settings', {
        // The shipped Caddy overwrites X-Forwarded-For with one canonical client
        // address after applying its trusted-proxy policy.
        headers: { 'x-forwarded-for': '198.51.100.2' },
      }),
    );

    expect(response).toBeNull();
    expect(mockedCheckRateLimit).toHaveBeenCalledWith(
      'admin:/api/settings:198.51.100.2',
      60,
      60_000,
    );
  });

  it('uses custom route keys and bulk preset limits when returning 429', async () => {
    mockedCheckRateLimit.mockResolvedValue({ limited: true, remaining: 0, retryAfterMs: 2_500 });

    const response = await checkAdminRateLimit(
      new Request('https://dashboard.test/api/deploy', {
        headers: { 'x-forwarded-for': '198.51.100.8' },
      }),
      'bulk',
      'deploy',
    );

    expect(mockedCheckRateLimit).toHaveBeenCalledWith('admin:deploy:198.51.100.8', 10, 60_000);
    expect(response?.status).toBe(429);
    expect(response?.headers.get('Retry-After')).toBe('3');
    expect(response?.headers.get('X-RateLimit-Remaining')).toBe('0');
    await expect(response?.json()).resolves.toEqual({
      error: 'Too many requests',
      retryAfterMs: 2_500,
    });
  });

  it('falls back to unknown IP and applies write preset limits', async () => {
    mockedCheckRateLimit.mockResolvedValue({ limited: false, remaining: 29, retryAfterMs: 0 });

    const response = await checkAdminRateLimit(
      new Request('https://dashboard.test/api/music'),
      'write',
    );

    expect(response).toBeNull();
    expect(mockedCheckRateLimit).toHaveBeenCalledWith('admin:/api/music:unknown', 30, 60_000);
  });
});

/**
 * These pin the bypass this helper exists to close.
 *
 * `checkAdminRateLimit` guards EVERY admin route, so before the fix a single
 * forged header defeated rate limiting across the entire admin surface. The
 * previous version of this file asserted the opposite of the tests below — it
 * expected the leading X-Forwarded-For entry and honoured `x-real-ip` — so the
 * suite was pinning the vulnerable behaviour in place.
 */
describe('checkAdminRateLimit — X-Forwarded-For spoofing', () => {
  it('ignores a forged leading entry, so rotating it cannot win a fresh bucket', async () => {
    allow();

    const buckets = new Set<string>();
    for (const forged of ['1.1.1.1', '2.2.2.2', '3.3.3.3', '4.4.4.4']) {
      await checkAdminRateLimit(
        new Request('https://dashboard.test/api/settings', {
          // Same real caller each time; only the attacker-controlled prefix moves.
          headers: { 'x-forwarded-for': `${forged}, 198.51.100.2` },
        }),
      );
      buckets.add(lastBucketKey());
    }

    // One bucket across four forged values — the limit actually accumulates.
    expect(buckets.size, 'a rotating forged prefix must not split the bucket').toBe(1);
    expect([...buckets][0]).toBe('admin:/api/settings:198.51.100.2');
  });

  it('does not honour x-real-ip, which a client can also supply', async () => {
    allow();

    await checkAdminRateLimit(
      new Request('https://dashboard.test/api/deploy', {
        headers: { 'x-real-ip': '203.0.113.9' },
      }),
    );

    // Caddy does not set x-real-ip, so trusting it would leave the bypass open
    // in the deployment actually shipped. No trustworthy address -> shared bucket.
    expect(lastBucketKey()).toBe('admin:/api/deploy:unknown');
    expect(lastBucketKey()).not.toContain('203.0.113.9');
  });

  it('honours a deeper proxy chain when the deployment declares one', async () => {
    process.env[TRUSTED_PROXY_HOPS_ENV] = '2';
    allow();

    await checkAdminRateLimit(
      new Request('https://dashboard.test/api/settings', {
        // forged prefix, real client, CDN edge — two trusted hops select client.
        headers: { 'x-forwarded-for': '203.0.113.7, 198.51.100.2, 10.0.0.5' },
      }),
    );

    expect(lastBucketKey()).toBe('admin:/api/settings:198.51.100.2');
  });

  it('fails closed when a declared multi-proxy chain is too short', async () => {
    process.env[TRUSTED_PROXY_HOPS_ENV] = '2';
    allow();

    await checkAdminRateLimit(
      new Request('https://dashboard.test/api/settings', {
        headers: { 'x-forwarded-for': '203.0.113.7' },
      }),
    );

    expect(lastBucketKey()).toBe('admin:/api/settings:unknown');
  });

  it('accepts the canonical single-entry header emitted by shipped Caddy', async () => {
    allow();

    await checkAdminRateLimit(
      new Request('https://dashboard.test/api/settings', {
        headers: { 'x-forwarded-for': '203.0.113.7' },
      }),
    );

    expect(lastBucketKey()).toBe('admin:/api/settings:203.0.113.7');
  });
});
