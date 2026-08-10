-- =============================================================================
-- Fishing catch idempotency: persist the cast correlation key.
--
-- A fishing cast already carries one operation id through the audit/event
-- surface, but economy_fish_catches did not retain it.  Persisting the same
-- key on the catch row makes a replay (including a process retry after the
-- Valkey occurrence claim) a durable no-op and lets payout recovery reuse the
-- original economy idempotency key.
--
-- The column remains nullable because historical catches have no trustworthy
-- operation identity.  They are intentionally not backfilled; inventing a
-- key from row metadata could collide with a future cast.  The partial unique
-- index scopes replay identity per guild while leaving legacy NULL rows and
-- callers that do not provide a correlation key unaffected.
-- =============================================================================

ALTER TABLE public.economy_fish_catches
  ADD COLUMN IF NOT EXISTS correlation_id text;

CREATE UNIQUE INDEX IF NOT EXISTS ux_fish_catches_guild_correlation
  ON public.economy_fish_catches (guild_id, correlation_id)
  WHERE correlation_id IS NOT NULL;
