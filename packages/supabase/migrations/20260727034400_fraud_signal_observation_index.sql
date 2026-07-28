-- Supabase CLI >= 2.110 executes CREATE INDEX CONCURRENTLY outside its normal
-- per-migration transaction. Keep this statement alone so detector writes and
-- dashboard threshold reads remain available throughout the history scan.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_fraud_signals_critical_observation
  ON public.fraud_signals (guild_id, last_observed_at DESC)
  WHERE status = 'open' AND severity = 'critical';
