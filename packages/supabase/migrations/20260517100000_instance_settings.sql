-- Instance settings table for operator configuration.
-- Stores external connection credentials and feature flags.
-- All values are accessible only via service_role (server-side API routes).

CREATE TABLE IF NOT EXISTS instance_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  section TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Only service_role can access (secrets are stored here)
GRANT ALL ON instance_settings TO service_role;
ALTER TABLE instance_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access"
  ON instance_settings
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
