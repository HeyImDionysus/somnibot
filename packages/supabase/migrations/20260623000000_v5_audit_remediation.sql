-- ============================================================
-- V5 Audit Remediation — §3.P3a + §14.P3b
-- ============================================================
-- §3.P3a: Add partial index on license_validations for rows
-- without a license_key_id (failed lookups). These are queried
-- for security analysis but were doing full-table scans.
--
-- §14.P3b: Add guild_id index on tables pruned by
-- prune_expired_data to support future guild-chunked batch
-- processing and improve current DELETE performance.
-- ============================================================

-- §3.P3a: Partial index for license validation audit queries
-- (only rows where the foreign key is NULL = failed lookups)
CREATE INDEX IF NOT EXISTS idx_license_validations_failed_lookups
  ON public.license_validations (created_at DESC)
  WHERE license_key_id IS NULL;

-- §14.P3b: Support efficient per-guild-id pruning.
-- Most pruned tables already have guild_id indexes from their
-- primary key or FK, but economy_transactions may not:
CREATE INDEX IF NOT EXISTS idx_economy_transactions_guild_updated
  ON public.economy_transactions (guild_id, created_at);
