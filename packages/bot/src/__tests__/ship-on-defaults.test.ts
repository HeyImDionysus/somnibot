/**
 * Ship-on defaults — migration + config-read coverage.
 *
 * The catalog contracts a "great out-of-box experience": economy (+ passive chat
 * income), the economy sub-features (gathering/crafting/farming/fishing/trivia/
 * pets), the casino (conservative-on), the starboard, and welcome/DM/goodbye all
 * ship ENABLED. This suite asserts:
 *   (1) the 20260724170000_ship_on_defaults migration flips every one of those
 *       guild_config column DEFAULTs to true, sets the casino conservative caps
 *       (coinflip/slots 500, blackjack 1000, daily-loss 5000), and sets
 *       sync_interval_minutes to 60 — and NEVER flips anti_raid_enabled (the
 *       catalog contracts anti-raid OFF: a lenient locked default);
 *   (2) the bot config-read fallbacks default ships-ON when a guild has no
 *       config row yet, so the out-of-box experience holds even before first save.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  }),
}));

vi.mock('discord.js', () => ({ EmbedBuilder: class {} }));

import { loadConfig as loadStarboardConfig } from '../features/starboard/index.js';

const MIGRATION_SQL = (() => {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const p = resolve(testDir, '../../../supabase/migrations/20260724170000_ship_on_defaults.sql');
  return readFileSync(p, 'utf8');
})();

describe('ship-on-defaults migration', () => {
  // Every feature the catalog contracts ON but the DB shipped OFF.
  const SHIP_ON_TRUE = [
    'economy_enabled',
    'economy_chat_income_enabled',
    'economy_gathering_enabled',
    'economy_crafting_enabled',
    'economy_farming_enabled',
    'economy_fishing_enabled',
    'economy_trivia_enabled',
    'economy_pets_enabled',
    'economy_games_enabled',
    'starboard_enabled',
    'welcome_enabled',
    'welcome_dm_enabled',
    'goodbye_enabled',
  ];

  it.each(SHIP_ON_TRUE)('flips %s column DEFAULT to true', (col) => {
    expect(MIGRATION_SQL).toMatch(new RegExp(`ALTER COLUMN\\s+${col}\\s+SET DEFAULT true`, 'i'));
  });

  it('sets the casino conservative-on wager + daily-loss caps', () => {
    expect(MIGRATION_SQL).toMatch(/ALTER COLUMN\s+economy_coinflip_max_bet\s+SET DEFAULT 500\b/i);
    expect(MIGRATION_SQL).toMatch(/ALTER COLUMN\s+economy_slots_max_bet\s+SET DEFAULT 500\b/i);
    expect(MIGRATION_SQL).toMatch(/ALTER COLUMN\s+economy_blackjack_max_bet\s+SET DEFAULT 1000\b/i);
    expect(MIGRATION_SQL).toMatch(/ALTER COLUMN\s+economy_daily_loss_limit\s+SET DEFAULT 5000\b/i);
  });

  it('sets sync_interval_minutes DEFAULT to the catalog value 60', () => {
    expect(MIGRATION_SQL).toMatch(/ALTER COLUMN\s+sync_interval_minutes\s+SET DEFAULT 60\b/i);
  });

  it('never alters anti_raid_enabled (the catalog contracts anti-raid OFF)', () => {
    // The comment documents the exclusion, but no DDL touches the column.
    expect(MIGRATION_SQL).not.toMatch(/ALTER COLUMN\s+anti_raid_enabled/i);
    expect(MIGRATION_SQL).not.toMatch(/anti_raid_enabled\s+SET DEFAULT/i);
  });

  it('only changes column DEFAULTs and never rewrites existing rows', () => {
    // Existing rows may hold a deliberate owner opt-out; a false is never
    // retroactively flipped, so the migration carries no UPDATE.
    expect(MIGRATION_SQL).not.toMatch(/UPDATE\s+public\.guild_config/i);
  });
});

describe('ship-on-defaults config-read', () => {
  function nullConfigSupabase() {
    const chain: Record<string, unknown> = {};
    for (const m of ['from', 'select', 'eq', 'maybeSingle', 'single']) {
      chain[m] = vi.fn(() => chain);
    }
    chain.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
    chain.single = vi.fn(async () => ({ data: null, error: null }));
    return { from: vi.fn(() => chain) };
  }

  it('starboard loadConfig ships ENABLED when the guild has no config row', async () => {
    // Unique guildId dodges the module-level per-guild config cache.
    const cfg = await loadStarboardConfig(nullConfigSupabase() as never, `no-row-${Date.now()}`);
    expect(cfg.starboard_enabled).toBe(true);
    // Non-ship-on defaults are unchanged (threshold 3, no self-star).
    expect(cfg.starboard_threshold).toBe(3);
    expect(cfg.starboard_self_star).toBe(false);
  });
});
