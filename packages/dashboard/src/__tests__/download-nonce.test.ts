/**
 * Tests for the signed-download nonce adapter.
 *
 * Security state must stay in one authoritative Valkey keyspace; this layer
 * may never manufacture a fresh process-local fallback.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/rate-limit', () => ({
  consumeSingleUseValkeyKey: vi.fn(),
}));

import { consumeDownloadNonce } from '@/lib/api/download-nonce';
import { consumeSingleUseValkeyKey } from '@/lib/api/rate-limit';

const consumeAuthoritatively = vi.mocked(consumeSingleUseValkeyKey);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('consumeDownloadNonce', () => {
  it.each(['consumed', 'replay', 'unavailable'] as const)(
    'preserves the authoritative %s result',
    async (result) => {
      consumeAuthoritatively.mockResolvedValueOnce(result);

      await expect(
        consumeDownloadNonce('nonce-1', Math.floor(Date.now() / 1000) + 300),
      ).resolves.toBe(result);
    },
  );

  it('uses a namespaced key and keeps the nonce past the signed URL expiry', async () => {
    const now = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    consumeAuthoritatively.mockResolvedValueOnce('consumed');

    await consumeDownloadNonce('nonce-2', Math.floor(now / 1000) + 300);

    expect(consumeAuthoritatively).toHaveBeenCalledWith(
      'ratelimit:download:nonce:nonce-2',
      330,
    );
    vi.restoreAllMocks();
  });

  it('uses a bounded minimum TTL even for an already-expired input', async () => {
    consumeAuthoritatively.mockResolvedValueOnce('unavailable');

    await consumeDownloadNonce('nonce-3', Math.floor(Date.now() / 1000) - 60);

    expect(consumeAuthoritatively).toHaveBeenCalledWith(
      'ratelimit:download:nonce:nonce-3',
      60,
    );
  });
});
