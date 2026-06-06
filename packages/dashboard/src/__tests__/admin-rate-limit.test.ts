import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/rate-limit', () => ({ checkRateLimit: vi.fn() }));

import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { checkRateLimit } from '@/lib/api/rate-limit';

const mockedCheckRateLimit = vi.mocked(checkRateLimit);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('checkAdminRateLimit', () => {
  it('allows requests and keys the standard preset by route and forwarded IP', async () => {
    mockedCheckRateLimit.mockResolvedValue({
      limited: false,
      remaining: 59,
      retryAfterMs: 0,
    });

    const response = await checkAdminRateLimit(
      new Request('https://dashboard.test/api/settings', {
        headers: {
          'x-forwarded-for': '203.0.113.7, 198.51.100.2',
        },
      }),
    );

    expect(response).toBeNull();
    expect(mockedCheckRateLimit).toHaveBeenCalledWith(
      'admin:/api/settings:203.0.113.7',
      60,
      60_000,
    );
  });

  it('uses custom route keys and bulk preset limits when returning 429', async () => {
    mockedCheckRateLimit.mockResolvedValue({
      limited: true,
      remaining: 0,
      retryAfterMs: 2_500,
    });

    const response = await checkAdminRateLimit(
      new Request('https://dashboard.test/api/deploy', {
        headers: {
          'x-real-ip': '198.51.100.8',
        },
      }),
      'bulk',
      'deploy',
    );

    expect(mockedCheckRateLimit).toHaveBeenCalledWith(
      'admin:deploy:198.51.100.8',
      10,
      60_000,
    );
    expect(response?.status).toBe(429);
    expect(response?.headers.get('Retry-After')).toBe('3');
    expect(response?.headers.get('X-RateLimit-Remaining')).toBe('0');
    await expect(response?.json()).resolves.toEqual({
      error: 'Too many requests',
      retryAfterMs: 2_500,
    });
  });

  it('falls back to unknown IP and applies write preset limits', async () => {
    mockedCheckRateLimit.mockResolvedValue({
      limited: false,
      remaining: 29,
      retryAfterMs: 0,
    });

    const response = await checkAdminRateLimit(
      new Request('https://dashboard.test/api/music'),
      'write',
    );

    expect(response).toBeNull();
    expect(mockedCheckRateLimit).toHaveBeenCalledWith(
      'admin:/api/music:unknown',
      30,
      60_000,
    );
  });
});
