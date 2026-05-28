-- V5 Audit §5.2 — Per-guild configurable data retention toggle.
--
-- Adds a data_retention_days column to guild_config with a sensible
-- default of 180 days. Guild owners can adjust this from the dashboard.
-- The cleanup_old_records RPC (v5_data_retention migration) already
-- handles the actual purging; this column stores the guild's preference.
--
-- Note: New retention periods start from the moment the setting is changed.
-- There is no retroactive rewind of data.

-- Add retention preference column
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'guild_config' AND column_name = 'data_retention_days'
  ) THEN
    ALTER TABLE guild_config
      ADD COLUMN data_retention_days INT NOT NULL DEFAULT 180;
  END IF;
END $$;

-- Ensure value is at least 30 days
ALTER TABLE guild_config
  DROP CONSTRAINT IF EXISTS chk_retention_min;
ALTER TABLE guild_config
  ADD CONSTRAINT chk_retention_min CHECK (data_retention_days >= 30);

-- Comment for clarity
COMMENT ON COLUMN guild_config.data_retention_days IS
  'Number of days to retain audit logs, transactions, etc. Minimum 30. Default 180.';
