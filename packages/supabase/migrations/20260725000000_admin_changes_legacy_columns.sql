-- Relax the superseded admin_changes columns so the table can actually be written.
--
-- 20260518000001_missing_tables.sql created admin_changes with change_type and
-- target_table as NOT NULL. 20260518200000_phase_d_sota.sql then introduced the
-- richer shape the product uses — action, target_type, undo_payload,
-- blast_radius — and added those columns to the existing table, but never
-- dropped or defaulted the two legacy NOT NULL columns.
--
-- Nothing has read change_type or target_table since; every writer supplies
-- action/target_type instead. So on any database built from this repository's
-- migrations, an insert of the current shape fails with:
--
--   null value in column "change_type" violates not-null constraint
--
-- The dashboard's own writer hit this too; it was invisible because callers
-- treat admin-change recording as best-effort and log rather than throw. The
-- practical effect was an Admin Changes page that could never fill up.
--
-- Backfill from the modern columns first so existing rows keep a sensible
-- value, then drop the constraints. The columns themselves are kept (dropping
-- them would break any external consumer reading the old names) but they are
-- now optional and unused.

UPDATE admin_changes
   SET change_type = COALESCE(change_type, action)
 WHERE change_type IS NULL;

UPDATE admin_changes
   SET target_table = COALESCE(target_table, target_type)
 WHERE target_table IS NULL;

ALTER TABLE admin_changes ALTER COLUMN change_type  DROP NOT NULL;
ALTER TABLE admin_changes ALTER COLUMN target_table DROP NOT NULL;

-- target_id has the same history: NOT NULL in the legacy table, plain TEXT in
-- the phase-D definition. Some changes genuinely have no single target (a
-- settings-wide edit), and the current shape declares it optional.
ALTER TABLE admin_changes ALTER COLUMN target_id DROP NOT NULL;

COMMENT ON COLUMN admin_changes.change_type IS
  'Deprecated: superseded by action. Nullable since 20260725000000.';
COMMENT ON COLUMN admin_changes.target_table IS
  'Deprecated: superseded by target_type. Nullable since 20260725000000.';
