-- V46 comprehensive audit fixes
-- 1. Atomic desired_state role mutations (fixes TOCTOU race condition)
-- 2. Atomic license key failed_attempts increment (fixes brute-force bypass)
-- 3. Per-section config watcher cooldown queue support (comment only — handled in code)

-- ─── 1. Atomic role add to desired state ────────────────────────
CREATE OR REPLACE FUNCTION desired_state_add_role(
  p_guild_id TEXT,
  p_role JSONB
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE guild_desired_state
  SET roles = COALESCE(roles, '[]'::jsonb) || p_role,
      updated_at = NOW()
  WHERE guild_id = p_guild_id;
END;
$$;

-- ─── 2. Atomic role update in desired state ─────────────────────
CREATE OR REPLACE FUNCTION desired_state_update_role(
  p_guild_id TEXT,
  p_template_key TEXT,
  p_updates JSONB
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_roles JSONB;
  v_idx INT;
  v_elem JSONB;
BEGIN
  SELECT roles INTO v_roles
  FROM guild_desired_state
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

  UPDATE guild_desired_state
  SET roles = v_roles, updated_at = NOW()
  WHERE guild_id = p_guild_id;
END;
$$;

-- ─── 3. Atomic role remove from desired state ──────────────────
CREATE OR REPLACE FUNCTION desired_state_remove_role(
  p_guild_id TEXT,
  p_template_key TEXT
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_roles JSONB;
  v_new_roles JSONB := '[]'::jsonb;
  v_elem JSONB;
  v_idx INT;
BEGIN
  SELECT roles INTO v_roles
  FROM guild_desired_state
  WHERE guild_id = p_guild_id
  FOR UPDATE;

  IF v_roles IS NULL THEN RETURN; END IF;

  FOR v_idx IN 0..jsonb_array_length(v_roles) - 1 LOOP
    v_elem := v_roles -> v_idx;
    IF v_elem ->> 'key' <> p_template_key THEN
      v_new_roles := v_new_roles || v_elem;
    END IF;
  END LOOP;

  UPDATE guild_desired_state
  SET roles = v_new_roles, updated_at = NOW()
  WHERE guild_id = p_guild_id;
END;
$$;

-- ─── 4. Atomic license key failed_attempts increment ────────────
-- Returns the new count so the caller can check the threshold in one round-trip.
CREATE OR REPLACE FUNCTION license_increment_failed_attempts(
  p_license_key_id UUID,
  p_suspend_threshold INT DEFAULT 50
)
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  v_new_count INT;
BEGIN
  UPDATE license_keys
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
