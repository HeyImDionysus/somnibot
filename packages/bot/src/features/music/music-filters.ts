/**
 * Music Filters — Lavalink audio filter presets and custom controls.
 *
 * Architecture doc §29.5 — enabled filters: volume, equalizer, timescale.
 *
 * Provides named presets (bass boost, nightcore, vaporwave, 8D) and
 * raw timescale/equalizer controls. DJ-only.
 */
import type { Player, Band, FilterOptions, TimescaleSettings, RotationSettings } from 'shoukaku';

// ── Filter Presets ────────────────────────────────────────

/** Bass boost: boost low-frequency bands (0–3), slight cut mid-highs. */
const BASS_BOOST_EQ: Band[] = [
  { band: 0, gain: 0.6 },
  { band: 1, gain: 0.5 },
  { band: 2, gain: 0.3 },
  { band: 3, gain: 0.15 },
  { band: 4, gain: 0.0 },
  { band: 5, gain: -0.05 },
  { band: 6, gain: -0.05 },
  { band: 7, gain: 0.0 },
  { band: 8, gain: 0.0 },
  { band: 9, gain: 0.0 },
  { band: 10, gain: 0.0 },
  { band: 11, gain: 0.0 },
  { band: 12, gain: 0.0 },
  { band: 13, gain: 0.0 },
  { band: 14, gain: 0.0 },
];

/** Treble boost: boost high-frequency bands. */
const TREBLE_BOOST_EQ: Band[] = [
  { band: 0, gain: 0.0 },
  { band: 1, gain: 0.0 },
  { band: 2, gain: 0.0 },
  { band: 3, gain: 0.0 },
  { band: 4, gain: 0.0 },
  { band: 5, gain: 0.0 },
  { band: 6, gain: 0.0 },
  { band: 7, gain: 0.0 },
  { band: 8, gain: 0.0 },
  { band: 9, gain: 0.0 },
  { band: 10, gain: 0.15 },
  { band: 11, gain: 0.2 },
  { band: 12, gain: 0.3 },
  { band: 13, gain: 0.4 },
  { band: 14, gain: 0.5 },
];

/** Nightcore: speed up + pitch up. */
const NIGHTCORE_TIMESCALE: TimescaleSettings = {
  speed: 1.25,
  pitch: 1.25,
  rate: 1.0,
};

/** Vaporwave: slow down + pitch down. */
const VAPORWAVE_TIMESCALE: TimescaleSettings = {
  speed: 0.8,
  pitch: 0.8,
  rate: 1.0,
};

/** 8D audio: rotation effect. */
const ROTATION_8D: RotationSettings = {
  rotationHz: 0.2,
};

/** Flat EQ: all bands at 0 (for reset). */
const FLAT_EQ: Band[] = Array.from({ length: 15 }, (_, i) => ({ band: i, gain: 0.0 }));

// ── Preset Definitions ────────────────────────────────────

export type FilterPreset = 'bassboost' | 'treble' | 'nightcore' | 'vaporwave' | '8d' | 'reset';

export interface FilterPresetInfo {
  name: string;
  description: string;
  emoji: string;
}

export const FILTER_PRESETS: Record<FilterPreset, FilterPresetInfo> = {
  bassboost: { name: 'Bass Boost', description: 'Heavy low-end boost', emoji: '🔊' },
  treble: { name: 'Treble Boost', description: 'Crisp high-end boost', emoji: '🔔' },
  nightcore: { name: 'Nightcore', description: 'Sped up + higher pitch', emoji: '🌙' },
  vaporwave: { name: 'Vaporwave', description: 'Slowed down + lower pitch', emoji: '🌊' },
  '8d': { name: '8D Audio', description: 'Rotating spatial audio', emoji: '🎧' },
  reset: { name: 'Reset', description: 'Clear all filters', emoji: '🔄' },
};

// ── Apply Functions ───────────────────────────────────────

/** Apply a named filter preset to the player. */
export async function applyFilterPreset(player: Player, preset: FilterPreset): Promise<void> {
  switch (preset) {
    case 'bassboost':
      await player.setEqualizer(BASS_BOOST_EQ);
      break;
    case 'treble':
      await player.setEqualizer(TREBLE_BOOST_EQ);
      break;
    case 'nightcore':
      await player.setTimescale(NIGHTCORE_TIMESCALE);
      break;
    case 'vaporwave':
      await player.setTimescale(VAPORWAVE_TIMESCALE);
      break;
    case '8d':
      await player.setRotation(ROTATION_8D);
      break;
    case 'reset':
      await player.clearFilters();
      break;
  }
}

/** Apply custom timescale settings. */
export async function applyCustomTimescale(
  player: Player,
  settings: TimescaleSettings,
): Promise<void> {
  await player.setTimescale(settings);
}

/** Apply custom equalizer bands. */
export async function applyCustomEqualizer(
  player: Player,
  bands: Band[],
): Promise<void> {
  await player.setEqualizer(bands);
}

/** Get a human-readable description of the active filters on a player. */
export function describeActiveFilters(player: Player): string {
  const parts: string[] = [];

  if (player.filters.equalizer && player.filters.equalizer.length > 0) {
    const nonZero = player.filters.equalizer.filter((b) => b.gain !== 0);
    if (nonZero.length > 0) {
      // Check if it matches a known preset
      if (matchesEq(player.filters.equalizer, BASS_BOOST_EQ)) {
        parts.push('🔊 Bass Boost');
      } else if (matchesEq(player.filters.equalizer, TREBLE_BOOST_EQ)) {
        parts.push('🔔 Treble Boost');
      } else {
        parts.push('🎛️ Custom EQ');
      }
    }
  }

  if (player.filters.timescale) {
    const ts = player.filters.timescale;
    if (ts.speed === 1.25 && ts.pitch === 1.25) {
      parts.push('🌙 Nightcore');
    } else if (ts.speed === 0.8 && ts.pitch === 0.8) {
      parts.push('🌊 Vaporwave');
    } else {
      parts.push(`⏱️ Timescale (${ts.speed ?? 1}x speed, ${ts.pitch ?? 1}x pitch)`);
    }
  }

  if (player.filters.rotation?.rotationHz) {
    parts.push('🎧 8D Audio');
  }

  return parts.length > 0 ? parts.join(' · ') : 'None';
}

// ── Helpers ───────────────────────────────────────────────

function matchesEq(current: Band[], preset: Band[]): boolean {
  if (current.length !== preset.length) return false;
  return preset.every((p) => {
    const c = current.find((b) => b.band === p.band);
    return c && Math.abs(c.gain - p.gain) < 0.01;
  });
}
