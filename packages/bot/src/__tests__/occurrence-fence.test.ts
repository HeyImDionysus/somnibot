/**
 * Occurrence fence — "has this exact event already been handled?"
 *
 * Four separate fences answered this question with three DIFFERENT behaviours
 * when the cache was unavailable: message-log used an in-memory Map, automod
 * failed OPEN (processing twice during a Valkey outage), games failed SAFE
 * (refusing the action), and gathering had no fallback at all. Which one a
 * feature got was an accident of when it was written.
 *
 * The consolidated fence makes that choice explicit and required, because it
 * genuinely differs by caller:
 *   * money/grants → fail SAFE (paying twice is a real loss)
 *   * logging/mirroring → fail OPEN (losing the only record is worse than noise)
 *
 * These tests pin both policies, and the fallback's bounds.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  claimOccurrence,
  releaseOccurrence,
  resetOccurrenceFenceForTests,
} from '../utils/occurrence-fence.js';

/** Valkey stub with a real SET NX PX so claims genuinely compete. */
function makeValkey(opts: { throws?: boolean } = {}) {
  const store = new Map<string, number>();
  const set = vi.fn(async (key: string, _v: string, _px: string, ttl: number, nx: string) => {
    if (opts.throws) throw new Error('ECONNREFUSED');
    const now = Date.now();
    const existing = store.get(key);
    if (nx === 'NX' && existing !== undefined && existing > now) return null;
    store.set(key, now + ttl);
    return 'OK';
  });
  const del = vi.fn(async (key: string) => {
    if (opts.throws) throw new Error('ECONNREFUSED');
    store.delete(key);
    return 1;
  });
  return { valkey: { set, del } as never, set, del, store };
}

const MONEY = { onUnavailable: 'decline' } as const;
const LOGGING = { onUnavailable: 'proceed' } as const;

beforeEach(() => {
  resetOccurrenceFenceForTests();
  vi.clearAllMocks();
});

describe('with the cache available', () => {
  it('claims a first-seen occurrence', async () => {
    const { valkey } = makeValkey();
    await expect(claimOccurrence(valkey, 'k1', MONEY)).resolves.toBe('claimed');
  });

  it('reports a redelivery of the same occurrence as a replay', async () => {
    const { valkey } = makeValkey();
    await claimOccurrence(valkey, 'k1', MONEY);
    await expect(claimOccurrence(valkey, 'k1', MONEY)).resolves.toBe('replay');
  });

  it('does not confuse two different occurrences', async () => {
    const { valkey } = makeValkey();
    await claimOccurrence(valkey, 'interaction-a', MONEY);
    // Keying on the ACTOR rather than the occurrence would fence this out.
    await expect(claimOccurrence(valkey, 'interaction-b', MONEY)).resolves.toBe('claimed');
  });

  it('only one of two simultaneous claims wins', async () => {
    const { valkey } = makeValkey();
    const [a, b] = await Promise.all([
      claimOccurrence(valkey, 'race', MONEY),
      claimOccurrence(valkey, 'race', MONEY),
    ]);
    expect([a, b].filter((r) => r === 'claimed')).toHaveLength(1);
    expect([a, b].filter((r) => r === 'replay')).toHaveLength(1);
  });

  it('uses the requested TTL', async () => {
    const { valkey, set } = makeValkey();
    await claimOccurrence(valkey, 'k1', { ...MONEY, ttlMs: 5_000 });
    expect(set).toHaveBeenCalledWith('k1', '1', 'PX', 5_000, 'NX');
  });
});

describe('when the cache is unavailable', () => {
  it('a money path DECLINES rather than risk paying twice', async () => {
    const { valkey } = makeValkey({ throws: true });

    // First call: nothing has claimed it, but the fence cannot be trusted, so a
    // payout path must not proceed on an unverifiable claim.
    await expect(claimOccurrence(valkey, 'pay-1', MONEY)).resolves.toBe('replay');
  });

  it('a logging path PROCEEDS rather than lose the only record', async () => {
    const { valkey } = makeValkey({ throws: true });
    await expect(claimOccurrence(valkey, 'log-1', LOGGING)).resolves.toBe('no-fence');
  });

  it('still catches an immediate redelivery via the in-process fallback', async () => {
    const { valkey } = makeValkey({ throws: true });

    // Even with Valkey down, the common case — the same event arriving twice
    // seconds apart in one process — is still deduplicated.
    await claimOccurrence(valkey, 'log-2', LOGGING);
    await expect(claimOccurrence(valkey, 'log-2', LOGGING)).resolves.toBe('replay');
  });

  it('treats a missing cache handle the same way', async () => {
    await expect(claimOccurrence(null, 'no-cache-1', LOGGING)).resolves.toBe('no-fence');
    await expect(claimOccurrence(null, 'no-cache-1', LOGGING)).resolves.toBe('replay');
  });
});

describe('release', () => {
  it('lets a genuinely failed attempt be retried instead of fenced out', async () => {
    const { valkey } = makeValkey();

    expect(await claimOccurrence(valkey, 'retry-1', MONEY)).toBe('claimed');
    // The caller's work failed — release so the retry is not treated as a replay.
    await releaseOccurrence(valkey, 'retry-1');
    expect(await claimOccurrence(valkey, 'retry-1', MONEY)).toBe('claimed');
  });

  it('never throws when the cache is down', async () => {
    const { valkey } = makeValkey({ throws: true });
    await expect(releaseOccurrence(valkey, 'k')).resolves.toBeUndefined();
  });
});
