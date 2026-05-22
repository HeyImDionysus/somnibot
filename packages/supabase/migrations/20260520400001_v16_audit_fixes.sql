-- V16 Audit Fixes
-- 1. Add missing updated_at column to tickets table
--    ticket-service.ts orders by updated_at for inactivity checks, but the column didn't exist.
-- 2. Add trigger to auto-update tickets.updated_at on row changes.

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- Backfill: set updated_at to created_at for existing rows
UPDATE tickets SET updated_at = created_at WHERE updated_at IS NULL;

-- Auto-update trigger (reuses existing function from initial_schema)
DROP TRIGGER IF EXISTS set_tickets_updated_at ON tickets;
CREATE TRIGGER set_tickets_updated_at
  BEFORE UPDATE ON tickets
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
