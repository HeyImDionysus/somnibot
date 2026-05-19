-- Add inactivity_warned flag to tickets table for auto-close feature.
-- Resets to false whenever updated_at changes (new message activity).

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS inactivity_warned BOOLEAN DEFAULT false;

-- Reset the warning flag whenever a ticket gets new activity
CREATE OR REPLACE FUNCTION reset_ticket_inactivity_warning()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.updated_at IS DISTINCT FROM NEW.updated_at AND NEW.inactivity_warned = OLD.inactivity_warned THEN
    NEW.inactivity_warned := false;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reset_ticket_inactivity
  BEFORE UPDATE ON tickets
  FOR EACH ROW
  EXECUTE FUNCTION reset_ticket_inactivity_warning();
