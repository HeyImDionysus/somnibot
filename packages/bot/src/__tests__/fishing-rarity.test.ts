/**
 * Fishing Rarity & Catch Logic — Unit Tests
 *
 * Tests weighted random selection, fish pricing, and rarity distributions.
 */
import { describe, it, expect } from 'vitest';

// ── Inline types and constants (from fishing-manager.ts) ───

type FishRarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';

interface FishSpecies {
  id: string;
  name: string;
  emoji: string;
  rarity: FishRarity;
  min_weight: number;
  max_weight: number;
  base_price: number;
}

const RARITY_WEIGHTS: Record<FishRarity, number> = {
  common: 50,
  uncommon: 30,
  rare: 15,
  epic: 4,
  legendary: 1,
};

const RARITY_COLORS: Record<FishRarity, number> = {
  common: 0x95a5a6,
  uncommon: 0x2ecc71,
  rare: 0x3498db,
  epic: 0x9b59b6,
  legendary: 0xf1c40f,
};

const BAIT_RARITY_BOOST: Record<string, Partial<Record<FishRarity, number>>> = {
  worm: { common: -10, uncommon: 5, rare: 5 },
  shrimp: { uncommon: -10, rare: 5, epic: 5 },
  golden_lure: { common: -30, rare: 10, epic: 10, legendary: 10 },
};

const DEFAULT_SPECIES: Omit<FishSpecies, 'id'>[] = [
  { name: 'Sardine', emoji: '🐟', rarity: 'common', min_weight: 0.1, max_weight: 0.5, base_price: 5 },
  { name: 'Bass', emoji: '🐟', rarity: 'common', min_weight: 1.0, max_weight: 4.0, base_price: 15 },
  { name: 'Trout', emoji: '🐟', rarity: 'common', min_weight: 0.5, max_weight: 3.0, base_price: 12 },
  { name: 'Salmon', emoji: '🐠', rarity: 'uncommon', min_weight: 2.0, max_weight: 8.0, base_price: 30 },
  { name: 'Catfish', emoji: '🐠', rarity: 'uncommon', min_weight: 3.0, max_weight: 12.0, base_price: 35 },
  { name: 'Tuna', emoji: '🐠', rarity: 'uncommon', min_weight: 5.0, max_weight: 20.0, base_price: 50 },
  { name: 'Swordfish', emoji: '🐡', rarity: 'rare', min_weight: 20.0, max_weight: 80.0, base_price: 120 },
  { name: 'Octopus', emoji: '🐙', rarity: 'rare', min_weight: 5.0, max_weight: 25.0, base_price: 100 },
  { name: 'Electric Eel', emoji: '🐍', rarity: 'epic', min_weight: 10.0, max_weight: 40.0, base_price: 300 },
  { name: 'Giant Squid', emoji: '🦑', rarity: 'epic', min_weight: 50.0, max_weight: 200.0, base_price: 500 },
  { name: 'Golden Koi', emoji: '✨', rarity: 'legendary', min_weight: 2.0, max_weight: 10.0, base_price: 1000 },
  { name: 'Leviathan Fry', emoji: '🐉', rarity: 'legendary', min_weight: 0.5, max_weight: 5.0, base_price: 2000 },
];

// ── Inline: weighted random selection ──────────────────────

function selectRarity(weights: Record<FishRarity, number>): FishRarity {
  const total = Object.values(weights).reduce((a, b) => a + Math.max(0, b), 0);
  let roll = Math.random() * total;
  for (const [rarity, weight] of Object.entries(weights) as [FishRarity, number][]) {
    const w = Math.max(0, weight);
    roll -= w;
    if (roll <= 0) return rarity;
  }
  return 'common'; // fallback
}

function applyBaitBoost(
  baseWeights: Record<FishRarity, number>,
  bait: string | null,
): Record<FishRarity, number> {
  if (!bait || !BAIT_RARITY_BOOST[bait]) return { ...baseWeights };
  const boost = BAIT_RARITY_BOOST[bait]!;
  const result = { ...baseWeights };
  for (const [rarity, delta] of Object.entries(boost) as [FishRarity, number][]) {
    result[rarity] = Math.max(0, (result[rarity] ?? 0) + delta);
  }
  return result;
}

function calculateFishPrice(basePrice: number, weight: number, minWeight: number, maxWeight: number): number {
  const weightRange = maxWeight - minWeight;
  const weightFactor = weightRange > 0 ? (weight - minWeight) / weightRange : 0.5;
  return Math.floor(basePrice * (0.5 + weightFactor));
}

// ════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════

