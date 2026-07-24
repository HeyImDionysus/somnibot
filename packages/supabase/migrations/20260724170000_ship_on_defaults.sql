-- =============================================================================
-- Ship-on defaults: align guild_config column DEFAULTs with the catalog's
-- "great out-of-box experience" contract.
--
-- Every feature below is contracted ON by the E2E catalog (v1.json declared
-- default = true) yet shipped OFF in the DB (NOT NULL DEFAULT false), so a fresh
-- guild_config row gets the feature disabled — contradicting the catalog and
-- surfacing as the "ships-OFF" DEF findings in the domain proofs. Flip each
-- column DEFAULT to true so a newly-inserted row (dashboard/onboarding/E2E boot)
-- gets the advertised out-of-box experience. The bot/dashboard code fallbacks
-- (`?? false` -> `?? true`) are aligned in the same PR.
--
-- Also aligns two great-default VALUE fixes:
--   * casino wager caps + daily-loss cap to the catalog's conservative-on floor
--     (economy_games_enabled ships ON, so the caps must be the recoverable
--     defaults the catalog contracts: coinflip/slots 500, blackjack 1000,
--     daily-loss 5000 — NOT the old 10000/5000/10000/0 free-for-all).
--   * sync_interval_minutes 15 -> 60 (catalog contracts 60).
--
-- Scope note: only the column DEFAULT is changed (new rows). Existing rows keep
-- their values — a persisted false may be a deliberate owner opt-out and cannot
-- be distinguished from the shipped default, so it is never retroactively
-- flipped (mirrors 20260720100000_sync_auto_repair_everyone_default_false).
--
-- Deliberately NOT flipped: anti_raid_enabled. The catalog contracts anti-raid
-- as a "lenient locked default" (declared default = FALSE: no join is ever
-- gated/deferred/tracked until the owner opts in), so the shipped DEFAULT false
-- already matches the catalog and the anti-raid DEF proof asserts exactly that.
-- =============================================================================

BEGIN;

-- ── Economy core + passive chat income (game-economy-wallet-rewards) ─────────
ALTER TABLE public.guild_config
  ALTER COLUMN economy_enabled              SET DEFAULT true;
ALTER TABLE public.guild_config
  ALTER COLUMN economy_chat_income_enabled  SET DEFAULT true;

-- ── Economy sub-features contracted ON by the catalog ───────────────────────
ALTER TABLE public.guild_config
  ALTER COLUMN economy_gathering_enabled    SET DEFAULT true;   -- game-economy-gathering
ALTER TABLE public.guild_config
  ALTER COLUMN economy_crafting_enabled     SET DEFAULT true;   -- game-economy-crafting
ALTER TABLE public.guild_config
  ALTER COLUMN economy_farming_enabled      SET DEFAULT true;   -- game-economy-farming
ALTER TABLE public.guild_config
  ALTER COLUMN economy_fishing_enabled      SET DEFAULT true;   -- game-economy-fishing
ALTER TABLE public.guild_config
  ALTER COLUMN economy_trivia_enabled       SET DEFAULT true;   -- game-economy-trivia
ALTER TABLE public.guild_config
  ALTER COLUMN economy_pets_enabled         SET DEFAULT true;   -- game-economy-pets

-- ── Casino (game-economy-casino): conservative-on per catalog ───────────────
-- Master switch ships ON, with recoverable wager caps + a sane daily-loss cap.
ALTER TABLE public.guild_config
  ALTER COLUMN economy_games_enabled        SET DEFAULT true;   -- casino-enabled
ALTER TABLE public.guild_config
  ALTER COLUMN economy_coinflip_max_bet     SET DEFAULT 500;    -- was 10000
ALTER TABLE public.guild_config
  ALTER COLUMN economy_slots_max_bet        SET DEFAULT 500;    -- was 5000
ALTER TABLE public.guild_config
  ALTER COLUMN economy_blackjack_max_bet    SET DEFAULT 1000;   -- was 10000
ALTER TABLE public.guild_config
  ALTER COLUMN economy_daily_loss_limit     SET DEFAULT 5000;   -- was 0 (uncapped)

-- ── Community starboard (community-starboard) ───────────────────────────────
ALTER TABLE public.guild_config
  ALTER COLUMN starboard_enabled            SET DEFAULT true;

-- ── Welcome / onboarding (community-welcome-onboarding) ─────────────────────
ALTER TABLE public.guild_config
  ALTER COLUMN welcome_enabled              SET DEFAULT true;
ALTER TABLE public.guild_config
  ALTER COLUMN welcome_dm_enabled           SET DEFAULT true;
ALTER TABLE public.guild_config
  ALTER COLUMN goodbye_enabled              SET DEFAULT true;

-- ── Server sync interval (administration-server-sync): catalog contracts 60 ──
ALTER TABLE public.guild_config
  ALTER COLUMN sync_interval_minutes        SET DEFAULT 60;

COMMIT;
