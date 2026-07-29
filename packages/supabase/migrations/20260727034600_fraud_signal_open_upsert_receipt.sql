-- =============================================================================
-- Give bot callers an atomic create-vs-refresh receipt.
--
-- The legacy RPC returns only the signal UUID. That is sufficient for dashboard
-- refreshes, but the bot must emit fraud.detected only for a newly created row.
-- A preflight SELECT cannot prove that distinction because another detector can
-- insert between the read and the UPSERT.
--
-- Generate the prospective row UUID before the single UPSERT instead. The
-- resulting row keeps that UUID only on INSERT; the conflict branch returns the
-- already-open row's UUID. Comparing those values inside the same statement is
-- an atomic created witness without depending on PostgreSQL system columns.
--
-- The UUID-returning function remains as a compatibility wrapper so deployed
-- dashboard callers do not need to change in lockstep with the bot.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fraud_upsert_open_signal_receipt(
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
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_candidate_id UUID := pg_catalog.gen_random_uuid();
  v_signal_id UUID;
  v_created BOOLEAN;
  v_guild_id TEXT;
  v_signal_type TEXT;
  v_entity_type TEXT;
  v_entity_id TEXT;
  v_status TEXT;
  v_severity TEXT;
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
    id,
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
    updated_at,
    last_observed_at
  ) VALUES (
    v_candidate_id,
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
    pg_catalog.clock_timestamp(),
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
    updated_at = pg_catalog.clock_timestamp(),
    last_observed_at = CASE
      WHEN v_incoming_rank >= CASE existing.severity
        WHEN 'low' THEN 1
        WHEN 'medium' THEN 2
        WHEN 'high' THEN 3
        WHEN 'critical' THEN 4
        ELSE 0
      END
        THEN EXCLUDED.last_observed_at
      ELSE existing.last_observed_at
    END
  RETURNING
    existing.id,
    existing.id = v_candidate_id,
    existing.guild_id,
    existing.signal_type,
    existing.entity_type,
    existing.entity_id,
    existing.status,
    existing.severity
  INTO
    v_signal_id,
    v_created,
    v_guild_id,
    v_signal_type,
    v_entity_type,
    v_entity_id,
    v_status,
    v_severity;

  RETURN pg_catalog.jsonb_build_object(
    'signal_id', v_signal_id,
    'created', v_created,
    'guild_id', v_guild_id,
    'signal_type', v_signal_type,
    'entity_type', v_entity_type,
    'entity_id', v_entity_id,
    'status', v_status,
    'severity', v_severity
  );
END;
$$;

REVOKE ALL ON FUNCTION public.fraud_upsert_open_signal_receipt(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.fraud_upsert_open_signal_receipt(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT
) TO service_role;

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
  v_receipt JSONB;
BEGIN
  v_receipt := public.fraud_upsert_open_signal_receipt(
    p_guild_id,
    p_signal_type,
    p_severity,
    p_entity_type,
    p_entity_id,
    p_discord_id,
    p_description,
    p_evidence,
    p_auto_action
  );

  RETURN (v_receipt ->> 'signal_id')::UUID;
END;
$$;

REVOKE ALL ON FUNCTION public.fraud_upsert_open_signal(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.fraud_upsert_open_signal(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT
) TO service_role;
