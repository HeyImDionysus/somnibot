-- =============================================================================
-- Atomically create or refresh one OPEN fraud signal per entity.
--
-- `uniq_open_signal_entity` is a partial unique index:
--
--   (guild_id, signal_type, entity_type, entity_id) WHERE status = 'open'
--
-- A normal PostgREST upsert cannot name the index predicate, so repeated
-- dashboard detections used a bare INSERT, received 23505, and were reported
-- as a detector outage. The original row also kept stale evidence and could
-- never escalate from high to critical.
--
-- This backend-only RPC expresses the partial conflict target exactly.
-- Severity is monotonic: a delayed weaker observation cannot silently
-- downgrade an unresolved critical signal. Evidence and description refresh
-- when the observation is at least as strong. Once an operator changes the
-- row away from `open`, it leaves the partial index and a later observation
-- creates a new row, preserving the resolved history.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fraud_upsert_open_signal(
  p_guild_id TEXT,
  p_signal_type TEXT,
  p_severity TEXT,
  p_entity_type TEXT,
  p_entity_id TEXT,
  p_discord_id TEXT,
  p_description TEXT,
  p_evidence JSONB,
  p_auto_action TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_signal_id UUID;
  v_incoming_rank INT;
BEGIN
  IF p_guild_id IS NULL OR pg_catalog.btrim(p_guild_id) = ''
     OR p_signal_type IS NULL OR pg_catalog.btrim(p_signal_type) = ''
     OR p_entity_type IS NULL OR pg_catalog.btrim(p_entity_type) = ''
     OR p_entity_id IS NULL OR pg_catalog.btrim(p_entity_id) = ''
     OR p_description IS NULL OR pg_catalog.btrim(p_description) = '' THEN
    RAISE EXCEPTION 'fraud signal identity and description are required'
      USING ERRCODE = '22023';
  END IF;

  v_incoming_rank := CASE p_severity
    WHEN 'low' THEN 1
    WHEN 'medium' THEN 2
    WHEN 'high' THEN 3
    WHEN 'critical' THEN 4
    ELSE 0
  END;

  IF v_incoming_rank = 0 THEN
    RAISE EXCEPTION 'unsupported fraud signal severity'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.fraud_signals AS existing (
    guild_id,
    signal_type,
    severity,
    entity_type,
    entity_id,
    discord_id,
    description,
    evidence,
    status,
    auto_action,
    updated_at
  ) VALUES (
    p_guild_id,
    p_signal_type,
    p_severity,
    p_entity_type,
    p_entity_id,
    p_discord_id,
    p_description,
    COALESCE(p_evidence, '{}'::JSONB),
    'open',
    p_auto_action,
    pg_catalog.clock_timestamp()
  )
  ON CONFLICT (guild_id, signal_type, entity_type, entity_id)
    WHERE status = 'open'
  DO UPDATE SET
    severity = CASE
      WHEN v_incoming_rank >= CASE existing.severity
        WHEN 'low' THEN 1
        WHEN 'medium' THEN 2
        WHEN 'high' THEN 3
        WHEN 'critical' THEN 4
        ELSE 0
      END
        THEN EXCLUDED.severity
      ELSE existing.severity
    END,
    discord_id = COALESCE(EXCLUDED.discord_id, existing.discord_id),
    description = CASE
      WHEN v_incoming_rank >= CASE existing.severity
        WHEN 'low' THEN 1
        WHEN 'medium' THEN 2
        WHEN 'high' THEN 3
        WHEN 'critical' THEN 4
        ELSE 0
      END
        THEN EXCLUDED.description
      ELSE existing.description
    END,
    evidence = CASE
      WHEN v_incoming_rank >= CASE existing.severity
        WHEN 'low' THEN 1
        WHEN 'medium' THEN 2
        WHEN 'high' THEN 3
        WHEN 'critical' THEN 4
        ELSE 0
      END
        THEN EXCLUDED.evidence
      ELSE existing.evidence
    END,
    auto_action = CASE
      WHEN v_incoming_rank >= CASE existing.severity
        WHEN 'low' THEN 1
        WHEN 'medium' THEN 2
        WHEN 'high' THEN 3
        WHEN 'critical' THEN 4
        ELSE 0
      END
        THEN COALESCE(EXCLUDED.auto_action, existing.auto_action)
      ELSE existing.auto_action
    END,
    -- `updated_at` is the observation time used by the critical-burst
    -- threshold. A weaker delayed observation must not make an old critical
    -- signal look newly critical.
    updated_at = CASE
      WHEN v_incoming_rank >= CASE existing.severity
        WHEN 'low' THEN 1
        WHEN 'medium' THEN 2
        WHEN 'high' THEN 3
        WHEN 'critical' THEN 4
        ELSE 0
      END
        THEN pg_catalog.clock_timestamp()
      ELSE existing.updated_at
    END
  RETURNING id INTO v_signal_id;

  RETURN v_signal_id;
END;
$$;

REVOKE ALL ON FUNCTION public.fraud_upsert_open_signal(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.fraud_upsert_open_signal(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT
) TO service_role;
