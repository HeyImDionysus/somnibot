-- ============================================================
-- V53 Phase 1.7: /forgetme data deletion
-- ============================================================
-- GDPR-style right-to-erasure. Cascading delete across all
-- member-specific tables for a given guild+user.
--
-- This does NOT delete guild-level config or item definitions —
-- only per-member data. Audit logs are anonymized, not deleted.
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

  -- Trivia sessions
  DELETE FROM economy_trivia_sessions
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_trivia_sessions', v_count);

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

  -- ── Levels data ───────────────────────────────────────────

  DELETE FROM member_levels
    WHERE guild_id = p_guild_id AND member_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('member_levels', v_count);

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
