/**
 * Level-curve parity — the SQL RPC and the TS display math MUST agree.
 *
 * History: increment_member_xp originally computed level as FLOOR(xp / 100)
 * while every display surface (and /xp set) used the designed cumulative
 * quadratic curve (5L² + 50L + 100, MAX_LEVEL 200) from constants/levels.ts.
 * At 1000 XP the SQL said level 10, the display math said level 4 — /rank
 * contradicted its own progress bar and /xp set created phantom multi-level
 * jumps that mass-granted role rewards.
 *
 * Migration 20260726126000_level_curve_parity.sql fixed this by adding
 * public.level_for_xp (a bounded-loop SQL port of calculateLevel) and routing
 * both RPCs through it. This test pins the parity from the TS side:
 *
 *  1. a line-for-line JS mirror of the SQL loop must equal calculateLevel()
 *     across boundary samples and a dense sweep;
 *  2. the shipped migration text must still contain the exact formula, loop
 *     bound and cap the mirror encodes — so silently editing the SQL curve
 *     breaks this test.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { calculateLevel, totalXpForLevel, LEVEL_CONFIG } from '../constants/levels.js';

/**
 * JS mirror of public.level_for_xp from
 * packages/supabase/migrations/20260726126000_level_curve_parity.sql.
 * Keep this a literal transcription of the SQL body — that is the point.
 */
function sqlLevelForXp(pXp: number): number {
  // IF p_xp IS NULL OR p_xp < 100 THEN RETURN 0;
  if (pXp < 100) return 0;

  let vLevel = 0;
  let vXpNeeded = 0;

  // WHILE v_level < 200 LOOP ... EXIT WHEN p_xp < v_xp_needed ...
  while (vLevel < 200) {
    vXpNeeded += 5 * vLevel * vLevel + 50 * vLevel + 100;
    if (pXp < vXpNeeded) break;
    vLevel++;
  }

  // RETURN LEAST(200, v_level);
  return Math.min(200, vLevel);
}

const MIGRATION_PATH = fileURLToPath(new URL(
  '../../../supabase/migrations/20260726126000_level_curve_parity.sql',
  import.meta.url,
));

describe('level_for_xp (SQL) ≡ calculateLevel (TS)', () => {
  const samples = [0, 99, 100, 250, 1000, 4675, 100_000, 10_000_000];

  it.each(samples.map((xp) => [xp]))('agrees at %i XP', (xp) => {
    expect(sqlLevelForXp(xp)).toBe(calculateLevel(xp));
  });

  it('pins the sampled values to the designed quadratic curve', () => {
    expect(samples.map((xp) => calculateLevel(xp))).toEqual([
      0,   // 0 XP
      0,   // 99 XP — still short of the first 100-XP threshold
      1,   // 100 XP — exactly the level-1 threshold
      1,   // 250 XP
      4,   // 1000 XP — the bug's marquee value: SQL used to say 10
      10,  // 4675 XP — exactly the cumulative level-10 threshold
      34,  // 100_000 XP
      177, // 10_000_000 XP
    ]);
  });

  it('agrees across a dense sweep and at every exact level threshold', () => {
    for (let xp = 0; xp <= 20_000; xp += 7) {
      expect(sqlLevelForXp(xp)).toBe(calculateLevel(xp));
    }
    for (let level = 0; level <= LEVEL_CONFIG.MAX_LEVEL; level++) {
      const threshold = totalXpForLevel(level);
      expect(sqlLevelForXp(threshold)).toBe(calculateLevel(threshold));
      expect(sqlLevelForXp(threshold - 1)).toBe(calculateLevel(threshold - 1));
    }
  });

  it('caps at MAX_LEVEL 200 on both sides', () => {
    const capThreshold = totalXpForLevel(200);
    expect(capThreshold).toBe(14_248_500);
    for (const xp of [capThreshold - 1, capThreshold, capThreshold + 1, 2_147_483_647]) {
      expect(sqlLevelForXp(xp)).toBe(calculateLevel(xp));
    }
    expect(calculateLevel(capThreshold - 1)).toBe(199);
    expect(calculateLevel(capThreshold)).toBe(200);
    expect(calculateLevel(2_147_483_647)).toBe(200);
  });

  it('returns 0 for negative XP on both sides', () => {
    expect(sqlLevelForXp(-1)).toBe(calculateLevel(-1));
    expect(calculateLevel(-1)).toBe(0);
  });

  it('the shipped migration still contains the exact curve the mirror transcribes', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf-8');
    // Formula: XP to advance FROM level L is 5L² + 50L + 100.
    expect(sql).toContain('5 * v_level * v_level + 50 * v_level + 100');
    // Bounded loop to MAX_LEVEL and the explicit cap.
    expect(sql).toContain('WHILE v_level < 200 LOOP');
    expect(sql).toContain('LEAST(200, v_level)');
    // Both RPCs must route through the shared function.
    expect(sql).toContain('v_new_level := public.level_for_xp(v_new_xp);');
    // The old flat formula must be gone from the live definition.
    expect(sql).not.toMatch(/FLOOR\(v_new_xp/i);
  });

  it('TS formula constant matches the documented curve', () => {
    // 5L² + 50L + 100 — spot checks so a constants/levels.ts edit cannot
    // drift silently either.
    expect(LEVEL_CONFIG.XP_FORMULA(0)).toBe(100);
    expect(LEVEL_CONFIG.XP_FORMULA(1)).toBe(155);
    expect(LEVEL_CONFIG.XP_FORMULA(4)).toBe(380);
    expect(LEVEL_CONFIG.XP_FORMULA(10)).toBe(1100);
  });
});
