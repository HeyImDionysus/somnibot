-- ============================================================
-- GUILD LIVE STATE & BOT ACTION QUEUE
--
-- guild_live_state: Bot writes periodic snapshots of actual
-- Discord guild state. Dashboard reads for display.
--
-- bot_action_queue: Dashboard writes commands for the bot to
-- execute. Bot subscribes via Realtime and processes.
-- ============================================================

-- Live state snapshot from the bot
CREATE TABLE IF NOT EXISTS guild_live_state (
  guild_id TEXT PRIMARY KEY REFERENCES guild(id),
  roles JSONB NOT NULL DEFAULT '[]',
  channels JSONB NOT NULL DEFAULT '[]',
  categories JSONB NOT NULL DEFAULT '[]',
  member_count INTEGER DEFAULT 0,
  bot_role_id TEXT,
  bot_role_position INTEGER DEFAULT 0,
  onboarding_enabled BOOLEAN DEFAULT false,
  onboarding_prompts JSONB DEFAULT '[]',
  snapshot_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Bot action queue
CREATE TABLE IF NOT EXISTS bot_action_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT NOT NULL REFERENCES guild(id),
  action TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  result JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_bot_action_queue_status
  ON bot_action_queue(guild_id, status)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_bot_action_queue_created
  ON bot_action_queue(guild_id, created_at DESC);

-- Enable Realtime for bot_action_queue so the bot can subscribe
ALTER PUBLICATION supabase_realtime ADD TABLE bot_action_queue;
