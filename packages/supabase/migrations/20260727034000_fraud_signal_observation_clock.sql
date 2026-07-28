-- =============================================================================
-- Give fraud detectors their own observation clock.
--
-- `updated_at` is generic row-maintenance metadata: operator note/status edits
-- legitimately change it. Using that column for the critical-signal burst
-- window let three annotations on old signals look like three new detections.
--
-- Historical rows are conservatively backfilled from `created_at`; an old
-- signal becomes current only after a detector observes it again. New direct
-- detector inserts receive the default, while the partial-index-aware RPC
-- advances the clock only when the incoming observation is at least as severe
-- as the unresolved signal. A delayed weaker observation cannot make an old
-- critical signal look newly critical.
-- =============================================================================

ALTER TABLE public.fraud_signals
  ADD COLUMN last_observed_at TIMESTAMPTZ;

UPDATE public.fraud_signals
   SET last_observed_at = COALESCE(
     created_at,
     updated_at,
     pg_catalog.clock_timestamp()
   )
 WHERE last_observed_at IS NULL;

ALTER TABLE public.fraud_signals
  ALTER COLUMN last_observed_at SET DEFAULT pg_catalog.now(),
  ALTER COLUMN last_observed_at SET NOT NULL;

COMMENT ON COLUMN public.fraud_signals.last_observed_at IS
  'Detector-owned observation time; operator edits must not change this value.';

CREATE INDEX idx_fraud_signals_critical_observation
  ON public.fraud_signals (guild_id, last_observed_at DESC)
  WHERE status = 'open' AND severity = 'critical';

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
    updated_at,
    last_observed_at
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