describe('RARITY_WEIGHTS', () => {
  it('total weight sums to 100', () => {
    const total = Object.values(RARITY_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBe(100);
  });

  it('common has highest weight', () => {
    expect(RARITY_WEIGHTS.common).toBeGreaterThan(RARITY_WEIGHTS.uncommon);
    expect(RARITY_WEIGHTS.uncommon).toBeGreaterThan(RARITY_WEIGHTS.rare);
    expect(RARITY_WEIGHTS.rare).toBeGreaterThan(RARITY_WEIGHTS.epic);
    expect(RARITY_WEIGHTS.epic).toBeGreaterThan(RARITY_WEIGHTS.legendary);
  });
});

describe('DEFAULT_SPECIES', () => {
  it('has 12 species', () => {
    expect(DEFAULT_SPECIES).toHaveLength(12);
  });

  it('has species for every rarity', () => {
    const rarities = new Set(DEFAULT_SPECIES.map(s => s.rarity));
    expect(rarities.has('common')).toBe(true);
    expect(rarities.has('uncommon')).toBe(true);
    expect(rarities.has('rare')).toBe(true);
    expect(rarities.has('epic')).toBe(true);
    expect(rarities.has('legendary')).toBe(true);
  });

  it('has positive prices for all species', () => {
    for (const s of DEFAULT_SPECIES) {
      expect(s.base_price).toBeGreaterThan(0);
    }
  });

  it('has valid weight ranges (min < max)', () => {
    for (const s of DEFAULT_SPECIES) {
      expect(s.min_weight).toBeLessThan(s.max_weight);
    }
  });

  it('rarer fish have higher base prices', () => {
    const avgByRarity = (rarity: FishRarity) => {
      const species = DEFAULT_SPECIES.filter(s => s.rarity === rarity);
      return species.reduce((sum, s) => sum + s.base_price, 0) / species.length;
    };
    expect(avgByRarity('uncommon')).toBeGreaterThan(avgByRarity('common'));
    expect(avgByRarity('rare')).toBeGreaterThan(avgByRarity('uncommon'));
    expect(avgByRarity('epic')).toBeGreaterThan(avgByRarity('rare'));
    expect(avgByRarity('legendary')).toBeGreaterThan(avgByRarity('epic'));
  });
});

describe('selectRarity', () => {
  it('returns a valid rarity', () => {
    for (let i = 0; i < 100; i++) {
      const rarity = selectRarity(RARITY_WEIGHTS);
      expect(['common', 'uncommon', 'rare', 'epic', 'legendary']).toContain(rarity);
    }
  });

  it('heavily favors common over legendary', () => {
    const counts: Record<string, number> = { common: 0, legendary: 0 };
    for (let i = 0; i < 10000; i++) {
      const r = selectRarity(RARITY_WEIGHTS);
      if (r in counts) counts[r]++;
    }
    expect(counts.common).toBeGreaterThan(counts.legendary * 10);
  });
});

describe('applyBaitBoost', () => {
  it('returns base weights when no bait', () => {
    const result = applyBaitBoost(RARITY_WEIGHTS, null);
    expect(result).toEqual(RARITY_WEIGHTS);
  });

  it('worm boosts uncommon and rare at expense of common', () => {
    const result = applyBaitBoost(RARITY_WEIGHTS, 'worm');
    expect(result.common).toBe(RARITY_WEIGHTS.common - 10);
    expect(result.uncommon).toBe(RARITY_WEIGHTS.uncommon + 5);
    expect(result.rare).toBe(RARITY_WEIGHTS.rare + 5);
  });

  it('golden_lure dramatically shifts odds', () => {
    const result = applyBaitBoost(RARITY_WEIGHTS, 'golden_lure');
    expect(result.common).toBe(RARITY_WEIGHTS.common - 30); // 20
    expect(result.legendary).toBe(RARITY_WEIGHTS.legendary + 10); // 11
  });

  it('never goes below 0', () => {
    // Force a scenario where boost would go negative
    const lowWeights: Record<FishRarity, number> = {
      common: 5,
      uncommon: 5,
      rare: 5,
      epic: 5,
      legendary: 5,
    };
    const result = applyBaitBoost(lowWeights, 'golden_lure');
    for (const val of Object.values(result)) {
      expect(val).toBeGreaterThanOrEqual(0);
    }
  });

  it('returns copy (does not mutate input)', () => {
    const original = { ...RARITY_WEIGHTS };
    applyBaitBoost(RARITY_WEIGHTS, 'worm');
    expect(RARITY_WEIGHTS).toEqual(original);
  });

  it('ignores unknown bait types', () => {
    const result = applyBaitBoost(RARITY_WEIGHTS, 'super_rare_bait');
    expect(result).toEqual(RARITY_WEIGHTS);
  });
});

describe('calculateFishPrice', () => {
  it('returns floor of price for minimum weight', () => {
    // weight = min → weightFactor = 0 → 0.5x
    const price = calculateFishPrice(100, 1.0, 1.0, 5.0);
    expect(price).toBe(50);
  });

  it('returns full price for maximum weight', () => {
    // weight = max → weightFactor = 1 → 1.5x
    const price = calculateFishPrice(100, 5.0, 1.0, 5.0);
    expect(price).toBe(150);
  });

  it('returns base price for median weight', () => {
    // weight = mid → weightFactor = 0.5 → 1.0x
    const price = calculateFishPrice(100, 3.0, 1.0, 5.0);
    expect(price).toBe(100);
  });

  it('handles equal min and max weight', () => {
    const price = calculateFishPrice(100, 5.0, 5.0, 5.0);
    // weightFactor = 0.5 (fallback)
    expect(price).toBe(100);
  });

  it('floors the result', () => {
    const price = calculateFishPrice(33, 2.0, 1.0, 5.0);
    // weightFactor = 0.25 → 33 * 0.75 = 24.75 → 24
    expect(price).toBe(24);
  });
});

describe('RARITY_COLORS', () => {
  it('has a color for every rarity', () => {
    for (const rarity of ['common', 'uncommon', 'rare', 'epic', 'legendary'] as FishRarity[]) {
      expect(typeof RARITY_COLORS[rarity]).toBe('number');
      expect(RARITY_COLORS[rarity]).toBeGreaterThan(0);
    }
  });
});
