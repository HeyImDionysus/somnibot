-- =============================================================================
-- Config constraint sweep — completes 20260727004000_config_check_constraints.
--
-- That migration deliberately covered only the values that fail SILENTLY. This
-- one finishes the job across the rest of guild_config and the sibling per-guild
-- config tables, so a nonsense value cannot be stored at all.
--
-- ── Rules every constraint here obeys ────────────────────────────────────────
--  1. A CHECK violation reaches the owner as a bare 500 ("An internal error
--     occurred" — packages/dashboard/src/lib/api/response.ts dbError). So NO
--     constraint may be tighter than the Zod schema guarding its write path,
--     or a legitimate save turns into an unexplained failure. Where several
--     routes write the same column, the LOOSEST bound wins:
--       /api/guild        packages/dashboard/src/app/api/guild/route.ts
--       /api/economy      packages/dashboard/src/app/api/economy/route.ts
--       /api/levels       packages/dashboard/src/app/api/levels/route.ts
--       shared schemas    packages/dashboard/src/lib/api/validation.ts
--  2. Every column here was traced to a real consumer. Columns whose consumer
--     could not be found are listed at the bottom and left unconstrained.
--  3. SENTINELS ARE PRESERVED. economy_max_wallet and economy_daily_loss_limit
--     use 0 to mean "no cap" (20260522700000_v44_audit_fixes.sql:60 `0 = no cap`;
--     games-manager.ts:397 `if (limit <= 0) return true`). A `> 0` floor would
--     silently impose a cap on every guild running on defaults, so those get
--     `>= 0` and nothing more.
--  4. The two economies stay separate. Everything under "GAME ECONOMY" is
--     play-money coins. grace_period_days and store_brand_name are the only
--     REAL-money (PayPal) columns touched, and both are non-monetary.
--
-- ── Existing data ────────────────────────────────────────────────────────────
-- Every constraint is preceded by a normalising UPDATE, matching 20260727004000.
-- Clamps move a value to the nearest legal one; they never invent an unrelated
-- number, and they never lower an owner's deliberate floor. That makes the
-- migration safe to deploy against live data with no prior per-guild audit, so
-- the constraints are added VALIDATED rather than NOT VALID.
-- =============================================================================

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. LEVELS / XP
-- ═══════════════════════════════════════════════════════════════════════════
-- Negative XP is a SILENT drain: increment_member_xp floors the stored total at
-- 0 (20260726126000_level_curve_parity.sql:106 GREATEST(0, ...)) and the level
-- recomputes DOWNWARD, but `leveledUp` is `newLevel > oldLevel` so nothing is
-- announced and level-announcer.ts only ever walks upward, so reward roles are
-- never revoked. Members quietly de-level with no trace anywhere.
UPDATE public.guild_config SET xp_min = 15 WHERE xp_min < 0;
UPDATE public.guild_config SET xp_max = 25 WHERE xp_max < 0;
UPDATE public.guild_config SET xp_cooldown_seconds = 60 WHERE xp_cooldown_seconds < 0;
UPDATE public.guild_config SET voice_xp_per_interval = 10 WHERE voice_xp_per_interval < 0;

-- rank_card_accent_color is turned into a CSS string by rank-card.ts:33
--   `#${n.toString(16).padStart(6, '0')}`
-- A negative gives "#0000-1"; anything over 0xFFFFFF gives 7 hex digits. Both
-- are unparseable, and the canvas spec says an unparseable fillStyle/strokeStyle
-- assignment is IGNORED — no throw. The avatar ring keeps the previous black,
-- and the progress bar keeps rgba(255,255,255,0.1) from rank-card.ts:165, so the
-- bar renders permanently empty at every XP level. The card still delivers
-- successfully, so nothing is logged. Same bound as brand_primary_color /
-- brand_accent_color (20260724160000_guild_brand_kit_colors_voice.sql).
UPDATE public.guild_config SET rank_card_accent_color = 16716947
 WHERE rank_card_accent_color IS NOT NULL
   AND (rank_card_accent_color < 0 OR rank_card_accent_color > 16777215);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_xp_min_floor_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_xp_min_floor_check
      CHECK (xp_min IS NULL OR xp_min >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_xp_max_floor_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_xp_max_floor_check
      CHECK (xp_max IS NULL OR xp_max >= 0);
  END IF;
  -- NOTE: >= 0, not >= 1. xp_cooldown_seconds = 0 makes Valkey reject
  -- `SET ... EX 0` and kills ALL message XP silently (xp-tracker.ts:254), but
  -- /api/levels validates it as .min(0) and the page's own client check only
  -- rejects < 0 — so 0 is a value the dashboard lets an owner save today.
  -- Blocking it here would convert that into an opaque 500. Reported instead.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_xp_cooldown_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_xp_cooldown_check
      CHECK (xp_cooldown_seconds IS NULL OR xp_cooldown_seconds >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_voice_xp_per_interval_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_voice_xp_per_interval_check
      CHECK (voice_xp_per_interval IS NULL OR voice_xp_per_interval >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_rank_card_accent_color_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_rank_card_accent_color_check
      CHECK (rank_card_accent_color IS NULL
             OR (rank_card_accent_color >= 0 AND rank_card_accent_color <= 16777215));
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. MEMBER-FACING MESSAGE TEMPLATES
-- ═══════════════════════════════════════════════════════════════════════════
-- All four are sent to Discord with NO truncation guard anywhere in the bot
-- (welcome-service.ts:118/143, goodbye-service.ts:54, level-announcer.ts:108).
-- Over 2000 characters Discord returns 50035 and every call site swallows it —
-- welcome-service.ts:145 even logs an over-length DM as "DMs may be disabled",
-- which sends the owner hunting the wrong problem entirely.
--
-- The bound is 2000, matching the Zod ceilings (validation.ts:472/476/480,
-- levels/route.ts:33). It is deliberately NOT lower even though interpolation
-- grows the string past 2000 after {user} expands to <@snowflake> — see the
-- report; tightening below the UI's own limit would reject a saveable value.
UPDATE public.guild_config SET welcome_message = left(welcome_message, 2000)
 WHERE welcome_message IS NOT NULL AND char_length(welcome_message) > 2000;
UPDATE public.guild_config SET welcome_dm_message = left(welcome_dm_message, 2000)
 WHERE welcome_dm_message IS NOT NULL AND char_length(welcome_dm_message) > 2000;
UPDATE public.guild_config SET goodbye_message = left(goodbye_message, 2000)
 WHERE goodbye_message IS NOT NULL AND char_length(goodbye_message) > 2000;
UPDATE public.guild_config SET level_up_message = left(level_up_message, 2000)
 WHERE level_up_message IS NOT NULL AND char_length(level_up_message) > 2000;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_welcome_message_len_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_welcome_message_len_check
      CHECK (welcome_message IS NULL OR char_length(welcome_message) <= 2000);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_welcome_dm_message_len_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_welcome_dm_message_len_check
      CHECK (welcome_dm_message IS NULL OR char_length(welcome_dm_message) <= 2000);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_goodbye_message_len_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_goodbye_message_len_check
      CHECK (goodbye_message IS NULL OR char_length(goodbye_message) <= 2000);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_level_up_message_len_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_level_up_message_len_check
      CHECK (level_up_message IS NULL OR char_length(level_up_message) <= 2000);
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. MODERATION / ANTI-RAID
-- ═══════════════════════════════════════════════════════════════════════════
-- infraction_expiry_days feeds calculateExpiryDate (infraction-service.ts:257)
-- `date.setDate(date.getDate() + expiryDays)`. At <= 0 every new infraction is
-- born already expired and is swept on the next pass — the warn command reports
-- success, the record vanishes, and ESCALATION CHAINS NEVER FIRE. Fully silent.
-- Upper bound 3650 mirrors validation.ts:428 (the escalation route narrows
-- further to 1..365 at runtime, so 3650 can never reject a reachable value).
UPDATE public.guild_config SET infraction_expiry_days = 30
 WHERE infraction_expiry_days IS NOT NULL
   AND (infraction_expiry_days < 1 OR infraction_expiry_days > 3650);

-- anti_raid_join_threshold: recordJoinAndCount (anti-raid/index.ts:268) zadds
-- the current join BEFORE zcard, so joinCount is never below 1. A threshold of
-- 1 therefore fires on the very first joiner and the server becomes unjoinable.
-- Floor 2 mirrors /api/guild route.ts:52, which already treats 2 as the minimum.
UPDATE public.guild_config SET anti_raid_join_threshold = 10
 WHERE anti_raid_join_threshold IS NOT NULL
   AND (anti_raid_join_threshold < 2 OR anti_raid_join_threshold > 100);

-- anti_raid_join_window_seconds is a Valkey sorted-set window, not a JS timer.
-- At <= 0 windowStart >= now, so zremrangebyscore purges every prior join on
-- each call and zcard is pinned at 1 — flood detection is DEAD while the
-- feature reads as enabled. Below -10s the pexpire TTL also goes negative,
-- which Valkey treats as immediate key deletion.
UPDATE public.guild_config SET anti_raid_join_window_seconds = 10
 WHERE anti_raid_join_window_seconds IS NOT NULL
   AND (anti_raid_join_window_seconds < 5 OR anti_raid_join_window_seconds > 120);

UPDATE public.guild_config SET anti_raid_account_age_days = 7
 WHERE anti_raid_account_age_days IS NOT NULL
   AND (anti_raid_account_age_days < 0 OR anti_raid_account_age_days > 365);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_infraction_expiry_days_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_infraction_expiry_days_check
      CHECK (infraction_expiry_days IS NULL
             OR (infraction_expiry_days >= 1 AND infraction_expiry_days <= 3650));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_anti_raid_join_threshold_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_anti_raid_join_threshold_check
      CHECK (anti_raid_join_threshold IS NULL
             OR (anti_raid_join_threshold >= 2 AND anti_raid_join_threshold <= 100));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_anti_raid_join_window_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_anti_raid_join_window_check
      CHECK (anti_raid_join_window_seconds IS NULL
             OR (anti_raid_join_window_seconds >= 5 AND anti_raid_join_window_seconds <= 120));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_anti_raid_account_age_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_anti_raid_account_age_check
      CHECK (anti_raid_account_age_days IS NULL
             OR (anti_raid_account_age_days >= 0 AND anti_raid_account_age_days <= 365));
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. COMMUNITY SURFACES HANDED TO DISCORD
-- ═══════════════════════════════════════════════════════════════════════════
-- starboard_threshold: at a huge value the starboard never posts and reads as
-- enabled — silent. Bounds mirror /api/guild route.ts:59.
UPDATE public.guild_config SET starboard_threshold = 3
 WHERE starboard_threshold IS NOT NULL
   AND (starboard_threshold < 1 OR starboard_threshold > 100);

-- starboard_emoji is compared by string equality only (starboard/index.ts:137)
-- and is never passed to Discord's reaction API, so the only DB-expressible
-- guard is length. Format is NOT constrained — see the report: a non-emoji
-- value silently matches nothing and kills the feature, but /api/guild accepts
-- any string up to 64 chars, so a format CHECK would reject saveable values.
UPDATE public.guild_config SET starboard_emoji = left(starboard_emoji, 64)
 WHERE starboard_emoji IS NOT NULL AND char_length(starboard_emoji) > 64;

-- giveaway_entry_button_label goes to ButtonBuilder.setLabel()
-- (giveaway-manager.ts:752-756). Discord hard-caps button labels at 80. On the
-- entry-count REFRESH path (giveaway-manager.ts:673-685) the builder's throw is
-- swallowed by a bare `catch {}` commented "Message may have been deleted", so
-- the button silently stops updating forever with nothing in the logs.
-- Bound 1..80 mirrors validation.ts:463 and the route's .slice(0, 80).
UPDATE public.guild_config SET giveaway_entry_button_label = 'Count me in!'
 WHERE char_length(giveaway_entry_button_label) < 1
    OR char_length(giveaway_entry_button_label) > 80;

-- store_brand_name (REAL-money store) is POSTed to PayPal as
-- application_context.brand_name (payment-handler.ts:313) and used as a Discord
-- embed title (store-command.ts:74). 64 mirrors branding/route.ts:41 and clears
-- both PayPal's 127 and Discord's 256.
UPDATE public.guild_config SET store_brand_name = left(store_brand_name, 64)
 WHERE store_brand_name IS NOT NULL AND char_length(store_brand_name) > 64;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_starboard_threshold_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_starboard_threshold_check
      CHECK (starboard_threshold IS NULL
             OR (starboard_threshold >= 1 AND starboard_threshold <= 100));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_starboard_emoji_len_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_starboard_emoji_len_check
      CHECK (starboard_emoji IS NULL OR char_length(starboard_emoji) <= 64);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_giveaway_button_label_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_giveaway_button_label_check
      CHECK (char_length(giveaway_entry_button_label) BETWEEN 1 AND 80);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_store_brand_name_len_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_store_brand_name_len_check
      CHECK (store_brand_name IS NULL OR char_length(store_brand_name) <= 64);
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. NODE TIMER DELAYS — the 2^31 ms trap
-- ═══════════════════════════════════════════════════════════════════════════
-- These three are multiplied into milliseconds and handed to setInterval /
-- setTimeout. Node's delay is a signed 32-bit int: ANY delay above 2147483647
-- ms is silently reset to 1 ms with only a TimeoutOverflowWarning on stderr. So
-- both ends of the range produce the SAME runaway:
--   sync_interval_minutes       (sync-engine.ts:270)  > 35791  -> full guild
--                               reconcile every millisecond
--   music_auto_leave_minutes    (music-player.ts:141 -> :1119) -> bot joins a
--                               voice channel and instantly leaves
--   music_auto_destroy_minutes  (music-player.ts:142 -> :1141) -> player
--                               destroyed on the next tick, re-armed on every
--                               activity = continuous destroy loop
-- All bounds mirror the write paths exactly: validation.ts:687 (sync 5..1440)
-- and music/route.ts:81/84, which already clamp to 1..60 and 1..120.
UPDATE public.guild_config SET sync_interval_minutes = 60
 WHERE sync_interval_minutes IS NOT NULL
   AND (sync_interval_minutes < 5 OR sync_interval_minutes > 1440);
UPDATE public.guild_config SET music_auto_leave_minutes = 5
 WHERE music_auto_leave_minutes IS NOT NULL
   AND (music_auto_leave_minutes < 1 OR music_auto_leave_minutes > 60);
UPDATE public.guild_config SET music_auto_destroy_minutes = 30
 WHERE music_auto_destroy_minutes IS NOT NULL
   AND (music_auto_destroy_minutes < 1 OR music_auto_destroy_minutes > 120);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_sync_interval_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_sync_interval_check
      CHECK (sync_interval_minutes IS NULL
             OR (sync_interval_minutes >= 5 AND sync_interval_minutes <= 1440));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_music_auto_leave_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_music_auto_leave_check
      CHECK (music_auto_leave_minutes IS NULL
             OR (music_auto_leave_minutes >= 1 AND music_auto_leave_minutes <= 60));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_music_auto_destroy_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_music_auto_destroy_check
      CHECK (music_auto_destroy_minutes IS NULL
             OR (music_auto_destroy_minutes >= 1 AND music_auto_destroy_minutes <= 120));
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. REAL-MONEY STORE — subscription grace
-- ═══════════════════════════════════════════════════════════════════════════
-- grace_period_days reaches EntitlementService.suspend (entitlement-service.ts:
-- 492) as `gracePeriodEnds.setDate(getDate() + days)`. At <= 0 paid access is
-- revoked instantly on the first failed payment while the customer DM
-- (commerce-fulfillment.ts:1910) reads "a -5-day grace period". At a huge value
-- grace never ends and non-paying customers keep paid access indefinitely — a
-- fully silent revenue leak. Bounds mirror /api/guild route.ts:77.
UPDATE public.guild_config SET grace_period_days = 3
 WHERE grace_period_days IS NOT NULL
   AND (grace_period_days < 0 OR grace_period_days > 90);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_grace_period_days_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_grace_period_days_check
      CHECK (grace_period_days IS NULL
             OR (grace_period_days >= 0 AND grace_period_days <= 90));
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. GAME ECONOMY — currency identity
-- ═══════════════════════════════════════════════════════════════════════════
-- currency_name / currency_emoji are interpolated into ~67 sites. The load-
-- bearing ones are embed TITLES (commands.ts:339, :631), capped by Discord at
-- 256: an over-long emoji makes discord.js throw client-side, and because those
-- handlers already deferred, the global catch at interaction-handler.ts:330
-- skips replying (`!interaction.deferred` is false) — the member is left on a
-- permanent "thinking..." spinner with only a log line.
-- `??` defaults do NOT catch '' (economy-manager.ts:223), which renders
-- "You earned 500 ." Bounds mirror economy/route.ts:65-66 and guild/route.ts:80-81.
UPDATE public.guild_config SET currency_name = 'Coins'
 WHERE char_length(currency_name) < 1 OR char_length(currency_name) > 32;
UPDATE public.guild_config SET currency_emoji = '🪙'
 WHERE char_length(currency_emoji) < 1 OR char_length(currency_emoji) > 64;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_currency_name_len_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_currency_name_len_check
      CHECK (char_length(currency_name) BETWEEN 1 AND 32);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_currency_emoji_len_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_currency_emoji_len_check
      CHECK (char_length(currency_emoji) BETWEEN 1 AND 64);
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 8. GAME ECONOMY — payouts, percentages and cooldowns
-- ═══════════════════════════════════════════════════════════════════════════
-- A negative payout makes creditWallet return null (economy-manager.ts:336),
-- which routes /daily into the OUTAGE lane: it raises an `economy_reward_outage`
-- owner alert and replies "temporarily unavailable". The owner is told their
-- infrastructure is down when the real cause is a config number.
--
-- Percentages are fed to `chance()` (economy-manager.ts:106) as
-- `randomInt(0, 10000) < pct * 100`. Out of range never throws — crime/rob just
-- always fails or always succeeds, indistinguishable from bad luck.
--
-- economy_pay_tax_pct is already asserted server-side by the economy_pay RPC
-- (20260719010000_economy_pay_atomic.sql:74). Out of range makes EVERY /pay
-- raise, and the bot retries 3x before giving up — this moves that failure to
-- config-save time. 0..100 matches the RPC and is looser than the UI's 0..50.
UPDATE public.guild_config SET economy_starting_balance = 0 WHERE economy_starting_balance < 0;
UPDATE public.guild_config SET economy_daily_amount   = 500   WHERE economy_daily_amount   < 0;
UPDATE public.guild_config SET economy_weekly_amount  = 3500  WHERE economy_weekly_amount  < 0;
UPDATE public.guild_config SET economy_monthly_amount = 15000 WHERE economy_monthly_amount < 0;
UPDATE public.guild_config SET economy_work_min  = 100 WHERE economy_work_min  < 0;
UPDATE public.guild_config SET economy_work_max  = 500 WHERE economy_work_max  < 0;
UPDATE public.guild_config SET economy_crime_min = 200  WHERE economy_crime_min < 0;
UPDATE public.guild_config SET economy_crime_max = 1000 WHERE economy_crime_max < 0;
UPDATE public.guild_config SET economy_chat_income_min = 5  WHERE economy_chat_income_min < 0;
UPDATE public.guild_config SET economy_chat_income_max = 15 WHERE economy_chat_income_max < 0;

UPDATE public.guild_config SET economy_streak_bonus_pct = LEAST(GREATEST(economy_streak_bonus_pct, 0), 100)
 WHERE economy_streak_bonus_pct < 0 OR economy_streak_bonus_pct > 100;
UPDATE public.guild_config SET economy_crime_fine_pct = LEAST(GREATEST(economy_crime_fine_pct, 0), 100)
 WHERE economy_crime_fine_pct < 0 OR economy_crime_fine_pct > 100;
UPDATE public.guild_config SET economy_rob_fine_pct = LEAST(GREATEST(economy_rob_fine_pct, 0), 100)
 WHERE economy_rob_fine_pct < 0 OR economy_rob_fine_pct > 100;
UPDATE public.guild_config SET economy_pay_tax_pct = LEAST(GREATEST(economy_pay_tax_pct, 0), 100)
 WHERE economy_pay_tax_pct < 0 OR economy_pay_tax_pct > 100;
UPDATE public.guild_config SET economy_crime_success_pct = LEAST(GREATEST(economy_crime_success_pct, 1), 100)
 WHERE economy_crime_success_pct < 1 OR economy_crime_success_pct > 100;
UPDATE public.guild_config SET economy_rob_success_pct = LEAST(GREATEST(economy_rob_success_pct, 1), 100)
 WHERE economy_rob_success_pct < 1 OR economy_rob_success_pct > 100;

-- Cooldowns become the PX/EX argument of a Valkey `SET ... NX`. Valkey rejects
-- a non-positive expiry outright ("ERR invalid expire time"), and the throw is
-- log-only, so the command dies for the whole guild with no user-visible cause.
-- Floors are 1 (not the UI's 60 / 1) so they can never reject a saveable value.
UPDATE public.guild_config SET economy_work_cooldown_seconds = 1800 WHERE economy_work_cooldown_seconds < 1;
UPDATE public.guild_config SET economy_chat_income_cooldown_seconds = 60 WHERE economy_chat_income_cooldown_seconds < 1;

-- SENTINELS: 0 means "no cap" / "no limit". Only negatives are normalised.
UPDATE public.guild_config SET economy_max_wallet = 0 WHERE economy_max_wallet < 0;
UPDATE public.guild_config SET economy_daily_loss_limit = 0 WHERE economy_daily_loss_limit < 0;

UPDATE public.guild_config SET economy_coinflip_max_bet  = 500  WHERE economy_coinflip_max_bet  < 0;
UPDATE public.guild_config SET economy_slots_max_bet     = 500  WHERE economy_slots_max_bet     < 0;
UPDATE public.guild_config SET economy_blackjack_max_bet  = 1000 WHERE economy_blackjack_max_bet < 0;

-- economy_lottery_ticket_price: lottery_buy_tickets_atomic validates p_count and
-- p_max but NEVER p_cost, then runs `wallet = wallet - p_cost`. A negative price
-- therefore INCREASES the buyer's wallet — a coin-minting exploit that the
-- economy_wallets `wallet >= 0` CHECK cannot catch because the balance only
-- goes up. Silent: the reply says "You bought 5 ticket(s) for -500".
UPDATE public.guild_config SET economy_lottery_ticket_price = 100 WHERE economy_lottery_ticket_price < 1;
UPDATE public.guild_config SET economy_lottery_max_tickets = 10 WHERE economy_lottery_max_tickets < 1;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_economy_amounts_non_negative') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_economy_amounts_non_negative
      CHECK (economy_starting_balance >= 0
         AND economy_daily_amount     >= 0
         AND economy_weekly_amount    >= 0
         AND economy_monthly_amount   >= 0
         AND economy_work_min         >= 0
         AND economy_work_max         >= 0
         AND economy_crime_min        >= 0
         AND economy_crime_max        >= 0
         AND economy_chat_income_min  >= 0
         AND economy_chat_income_max  >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_economy_pct_ranges') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_economy_pct_ranges
      CHECK (economy_streak_bonus_pct  BETWEEN 0 AND 100
         AND economy_crime_fine_pct    BETWEEN 0 AND 100
         AND economy_rob_fine_pct      BETWEEN 0 AND 100
         AND economy_pay_tax_pct       BETWEEN 0 AND 100
         AND economy_crime_success_pct BETWEEN 1 AND 100
         AND economy_rob_success_pct   BETWEEN 1 AND 100);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_economy_cooldown_floors') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_economy_cooldown_floors
      CHECK (economy_work_cooldown_seconds        >= 1
         AND economy_chat_income_cooldown_seconds >= 1);
  END IF;
  -- >= 0 ONLY. 0 is the shipped default and means "no cap" / "no limit".
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_economy_sentinel_caps') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_economy_sentinel_caps
      CHECK (economy_max_wallet       >= 0
         AND economy_daily_loss_limit >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_economy_max_bets_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_economy_max_bets_check
      CHECK (economy_coinflip_max_bet  >= 0
         AND economy_slots_max_bet     >= 0
         AND economy_blackjack_max_bet >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_lottery_price_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_lottery_price_check
      CHECK (economy_lottery_ticket_price >= 1
         AND economy_lottery_max_tickets  >= 1);
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 9. GAME ECONOMY — heist
-- ═══════════════════════════════════════════════════════════════════════════
-- The max >= min pair is already covered by 20260727004000. Remaining:
--
-- economy_heist_join_window_secs is the setTimeout delay that schedules
-- resolveHeist (heist-manager.ts:447). At <= 0 the timer fires before anyone
-- can join, so the crew is 1, the heist cancels, and it reads as "nobody joined
-- in time". Above 2147483 seconds it overflows Node's 2^31 ms ceiling and is
-- reset to 1 ms — the SAME instant cancel. voice-xp.ts:78 clamps for exactly
-- this reason; the heist path has no equivalent. 10..600 mirrors both routes.
--
-- economy_heist_base_payout: heist_credit_participant gates the wallet write on
-- `p_amount > 0` but still stamps paid_at, so a negative payout marks every
-- participant settled having received nothing while the embed announces
-- "+ -125 Coins". Money-safe but silently wrong.
UPDATE public.guild_config SET economy_heist_min_participants = 2 WHERE economy_heist_min_participants < 1;
UPDATE public.guild_config SET economy_heist_max_participants = 8 WHERE economy_heist_max_participants < 1;
UPDATE public.guild_config SET economy_heist_join_window_secs = 60
 WHERE economy_heist_join_window_secs < 10 OR economy_heist_join_window_secs > 600;
UPDATE public.guild_config SET economy_heist_cooldown_seconds = 300 WHERE economy_heist_cooldown_seconds < 0;
UPDATE public.guild_config SET economy_heist_base_payout = 500 WHERE economy_heist_base_payout < 0;
UPDATE public.guild_config SET economy_heist_entry_fee = 100 WHERE economy_heist_entry_fee < 0;
UPDATE public.guild_config SET economy_heist_success_base_pct = LEAST(GREATEST(economy_heist_success_base_pct, 1), 100)
 WHERE economy_heist_success_base_pct < 1 OR economy_heist_success_base_pct > 100;

-- Re-assert the pair after the floor clamps above, so the ordering constraint
-- from 20260727004000 still holds for any row this migration just touched.
UPDATE public.guild_config SET economy_heist_max_participants = economy_heist_min_participants
 WHERE economy_heist_max_participants < economy_heist_min_participants;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_heist_ranges_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_heist_ranges_check
      CHECK (economy_heist_min_participants >= 1
         AND economy_heist_max_participants >= 1
         AND economy_heist_join_window_secs BETWEEN 10 AND 600
         AND economy_heist_cooldown_seconds >= 0
         AND economy_heist_base_payout      >= 0
         AND economy_heist_entry_fee        >= 0
         AND economy_heist_success_base_pct BETWEEN 1 AND 100);
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 10. GAME ECONOMY — gathering / crafting / farming / fishing
-- ═══════════════════════════════════════════════════════════════════════════
-- economy_farm_grid_size is BOTH a loop bound (farming-manager.ts:151 via
-- Math.ceil(Math.sqrt(n)), and :703 `for (i = 0; i < n; i++)`) AND the plot-slot
-- validator (:521). At 0 the loops never run and every /farm plant is rejected
-- with the nonsense "Use 1-0."; at a negative Math.sqrt returns NaN and the
-- comparison silently short-circuits to the same dead farm. 1..25 mirrors
-- /api/guild route.ts:121.
--
-- economy_fertilizer_time_reduction_pct multiplies grow time by (1 - pct/100)
-- (farming-manager.ts:672). At >= 100 grow time is zero or NEGATIVE, which
-- pulls the wilt threshold EARLIER than the ready time — a fertilised crop can
-- wilt the moment it is watered, while getTimeInfo's Math.max(0, ...) still
-- displays "Ready!". Bound 99 blocks the sign flip and stays looser than the
-- UI's own 0..90.
UPDATE public.guild_config SET economy_gathering_cooldown_seconds = 300 WHERE economy_gathering_cooldown_seconds < 1;
UPDATE public.guild_config SET economy_crafting_cooldown_seconds = 60 WHERE economy_crafting_cooldown_seconds < 0;
UPDATE public.guild_config SET economy_fishing_cooldown_seconds = 30 WHERE economy_fishing_cooldown_seconds < 1;
UPDATE public.guild_config SET economy_farm_grid_size = LEAST(GREATEST(economy_farm_grid_size, 1), 25)
 WHERE economy_farm_grid_size < 1 OR economy_farm_grid_size > 25;
UPDATE public.guild_config SET economy_fertilizer_time_reduction_pct = LEAST(GREATEST(economy_fertilizer_time_reduction_pct, 0), 99)
 WHERE economy_fertilizer_time_reduction_pct < 0 OR economy_fertilizer_time_reduction_pct > 99;
UPDATE public.guild_config SET economy_fishing_collection_reward_coins = 5000
 WHERE economy_fishing_collection_reward_coins < 1;

-- CROSS-COLUMN: fishing-manager.ts:451-453 partitions a single roll over [0,100)
--   junkThreshold     = junk_pct
--   treasureThreshold = junk_pct + treasure_pct
--   roll < junk -> junk | roll < treasure -> treasure | else -> a real fish
-- If the two sum above 100 the FISH BRANCH IS UNREACHABLE: no species is ever
-- caught, so collection progress and the collection reward are permanently
-- dead, with no throw and no log. Zod validates the two independently and never
-- checks the sum, so junk=100 + treasure=100 passes the dashboard today.
-- This is the same class as the max<min ordering pairs in 20260727004000, which
-- were likewise added despite no route validating them.
-- Normalisation preserves the junk setting and gives the remainder to treasure.
UPDATE public.guild_config
   SET economy_fishing_junk_chance_pct = LEAST(GREATEST(economy_fishing_junk_chance_pct, 0), 100)
 WHERE economy_fishing_junk_chance_pct < 0 OR economy_fishing_junk_chance_pct > 100;
UPDATE public.guild_config
   SET economy_fishing_treasure_chance_pct = LEAST(GREATEST(economy_fishing_treasure_chance_pct, 0), 100)
 WHERE economy_fishing_treasure_chance_pct < 0 OR economy_fishing_treasure_chance_pct > 100;
UPDATE public.guild_config
   SET economy_fishing_treasure_chance_pct = 100 - economy_fishing_junk_chance_pct
 WHERE economy_fishing_junk_chance_pct + economy_fishing_treasure_chance_pct > 100;

DO $$
BEGIN
  -- NOTE: crafting is >= 0, not >= 1. A 0 cooldown makes Valkey reject the
  -- `SET ... PX 0` and kills /craft, but /api/guild validates it as .min(0), so
  -- 0 is saveable from the dashboard today. Reported rather than blocked.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_gather_craft_fish_cooldowns') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_gather_craft_fish_cooldowns
      CHECK (economy_gathering_cooldown_seconds >= 1
         AND economy_crafting_cooldown_seconds  >= 0
         AND economy_fishing_cooldown_seconds   >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_farming_ranges_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_farming_ranges_check
      CHECK (economy_farm_grid_size BETWEEN 1 AND 25
         AND economy_fertilizer_time_reduction_pct BETWEEN 0 AND 99);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_fishing_chances_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_fishing_chances_check
      CHECK (economy_fishing_junk_chance_pct     BETWEEN 0 AND 100
         AND economy_fishing_treasure_chance_pct BETWEEN 0 AND 100
         AND economy_fishing_junk_chance_pct + economy_fishing_treasure_chance_pct <= 100);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_fishing_collection_reward_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_fishing_collection_reward_check
      CHECK (economy_fishing_collection_reward_coins >= 1);
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 11. GAME ECONOMY — adventures / market / quests / prestige / pets
-- ═══════════════════════════════════════════════════════════════════════════
-- economy_adventure_max_scenes is a comparison, not a loop bound
-- (adventure-manager.ts:990). scenesTraversed starts at 2, so at <= 1 every run
-- force-ends at scene 2 and short-pays, resolving as `success` with no error.
--
-- economy_market_fee_pct is already asserted by economy_market_settle_buy
-- (20260720090000:51) — out of range makes EVERY market purchase in the guild
-- fail. 0..100 matches the RPC and is looser than the UI's 0..50.
--
-- economy_market_listing_days: `new Date(now + days*86400000).toISOString()`
-- (market-manager.ts:225). At <= 0 the listing is created already-expired while
-- the seller's inventory is decremented and the reply claims success.
--
-- economy_daily_quest_count / economy_weekly_quest_count use >= 0, NOT >= 1:
-- quests-manager.ts:302 explicitly supports 0 with the comment "daily cadence
-- disabled (count 0)". A >= 1 floor would delete a documented feature. The
-- negative case is the real bug — slice(0, -3) silently assigns every template
-- EXCEPT the last three.
--
-- economy_quest_reward_base is a live multiplier (quests-manager.ts:184). At 0
-- the quests are already flipped to claimed by the RPC before the payout guard
-- skips, so progress is permanently lost for nothing.
--
-- economy_prestige_multiplier_pct is ADDED to the stored multiplier with no
-- clamp (20260723170000:90). A negative value means each prestige REDUCES the
-- permanent earning multiplier — the member pays a full wallet+bank wipe for a
-- penalty, and the confirmation reports "New earning multiplier: +-30%".
--
-- economy_pet_decay_interval_hours is a setInterval delay (pets-manager.ts:96).
-- At <= 0 Node clamps to 1 ms and runDecayCycle spins ~1000x/sec, each cycle
-- doing a 1000-row select plus an UPDATE per pet — a self-inflicted DoS, wholly
-- swallowed by the log-only catch at :184. Above 596 hours it crosses the 2^31
-- ms ceiling and produces the IDENTICAL 1 ms spin. Both ends, same failure.
UPDATE public.guild_config SET economy_adventure_daily_limit = 3 WHERE economy_adventure_daily_limit < 1;
UPDATE public.guild_config SET economy_adventure_ticket_cost = 100 WHERE economy_adventure_ticket_cost < 0;
UPDATE public.guild_config SET economy_adventure_max_scenes = LEAST(GREATEST(economy_adventure_max_scenes, 3), 30)
 WHERE economy_adventure_max_scenes < 3 OR economy_adventure_max_scenes > 30;

UPDATE public.guild_config SET economy_market_fee_pct = LEAST(GREATEST(economy_market_fee_pct, 0), 100)
 WHERE economy_market_fee_pct < 0 OR economy_market_fee_pct > 100;
UPDATE public.guild_config SET economy_market_listing_days = LEAST(GREATEST(economy_market_listing_days, 1), 30)
 WHERE economy_market_listing_days < 1 OR economy_market_listing_days > 30;
UPDATE public.guild_config SET economy_market_max_listings = 10 WHERE economy_market_max_listings < 1;

UPDATE public.guild_config SET economy_daily_quest_count = 3 WHERE economy_daily_quest_count < 0;
UPDATE public.guild_config SET economy_weekly_quest_count = 5 WHERE economy_weekly_quest_count < 0;
UPDATE public.guild_config SET economy_quest_reward_base = 100 WHERE economy_quest_reward_base < 0;

UPDATE public.guild_config SET economy_prestige_multiplier_pct = LEAST(GREATEST(economy_prestige_multiplier_pct, 1), 100)
 WHERE economy_prestige_multiplier_pct < 1 OR economy_prestige_multiplier_pct > 100;
UPDATE public.guild_config SET economy_prestige_min_level = 50 WHERE economy_prestige_min_level < 1;
UPDATE public.guild_config SET economy_prestige_min_net_worth = 1000000 WHERE economy_prestige_min_net_worth < 0;
UPDATE public.guild_config SET economy_prestige_max_level = 10 WHERE economy_prestige_max_level < 1;

UPDATE public.guild_config SET economy_pet_decay_rate = LEAST(GREATEST(economy_pet_decay_rate, 0), 100)
 WHERE economy_pet_decay_rate < 0 OR economy_pet_decay_rate > 100;
UPDATE public.guild_config SET economy_pet_low_stat_threshold = LEAST(GREATEST(economy_pet_low_stat_threshold, 0), 100)
 WHERE economy_pet_low_stat_threshold < 0 OR economy_pet_low_stat_threshold > 100;
UPDATE public.guild_config SET economy_pet_decay_interval_hours = LEAST(GREATEST(economy_pet_decay_interval_hours, 1), 168)
 WHERE economy_pet_decay_interval_hours < 1 OR economy_pet_decay_interval_hours > 168;
UPDATE public.guild_config SET economy_pet_feed_cost = 50 WHERE economy_pet_feed_cost < 0;
UPDATE public.guild_config SET economy_pet_train_cost = 100 WHERE economy_pet_train_cost < 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_adventure_ranges_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_adventure_ranges_check
      CHECK (economy_adventure_daily_limit >= 1
         AND economy_adventure_ticket_cost >= 0
         AND economy_adventure_max_scenes BETWEEN 3 AND 30);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_market_ranges_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_market_ranges_check
      CHECK (economy_market_fee_pct BETWEEN 0 AND 100
         AND economy_market_listing_days BETWEEN 1 AND 30
         AND economy_market_max_listings >= 1);
  END IF;
  -- >= 0 on the counts: 0 is the documented "cadence disabled" value.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_quest_ranges_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_quest_ranges_check
      CHECK (economy_daily_quest_count  >= 0
         AND economy_weekly_quest_count >= 0
         AND economy_quest_reward_base  >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_prestige_ranges_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_prestige_ranges_check
      CHECK (economy_prestige_multiplier_pct BETWEEN 1 AND 100
         AND economy_prestige_min_level      >= 1
         AND economy_prestige_min_net_worth  >= 0
         AND economy_prestige_max_level      >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_pet_ranges_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_pet_ranges_check
      CHECK (economy_pet_decay_rate           BETWEEN 0 AND 100
         AND economy_pet_low_stat_threshold   BETWEEN 0 AND 100
         AND economy_pet_decay_interval_hours BETWEEN 1 AND 168
         AND economy_pet_feed_cost            >= 0
         AND economy_pet_train_cost           >= 0);
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 12. SIBLING PER-GUILD CONFIG TABLES
-- ═══════════════════════════════════════════════════════════════════════════
-- These follow the temp_channel_hubs pattern from 20260727004000: NOT VALID
-- first, then an explicit VALIDATE, so the ACCESS EXCLUSIVE lock window stays
-- short on tables that can be large.

-- member_rank_settings colours share rank-card.ts's numToHex, so they have the
-- same silent invalid-CSS failure as rank_card_accent_color above. These ARE
-- reachable: /rank customize parses the option with
-- `parseInt(hex.replace('#',''), 16)` (levels/commands.ts:172-175) and never
-- range-checks, so "#1FFFFFF" or "-1" is stored verbatim.
UPDATE public.member_rank_settings SET accent_color = NULL
 WHERE accent_color IS NOT NULL AND (accent_color < 0 OR accent_color > 16777215);
UPDATE public.member_rank_settings SET progress_bar_color = NULL
 WHERE progress_bar_color IS NOT NULL AND (progress_bar_color < 0 OR progress_bar_color > 16777215);

-- overlay_opacity is interpolated into `rgba(0, 0, 0, ${opacity})`
-- (rank-card.ts:99). Outside 0..1 the string is invalid, canvas ignores the
-- fillStyle assignment, and the readability overlay is simply never drawn over
-- the background image. The /rank customize option is already declared
-- .setMinValue(0).setMaxValue(1) (levels/commands.ts:47), so this mirrors the
-- only write path exactly.
UPDATE public.member_rank_settings SET overlay_opacity = 0.7
 WHERE overlay_opacity IS NOT NULL AND (overlay_opacity < 0 OR overlay_opacity > 1);

-- economy_collect_role_income filters rules with `i.interval_minutes > 0`
-- (20260711020000:706). A rule at 0 or below is SILENTLY SKIPPED forever: the
-- owner configures role income, the dashboard lists the rule, and the member is
-- never paid, with no error on any surface. Mirrors the sibling
-- economy_role_income_amount_positive CHECK and validation.ts:705 (min 1).
UPDATE public.economy_role_income SET interval_minutes = 60 WHERE interval_minutes < 1;

-- product_license_config.max_devices (REAL-money store). The validate route
-- guards the device-limit branch with `if (device_fingerprint &&
-- result.config_max_devices)` and then uses `result.config_max_devices || 3`
-- (license/validate/route.ts:215, :223). A stored 0 is falsy on BOTH, so the
-- device cap is not merely wrong — it is NOT ENFORCED AT ALL, silently granting
-- unlimited activations. Floor 1 mirrors validation.ts:615.
UPDATE public.product_license_config SET max_devices = 3 WHERE max_devices < 1;

-- ticket_panels.max_open_per_user is compared as `openCount >= max`
-- (ticket-service.ts:109). At <= 0 nobody can ever open a ticket. The
-- inactivity hours are `?? 24 / ?? 48` then multiplied to ms
-- (ticket-service.ts:695-696); 0 is the UI's own "disabled" value, so only
-- negatives are excluded.
UPDATE public.ticket_panels SET max_open_per_user = 3 WHERE max_open_per_user < 1;
UPDATE public.ticket_panels SET inactivity_warn_hours = 24
 WHERE inactivity_warn_hours IS NOT NULL AND inactivity_warn_hours < 0;
UPDATE public.ticket_panels SET inactivity_close_hours = 48
 WHERE inactivity_close_hours IS NOT NULL AND inactivity_close_hours < 0;

-- temp_channel_hubs.keep_alive_minutes is the legacy fallback for the empty-room
-- grace period: `empty_grace_seconds ?? (keep_alive_minutes * 60)`
-- (temp-channel-manager.ts:374). A negative produces a negative grace, deleting
-- the room the instant it empties. 0..1440 mirrors temp-channels/route.ts:30.
UPDATE public.temp_channel_hubs SET keep_alive_minutes = 1
 WHERE keep_alive_minutes IS NOT NULL
   AND (keep_alive_minutes < 0 OR keep_alive_minutes > 1440);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'member_rank_settings_colors_check') THEN
    ALTER TABLE public.member_rank_settings ADD CONSTRAINT member_rank_settings_colors_check
      CHECK ((accent_color IS NULL OR (accent_color BETWEEN 0 AND 16777215))
         AND (progress_bar_color IS NULL OR (progress_bar_color BETWEEN 0 AND 16777215))) NOT VALID;
    ALTER TABLE public.member_rank_settings VALIDATE CONSTRAINT member_rank_settings_colors_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'member_rank_settings_overlay_opacity_check') THEN
    ALTER TABLE public.member_rank_settings ADD CONSTRAINT member_rank_settings_overlay_opacity_check
      CHECK (overlay_opacity IS NULL OR (overlay_opacity >= 0 AND overlay_opacity <= 1)) NOT VALID;
    ALTER TABLE public.member_rank_settings VALIDATE CONSTRAINT member_rank_settings_overlay_opacity_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'economy_role_income_interval_positive') THEN
    ALTER TABLE public.economy_role_income ADD CONSTRAINT economy_role_income_interval_positive
      CHECK (interval_minutes >= 1) NOT VALID;
    ALTER TABLE public.economy_role_income VALIDATE CONSTRAINT economy_role_income_interval_positive;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_license_config_max_devices_check') THEN
    ALTER TABLE public.product_license_config ADD CONSTRAINT product_license_config_max_devices_check
      CHECK (max_devices IS NULL OR max_devices >= 1) NOT VALID;
    ALTER TABLE public.product_license_config VALIDATE CONSTRAINT product_license_config_max_devices_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_panels_limits_check') THEN
    ALTER TABLE public.ticket_panels ADD CONSTRAINT ticket_panels_limits_check
      CHECK ((max_open_per_user IS NULL OR max_open_per_user >= 1)
         AND (inactivity_warn_hours IS NULL OR inactivity_warn_hours >= 0)
         AND (inactivity_close_hours IS NULL OR inactivity_close_hours >= 0)) NOT VALID;
    ALTER TABLE public.ticket_panels VALIDATE CONSTRAINT ticket_panels_limits_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'temp_channel_hubs_keep_alive_check') THEN
    ALTER TABLE public.temp_channel_hubs ADD CONSTRAINT temp_channel_hubs_keep_alive_check
      CHECK (keep_alive_minutes IS NULL
             OR (keep_alive_minutes >= 0 AND keep_alive_minutes <= 1440)) NOT VALID;
    ALTER TABLE public.temp_channel_hubs VALIDATE CONSTRAINT temp_channel_hubs_keep_alive_check;
  END IF;
END $$;

-- =============================================================================
-- DELIBERATELY LEFT UNCONSTRAINED (documented so the next sweep does not redo
-- this analysis):
--
--  * economy_max_bank — NO CONSUMER. It is selected and defaulted
--    (economy-manager.ts:214, :248) and then never read again; deposit() caps
--    against the per-wallet economy_wallets.bank_max column instead
--    (economy-manager.ts:404). No migration references it beyond its ADD COLUMN.
--    The dashboard still renders an owner-facing "Max Bank" field that does
--    nothing. Constraining a dead column would only make the lie tidier.
--
--  * Every *_channel_id / *_role_id snowflake column. The dashboard routes
--    validate them as z.string().nullable() with no snowflake regex, and the
--    integration suite deliberately stores non-snowflake ids (e.g.
--    anti-raid-config.integration.test.ts:46 'log-chan-antiraid'). A 17-20 digit
--    CHECK would be tighter than every current write path.
--
--  * starboard_emoji FORMAT, rank_card_background / welcome_card_background
--    URL shape. Bad values fail silently, but no write path validates them, so
--    a format CHECK would reject values the dashboard accepts today.
--
--  * stats_update_interval_minutes — already floored by 20260727004000.
--  * economy_trivia_* — already constrained by 20260723180100.
--  * product_license_config.heartbeat_interval_seconds /
--    offline_grace_period_seconds — validation.ts:616-617 explicitly allows 0,
--    and reconciliation.ts:130 already rejects negatives defensively.
-- =============================================================================

COMMIT;
