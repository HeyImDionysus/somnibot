-- Scheduled / hosted trivia cadence + trivia config CHECK constraints.
--
-- Two gaps from the game-economy-trivia audit are closed here:
--
--   (1) policy-default: "Scheduled/hosted trivia cadence is contracted but
--       entirely unimplemented (no guild_config columns, no scheduler)". The
--       catalog contracts an owner-scheduled hosted cadence — automatic rounds
--       posted to a configured channel on an interval, toggled independently of
--       on-command /trivia. There was no storage for it, so the SET-B proof had
--       to GATE the whole hosted cadence. Add the columns the scheduler
--       (packages/bot/src/features/trivia/schedule-runner.ts) reads/claims.
--
--   (2) low: "Trivia config columns carry no DB CHECK constraints (validation
--       only in dashboard Zod)". The dashboard Zod layer bounded base payout,
--       streak %, hard multiplier, and cooldown, but the guild_config columns
--       themselves accepted anything, so the INVALID proof's reject path was
--       unreachable at the DB. Add DB CHECK constraints mirroring the Zod
--       validity domain (values are normalized into range first so the
--       constraints can never fail to apply on existing rows).
--
-- The `economy_trivia_schedule_last_run_at` column is the atomic-claim baseline
-- the scheduler uses to guarantee exactly one hosted round per interval across
-- ticks / restarts / shards (mirrors scheduled_messages.last_sent_at).

BEGIN;

-- ── (1) Hosted-cadence storage ────────────────────────────────────────────
ALTER TABLE public.guild_config
  ADD COLUMN IF NOT EXISTS economy_trivia_schedule_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS economy_trivia_schedule_interval_minutes integer NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS economy_trivia_schedule_channel_id text,
  ADD COLUMN IF NOT EXISTS economy_trivia_schedule_category text,
  ADD COLUMN IF NOT EXISTS economy_trivia_schedule_difficulty text,
  ADD COLUMN IF NOT EXISTS economy_trivia_schedule_last_run_at timestamptz;

-- Interval bounds: 5 minutes .. 7 days (10080 min). A too-small interval would
-- spam a channel; a too-large one is meaningless. Guard the enabled flag +
-- interval on the new columns directly (added inline via a guarded block so a
-- re-run is a no-op).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'guild_config_trivia_schedule_interval_check'
       AND conrelid = 'public.guild_config'::regclass
  ) THEN
    ALTER TABLE public.guild_config
      ADD CONSTRAINT guild_config_trivia_schedule_interval_check
      CHECK (economy_trivia_schedule_interval_minutes >= 5
             AND economy_trivia_schedule_interval_minutes <= 10080);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'guild_config_trivia_schedule_difficulty_check'
       AND conrelid = 'public.guild_config'::regclass
  ) THEN
    ALTER TABLE public.guild_config
      ADD CONSTRAINT guild_config_trivia_schedule_difficulty_check
      CHECK (economy_trivia_schedule_difficulty IS NULL
             OR economy_trivia_schedule_difficulty IN ('easy', 'medium', 'hard'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'guild_config_trivia_schedule_category_check'
       AND conrelid = 'public.guild_config'::regclass
  ) THEN
    ALTER TABLE public.guild_config
      ADD CONSTRAINT guild_config_trivia_schedule_category_check
      CHECK (economy_trivia_schedule_category IS NULL
             OR char_length(economy_trivia_schedule_category) <= 64);
  END IF;
END $$;

-- ── (2) CHECK constraints for the existing trivia config columns ──────────
-- Normalize any out-of-range legacy values first so ADD CONSTRAINT can never
-- fail to validate existing rows (all live writers are Zod-validated, so this
-- is defensive, but a direct-SQL / seed row could carry garbage).
UPDATE public.guild_config
   SET economy_trivia_cooldown_seconds = GREATEST(0, LEAST(86400, economy_trivia_cooldown_seconds))
 WHERE economy_trivia_cooldown_seconds < 0 OR economy_trivia_cooldown_seconds > 86400;

UPDATE public.guild_config
   SET economy_trivia_base_payout = GREATEST(0, LEAST(1000000000, economy_trivia_base_payout))
 WHERE economy_trivia_base_payout < 0 OR economy_trivia_base_payout > 1000000000;

UPDATE public.guild_config
   SET economy_trivia_streak_multiplier_pct = GREATEST(0, LEAST(10000, economy_trivia_streak_multiplier_pct))
 WHERE economy_trivia_streak_multiplier_pct < 0 OR economy_trivia_streak_multiplier_pct > 10000;

UPDATE public.guild_config
   SET economy_trivia_hard_multiplier = GREATEST(1, LEAST(100, economy_trivia_hard_multiplier))
 WHERE economy_trivia_hard_multiplier < 1 OR economy_trivia_hard_multiplier > 100;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'guild_config_trivia_cooldown_check'
       AND conrelid = 'public.guild_config'::regclass
  ) THEN
    ALTER TABLE public.guild_config
      ADD CONSTRAINT guild_config_trivia_cooldown_check
      CHECK (economy_trivia_cooldown_seconds >= 0
             AND economy_trivia_cooldown_seconds <= 86400);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'guild_config_trivia_base_payout_check'
       AND conrelid = 'public.guild_config'::regclass
  ) THEN
    ALTER TABLE public.guild_config
      ADD CONSTRAINT guild_config_trivia_base_payout_check
      CHECK (economy_trivia_base_payout >= 0
             AND economy_trivia_base_payout <= 1000000000);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'guild_config_trivia_streak_mult_check'
       AND conrelid = 'public.guild_config'::regclass
  ) THEN
    ALTER TABLE public.guild_config
      ADD CONSTRAINT guild_config_trivia_streak_mult_check
      CHECK (economy_trivia_streak_multiplier_pct >= 0
             AND economy_trivia_streak_multiplier_pct <= 10000);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'guild_config_trivia_hard_mult_check'
       AND conrelid = 'public.guild_config'::regclass
  ) THEN
    ALTER TABLE public.guild_config
      ADD CONSTRAINT guild_config_trivia_hard_mult_check
      CHECK (economy_trivia_hard_multiplier >= 1
             AND economy_trivia_hard_multiplier <= 100);
  END IF;
END $$;

COMMIT;
