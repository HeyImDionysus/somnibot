/**
 * Level system constants and XP curve formula.
 */
import { randomInt } from 'node:crypto';

export const LEVEL_CONFIG = {
  /** XP required to reach a given level: 5L² + 50L + 100 */
  XP_FORMULA: (level: number): number => 5 * Math.pow(level, 2) + 50 * level + 100,

  /** Default min XP per qualifying message */
  DEFAULT_MIN_XP: 15,
  /** Default max XP per qualifying message */
  DEFAULT_MAX_XP: 25,
  /** Default cooldown between XP grants (seconds) */
  DEFAULT_COOLDOWN_SECONDS: 60,

  /** Default voice XP per interval */
  DEFAULT_VOICE_XP_PER_INTERVAL: 10,
  /** Default voice XP interval (minutes) */
  DEFAULT_VOICE_INTERVAL_MINUTES: 5,

  /** Maximum achievable level */
  MAX_LEVEL: 200,
} as const;

/**
 * Calculate the level for a given total XP amount.
 */
export function calculateLevel(totalXp: number): number {
  let level = 0;
  let xpNeeded = 0;

  while (level < LEVEL_CONFIG.MAX_LEVEL) {
    xpNeeded += LEVEL_CONFIG.XP_FORMULA(level);
    if (totalXp < xpNeeded) break;
    level++;
  }

  return level;
}

/**
 * Calculate total XP needed to reach a specific level.
 */
export function totalXpForLevel(targetLevel: number): number {
  let total = 0;
  for (let i = 0; i < targetLevel; i++) {
    total += LEVEL_CONFIG.XP_FORMULA(i);
  }
  return total;
}

/**
 * Calculate XP progress within the current level.
 */
export function levelProgress(totalXp: number): {
  level: number;
  currentLevelXp: number;
  xpForNextLevel: number;
  progressPercent: number;
} {
  const level = calculateLevel(totalXp);
  const xpAtCurrentLevel = totalXpForLevel(level);
  const xpForNextLevel = LEVEL_CONFIG.XP_FORMULA(level);
  const currentLevelXp = totalXp - xpAtCurrentLevel;
  const progressPercent = Math.min((currentLevelXp / xpForNextLevel) * 100, 100);

  return { level, currentLevelXp, xpForNextLevel, progressPercent };
}

/**
 * Generate a random XP value between min and max.
 *
 * V10 Audit §4.P3a — Uses crypto.randomInt for consistency with the
 * rest of the codebase (all other random functions use CSPRNG).
 */
export function randomXp(min: number = LEVEL_CONFIG.DEFAULT_MIN_XP, max: number = LEVEL_CONFIG.DEFAULT_MAX_XP): number {
  return randomInt(min, max + 1);
}
