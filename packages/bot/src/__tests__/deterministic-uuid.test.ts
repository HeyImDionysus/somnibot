import { describe, expect, it } from 'vitest';
import { deterministicUuidV8 } from '../utils/deterministic-uuid.js';

describe('deterministicUuidV8', () => {
  const namespace = 'somnibot:test-entitlement:v1';

  it('returns the same lowercase RFC UUIDv8 for the same canonical tuple', () => {
    const parts = ['guild-1', 'occurrence-1', '0', 'user-1', 'product-1'];

    const first = deterministicUuidV8(namespace, parts);
    const replay = deterministicUuidV8(namespace, parts);

    expect(replay).toBe(first);
    expect(first).toBe('b4839f30-beeb-887d-bfd0-c9f3ca1de959');
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it.each([
    [['ab', 'c'], ['a', 'bc']],
    [['a:b', 'c'], ['a', 'b:c']],
    [['', 'x'], ['x']],
    [['a', ''], ['a']],
  ] as const)(
    'keeps length-delimited tuples distinct: %j versus %j',
    (left, right) => {
      expect(deterministicUuidV8(namespace, left)).not.toBe(
        deterministicUuidV8(namespace, right),
      );
    },
  );

  it('separates producer and schema versions even when their parts match', () => {
    const parts = ['same', 'parts'];

    expect(deterministicUuidV8('somnibot:automation-entitlement:v1', parts)).not.toBe(
      deterministicUuidV8('somnibot:giveaway-entitlement:v1', parts),
    );
    expect(deterministicUuidV8('somnibot:automation-entitlement:v1', parts)).not.toBe(
      deterministicUuidV8('somnibot:automation-entitlement:v2', parts),
    );
  });

  it('rejects a blank or non-canonical namespace', () => {
    expect(() => deterministicUuidV8('', [])).toThrow(/namespace/i);
    expect(() => deterministicUuidV8(' namespace:v1 ', [])).toThrow(/namespace/i);
  });

  it('rejects non-string tuple parts at the runtime boundary', () => {
    expect(() => deterministicUuidV8(namespace, ['valid', 1] as unknown as string[]))
      .toThrow(/parts/i);
  });
});
