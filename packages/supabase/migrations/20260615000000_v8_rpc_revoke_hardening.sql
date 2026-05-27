-- ============================================================
-- V8 Audit §5.P2a — REVOKE EXECUTE on 26 SECURITY DEFINER RPCs
-- ============================================================
-- These functions were created in migrations after v42 and never
-- added to any REVOKE block. Since PostgreSQL grants EXECUTE to
-- PUBLIC by default, they are callable via PostgREST RPC by any
-- user with the anon key — despite being SECURITY DEFINER.
--
-- Fix: REVOKE from anon, authenticated, and PUBLIC; GRANT to
-- service_role only (the bot and dashboard both use service_role).
-- ============================================================

DO $$
DECLARE
  fn TEXT;
BEGIN
  FOR fn IN
    SELECT unnest(ARRAY[
      'purge_member_data(text, text)',
      'purge_user_data(text, text)',
      'license_increment_failed_attempts(uuid, int)',
      'desired_state_add_role(text, jsonb)',
      'desired_state_update_role(text, text, jsonb)',
      'desired_state_remove_role(text, text)',
      'giveaway_atomic_end(uuid, text[], timestamptz)',
      'giveaway_atomic_reroll(uuid, text[])',
      'giveaway_add_entry(uuid, text)',
      'giveaway_remove_entry(uuid, text)',
      'poll_vote_single(uuid, uuid, text)',
      'cleanup_member_economy(text, text, text)',
      'unsuspend_member_economy(text, text)',
      'generate_order_number()',
      'increment_download_count(uuid)',
      'increment_profile_views(text, text)',
      'aggregate_member_levels(text)',
      'sum_guild_xp(text)',
      'lottery_increment_jackpot(uuid, int)',
      'array_append_heist_participant(uuid, text)',
      'seed_default_quest_templates(text)',
      'nextval_ticket()',
      'nextval_incident()',
      'increment_automation_count(uuid)',
      'reset_ticket_inactivity_warning()',
      'update_updated_at_column()'
    ])
  LOOP
    BEGIN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', fn);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    BEGIN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM authenticated', fn);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    BEGIN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM public', fn);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    BEGIN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;
END;
$$;
