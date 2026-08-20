import { describe, expect, it } from 'vitest';
import { applyAdventureDamage } from '../features/adventures/adventure-manager.js';

describe('adventure choice damage', () => {
  it('subtracts configured percentage points and clamps health at zero', () => {
    expect(applyAdventureDamage(100, 30)).toBe(70);
    expect(applyAdventureDamage(25, 40)).toBe(0);
    expect(applyAdventureDamage(80, 0)).toBe(80);
  });
});
