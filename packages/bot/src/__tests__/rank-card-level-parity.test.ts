/**
 * Rank card — level number and progress bar must come from the SAME math.
 *
 * The pre-parity bug: /rank printed the stored member_levels.level (written by
 * SQL as FLOOR(xp/100)) next to a progress bar computed from levelProgress(xp)
 * (the designed quadratic curve), so at 1000 XP the card said "Level 10" over
 * a level-4 progress bar. The fix removed `level` from RankCardOptions
 * entirely: generateRankCard derives the displayed level from
 * levelProgress(options.xp).level, so the number and the bar can never
 * disagree again.
 *
 * Uses the REAL @somnibot/shared curve (no mock) — that is the point.
 */
import { describe, it, expect, vi } from 'vitest';

const fillTexts: string[] = [];

vi.mock('@napi-rs/canvas', () => {
  const ctx: Record<string, unknown> = {
    fillStyle: '',
    strokeStyle: '',
    font: '',
    lineWidth: 0,
    beginPath: vi.fn(),
    roundRect: vi.fn(),
    fill: vi.fn(),
    clip: vi.fn(),
    arc: vi.fn(),
    stroke: vi.fn(),
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    fillText: (text: string) => { fillTexts.push(text); },
    measureText: (text: string) => ({ width: text.length * 7 }),
  };
  return {
    createCanvas: () => ({
      getContext: () => ctx,
      toBuffer: () => Buffer.from('png'),
    }),
    // Reject so both avatar and background fall back to the solid-color paths.
    loadImage: vi.fn().mockRejectedValue(new Error('no image loads in tests')),
    GlobalFonts: { registerFromPath: vi.fn(), register: vi.fn() },
  };
});

import { levelProgress } from '@somnibot/shared';
import { generateRankCard } from '../features/levels/rank-card.js';

describe('generateRankCard level/bar parity', () => {
  it('renders the level derived from the same XP as the progress bar (1000 XP → Level 4)', async () => {
    fillTexts.length = 0;

    await generateRankCard({
      username: 'Tester',
      avatarUrl: 'https://cdn.example.com/a.png',
      xp: 1000,
      rank: 3,
      totalMessages: 42,
    });

    const progress = levelProgress(1000);
    // The marquee bug value: the flat SQL curve said 10; the designed
    // quadratic curve says 4.
    expect(progress.level).toBe(4);

    // Level line uses the computed level…
    expect(fillTexts).toContain(`Level ${progress.level}  ·  Rank #3`);
    // …and the bar's XP text uses the very same levelProgress numbers
    // (1000 XP into level 4: 230 into the 380 needed for level 5).
    expect(progress.currentLevelXp).toBe(230);
    expect(progress.xpForNextLevel).toBe(380);
    expect(fillTexts).toContain(
      `${progress.currentLevelXp.toLocaleString()} / ${progress.xpForNextLevel.toLocaleString()} XP`,
    );

    // The old flat-curve number must not appear anywhere on the card.
    expect(fillTexts.some((t) => t.startsWith('Level 10 '))).toBe(false);
  });

  it('number and bar agree at an exact threshold (4675 XP → Level 10, 0/1100)', async () => {
    fillTexts.length = 0;

    await generateRankCard({
      username: 'Threshold',
      avatarUrl: 'https://cdn.example.com/a.png',
      xp: 4675,
      rank: 1,
      totalMessages: 1,
    });

    const progress = levelProgress(4675);
    expect(progress.level).toBe(10);
    expect(fillTexts).toContain(`Level ${progress.level}  ·  Rank #1`);
    expect(fillTexts).toContain(
      `${progress.currentLevelXp.toLocaleString()} / ${progress.xpForNextLevel.toLocaleString()} XP`,
    );
  });
});
