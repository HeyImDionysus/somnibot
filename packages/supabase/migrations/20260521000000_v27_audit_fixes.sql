-- V27 Audit Fixes
--
-- 1. (Critical) giveaways.status CHECK constraint blocks 'paused'
--    V17 Behavioral Audit added pause/resume but never updated the CHECK.
--    GiveawayManager.pauseGiveaway() sets status='paused' → DB rejects the
--    update (constraint violation), so pause silently fails.
--
-- 2. (Medium) POST /api/sync with action='update_config' writes sync settings
--    to guild_config without calling notifyBot(). Bot never hot-reloads sync
--    config changes made through this endpoint.

-- Fix 1: Widen the giveaways.status CHECK to include 'paused'
ALTER TABLE giveaways DROP CONSTRAINT IF EXISTS giveaways_status_check;
ALTER TABLE giveaways ADD CONSTRAINT giveaways_status_check
  CHECK (status IN ('active', 'ended', 'cancelled', 'paused'));
