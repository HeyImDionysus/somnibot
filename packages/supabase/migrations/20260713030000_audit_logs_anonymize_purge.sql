-- =============================================================================
-- Audit rows are NEVER deleted (owner decision, 2026-07-18).
--
-- trg_prevent_audit_log_delete stays unconditional. Tenant deletion
-- (purge_guild_data) and retention pruning (prune_expired_data) ANONYMIZE
-- instead: identity-bearing fields (actor/target ids, payload snapshots,
-- error text, correlation) are scrubbed while the forensic skeleton
-- (action, actor type, timestamp, outcome) is retained forever.
--
-- Tenant purge additionally DETACHES the scrubbed rows from the erased
-- guild so the guild row itself can be deleted: guild_id must therefore
-- accept NULL for anonymized orphans. Live audit writes still always carry
-- a guild binding — the bot and dashboard never insert NULL — and the FK
-- continues to validate every non-NULL binding.
-- =============================================================================
BEGIN;

ALTER TABLE public.audit_logs
  ALTER COLUMN guild_id DROP NOT NULL;

COMMIT;
