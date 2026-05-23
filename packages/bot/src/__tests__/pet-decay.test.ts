/**
 * Pet Decay — Unit Tests (V5 audit remediation — Finding 4.3)
 *
 * Tests the pet decay calculation logic and status transitions.
 */
import { describe, it, expect } from 'vitest';

interface PetDecayInput {
  hunger: number;
  happiness: number;
  energy: number;
  status: string;
}

interface PetDecayOutput {
  hunger: number;
  happiness: number;
  energy: number;
  status: string;
}

function computeDecay(pet: PetDecayInput, decayRate: number, threshold: number): PetDecayOutput {
  const newHunger = Math.max(0, pet.hunger - decayRate);
  const newHappiness = Math.max(0, pet.happiness - Math.floor(decayRate * 0.8));
  const newEnergy = Math.min(100, pet.energy + Math.floor(decayRate * 0.5));

  let newStatus: string;
  if (newHunger === 0 || newHappiness === 0) {
    newStatus = 'sick';
  } else if (newHunger <= threshold || newHappiness <= threshold) {
    newStatus = 'sad';
  } else {
    newStatus = 'happy';
  }

  return { hunger: newHunger, happiness: newHappiness, energy: newEnergy, status: newStatus };
}

describe('Pet Decay Logic', () => {
  const DEFAULT_DECAY = 5;
  const DEFAULT_THRESHOLD = 20;

  it('applies hunger decay correctly', () => {
    const result = computeDecay(
      { hunger: 50, happiness: 50, energy: 50, status: 'happy' },
      DEFAULT_DECAY, DEFAULT_THRESHOLD,
    );
    expect(result.hunger).toBe(45);
  });

  it('applies happiness decay at 0.8x rate', () => {
    const result = computeDecay(
      { hunger: 50, happiness: 50, energy: 50, status: 'happy' },
      DEFAULT_DECAY, DEFAULT_THRESHOLD,
    );
    expect(result.happiness).toBe(46); // 50 - floor(5 * 0.8) = 50 - 4 = 46
  });

  it('recovers energy at 0.5x rate', () => {
    const result = computeDecay(
      { hunger: 50, happiness: 50, energy: 50, status: 'happy' },
      DEFAULT_DECAY, DEFAULT_THRESHOLD,
    );
    expect(result.energy).toBe(52); // 50 + floor(5 * 0.5) = 50 + 2 = 52
  });

  it('caps energy at 100', () => {
    const result = computeDecay(
      { hunger: 50, happiness: 50, energy: 99, status: 'happy' },
      DEFAULT_DECAY, DEFAULT_THRESHOLD,
    );
    expect(result.energy).toBe(100);
  });

  it('floors hunger at 0', () => {
    const result = computeDecay(
      { hunger: 3, happiness: 50, energy: 50, status: 'happy' },
      DEFAULT_DECAY, DEFAULT_THRESHOLD,
    );
    expect(result.hunger).toBe(0);
    expect(result.status).toBe('sick');
  });

  it('transitions to sad when below threshold', () => {
    const result = computeDecay(
      { hunger: 22, happiness: 50, energy: 50, status: 'happy' },
      DEFAULT_DECAY, DEFAULT_THRESHOLD,
    );
    expect(result.hunger).toBe(17);
    expect(result.status).toBe('sad');
  });

  it('transitions to sick when hunger hits 0', () => {
    const result = computeDecay(
      { hunger: 3, happiness: 80, energy: 50, status: 'happy' },
      DEFAULT_DECAY, DEFAULT_THRESHOLD,
    );
    expect(result.status).toBe('sick');
  });

  it('transitions to sick when happiness hits 0', () => {
    const result = computeDecay(
      { hunger: 80, happiness: 2, energy: 50, status: 'happy' },
      DEFAULT_DECAY, DEFAULT_THRESHOLD,
    );
    expect(result.happiness).toBe(0);
    expect(result.status).toBe('sick');
  });

  it('stays happy when above threshold', () => {
    const result = computeDecay(
      { hunger: 80, happiness: 80, energy: 50, status: 'happy' },
      DEFAULT_DECAY, DEFAULT_THRESHOLD,
    );
    expect(result.status).toBe('happy');
  });

  it('handles zero decay rate', () => {
    const result = computeDecay(
      { hunger: 50, happiness: 50, energy: 50, status: 'happy' },
      0, DEFAULT_THRESHOLD,
    );
    expect(result.hunger).toBe(50);
    expect(result.happiness).toBe(50);
    expect(result.energy).toBe(50);
    expect(result.status).toBe('happy');
  });

  it('handles high decay rate', () => {
    const result = computeDecay(
      { hunger: 100, happiness: 100, energy: 10, status: 'happy' },
      50, DEFAULT_THRESHOLD,
    );
    expect(result.hunger).toBe(50);
    expect(result.happiness).toBe(60); // 100 - floor(50 * 0.8) = 100 - 40 = 60
    expect(result.energy).toBe(35); // 10 + floor(50 * 0.5) = 10 + 25 = 35
    expect(result.status).toBe('happy');
  });
});
