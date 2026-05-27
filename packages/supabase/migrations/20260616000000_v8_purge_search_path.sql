-- ============================================================
-- V8 Audit §5.P3a — Fix purge_member_data search_path
-- ============================================================
-- The function used SET search_path = public with unqualified table
-- names.  Every other SECURITY DEFINER function in the codebase uses
-- SET search_path = '' with fully-qualified public.table references.
-- This migration rewrites the function to match the convention,
-- closing a theoretical search_path hijack vector.
-- ============================================================

CREATE OR REPLACE FUNCTION public.purge_member_data(
  p_guild_id text,
  p_user_id  text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_deleted jsonb := '{}'::jsonb;
  v_count   int;
BEGIN
  -- ── Economy data ──────────────────────────────────────────

  DELETE FROM public.economy_wallets
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_wallets', v_count);

  DELETE FROM public.economy_transactions
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_transactions', v_count);

  DELETE FROM public.economy_inventory
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_inventory', v_count);

  DELETE FROM public.economy_streaks
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_streaks', v_count);

  -- Market listings by this user
  DELETE FROM public.economy_market_listings
    WHERE guild_id = p_guild_id AND seller_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_market_listings', v_count);

  -- Farm plots
  DELETE FROM public.economy_farm_plots
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_farm_plots', v_count);

  -- Fish catches
  DELETE FROM public.economy_fish_catches
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_fish_catches', v_count);

  -- Adventure sessions
  DELETE FROM public.economy_adventure_sessions
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_adventure_sessions', v_count);

  -- economy_trivia_sessions: table dropped in v53_dead_table_cleanup — trivia uses Valkey

  -- Lottery tickets
  DELETE FROM public.economy_lottery_tickets
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_lottery_tickets', v_count);

  -- Pets
  DELETE FROM public.economy_pets
    WHERE guild_id = p_guild_id AND owner_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_pets', v_count);

  -- Pet battles — anonymize rather than delete (preserves game history)
  UPDATE public.economy_pet_battles
  SET challenger_id = CASE WHEN challenger_id = p_user_id THEN 'deleted_user' ELSE challenger_id END,
      defender_id   = CASE WHEN defender_id = p_user_id   THEN 'deleted_user' ELSE defender_id END,
      winner_id     = CASE WHEN winner_id = p_user_id     THEN 'deleted_user' ELSE winner_id END
  WHERE guild_id = p_guild_id
    AND (challenger_id = p_user_id OR defender_id = p_user_id);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_pet_battles_anonymized', v_count);

  -- Quest progress
  DELETE FROM public.economy_quest_progress
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_quest_progress', v_count);

  -- Achievements
  DELETE FROM public.economy_user_achievements
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_user_achievements', v_count);

  -- Prestige
  DELETE FROM public.economy_prestige
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_prestige', v_count);

  -- Profiles
  DELETE FROM public.economy_profiles
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_profiles', v_count);

  -- Heist participation
  DELETE FROM public.economy_heist_participants
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_heist_participants', v_count);

  -- Daily losses
  DELETE FROM public.economy_daily_losses
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_daily_losses', v_count);

  -- Also remove from heist participants arrays
  UPDATE public.economy_heists
  SET participants = array_remove(participants, p_user_id)
  WHERE guild_id = p_guild_id
    AND p_user_id = ANY(participants);

  -- Poll votes
  DELETE FROM public.poll_votes
    WHERE user_id = p_user_id
      AND poll_id IN (SELECT id FROM public.polls WHERE guild_id = p_guild_id);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('poll_votes', v_count);

  -- ── Levels data ───────────────────────────────────────────

  DELETE FROM public.member_levels
    WHERE guild_id = p_guild_id AND member_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('member_levels', v_count);

  -- ── Infractions — anonymize, don't delete (mod records) ───

  UPDATE public.infractions
  SET member_id = 'deleted_user'
  WHERE guild_id = p_guild_id AND member_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('infractions_anonymized', v_count);

  -- ── Members table ─────────────────────────────────────────

  DELETE FROM public.members
    WHERE guild_id = p_guild_id AND discord_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('members', v_count);

  -- ── Tickets — anonymize, don't delete (operational data) ──

  UPDATE public.tickets
  SET creator_id = 'deleted_user'
  WHERE guild_id = p_guild_id AND creator_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('tickets_anonymized', v_count);

  -- ── Audit logs — anonymize actor/target ───────────────────

  UPDATE public.audit_logs
  SET details = details || '{"anonymized": true}'::jsonb
  WHERE guild_id = p_guild_id
    AND (
      (actor_type = 'user' AND actor_id = p_user_id)
      OR (target_type = 'member' AND target_id = p_user_id)
    );

  -- ── Giveaway entries — remove ─────────────────────────────

  UPDATE public.giveaways
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

REVOKE ALL ON FUNCTION public.purge_member_data(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_member_data(text, text) TO service_role;
