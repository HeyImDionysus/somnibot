-- V31 PR #45: Trivia + Mini-Games + Polls/Predictions
-- guild_config additions (~15 cols) + 8 new tables

-- ── guild_config columns ──────────────────────────────────

ALTER TABLE guild_config
  -- Trivia
  ADD COLUMN IF NOT EXISTS economy_trivia_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS economy_trivia_cooldown_seconds INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS economy_trivia_base_payout INTEGER NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS economy_trivia_streak_multiplier_pct INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS economy_trivia_hard_multiplier NUMERIC(3,1) NOT NULL DEFAULT 2.0,
  -- Mini-Games
  ADD COLUMN IF NOT EXISTS economy_games_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS economy_daily_loss_limit INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS economy_coinflip_max_bet INTEGER NOT NULL DEFAULT 10000,
  ADD COLUMN IF NOT EXISTS economy_slots_max_bet INTEGER NOT NULL DEFAULT 5000,
  ADD COLUMN IF NOT EXISTS economy_blackjack_max_bet INTEGER NOT NULL DEFAULT 10000,
  -- Lottery
  ADD COLUMN IF NOT EXISTS economy_lottery_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS economy_lottery_schedule TEXT NOT NULL DEFAULT 'weekly',
  ADD COLUMN IF NOT EXISTS economy_lottery_ticket_price INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS economy_lottery_max_tickets INTEGER NOT NULL DEFAULT 10,
  -- Polls & Predictions
  ADD COLUMN IF NOT EXISTS polls_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS predictions_enabled BOOLEAN NOT NULL DEFAULT false;

-- ── Trivia tables ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS economy_trivia_questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT NOT NULL REFERENCES guild_config(guild_id) ON DELETE CASCADE,
  category TEXT NOT NULL DEFAULT 'general',
  difficulty TEXT NOT NULL DEFAULT 'medium' CHECK (difficulty IN ('easy', 'medium', 'hard')),
  question TEXT NOT NULL,
  correct_answer TEXT NOT NULL,
  wrong_answers TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trivia_questions_guild ON economy_trivia_questions(guild_id);
CREATE INDEX IF NOT EXISTS idx_trivia_questions_category ON economy_trivia_questions(guild_id, category);

ALTER TABLE economy_trivia_questions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "trivia_questions_guild_access" ON economy_trivia_questions
  FOR ALL USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS economy_trivia_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT NOT NULL REFERENCES guild_config(guild_id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  host_user_id TEXT NOT NULL,
  category TEXT,
  difficulty TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'finished', 'cancelled')),
  rounds_completed INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_trivia_sessions_guild ON economy_trivia_sessions(guild_id);
ALTER TABLE economy_trivia_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "trivia_sessions_guild_access" ON economy_trivia_sessions
  FOR ALL USING (true) WITH CHECK (true);

-- ── Lottery tables ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS economy_lottery_drawings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT NOT NULL REFERENCES guild_config(guild_id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'drawn', 'cancelled')),
  jackpot INTEGER NOT NULL DEFAULT 0,
  winner_user_id TEXT,
  winning_number INTEGER,
  drawn_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lottery_drawings_guild ON economy_lottery_drawings(guild_id);
CREATE INDEX IF NOT EXISTS idx_lottery_drawings_active ON economy_lottery_drawings(guild_id, status) WHERE status = 'active';

ALTER TABLE economy_lottery_drawings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "lottery_drawings_guild_access" ON economy_lottery_drawings
  FOR ALL USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS economy_lottery_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  drawing_id UUID NOT NULL REFERENCES economy_lottery_drawings(id) ON DELETE CASCADE,
  guild_id TEXT NOT NULL REFERENCES guild_config(guild_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  ticket_number INTEGER NOT NULL,
  purchased_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lottery_tickets_drawing ON economy_lottery_tickets(drawing_id);
CREATE INDEX IF NOT EXISTS idx_lottery_tickets_user ON economy_lottery_tickets(guild_id, user_id);

ALTER TABLE economy_lottery_tickets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "lottery_tickets_guild_access" ON economy_lottery_tickets
  FOR ALL USING (true) WITH CHECK (true);

-- ── Polls tables ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS polls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT NOT NULL REFERENCES guild_config(guild_id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  creator_user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  allow_multiple BOOLEAN NOT NULL DEFAULT false,
  ends_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_polls_guild ON polls(guild_id);
CREATE INDEX IF NOT EXISTS idx_polls_active ON polls(guild_id, status) WHERE status = 'active';

ALTER TABLE polls ENABLE ROW LEVEL SECURITY;
CREATE POLICY "polls_guild_access" ON polls
  FOR ALL USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS poll_options (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  poll_id UUID NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  emoji TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_poll_options_poll ON poll_options(poll_id);

ALTER TABLE poll_options ENABLE ROW LEVEL SECURITY;
CREATE POLICY "poll_options_access" ON poll_options
  FOR ALL USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS poll_votes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  poll_id UUID NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  option_id UUID NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  voted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(poll_id, option_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_poll_votes_poll ON poll_votes(poll_id);
CREATE INDEX IF NOT EXISTS idx_poll_votes_user ON poll_votes(poll_id, user_id);

ALTER TABLE poll_votes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "poll_votes_access" ON poll_votes
  FOR ALL USING (true) WITH CHECK (true);

-- ── Predictions tables ────────────────────────────────────

CREATE TABLE IF NOT EXISTS predictions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT NOT NULL REFERENCES guild_config(guild_id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  creator_user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'locked', 'resolved', 'cancelled')),
  winning_option_id UUID,
  total_pool INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_predictions_guild ON predictions(guild_id);
CREATE INDEX IF NOT EXISTS idx_predictions_active ON predictions(guild_id, status) WHERE status IN ('open', 'locked');

ALTER TABLE predictions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "predictions_guild_access" ON predictions
  FOR ALL USING (true) WITH CHECK (true);

-- Reuse poll_options pattern but for predictions
CREATE TABLE IF NOT EXISTS prediction_options (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prediction_id UUID NOT NULL REFERENCES predictions(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  emoji TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_prediction_options_pred ON prediction_options(prediction_id);

ALTER TABLE prediction_options ENABLE ROW LEVEL SECURITY;
CREATE POLICY "prediction_options_access" ON prediction_options
  FOR ALL USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS prediction_bets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prediction_id UUID NOT NULL REFERENCES predictions(id) ON DELETE CASCADE,
  option_id UUID NOT NULL REFERENCES prediction_options(id) ON DELETE CASCADE,
  guild_id TEXT NOT NULL REFERENCES guild_config(guild_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  placed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payout INTEGER,
  UNIQUE(prediction_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_prediction_bets_pred ON prediction_bets(prediction_id);
CREATE INDEX IF NOT EXISTS idx_prediction_bets_user ON prediction_bets(guild_id, user_id);

ALTER TABLE prediction_bets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "prediction_bets_access" ON prediction_bets
  FOR ALL USING (true) WITH CHECK (true);
