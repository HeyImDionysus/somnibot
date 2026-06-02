/**
 * Music Filters — Full tests
 *
 * Tests applyFilterPreset, applyCustomTimescale, applyCustomEqualizer,
 * describeActiveFilters. Covers all presets, reset, and filter description logic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  applyFilterPreset,
  applyCustomTimescale,
  applyCustomEqualizer,
  describeActiveFilters,
  FILTER_PRESETS,
  type FilterPreset,
} from '../features/music/music-filters.js';

function makePlayer(filters: Record<string, any> = {}): any {
  return {
    setEqualizer: vi.fn(async () => {}),
    setTimescale: vi.fn(async () => {}),
    setRotation: vi.fn(async () => {}),
    clearFilters: vi.fn(async () => {}),
    filters: {
      equalizer: null,
      timescale: null,
      rotation: null,
      ...filters,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('FILTER_PRESETS', () => {
  it('has all expected presets', () => {
    const expected: FilterPreset[] = ['bassboost', 'treble', 'nightcore', 'vaporwave', '8d', 'reset'];
    for (const preset of expected) {
      expect(FILTER_PRESETS[preset]).toBeDefined();
      expect(FILTER_PRESETS[preset].name).toBeTruthy();
      expect(FILTER_PRESETS[preset].description).toBeTruthy();
      expect(FILTER_PRESETS[preset].emoji).toBeTruthy();
    }
  });
});

describe('applyFilterPreset', () => {
  it('applies bassboost equalizer', async () => {
    const player = makePlayer();
    await applyFilterPreset(player, 'bassboost');
    expect(player.setEqualizer).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ band: 0, gain: 0.6 }),
    ]));
  });

  it('applies treble equalizer', async () => {
    const player = makePlayer();
    await applyFilterPreset(player, 'treble');
    expect(player.setEqualizer).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ band: 14, gain: 0.5 }),
    ]));
  });

  it('applies nightcore timescale', async () => {
    const player = makePlayer();
    await applyFilterPreset(player, 'nightcore');
    expect(player.setTimescale).toHaveBeenCalledWith(expect.objectContaining({
      speed: 1.25,
      pitch: 1.25,
    }));
  });

  it('applies vaporwave timescale', async () => {
    const player = makePlayer();
    await applyFilterPreset(player, 'vaporwave');
    expect(player.setTimescale).toHaveBeenCalledWith(expect.objectContaining({
      speed: 0.8,
      pitch: 0.8,
    }));
  });

  it('applies 8D rotation', async () => {
    const player = makePlayer();
    await applyFilterPreset(player, '8d');
    expect(player.setRotation).toHaveBeenCalledWith(expect.objectContaining({
      rotationHz: 0.2,
    }));
  });

  it('clears all filters on reset', async () => {
    const player = makePlayer();
    await applyFilterPreset(player, 'reset');
    expect(player.clearFilters).toHaveBeenCalled();
  });
});

describe('applyCustomTimescale', () => {
  it('applies custom timescale settings', async () => {
    const player = makePlayer();
    await applyCustomTimescale(player, { speed: 1.5, pitch: 0.9, rate: 1.1 });
    expect(player.setTimescale).toHaveBeenCalledWith({ speed: 1.5, pitch: 0.9, rate: 1.1 });
  });
});

describe('applyCustomEqualizer', () => {
  it('applies custom equalizer bands', async () => {
    const player = makePlayer();
    const bands = [{ band: 0, gain: 0.5 }, { band: 1, gain: -0.3 }];
    await applyCustomEqualizer(player, bands);
    expect(player.setEqualizer).toHaveBeenCalledWith(bands);
  });
});

describe('describeActiveFilters', () => {
  it('returns "None" when no filters active', () => {
    const player = makePlayer();
    expect(describeActiveFilters(player)).toBe('None');
  });

  it('detects bass boost preset', () => {
    const bassEq = [
      { band: 0, gain: 0.6 }, { band: 1, gain: 0.5 }, { band: 2, gain: 0.3 },
      { band: 3, gain: 0.15 }, { band: 4, gain: 0.0 }, { band: 5, gain: -0.05 },
      { band: 6, gain: -0.05 }, { band: 7, gain: 0.0 }, { band: 8, gain: 0.0 },
      { band: 9, gain: 0.0 }, { band: 10, gain: 0.0 }, { band: 11, gain: 0.0 },
      { band: 12, gain: 0.0 }, { band: 13, gain: 0.0 }, { band: 14, gain: 0.0 },
    ];
    const player = makePlayer({ equalizer: bassEq });
    const desc = describeActiveFilters(player);
    expect(desc).toContain('Bass Boost');
  });

  it('detects treble boost preset', () => {
    const trebleEq = [
      { band: 0, gain: 0.0 }, { band: 1, gain: 0.0 }, { band: 2, gain: 0.0 },
      { band: 3, gain: 0.0 }, { band: 4, gain: 0.0 }, { band: 5, gain: 0.0 },
      { band: 6, gain: 0.0 }, { band: 7, gain: 0.0 }, { band: 8, gain: 0.0 },
      { band: 9, gain: 0.0 }, { band: 10, gain: 0.15 }, { band: 11, gain: 0.2 },
      { band: 12, gain: 0.3 }, { band: 13, gain: 0.4 }, { band: 14, gain: 0.5 },
    ];
    const player = makePlayer({ equalizer: trebleEq });
    const desc = describeActiveFilters(player);
    expect(desc).toContain('Treble Boost');
  });

  it('detects nightcore timescale', () => {
    const player = makePlayer({ timescale: { speed: 1.25, pitch: 1.25, rate: 1.0 } });
    const desc = describeActiveFilters(player);
    expect(desc).toContain('Nightcore');
  });

  it('detects vaporwave timescale', () => {
    const player = makePlayer({ timescale: { speed: 0.8, pitch: 0.8, rate: 1.0 } });
    const desc = describeActiveFilters(player);
    expect(desc).toContain('Vaporwave');
  });

  it('shows custom timescale when not matching preset', () => {
    const player = makePlayer({ timescale: { speed: 1.5, pitch: 0.7, rate: 1.0 } });
    const desc = describeActiveFilters(player);
    expect(desc).toContain('Timescale');
    expect(desc).toContain('1.5x speed');
  });

  it('detects 8D audio', () => {
    const player = makePlayer({ rotation: { rotationHz: 0.2 } });
    const desc = describeActiveFilters(player);
    expect(desc).toContain('8D Audio');
  });

  it('shows custom EQ when not matching known presets', () => {
    const customEq = [
      { band: 0, gain: 0.3 }, { band: 1, gain: 0.3 }, { band: 2, gain: 0.0 },
      { band: 3, gain: 0.0 }, { band: 4, gain: 0.0 }, { band: 5, gain: 0.0 },
      { band: 6, gain: 0.0 }, { band: 7, gain: 0.0 }, { band: 8, gain: 0.0 },
      { band: 9, gain: 0.0 }, { band: 10, gain: 0.0 }, { band: 11, gain: 0.0 },
      { band: 12, gain: 0.0 }, { band: 13, gain: 0.0 }, { band: 14, gain: 0.0 },
    ];
    const player = makePlayer({ equalizer: customEq });
    const desc = describeActiveFilters(player);
    expect(desc).toContain('Custom EQ');
  });

  it('combines multiple active filters', () => {
    const bassEq = [
      { band: 0, gain: 0.6 }, { band: 1, gain: 0.5 }, { band: 2, gain: 0.3 },
      { band: 3, gain: 0.15 }, { band: 4, gain: 0.0 }, { band: 5, gain: -0.05 },
      { band: 6, gain: -0.05 }, { band: 7, gain: 0.0 }, { band: 8, gain: 0.0 },
      { band: 9, gain: 0.0 }, { band: 10, gain: 0.0 }, { band: 11, gain: 0.0 },
      { band: 12, gain: 0.0 }, { band: 13, gain: 0.0 }, { band: 14, gain: 0.0 },
    ];
    const player = makePlayer({
      equalizer: bassEq,
      rotation: { rotationHz: 0.2 },
    });
    const desc = describeActiveFilters(player);
    expect(desc).toContain('Bass Boost');
    expect(desc).toContain('8D Audio');
    expect(desc).toContain('·'); // separator
  });
});
