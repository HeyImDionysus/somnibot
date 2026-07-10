-- =============================================================================
-- bot_action_queue lane segregation — commerce vs game.
--
-- The queue carries two very different kinds of work:
--   - COMMERCE: real-money fulfillment for the paid store — entitlement
--     grant/revoke after PayPal payments (fulfill_*), paid customers'
--     receipt/license-key DM re-delivery (deliver_receipt), and Discord role
--     revocation after refunds/cancellations (revoke_roles).
--   - GAME: everything else — game-economy recovery jobs
--     (market_item_reconcile), dashboard CRUD, bulk member ops, config
--     reloads, sync repairs.
--
-- Owner requirement: commerce jobs can NEVER be starved or delayed by
-- game-job floods. The bot sweeps `ORDER BY lane, created_at` (lane values
-- are chosen so lexicographic ASC order IS priority order: 'commerce' <
-- 'game') and runs per-lane concurrency budgets on the Realtime path — see
-- packages/bot/src/services/action-queue-lanes.ts.
--
-- Classification is enforced HERE, by a BEFORE INSERT trigger, not in
-- producer code, deliberately:
--   1. It covers every producer — bot, dashboard API routes, the dashboard
--      DLQ-retry flow, and any future code — atomically at insert. No
--      producer can misroute a commerce action into the game lane (the
--      trigger overrides any client-supplied value).
--   2. Producers never write the column, so no insert can fail with an
--      undefined-column error in an environment where code runs ahead of
--      this migration. That matters most for deliver_receipt queueing: the
--      queue row is the only at-rest copy of the plaintext license key
--      (see PR #265), and its insert path must not gain new failure modes.
--
-- The TypeScript mirror of the classification list lives in
-- packages/bot/src/services/action-queue-lanes.ts (COMMERCE_LANE_ACTIONS);
-- a unit test pins the two lists to each other.
--
-- Existing RPCs (bot_action_queue_claim, bot_action_queue_recover_stale)
-- are intentionally untouched: they only flip status/retry bookkeeping, so
-- recovered rows keep their lane, and their signatures stay backward
-- compatible.
--
-- Forward-only. Grants mirror the lockdown posture of 20260709210000 /
-- 20260709220000 / 20260709230000 (service_role only).
-- =============================================================================

-- ── 1. Lane classification function ─────────────────────────
-- Single source of truth for action-type → lane. IMMUTABLE: pure function
-- of the action name. Keep the commerce list in lock-step with
-- COMMERCE_LANE_ACTIONS in packages/bot/src/services/action-queue-lanes.ts.
CREATE OR REPLACE FUNCTION public.bot_action_queue_lane_for_action(p_action TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_action IN (
      'fulfill_purchase',
      'fulfill_subscription',
      'fulfill_cancellation',
      'fulfill_suspension',
      'fulfill_giveaway_prize',
      'deliver_receipt',
      'revoke_roles'
    ) THEN 'commerce'
    ELSE 'game'
  END;
$$;

REVOKE ALL ON FUNCTION public.bot_action_queue_lane_for_action(TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bot_action_queue_lane_for_action(TEXT)
  TO service_role;

-- ── 2. lane column on the live queue ────────────────────────
-- DEFAULT 'game' so legacy writers (and the backfill window) are safe;
-- the trigger below stamps the real lane on every new insert.
ALTER TABLE public.bot_action_queue
  ADD COLUMN IF NOT EXISTS lane TEXT NOT NULL DEFAULT 'game'
    CHECK (lane IN ('commerce', 'game'));

-- Backfill pre-migration rows by action type (only commerce rows change —
-- everything else already holds the 'game' default).
UPDATE public.bot_action_queue
   SET lane = public.bot_action_queue_lane_for_action(action)
 WHERE lane IS DISTINCT FROM public.bot_action_queue_lane_for_action(action);

-- ── 3. Authoritative stamp trigger ──────────────────────────
-- BEFORE INSERT so the Realtime postgres_changes payload the bot receives
-- already carries the stamped lane. Derives from NEW.action and OVERRIDES
-- any client-supplied lane — classification cannot be spoofed or forgotten.
-- INSERT-only: `action` is immutable after enqueue (no UPDATE path changes
-- it), and the recover-stale RPC only touches status/retry columns.
CREATE OR REPLACE FUNCTION public.bot_action_queue_stamp_lane()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.lane := public.bot_action_queue_lane_for_action(NEW.action);
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.bot_action_queue_stamp_lane()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bot_action_queue_stamp_lane()
  TO service_role;

DROP TRIGGER IF EXISTS trg_bot_action_queue_stamp_lane ON public.bot_action_queue;
CREATE TRIGGER trg_bot_action_queue_stamp_lane
  BEFORE INSERT ON public.bot_action_queue
  FOR EACH ROW
  EXECUTE FUNCTION public.bot_action_queue_stamp_lane();

-- ── 4. Sweep/depth index ────────────────────────────────────
-- Serves both hot per-guild queries added by lane segregation:
--   - pending sweep: WHERE guild_id AND status='pending' AND next_retry_at
--     due, ORDER BY lane, created_at
--   - per-lane depth alert: COUNT WHERE guild_id AND lane AND status
-- guild_id leads (every query is guild-scoped); lane/status/next_retry_at
-- as specified for the lane work.
CREATE INDEX IF NOT EXISTS idx_bot_action_queue_lane_sweep
  ON public.bot_action_queue (guild_id, lane, status, next_retry_at);

-- ── 5. DLQ lane preservation ────────────────────────────────
-- Dead-lettered rows keep their lane so DLQ listings are self-describing
-- and a dashboard retry re-enters the queue at the right priority (the
-- live-queue trigger re-stamps on re-insert anyway; lane is a pure function
-- of `action`, so trigger-derived == preserved). Same trigger-not-code
-- rationale as the live queue: DLQ inserts are the last-resort persistence
-- of commerce payloads and must not gain failure modes from code running
-- ahead of this migration.
ALTER TABLE public.action_queue_dlq
  ADD COLUMN IF NOT EXISTS lane TEXT NOT NULL DEFAULT 'game'
    CHECK (lane IN ('commerce', 'game'));

UPDATE public.action_queue_dlq
   SET lane = public.bot_action_queue_lane_for_action(action)
 WHERE lane IS DISTINCT FROM public.bot_action_queue_lane_for_action(action);

DROP TRIGGER IF EXISTS trg_action_queue_dlq_stamp_lane ON public.action_queue_dlq;
CREATE TRIGGER trg_action_queue_dlq_stamp_lane
  BEFORE INSERT ON public.action_queue_dlq
  FOR EACH ROW
  EXECUTE FUNCTION public.bot_action_queue_stamp_lane();

-- ── 6. Per-lane depth-alert dedupe ──────────────────────────
-- The bot raises per-lane pending-depth alerts (alert_type
-- 'action_queue_depth_commerce' — critical, threshold >10 — and
-- 'action_queue_depth_game' — warning, threshold >100, the old single
-- queue-depth bar). Dedupe is atomic at the DB, same pattern as
-- 20260709170000_fraud_alert_dedupe_unique_index.sql: at most ONE
-- unresolved alert per guild per lane; the racing loser's INSERT fails
-- with 23505, which the bot treats as "already alerted" and refreshes the
-- existing row. Both alert_type values first ship with this migration, so
-- no pre-existing duplicates can exist and no defensive cleanup is needed.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_alerts_unresolved_action_queue_depth
  ON public.alerts (guild_id, alert_type)
  WHERE alert_type IN ('action_queue_depth_commerce', 'action_queue_depth_game')
    AND resolved = false;
