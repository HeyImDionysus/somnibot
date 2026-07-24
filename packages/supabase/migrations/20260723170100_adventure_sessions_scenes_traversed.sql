-- =============================================================================
-- Enforce the adventure scene cap (game-economy-adventures).
--
-- The catalog contracts adventure-max-scenes (guild_config.economy_adventure_
-- max_scenes, default 10) as an "upper bound on scenes an adventure may
-- traverse before it is forced to an ending". The column was read but NEVER
-- enforced: handleChoice navigated purely by the scene graph, so a looping or
-- overlong custom adventure could run without limit.
--
-- Enforcing the cap needs a durable per-session step counter, because each
-- button click is a fresh, stateless handleChoice that re-reads the session
-- from the database. This adds that counter; the bot increments it on every
-- scene transition and forces an ending once it reaches the configured cap.
-- Default 1 = the opening scene already shown when the session was created.
-- =============================================================================

BEGIN;

ALTER TABLE public.economy_adventure_sessions
  ADD COLUMN IF NOT EXISTS scenes_traversed integer NOT NULL DEFAULT 1;

COMMIT;
