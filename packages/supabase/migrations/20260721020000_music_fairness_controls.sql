-- Music fairness controls: back the four advertised controls with storage.
--
-- The catalog (music.json) declares five fairness controls, but only dj-role-id
-- was schema-backed. vote_skip_threshold_percent / self_skip_enabled /
-- requester_move_enabled / priority_voting_enabled had no guild_config column,
-- so the dashboard couldn't persist them, the bot couldn't read them, and every
-- one was inert (voteSkip hardcoded a 50% majority). Add the columns with the
-- catalog defaults so the controls actually take effect.

ALTER TABLE public.guild_config
  ADD COLUMN IF NOT EXISTS vote_skip_threshold_percent integer NOT NULL DEFAULT 50
    CHECK (vote_skip_threshold_percent BETWEEN 1 AND 100),
  ADD COLUMN IF NOT EXISTS self_skip_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS requester_move_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS priority_voting_enabled boolean NOT NULL DEFAULT true;
