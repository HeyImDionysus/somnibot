/**
 * CSPRNG utilities for game outcomes and random selection.
 *
 * V7 Audit §4: Centralizes crypto.randomInt() usage for all
 * economy-adjacent features (adventures, fishing, gathering,
 * heist, lottery, pets, quests, trivia) so game outcomes are
 * not predictable from V8's PRNG state.
 *
 * Features that intentionally opt out:
 * - games-manager: documented design decision (virtual-only games)
 * - welcome-card: cosmetic star positions
 * - music-queue: shuffle order (UX, no economic impact)
 */

import { randomInt } from 'node:crypto';

/** Pick a random element from an array using CSPRNG. */
export function randomPick<T>(arr: readonly T[]): T {
  if (arr.length === 0) throw new RangeError('randomPick called on empty array');
  return arr[randomInt(arr.length)]!;
}

/**
 * Return true with the given percentage chance (0–100) using CSPRNG.
 * Resolution: 0.01% (10,000 buckets).
 */
export function randomChance(percentChance: number): boolean {
  const p = typeof percentChance === 'number' && !Number.isNaN(percentChance) ? percentChance : 0;
  return randomInt(10_000) < p * 100;
}

/** Return a random integer in [min, max] (inclusive) using CSPRNG. */
export function randomIntRange(min: number, max: number): number {
  if (min > max) return min;
  return min + randomInt(max - min + 1);
}

/** Return a random float in [0, max) using CSPRNG. Resolution: 1/1,000,000. */
export function randomFloat(max: number): number {
  return (randomInt(1_000_000) / 1_000_000) * max;
}

/**
 * Weighted random selection from an array of { weight, ... } objects.
 * Falls back to last element if rounding causes overshoot.
 */
export function weightedPick<T extends { weight: number }>(entries: readonly T[]): T {
  const totalWeight = entries.reduce((sum, e) => sum + e.weight, 0);
  let roll = randomFloat(totalWeight);
  for (const entry of entries) {
    roll -= entry.weight;
    if (roll <= 0) return entry;
  }
  return entries[entries.length - 1]!;
}

/** Fisher-Yates shuffle using CSPRNG. Returns a new array. */
export function cryptoShuffle<T>(arr: readonly T[]): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}
