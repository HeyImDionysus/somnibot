-- Phase 8: Automation Engine helpers
-- ============================================================

-- RPC to atomically increment automation execution count
CREATE OR REPLACE FUNCTION increment_automation_count(automation_uuid UUID)
RETURNS void AS $$
BEGIN
  UPDATE automations
  SET execution_count = COALESCE(execution_count, 0) + 1,
      last_executed_at = now()
  WHERE id = automation_uuid;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Index for execution log queries
CREATE INDEX IF NOT EXISTS idx_automation_executions_automation_id
  ON automation_executions(automation_id);

CREATE INDEX IF NOT EXISTS idx_automation_executions_created_at
  ON automation_executions(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_automations_guild_enabled
  ON automations(guild_id, enabled);

-- Enable RLS on automations and automation_executions
ALTER TABLE automations ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_executions ENABLE ROW LEVEL SECURITY;

-- RLS policies (service role bypasses, auth users can read their guild's data)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'automations' AND policyname = 'automations_select') THEN
    CREATE POLICY automations_select ON automations FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'automations' AND policyname = 'automations_all') THEN
    CREATE POLICY automations_all ON automations FOR ALL USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'automation_executions' AND policyname = 'executions_select') THEN
    CREATE POLICY executions_select ON automation_executions FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'automation_executions' AND policyname = 'executions_insert') THEN
    CREATE POLICY executions_insert ON automation_executions FOR INSERT WITH CHECK (true);
  END IF;
END $$;
