-- =============================================================================
-- [game-economy-fishing] Durable unpaid flag for failed auto-sell payouts.
--
-- rollFishCatch inserts an economy_fish_catches row and then credits the wallet
-- as two separate writes. On a credit failure the "paid" state lived only on the
-- in-memory FishCatch object, so an operator could not identify unpaid catches
-- and a blind re-credit would double-pay. Add a durable `paid` flag: catches are
-- inserted paid=false and flipped to true only once the credit lands, so a
-- retry sweep can re-credit exactly the still-unpaid rows and flip them in the
-- same statement (idempotent — a row is only ever credited while paid=false).
--
-- Default true keeps every historical row (already credited) marked paid.
-- =============================================================================

BEGIN;

ALTER TABLE public.economy_fish_catches
  ADD COLUMN IF NOT EXISTS paid boolean NOT NULL DEFAULT true;

-- Partial index so the operator/retry sweep can find unpaid catches cheaply.
CREATE INDEX IF NOT EXISTS idx_fish_catches_unpaid
  ON public.economy_fish_catches (guild_id, user_id)
  WHERE paid = false;

COMMIT;
