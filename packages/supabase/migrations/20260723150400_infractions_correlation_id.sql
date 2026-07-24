-- =============================================================================
-- Infraction idempotency: persisted correlation key.
--
-- createInfraction was a bare INSERT with no correlation/idempotency key, and
-- infractions had only PRIMARY KEY(id) + non-unique member/active indexes. A
-- re-delivered /warn interaction (Discord gateway RESUME) or a mid-write retry
-- created a SECOND infraction row and could re-fire escalation.
--
-- Add a nullable correlation_id + a partial unique index so a replayed write is
-- rejected with 23505 (createInfraction treats that as a dedup no-op and reads
-- back the original row). Nullable + partial keeps every existing/automod row
-- (which pass no correlation_id) unaffected.
-- =============================================================================

ALTER TABLE public.infractions
  ADD COLUMN IF NOT EXISTS correlation_id text;

CREATE UNIQUE INDEX IF NOT EXISTS ux_infractions_guild_correlation
  ON public.infractions (guild_id, correlation_id)
  WHERE correlation_id IS NOT NULL;
