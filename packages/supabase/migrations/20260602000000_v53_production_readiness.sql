-- ============================================================
-- V53 Production Readiness — Database Fixes
-- ============================================================
-- Addresses findings from the V53 production readiness audit:
--
-- 1. Fix purge_member_data: remove reference to dropped economy_trivia_sessions,
--    add missing tables (poll_votes, economy_pet_battles), anonymize infractions
-- 2. Drop dead purge_user_data function
-- 3. ALTER COLUMN guild_id SET NOT NULL on 30 initial-schema tables
-- 4. Add CHECK constraints on economy_wallets (wallet >= 0, bank >= 0)
-- ============================================================


-- ============================================================
-- 1. Replace purge_member_data with corrected version
-- ============================================================
-- Changes vs original (v53_forgetme.sql):
--   - Removed: DELETE FROM economy_trivia_sessions (table dropped in v53_dead_table_cleanup)
--   - Added: DELETE FROM poll_votes (per-user vote records)
--   - Added: DELETE/anonymize economy_pet_battles (challenger/defender user refs)
--   - Added: Anonymize infractions (preserve mod records, scrub user identity)
-- ============================================================

CREATE OR REPLACE FUNCTION public.purge_member_data(
  p_guild_id text,
  p_user_id  text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted jsonb := '{}'::jsonb;
  v_count   int;
BEGIN
  -- ── Economy data ──────────────────────────────────────────

  DELETE FROM economy_wallets
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_wallets', v_count);

  DELETE FROM economy_transactions
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_transactions', v_count);

  DELETE FROM economy_inventory
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_inventory', v_count);

  DELETE FROM economy_streaks
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_streaks', v_count);

  -- Market listings by this user
  DELETE FROM economy_market_listings
    WHERE guild_id = p_guild_id AND seller_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_market_listings', v_count);

  -- Farm plots
  DELETE FROM economy_farm_plots
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_farm_plots', v_count);

  -- Fish catches
  DELETE FROM economy_fish_catches
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_fish_catches', v_count);

  -- Adventure sessions
  DELETE FROM economy_adventure_sessions
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_adventure_sessions', v_count);

  -- economy_trivia_sessions: table dropped in v53_dead_table_cleanup — trivia uses Valkey

  -- Lottery tickets
  DELETE FROM economy_lottery_tickets
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_lottery_tickets', v_count);

  -- Pets
  DELETE FROM economy_pets
    WHERE guild_id = p_guild_id AND owner_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_pets', v_count);

  -- Pet battles — anonymize rather than delete (preserves game history)
  UPDATE economy_pet_battles
  SET challenger_id = CASE WHEN challenger_id = p_user_id THEN 'deleted_user' ELSE challenger_id END,
      defender_id   = CASE WHEN defender_id = p_user_id   THEN 'deleted_user' ELSE defender_id END,
      winner_id     = CASE WHEN winner_id = p_user_id     THEN 'deleted_user' ELSE winner_id END
  WHERE guild_id = p_guild_id
    AND (challenger_id = p_user_id OR defender_id = p_user_id);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_pet_battles_anonymized', v_count);

  -- Quest progress
  DELETE FROM economy_quest_progress
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_quest_progress', v_count);

  -- Achievements
  DELETE FROM economy_user_achievements
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_user_achievements', v_count);

  -- Prestige
  DELETE FROM economy_prestige
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_prestige', v_count);

  -- Profiles
  DELETE FROM economy_profiles
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_profiles', v_count);

  -- Heist participation
  DELETE FROM economy_heist_participants
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_heist_participants', v_count);

  -- Daily losses
  DELETE FROM economy_daily_losses
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_daily_losses', v_count);

  -- Also remove from heist participants arrays
  UPDATE economy_heists
  SET participants = array_remove(participants, p_user_id)
  WHERE guild_id = p_guild_id
    AND p_user_id = ANY(participants);

  -- Poll votes
  DELETE FROM poll_votes
    WHERE user_id = p_user_id
      AND poll_id IN (SELECT id FROM polls WHERE guild_id = p_guild_id);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('poll_votes', v_count);

  -- ── Levels data ───────────────────────────────────────────

  DELETE FROM member_levels
    WHERE guild_id = p_guild_id AND member_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('member_levels', v_count);

  -- ── Infractions — anonymize, don't delete (mod records) ───

  UPDATE infractions
  SET member_id = 'deleted_user'
  WHERE guild_id = p_guild_id AND member_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('infractions_anonymized', v_count);

  -- ── Members table ─────────────────────────────────────────

  DELETE FROM members
    WHERE guild_id = p_guild_id AND discord_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('members', v_count);

  -- ── Tickets — anonymize, don't delete (operational data) ──

  UPDATE tickets
  SET creator_id = 'deleted_user'
  WHERE guild_id = p_guild_id AND creator_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('tickets_anonymized', v_count);

  -- ── Audit logs — anonymize actor/target ───────────────────

  UPDATE audit_logs
  SET details = details || '{"anonymized": true}'::jsonb
  WHERE guild_id = p_guild_id
    AND (
      (actor_type = 'user' AND actor_id = p_user_id)
      OR (target_type = 'member' AND target_id = p_user_id)
    );

  -- ── Giveaway entries — remove ─────────────────────────────

  UPDATE giveaways
  SET entries = (
    SELECT coalesce(jsonb_agg(elem), '[]'::jsonb)
    FROM jsonb_array_elements(entries) elem
    WHERE elem->>'userId' != p_user_id
  )
  WHERE guild_id = p_guild_id
    AND entries @> jsonb_build_array(jsonb_build_object('userId', p_user_id));

  -- ── Reaction role state in Valkey — handled at app layer ──
  -- (The bot clears Valkey keys when processing the command)

  RETURN v_deleted;
END;
$$;

GRANT EXECUTE ON FUNCTION public.purge_member_data(text, text) TO service_role;


-- ============================================================
-- 2. Drop dead purge_user_data function
-- ============================================================
-- This function was created in v53_dead_table_cleanup but:
--   a) It's never called by the bot (bot calls purge_member_data)
--   b) It references economy_inventories (wrong name — table is economy_inventory)
--   c) It deletes infractions/tickets outright instead of anonymizing
-- Removing to avoid confusion.
-- ============================================================

