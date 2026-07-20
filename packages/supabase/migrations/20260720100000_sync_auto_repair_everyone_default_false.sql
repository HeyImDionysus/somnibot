-- =============================================================================
-- Ship @everyone auto-repair OFF by default.
--
-- guild_config.sync_auto_repair_everyone shipped DEFAULT true, and the sync
-- engine gated the @everyone repair on autoRepairEveryone ALONE (not also on the
-- general autoRepair). So out of the box — an owner never enabling any
-- auto-repair — any guild with a deployed template silently reset @everyone's
-- permissions to 0 on the next sync cycle whenever @everyone had any non-zero
-- permission. The catalog contracts auto-repair-everyone as explicit opt-in
-- ("nothing repaired silently"; @everyone drift is surfaced for a manual
-- decision). Flip the persisted default; the engine gating + the bot/dashboard
-- fallbacks are fixed in the same PR.
-- =============================================================================

BEGIN;

ALTER TABLE public.guild_config
  ALTER COLUMN sync_auto_repair_everyone SET DEFAULT false;

COMMIT;
