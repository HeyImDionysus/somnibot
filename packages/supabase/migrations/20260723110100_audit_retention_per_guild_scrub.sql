-- =============================================================================
-- Honor the per-guild data_retention_days preference for audit anonymization.
--
-- Before: guild_config.data_retention_days was an inert knob for audit_logs.
-- The nightly `retention-audit-scrub` cron ran a hard-coded
-- `scrub_expired_audit_logs(90)` — a GLOBAL scrub on a fixed 90-day window that
-- never read the owner's per-guild setting. So audit rows were always
-- anonymized on 90 days regardless of the owner choosing (say) 180, and any
-- setting < 60 could never scrub at all (the scrub RAISEs below 60).
--
-- After: a per-guild driver loops guild_config and anonymizes each guild's
-- audit_logs on its own window, clamped to the >= 60-day anonymize floor
-- (GREATEST(data_retention_days, 60)) so a longer preference is honored while
-- the forensic floor still holds. The cron now calls the driver.
--
-- Note: the anonymize FLOOR stays at 60 days. data_retention_days keeps its
-- 30-day minimum for non-audit data; for audit anonymization anything below 60
-- is clamped up to 60 (documented in the retention API route note).
-- =============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.scrub_expired_audit_logs_all_guilds()
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  total_scrubbed BIGINT := 0;
  batch_rows BIGINT;
  g RECORD;
BEGIN
  FOR g IN
    SELECT guild_id, data_retention_days
      FROM public.guild_config
     WHERE guild_id IS NOT NULL
  LOOP
    UPDATE public.audit_logs
       SET actor_id = 'anonymized',
           target_id = CASE WHEN target_id IS NULL THEN NULL ELSE 'anonymized' END,
           details = pg_catalog.jsonb_build_object('anonymized', true),
           before_state = NULL,
           after_state = NULL,
           error_message = NULL,
           correlation_id = NULL
     WHERE guild_id = g.guild_id
       AND "timestamp" < pg_catalog.now()
           - (GREATEST(COALESCE(g.data_retention_days, 90), 60) || ' days')::INTERVAL
       AND actor_id IS DISTINCT FROM 'anonymized';
    GET DIAGNOSTICS batch_rows = ROW_COUNT;
    total_scrubbed := total_scrubbed + batch_rows;
  END LOOP;

  RETURN total_scrubbed;
END;
$$;

REVOKE ALL ON FUNCTION public.scrub_expired_audit_logs_all_guilds()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scrub_expired_audit_logs_all_guilds() TO service_role;

-- Re-point the nightly scrub at the per-guild driver.
SELECT cron.unschedule('retention-audit-scrub')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'retention-audit-scrub');

SELECT cron.schedule(
  'retention-audit-scrub',
  '10 3 * * *',
  $$SELECT public.scrub_expired_audit_logs_all_guilds()$$
);

COMMIT;
