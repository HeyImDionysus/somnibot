-- Add total_roles column to guild table for dashboard display
ALTER TABLE guild ADD COLUMN IF NOT EXISTS total_roles INTEGER;
