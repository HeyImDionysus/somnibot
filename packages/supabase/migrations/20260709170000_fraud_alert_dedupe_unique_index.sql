-- =============================================================================
-- PR #263 codex P2: make fraud_check_failure alert dedupe atomic at the DB.
--
-- POST /api/license/validate raises an operator alert (alert_type =
-- 'fraud_check_failure') when its fire-and-forget fraud checks fail. The
-- dedupe was check-then-insert in application code: with the dashboard
-- running on multiple processes/serverless instances during the same outage,
-- two instances could both observe "no unresolved alert" before either
-- insert committed, producing duplicate alert rows. The alerts table only
-- has non-unique indexes, so nothing enforced the dedupe across instances.
--
-- Fix: partial unique index — at most ONE unresolved fraud_check_failure
-- alert per guild, enforced by the database. Scoped to this alert type and
-- resolved = false, so other alert types (memory_high, bot_offline, ...)
-- and resolved history rows are unaffected. Same pattern as
-- uniq_active_heist_per_guild (20260524000000): the racing loser's INSERT
-- fails with 23505, which the dashboard treats as dedupe success.
-- =============================================================================

-- Defensive cleanup so the unique index can build even if duplicate
-- unresolved rows already exist: keep the newest, resolve the rest.
-- (alert_type 'fraud_check_failure' first ships with PR #263, so in
-- practice this is a no-op.)
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY guild_id
           ORDER BY created_at DESC, id DESC
         ) AS rn
  FROM alerts
  WHERE alert_type = 'fraud_check_failure'
    AND resolved = false
)
UPDATE alerts a
   SET resolved    = true,
       resolved_at = now(),
       updated_at  = now()
  FROM ranked r
 WHERE a.id = r.id
   AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_alerts_unresolved_fraud_check_failure
  ON alerts (guild_id)
  WHERE alert_type = 'fraud_check_failure' AND resolved = false;
