-- V53 Phase 6.1 — Dead Table Cleanup
--
-- economy_trivia_sessions: Created in v31 but never read/written by bot or dashboard.
-- Trivia uses Valkey for session state. The forgetme RPC row is removed below.
--
-- server_templates: Created in initial schema, type exists in shared/database.ts,
-- but never read/written. guild_desired_state.server_template_id references it
-- but is also never used.

-- ============================================================
-- 1. Drop economy_trivia_sessions
-- ============================================================
DROP POLICY IF EXISTS "trivia_sessions_guild_access" ON economy_trivia_sessions;
DROP TABLE IF EXISTS economy_trivia_sessions;

-- ============================================================
-- 2. Drop server_template_id from guild_desired_state
-- ============================================================
ALTER TABLE guild_desired_state DROP COLUMN IF EXISTS server_template_id;

-- ============================================================
-- 3. Drop server_templates table
-- ============================================================
DROP POLICY IF EXISTS "owner_full_access" ON server_templates;
DROP TRIGGER IF EXISTS update_server_templates_updated_at ON server_templates;
DROP TABLE IF EXISTS server_templates;

-- ============================================================
-- 4. Update forgetme RPC to skip economy_trivia_sessions
-- ============================================================
-- The v53_forgetme migration included DELETE FROM economy_trivia_sessions.
-- Since the table is now dropped, recreate the function without that line.
CREATE OR REPLACE FUNCTION purge_user_data(
  p_guild_id TEXT,
  p_user_discord_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_deleted JSONB := '{}'::JSONB;
  v_count INT;
BEGIN
  -- Economy tables
  DELETE FROM economy_wallets WHERE guild_id = p_guild_id AND user_id IN (
    SELECT id FROM members WHERE guild_id = p_guild_id AND discord_id = p_user_discord_id
  );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_wallets', v_count);

  DELETE FROM economy_transactions WHERE guild_id = p_guild_id AND user_id IN (
    SELECT id FROM members WHERE guild_id = p_guild_id AND discord_id = p_user_discord_id
  );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_transactions', v_count);

  DELETE FROM economy_market_listings WHERE guild_id = p_guild_id AND seller_id IN (
    SELECT id FROM members WHERE guild_id = p_guild_id AND discord_id = p_user_discord_id
  );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_market_listings', v_count);

  DELETE FROM economy_inventories WHERE guild_id = p_guild_id AND user_id IN (
    SELECT id FROM members WHERE guild_id = p_guild_id AND discord_id = p_user_discord_id
  );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_inventories', v_count);

  DELETE FROM economy_streaks WHERE guild_id = p_guild_id AND user_id IN (
    SELECT id FROM members WHERE guild_id = p_guild_id AND discord_id = p_user_discord_id
  );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_streaks', v_count);

  DELETE FROM economy_farm_plots WHERE guild_id = p_guild_id AND user_id IN (
    SELECT id FROM members WHERE guild_id = p_guild_id AND discord_id = p_user_discord_id
  );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_farm_plots', v_count);

  DELETE FROM economy_fish_catches WHERE guild_id = p_guild_id AND user_id IN (
    SELECT id FROM members WHERE guild_id = p_guild_id AND discord_id = p_user_discord_id
  );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_fish_catches', v_count);

  DELETE FROM economy_adventure_sessions WHERE guild_id = p_guild_id AND user_id IN (
    SELECT id FROM members WHERE guild_id = p_guild_id AND discord_id = p_user_discord_id
  );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_adventure_sessions', v_count);

  -- economy_trivia_sessions dropped in v53 — trivia uses Valkey

  DELETE FROM economy_lottery_tickets WHERE guild_id = p_guild_id AND user_id IN (
    SELECT id FROM members WHERE guild_id = p_guild_id AND discord_id = p_user_discord_id
  );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_lottery_tickets', v_count);

  DELETE FROM economy_pets WHERE guild_id = p_guild_id AND owner_id IN (
    SELECT id FROM members WHERE guild_id = p_guild_id AND discord_id = p_user_discord_id
  );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_pets', v_count);

  DELETE FROM economy_quest_progress WHERE guild_id = p_guild_id AND user_id IN (
    SELECT id FROM members WHERE guild_id = p_guild_id AND discord_id = p_user_discord_id
  );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_quest_progress', v_count);

  DELETE FROM economy_user_achievements WHERE guild_id = p_guild_id AND user_id IN (
    SELECT id FROM members WHERE guild_id = p_guild_id AND discord_id = p_user_discord_id
  );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_user_achievements', v_count);

  DELETE FROM economy_prestige WHERE guild_id = p_guild_id AND user_id IN (
    SELECT id FROM members WHERE guild_id = p_guild_id AND discord_id = p_user_discord_id
  );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_prestige', v_count);

  -- XP / levels
  DELETE FROM xp_history WHERE guild_id = p_guild_id AND user_id IN (
    SELECT id FROM members WHERE guild_id = p_guild_id AND discord_id = p_user_discord_id
  );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('xp_history', v_count);

  -- Infractions
  DELETE FROM infractions WHERE guild_id = p_guild_id AND user_discord_id = p_user_discord_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('infractions', v_count);

  -- Tickets
  DELETE FROM tickets WHERE guild_id = p_guild_id AND creator_discord_id = p_user_discord_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('tickets', v_count);

  -- Member record itself (last)
  DELETE FROM members WHERE guild_id = p_guild_id AND discord_id = p_user_discord_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('members', v_count);

  RETURN v_deleted;
END;
$$;
