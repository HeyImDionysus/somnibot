-- Fix: diagnostic alerts could open twice for one condition.
--
-- AlertManager.evaluate opens alerts via check-then-insert (SELECT the
-- unresolved row of this alert_type; if none, INSERT), with the only
-- cross-process guard being an in-memory Set that is empty on every fresh boot.
-- The alerts table has partial unique indexes for the commerce/fraud alert
-- types but NONE for the diagnostic types memory_high / ws_ping_high /
-- valkey_disconnected / lavalink_down. So two concurrent evaluations for the
-- same guild (multi-shard, or old+new process during a rolling restart) both
-- read zero and both INSERT → two unresolved rows of the same type and a double
-- owner notification, violating "exactly one unresolved alert opens per type".
--
-- Add the missing partial unique fence (mirrors the fraud/commerce controls).

-- Collapse any pre-existing duplicate unresolved diagnostic alerts so the index
-- can be built: keep the earliest per (guild, type), resolve the rest.
UPDATE public.alerts a
  SET resolved = true, resolved_at = COALESCE(a.resolved_at, now())
  WHERE a.resolved = false
    AND a.alert_type IN ('memory_high', 'ws_ping_high', 'valkey_disconnected', 'lavalink_down')
    AND EXISTS (
      SELECT 1 FROM public.alerts b
      WHERE b.guild_id = a.guild_id
        AND b.alert_type = a.alert_type
        AND b.resolved = false
        AND (b.created_at < a.created_at
             OR (b.created_at = a.created_at AND b.id < a.id))
    );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'uniq_alerts_unresolved_diagnostics'
  ) THEN
    CREATE UNIQUE INDEX uniq_alerts_unresolved_diagnostics
      ON public.alerts (guild_id, alert_type)
      WHERE alert_type IN ('memory_high', 'ws_ping_high', 'valkey_disconnected', 'lavalink_down')
        AND resolved = false;
  END IF;
END $$;
