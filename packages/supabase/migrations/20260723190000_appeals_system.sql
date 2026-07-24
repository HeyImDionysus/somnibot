-- =============================================================================
-- Moderation appeals lifecycle (moderation-infractions-appeals).
--
-- The catalog contracts a full appeal lifecycle — a punished member submits an
-- appeal against an infraction, a guild owner reviews it on the dashboard, and
-- the member is DM'd the decision — but no table existed. Add the owning table.
--
-- Lifecycle: pending -> approved | denied  (owner decision, dashboard-driven)
--            pending -> expired            (auto, past expires_at, bot sweep)
--
-- At most ONE pending appeal may exist per (guild, infraction): a partial unique
-- index enforces it, so a replayed / double /appeal submit dedups to a single
-- open request (the manager treats the resulting 23505 as "already pending").
--
-- `decision_notified` drives one-shot, idempotent DM delivery: a decision is
-- recorded (dashboard) independently of the Discord-side DM (bot), so the bot's
-- maintenance sweep can pick up decided-but-unnotified rows exactly once without
-- re-DMing on every pass. It is NOT part of the appeal state machine.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.appeals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id text NOT NULL REFERENCES public.guild(id) ON DELETE CASCADE,
  -- The infraction being appealed. CASCADE: if the infraction is hard-deleted
  -- (e.g. guild data purge) its appeals go with it.
  infraction_id uuid NOT NULL REFERENCES public.infractions(id) ON DELETE CASCADE,
  -- The Discord user who filed the appeal (== the infraction's member_id). Kept
  -- as its own column because a banned appellant may no longer be a guild member.
  appellant_discord_id text NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  -- Discord id of the reviewer who approved/denied (null while pending/expired).
  reviewer_id text,
  -- One-shot DM delivery latch (see header). Not a lifecycle column.
  decision_notified boolean NOT NULL DEFAULT false,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz
);

-- At most one OPEN appeal per infraction. A repeated submit resolves to a single
-- pending row (createAppeal treats the 23505 as a dedup no-op and reads it back).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_pending_appeal_per_infraction
  ON public.appeals (guild_id, infraction_id)
  WHERE status = 'pending';

-- Dashboard review list: newest-first per guild, optionally filtered by status.
CREATE INDEX IF NOT EXISTS idx_appeals_guild_status
  ON public.appeals (guild_id, status, created_at DESC);

-- `/appeal status`: a member's own appeals within a guild.
CREATE INDEX IF NOT EXISTS idx_appeals_appellant
  ON public.appeals (guild_id, appellant_discord_id, created_at DESC);

-- Expiry sweep: pending appeals past their expires_at.
CREATE INDEX IF NOT EXISTS idx_appeals_pending_expiry
  ON public.appeals (expires_at)
  WHERE status = 'pending' AND expires_at IS NOT NULL;

-- DM-delivery sweep: decided appeals whose member has not been notified yet.
CREATE INDEX IF NOT EXISTS idx_appeals_undelivered_decision
  ON public.appeals (guild_id)
  WHERE decision_notified = false AND status IN ('approved', 'denied');

-- Owner-only, mirroring the v6 hardening on the other moderation/commerce tables:
-- the bot and dashboard reach this table only through the service-role admin
-- client. Direct anon/authenticated access is revoked.
ALTER TABLE public.appeals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.appeals FROM PUBLIC, anon, authenticated, service_role;
CREATE POLICY service_role_all ON public.appeals
  FOR ALL TO service_role USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON public.appeals TO service_role;