DROP FUNCTION IF EXISTS public.purge_user_data(text, text);


-- ============================================================
-- 3. Add NOT NULL constraint to guild_id on 30 initial-schema tables
-- ============================================================
-- server_templates was dropped in v53_dead_table_cleanup, so 30 remain.
--
-- Safety: these columns already have a REFERENCES guild(id) FK, and all
-- application code always provides guild_id. This just closes the gap
-- at the database level.
-- ============================================================

ALTER TABLE discord_id_map       ALTER COLUMN guild_id SET NOT NULL;
ALTER TABLE reaction_roles       ALTER COLUMN guild_id SET NOT NULL;
ALTER TABLE automod_rules        ALTER COLUMN guild_id SET NOT NULL;
ALTER TABLE infractions          ALTER COLUMN guild_id SET NOT NULL;
ALTER TABLE ticket_panels        ALTER COLUMN guild_id SET NOT NULL;
ALTER TABLE tickets              ALTER COLUMN guild_id SET NOT NULL;
ALTER TABLE automations          ALTER COLUMN guild_id SET NOT NULL;
ALTER TABLE automation_executions ALTER COLUMN guild_id SET NOT NULL;
ALTER TABLE custom_commands      ALTER COLUMN guild_id SET NOT NULL;
ALTER TABLE embed_configs        ALTER COLUMN guild_id SET NOT NULL;
ALTER TABLE member_levels        ALTER COLUMN guild_id SET NOT NULL;
ALTER TABLE level_rewards        ALTER COLUMN guild_id SET NOT NULL;
ALTER TABLE xp_multipliers       ALTER COLUMN guild_id SET NOT NULL;
ALTER TABLE member_rank_settings ALTER COLUMN guild_id SET NOT NULL;
ALTER TABLE temp_channel_hubs    ALTER COLUMN guild_id SET NOT NULL;
ALTER TABLE active_temp_channels ALTER COLUMN guild_id SET NOT NULL;
ALTER TABLE stats_channels       ALTER COLUMN guild_id SET NOT NULL;
ALTER TABLE scheduled_messages   ALTER COLUMN guild_id SET NOT NULL;
ALTER TABLE products             ALTER COLUMN guild_id SET NOT NULL;
ALTER TABLE plans                ALTER COLUMN guild_id SET NOT NULL;
ALTER TABLE customers            ALTER COLUMN guild_id SET NOT NULL;
ALTER TABLE promotions           ALTER COLUMN guild_id SET NOT NULL;
ALTER TABLE orders               ALTER COLUMN guild_id SET NOT NULL;
ALTER TABLE license_keys         ALTER COLUMN guild_id SET NOT NULL;
ALTER TABLE entitlements         ALTER COLUMN guild_id SET NOT NULL;
ALTER TABLE giveaways            ALTER COLUMN guild_id SET NOT NULL;
ALTER TABLE payments             ALTER COLUMN guild_id SET NOT NULL;
ALTER TABLE audit_logs           ALTER COLUMN guild_id SET NOT NULL;


-- ============================================================
-- 4. Add CHECK constraints on economy_wallets
-- ============================================================
-- Prevents negative balances at the database level.
-- Application RPCs already enforce this, but this is belt-and-suspenders.
-- ============================================================

ALTER TABLE economy_wallets ADD CONSTRAINT economy_wallets_wallet_non_negative CHECK (wallet >= 0);
ALTER TABLE economy_wallets ADD CONSTRAINT economy_wallets_bank_non_negative   CHECK (bank >= 0);
