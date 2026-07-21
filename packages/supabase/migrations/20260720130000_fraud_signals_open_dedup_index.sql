-- Fix: replayed commerce events duplicated fraud signals.
--
-- createSignal (packages/bot/src/services/fraud-detection.ts) inserts into
-- fraud_signals unconditionally with status='open' and no dedup key.
-- runFraudChecks re-runs per fulfillment / payment-failed event, and the
-- velocity/payment detectors re-evaluate the same order/payment set on
-- re-processing, so a re-delivered (at-least-once) webhook inserts a second
-- identical open signal. This violates the catalog replay-safety promise
-- "Re-processing the same commerce events never duplicates signals", and
-- duplicated 'critical' signals inflate checkCriticalThreshold (>=3), which
-- can falsely auto-open incidents.
--
-- Fence: at most one OPEN signal per (guild, signal_type, entity). Once a
-- signal is resolved (status <> 'open') the partial index stops covering it,
-- so the entity can legitimately be re-flagged later.

-- 1. Collapse any pre-existing duplicate OPEN signals so the unique index can
--    be built. Keep the earliest row per key; demote the rest to
--    'auto_resolved' (a valid status). Rows with NULL entity fields are left
--    alone — NULLs are distinct in a unique index and won't collide.
UPDATE public.fraud_signals f
  SET status = 'auto_resolved'
  WHERE f.status = 'open'
    AND f.entity_type IS NOT NULL
    AND f.entity_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.fraud_signals g
      WHERE g.guild_id = f.guild_id
        AND g.signal_type = f.signal_type
        AND g.entity_type = f.entity_type
        AND g.entity_id = f.entity_id
        AND g.status = 'open'
        AND (g.created_at < f.created_at
             OR (g.created_at = f.created_at AND g.id < f.id))
    );

-- 2. Idempotent partial unique index (one open signal per entity).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'uniq_open_signal_entity'
  ) THEN
    CREATE UNIQUE INDEX uniq_open_signal_entity
      ON public.fraud_signals (guild_id, signal_type, entity_type, entity_id)
      WHERE status = 'open';
  END IF;
END $$;
