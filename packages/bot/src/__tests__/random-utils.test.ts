/**
 * Tests for CSPRNG utility functions (src/utils/random.ts).
 *
 * V8 Audit §4.P3a: Validates centralized CSPRNG helpers used across
 * games, economy, and shuffle features.
 */
import { describe, it, expect } from 'vitest';
import {
  randomPick,
  randomChance,
  randomIntRange,
  randomFloat,
  weightedPick,
  cryptoShuffle,
} from '../utils/random.js';

describe('randomPick', () => {
  it('returns an element from the array', () => {
    const arr = [1, 2, 3, 4, 5];
    const result = randomPick(arr);
    expect(arr).toContain(result);
  });

  it('throws on empty array', () => {
    expect(() => randomPick([])).toThrow('randomPick called on empty array');
  });
});

describe('randomChance', () => {
  it('returns a boolean', () => {
    expect(typeof randomChance(50)).toBe('boolean');
  });

  it('always true at 100%', () => {
    // 100% chance — should always return true
    for (let i = 0; i < 20; i++) {
      expect(randomChance(100)).toBe(true);
    }
  });

  it('always false at 0%', () => {
    for (let i = 0; i < 20; i++) {
      expect(randomChance(0)).toBe(false);
    }
  });

  it('handles NaN gracefully (returns false)', () => {
    expect(randomChance(NaN)).toBe(false);
  });
});

describe('randomIntRange', () => {
  it('returns value within range', () => {
    for (let i = 0; i < 50; i++) {
      const val = randomIntRange(5, 10);
      expect(val).toBeGreaterThanOrEqual(5);
      expect(val).toBeLessThanOrEqual(10);
    }
  });

  it('returns min when min === max', () => {
    expect(randomIntRange(7, 7)).toBe(7);
  });

  it('returns min when min > max', () => {
    expect(randomIntRange(10, 5)).toBe(10);
  });
});

describe('randomFloat', () => {
  it('returns value in [0, max)', () => {
    for (let i = 0; i < 50; i++) {
      const val = randomFloat(10);
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThan(10);
    }
  });
});

describe('weightedPick', () => {
  it('returns an entry from the input', () => {
    const entries = [
      { weight: 1, name: 'a' },
      { weight: 2, name: 'b' },
      { weight: 3, name: 'c' },
    ];
    const result = weightedPick(entries);
    expect(entries).toContain(result);
  });

  it('always picks the only option', () => {
    const entries = [{ weight: 1, name: 'only' }];
    expect(weightedPick(entries).name).toBe('only');
  });
});

describe('cryptoShuffle', () => {
  it('returns array of same length', () => {
    const arr = [1, 2, 3, 4, 5];
    const shuffled = cryptoShuffle(arr);
    expect(shuffled).toHaveLength(5);
  });

  it('contains same elements', () => {
    const arr = [1, 2, 3, 4, 5];
    const shuffled = cryptoShuffle(arr);
    expect(shuffled.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('does not mutate original', () => {
    const arr = [1, 2, 3, 4, 5];
    cryptoShuffle(arr);
    expect(arr).toEqual([1, 2, 3, 4, 5]);
  });

  it('handles empty array', () => {
    expect(cryptoShuffle([])).toEqual([]);
  });

  it('handles single-element array', () => {
    expect(cryptoShuffle([42])).toEqual([42]);
  });

  it('handles large array', () => {
    const arr = Array.from({ length: 100 }, (_, i) => i);
    const shuffled = cryptoShuffle(arr);
    expect(shuffled).toHaveLength(100);
    expect(shuffled.sort((a, b) => a - b)).toEqual(arr);
  });
});

describe('randomChance - statistical sanity', () => {
  it('50% chance is roughly balanced over many trials', () => {
    let trueCount = 0;
    const trials = 200;
    for (let i = 0; i < trials; i++) {
      if (randomChance(50)) trueCount++;
    }
    // Should be somewhere between 20% and 80% — very loose bounds
    expect(trueCount).toBeGreaterThan(trials * 0.2);
    expect(trueCount).toBeLessThan(trials * 0.8);
  });
});

describe('weightedPick - distribution sanity', () => {
  it('heavily weighted item is picked most often', () => {
    const entries = [
      { weight: 100, name: 'heavy' },
      { weight: 1, name: 'light' },
    ];
    let heavyCount = 0;
    for (let i = 0; i < 100; i++) {
      if (weightedPick(entries).name === 'heavy') heavyCount++;
    }
    expect(heavyCount).toBeGreaterThan(80);
  });
});
