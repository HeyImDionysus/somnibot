-- Ship-ON defaults, part 2 — catalog parity for the flags the first pass missed.
--
-- The catalog contracts these features ON out of the box (verified against
-- packages/e2e/catalog/fragments: levels-enabled, voice-xp-enabled,
-- quests-enabled, achievements-enabled, prestige-enabled, adventures-enabled,
-- economy-heist-enabled, lottery-enabled, polls-enabled, predictions-enabled,
-- temp-channels-enabled, stats-channels-enabled = true), but guild_config still
-- defaulted them to false. Because a guild_config row is created on first setup
-- and unset columns take their DEFAULT, a brand-new server silently shipped with
-- XP/levels, quests, achievements, adventures, heist, lottery, polls,
-- predictions, temp channels, stats channels and voice XP all switched OFF —
-- the opposite of the contracted out-of-box experience.
--
-- Deliberately NOT flipped (each matches its contract or an explicit decision):
--   * economy_market_enabled  — catalog market-enabled = false (opt-in trading)
--   * message_log_enabled     — catalog message-log-enabled = false (privacy)
--   * anti_raid_enabled       — owner decision: lenient opt-in; auto-gating
--                               members on join-bursts is dangerous by default
--   * paypal_enabled          — requires credentials before it can do anything
--   * team_direct_assignment_enabled — consent-invitation model is the default
--
-- Existing rows are left untouched: this changes the DEFAULT for newly created
-- guild_config rows only, so no live server has its configuration rewritten.

BEGIN;

ALTER TABLE public.guild_config
  ALTER COLUMN levels_enabled                SET DEFAULT true,
  ALTER COLUMN voice_xp_enabled              SET DEFAULT true,
  ALTER COLUMN economy_quests_enabled        SET DEFAULT true,
  ALTER COLUMN economy_achievements_enabled  SET DEFAULT true,
  ALTER COLUMN economy_prestige_enabled      SET DEFAULT true,
  ALTER COLUMN economy_adventures_enabled    SET DEFAULT true,
  ALTER COLUMN economy_heist_enabled         SET DEFAULT true,
  ALTER COLUMN economy_lottery_enabled       SET DEFAULT true,
  ALTER COLUMN polls_enabled                 SET DEFAULT true,
  ALTER COLUMN predictions_enabled           SET DEFAULT true,
  ALTER COLUMN temp_channels_enabled         SET DEFAULT true,
  ALTER COLUMN stats_enabled                 SET DEFAULT true;

COMMIT;
