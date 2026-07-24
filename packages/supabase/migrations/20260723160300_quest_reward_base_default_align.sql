-- =============================================================================
-- [game-economy-quests] Align economy_quest_reward_base default with the catalog
-- and make the control safe to activate.
--
-- The catalog contracts quest-reward-base default = 100, and the default quest
-- templates seed base-100-relative reward_currency values (Active Member = 100,
-- Master Angler = 1200, ...). The shipped guild_config default was 200, which
-- diverged from the catalog. QuestsManager.claimQuests now scales each quest's
-- coin payout by economy_quest_reward_base / 100, so a lingering 200 default
-- would silently DOUBLE every guild's quest payout the moment the control goes
-- live. The control was fully inert until now (no payout path read the column),
-- so no guild could have deliberately relied on 200 having any effect.
--
-- Fix: set the default to the catalog value (100), and reset rows still sitting
-- at the buggy 200 default back to 100 so activating the control leaves payouts
-- unchanged at the default while remaining linearly owner-tunable.
-- =============================================================================

BEGIN;

ALTER TABLE public.guild_config
  ALTER COLUMN economy_quest_reward_base SET DEFAULT 100;

UPDATE public.guild_config
  SET economy_quest_reward_base = 100
  WHERE economy_quest_reward_base = 200;

COMMIT;
