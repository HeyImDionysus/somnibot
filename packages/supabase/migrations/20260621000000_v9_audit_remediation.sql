-- ══════════════════════════════════════════════════════════════
-- V9 Audit Remediation
-- ══════════════════════════════════════════════════════════════
--
-- 1. purge_member_data — add license key revocation + session cleanup
--    (§8.P3: /forgetme should revoke active license keys)
-- ══════════════════════════════════════════════════════════════

-- Re-create purge_member_data with license key handling
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

  DELETE FROM public.economy_market_listings
    WHERE guild_id = p_guild_id AND seller_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_market_listings', v_count);

  DELETE FROM public.economy_farm_plots
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_farm_plots', v_count);

  DELETE FROM public.economy_fish_catches
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_fish_catches', v_count);

  DELETE FROM public.economy_adventure_sessions
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_adventure_sessions', v_count);

  DELETE FROM public.economy_trivia_sessions
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_trivia_sessions', v_count);

  DELETE FROM public.economy_lottery_tickets
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_lottery_tickets', v_count);

  DELETE FROM public.economy_pets
    WHERE guild_id = p_guild_id AND owner_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_pets', v_count);

  DELETE FROM public.economy_quest_progress
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_quest_progress', v_count);

  DELETE FROM public.economy_user_achievements
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_user_achievements', v_count);

  DELETE FROM public.economy_prestige
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_prestige', v_count);

  DELETE FROM public.economy_profiles
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_profiles', v_count);

  DELETE FROM public.economy_heist_participants
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_heist_participants', v_count);

  DELETE FROM public.economy_daily_losses
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('economy_daily_losses', v_count);

  UPDATE public.economy_heists
  SET participants = array_remove(participants, p_user_id)
  WHERE guild_id = p_guild_id
    AND p_user_id = ANY(participants);

  -- ── Levels data ───────────────────────────────────────────

  DELETE FROM public.member_levels
    WHERE guild_id = p_guild_id AND member_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('member_levels', v_count);

  -- ── Members table ─────────────────────────────────────────

  DELETE FROM public.members
    WHERE guild_id = p_guild_id AND discord_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('members', v_count);

  -- ── License keys — revoke + deactivate sessions ───────────
  -- V9 Audit §8.P3: /forgetme should revoke active license keys
  -- bound to this Discord user. Sessions are cascaded via ON DELETE
  -- but we explicitly deactivate them first for a clean audit trail.

  UPDATE public.license_sessions
  SET active = false,
      deactivated_at = now(),
      deactivation_reason = 'entitlement_revoked'
  WHERE license_key_id IN (
    SELECT id FROM public.license_keys
    WHERE guild_id = p_guild_id AND bound_discord_id = p_user_id
  ) AND active = true;

  UPDATE public.license_keys
  SET status = 'revoked',
      revoked_at = now(),
      revocation_reason = 'user_data_purge'
  WHERE guild_id = p_guild_id
    AND bound_discord_id = p_user_id
    AND status IN ('active', 'pending_activation');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('license_keys_revoked', v_count);

  -- Revoke matching entitlements
  UPDATE public.entitlements
  SET status = 'cancelled',
      cancelled_at = now()
  WHERE guild_id = p_guild_id
    AND customer_id IN (
      SELECT c.id FROM public.customers c
      WHERE c.discord_id = p_user_id AND c.guild_id = p_guild_id
    )
    AND status IN ('active', 'pending', 'grace_period');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('entitlements_revoked', v_count);

  -- ── Poll votes ────────────────────────────────────────────

  DELETE FROM public.poll_votes
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('poll_votes', v_count);

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

  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_member_data(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_member_data(text, text) TO service_role;
