-- ═══════════════════════════════════════════════════════════════════════
-- V53 Final Audit Fixes
-- Addresses 2 MEDIUM findings from the V53 independent audit.
-- ═══════════════════════════════════════════════════════════════════════

-- ─── MEDIUM-1: Enable RLS on reconciliation_runs ────────────────────
-- 101 of 103 tables had RLS enabled; this one was missed.
ALTER TABLE IF EXISTS reconciliation_runs ENABLE ROW LEVEL SECURITY;

-- ─── MEDIUM-2: Harden 5 RPCs with SECURITY DEFINER + search_path ───
-- These functions were created without SECURITY DEFINER and SET
-- search_path, and were never included in any REVOKE EXECUTE loop.

-- 1. desired_state_add_role
CREATE OR REPLACE FUNCTION desired_state_add_role(
  p_guild_id TEXT,
  p_role JSONB
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.guild_desired_state
  SET roles = COALESCE(roles, '[]'::jsonb) || p_role,
      updated_at = NOW()
  WHERE guild_id = p_guild_id;
END;
$$;

-- 2. desired_state_update_role
CREATE OR REPLACE FUNCTION desired_state_update_role(
  p_guild_id TEXT,
  p_template_key TEXT,
  p_updates JSONB
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_roles JSONB;
  v_idx INT;
  v_elem JSONB;
BEGIN
  SELECT roles INTO v_roles
  FROM public.guild_desired_state
  WHERE guild_id = p_guild_id
  FOR UPDATE;

  IF v_roles IS NULL THEN RETURN; END IF;

  FOR v_idx IN 0..jsonb_array_length(v_roles) - 1 LOOP
    v_elem := v_roles -> v_idx;
    IF v_elem ->> 'key' = p_template_key THEN
      v_roles := jsonb_set(v_roles, ARRAY[v_idx::text], v_elem || p_updates);
      EXIT;
    END IF;
  END LOOP;

  UPDATE public.guild_desired_state
  SET roles = v_roles, updated_at = NOW()
  WHERE guild_id = p_guild_id;
END;
$$;

-- 3. desired_state_remove_role
CREATE OR REPLACE FUNCTION desired_state_remove_role(
  p_guild_id TEXT,
  p_template_key TEXT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_roles JSONB;
  v_new_roles JSONB := '[]'::jsonb;
  v_elem JSONB;
  v_idx INT;
BEGIN
  SELECT roles INTO v_roles
  FROM public.guild_desired_state
  WHERE guild_id = p_guild_id
  FOR UPDATE;

  IF v_roles IS NULL THEN RETURN; END IF;

  FOR v_idx IN 0..jsonb_array_length(v_roles) - 1 LOOP
    v_elem := v_roles -> v_idx;
    IF v_elem ->> 'key' <> p_template_key THEN
      v_new_roles := v_new_roles || v_elem;
    END IF;
  END LOOP;

  UPDATE public.guild_desired_state
  SET roles = v_new_roles, updated_at = NOW()
  WHERE guild_id = p_guild_id;
END;
$$;

-- 4. license_increment_failed_attempts
CREATE OR REPLACE FUNCTION license_increment_failed_attempts(
  p_license_key_id UUID,
  p_suspend_threshold INT DEFAULT 50
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_new_count INT;
BEGIN
  UPDATE public.license_keys
  SET failed_attempts = failed_attempts + 1,
      last_failed_at = NOW(),
      status = CASE
        WHEN failed_attempts + 1 >= p_suspend_threshold THEN 'suspended'
        ELSE status
      END,
      revocation_reason = CASE
        WHEN failed_attempts + 1 >= p_suspend_threshold THEN 'auto_suspended_abuse'
        ELSE revocation_reason
      END
  WHERE id = p_license_key_id
  RETURNING failed_attempts INTO v_new_count;

  RETURN COALESCE(v_new_count, 0);
END;
$$;

-- 5. update_updated_at_column (trigger function)
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ─── Revoke EXECUTE from anon/authenticated/public, grant to service_role ───
DO $$
DECLARE
  fn TEXT;
BEGIN
  FOR fn IN SELECT unnest(ARRAY[
    'desired_state_add_role(text, jsonb)',
    'desired_state_update_role(text, text, jsonb)',
    'desired_state_remove_role(text, text)',
    'license_increment_failed_attempts(uuid, int)',
    'update_updated_at_column()'
  ])
  LOOP
    BEGIN EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon',          fn); EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM authenticated', fn); EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM public',        fn); EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN EXECUTE format('GRANT  EXECUTE ON FUNCTION %s TO   service_role',  fn); EXCEPTION WHEN OTHERS THEN NULL; END;
  END LOOP;
END;
$$;
