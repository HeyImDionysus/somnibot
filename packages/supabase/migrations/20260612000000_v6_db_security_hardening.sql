-- ============================================================
-- V6 Audit: DB Security Hardening
-- ============================================================
-- 1. Fix 4 SECURITY DEFINER functions missing SET search_path = ''
-- 2. REVOKE table access from anon/authenticated on 32 sensitive tables
-- 3. REVOKE EXECUTE on the 4 patched functions from anon/authenticated/public
-- ============================================================

-- ── 1. Fix SECURITY DEFINER functions missing search_path ──────────

-- 1a. bulk_reset_economy (last defined in v53_phase4_infrastructure.sql)
ALTER FUNCTION public.bulk_reset_economy(text, text[])
  SET search_path = '';

-- 1b. cleanup_old_health_metrics (last defined in v53_phase2_observability.sql)
ALTER FUNCTION public.cleanup_old_health_metrics()
  SET search_path = '';

-- 1c. economy_heist_join (last defined in codex_cross_reference_fixes.sql)
ALTER FUNCTION public.economy_heist_join(UUID, text)
  SET search_path = '';

-- 1d. purge_user_data (last defined in v53_dead_table_cleanup.sql)
ALTER FUNCTION public.purge_user_data(text, text)
  SET search_path = '';


-- ── 2. REVOKE EXECUTE from anon/authenticated/public on the 4 patched functions ──

REVOKE ALL ON FUNCTION public.bulk_reset_economy(text, text[])
  FROM anon, authenticated, public;

REVOKE ALL ON FUNCTION public.cleanup_old_health_metrics()
  FROM anon, authenticated, public;

REVOKE ALL ON FUNCTION public.economy_heist_join(UUID, text)
  FROM anon, authenticated, public;

REVOKE ALL ON FUNCTION public.purge_user_data(text, text)
  FROM anon, authenticated, public;


-- ── 3. Lock down 32 tables that have USING(true) RLS policies ──────
-- The bot and dashboard exclusively use service_role (bypasses RLS).
-- anon/authenticated should have zero access to these tables.
-- This is idempotent — REVOKE is a no-op if grants don't exist.

DO $$
DECLARE
  tbl TEXT;
  tables_to_lock TEXT[] := ARRAY[
    'admin_changes',
    'automation_executions',
    'automations',
    'dashboard_roles',
    'dashboard_user_roles',
    'dead_letter_queue',
    'economy_achievement_defs',
    'economy_crops',
    'economy_farm_plots',
    'economy_heist_participants',
    'economy_heists',
    'economy_inventory',
    'economy_items',
    'economy_loot_tables',
    'economy_pet_battles',
    'economy_pets',
    'economy_prestige',
    'economy_profiles',
    'economy_quest_progress',
    'economy_quest_templates',
    'economy_recipes',
    'economy_role_income',
    'economy_streaks',
    'economy_transactions',
    'economy_user_achievements',
    'economy_wallets',
    'fraud_rules',
    'fraud_signals',
    'incident_events',
    'incidents',
    'portal_sessions',
    'workflow_events'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables_to_lock LOOP
    BEGIN
      EXECUTE format('REVOKE ALL ON %I FROM anon', tbl);
      EXECUTE format('REVOKE ALL ON %I FROM authenticated', tbl);
    EXCEPTION WHEN undefined_table THEN
      RAISE NOTICE 'Table % does not exist — skipping REVOKE', tbl;
    END;
  END LOOP;
END
$$;
