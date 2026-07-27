-- =============================================================================
-- Config constraints for values that are BROKEN, not merely odd.
--
-- The full constraint sweep in the audit covers ~90 columns. Most of those are
-- defensive: a negative daily reward is silly but visible the moment anyone
-- runs /daily. This migration deliberately covers only the cases where a bad
-- value makes a feature fail SILENTLY or hands Discord something it rejects —
-- the ones an owner cannot diagnose from the symptom.
--
-- Every constraint is preceded by a normalising UPDATE, so it applies cleanly
-- to whatever is already stored instead of failing the deploy on live data.
-- That also makes the migration safe to run without a prior audit of each
-- guild's rows.
--
-- ── Why these four groups ────────────────────────────────────────────────────
--  1. Lottery schedule: an unrecognised value means the draw NEVER FIRES. The
--     lottery looks configured, sells tickets, and silently never draws.
--  2. Ordering pairs (max < min): nothing in any route validates these today.
--     A max below its min produces an empty random range — broken payouts and
--     heists that can never start — with no error anywhere.
--  3. Voice/temp-channel limits: passed STRAIGHT to Discord. Out of range is a
--     rejected API call, surfacing as "the bot didn't make my channel".
--  4. Interval floors: a zero or negative interval means a timer that either
--     never fires or spins.
-- =============================================================================

BEGIN;

-- ── 1. Lottery schedule enum ───────────────────────────────────────────────
-- Anything outside this set leaves the draw scheduler with no match, so the
-- lottery accepts entries forever and never pays out.
UPDATE public.guild_config
   SET economy_lottery_schedule = 'weekly'
 WHERE economy_lottery_schedule IS NOT NULL
   AND economy_lottery_schedule NOT IN ('6h', '12h', 'daily', 'weekly', 'biweekly', 'monthly');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_lottery_schedule_check'
  ) THEN
    ALTER TABLE public.guild_config
      ADD CONSTRAINT guild_config_lottery_schedule_check
      CHECK (
        economy_lottery_schedule IS NULL
        OR economy_lottery_schedule IN ('6h', '12h', 'daily', 'weekly', 'biweekly', 'monthly')
      );
  END IF;
END $$;

-- ── 2. Ordering pairs ──────────────────────────────────────────────────────
-- A max below its min yields an empty range. Normalise by lifting the max to
-- the min (never lowering the min — an owner's floor is a deliberate choice).
UPDATE public.guild_config
   SET economy_work_max = economy_work_min
 WHERE economy_work_max < economy_work_min;

UPDATE public.guild_config
   SET economy_crime_max = economy_crime_min
 WHERE economy_crime_max < economy_crime_min;

UPDATE public.guild_config
   SET economy_chat_income_max = economy_chat_income_min
 WHERE economy_chat_income_max < economy_chat_income_min;

UPDATE public.guild_config
   SET economy_heist_max_participants = economy_heist_min_participants
 WHERE economy_heist_max_participants < economy_heist_min_participants;

UPDATE public.guild_config
   SET xp_max = xp_min
 WHERE xp_max < xp_min;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_work_range_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_work_range_check
      CHECK (economy_work_max >= economy_work_min);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_crime_range_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_crime_range_check
      CHECK (economy_crime_max >= economy_crime_min);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_chat_income_range_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_chat_income_range_check
      CHECK (economy_chat_income_max >= economy_chat_income_min);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_heist_participants_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_heist_participants_check
      CHECK (economy_heist_max_participants >= economy_heist_min_participants);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_xp_range_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_xp_range_check
      CHECK (xp_max >= xp_min);
  END IF;
END $$;

-- ── 3. Interval floors ─────────────────────────────────────────────────────
-- A zero or negative interval is a timer that never fires (or spins).
UPDATE public.guild_config SET voice_xp_interval_minutes = 1 WHERE voice_xp_interval_minutes < 1;
UPDATE public.guild_config SET stats_update_interval_minutes = 5 WHERE stats_update_interval_minutes < 1;
UPDATE public.guild_config SET music_default_volume = 100
 WHERE music_default_volume < 0 OR music_default_volume > 150;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_voice_xp_interval_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_voice_xp_interval_check
      CHECK (voice_xp_interval_minutes >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_stats_interval_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_stats_interval_check
      CHECK (stats_update_interval_minutes >= 1);
  END IF;
  -- Discord rejects a volume outside 0-150 outright.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_music_volume_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_music_volume_check
      CHECK (music_default_volume BETWEEN 0 AND 150);
  END IF;
END $$;

-- ── 4. Temp channel limits handed straight to Discord ───────────────────────
-- These are passed verbatim to the Discord API. Out of range is a rejected
-- call, which reaches the member as "the bot didn't create my channel" with no
-- indication that a setting is at fault.
UPDATE public.temp_channel_hubs SET default_user_limit = 0 WHERE default_user_limit < 0 OR default_user_limit > 99;
UPDATE public.temp_channel_hubs SET default_bitrate = 64000
 WHERE default_bitrate IS NOT NULL AND (default_bitrate < 8000 OR default_bitrate > 384000);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'temp_channel_hubs_user_limit_check') THEN
    ALTER TABLE public.temp_channel_hubs ADD CONSTRAINT temp_channel_hubs_user_limit_check
      CHECK (default_user_limit BETWEEN 0 AND 99) NOT VALID;
    ALTER TABLE public.temp_channel_hubs VALIDATE CONSTRAINT temp_channel_hubs_user_limit_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'temp_channel_hubs_bitrate_check') THEN
    ALTER TABLE public.temp_channel_hubs ADD CONSTRAINT temp_channel_hubs_bitrate_check
      CHECK (default_bitrate IS NULL OR default_bitrate BETWEEN 8000 AND 384000) NOT VALID;
    ALTER TABLE public.temp_channel_hubs VALIDATE CONSTRAINT temp_channel_hubs_bitrate_check;
  END IF;
END $$;

COMMIT;
