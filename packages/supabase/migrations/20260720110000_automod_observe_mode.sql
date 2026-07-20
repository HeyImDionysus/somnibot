-- =============================================================================
-- Add the automod master switch + observe/enforce mode.
--
-- The catalog ships automod in OBSERVE-ONLY mode by default ("logs would-be
-- violations without touching members or messages", automod-enabled=true,
-- automod-mode='observe'). But no automod_enabled / automod_mode column ever
-- existed: loadModConfig read neither, and executeAutoModAction enforced
-- (delete/mute/kick/ban + createInfraction) the moment any enabled rule matched.
-- So the shipped "zero member risk" safety default did not exist — the first
-- message that tripped any rule was actioned with no owner opt-in. Add the
-- columns; the bot now skips automod when disabled and only enforces in
-- 'enforce' mode (observe logs a would-be entry and touches nothing).
-- =============================================================================

BEGIN;

ALTER TABLE public.guild_config
  ADD COLUMN IF NOT EXISTS automod_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS automod_mode TEXT NOT NULL DEFAULT 'observe'
    CHECK (automod_mode IN ('observe', 'enforce'));

COMMIT;
