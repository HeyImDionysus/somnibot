-- =============================================================================
-- Farming: stop advertising a seed return that cannot happen.
--
-- The default crop catalogue ships seeds_returned values (Potato 1, Corn 2,
-- Tomato 1, Pumpkin 1) and the dashboard renders "Seeds back: N" from them.
-- But seedDefaultCrops inserts every default crop with seed_item_id = NULL,
-- and the harvest path only returns seeds when BOTH are set:
--
--     if (crop.seeds_returned > 0 && crop.seed_item_id) { ... }
--
-- So for every guild on the seeded defaults, the promised seeds were never
-- returned — not a failure anyone could see, just a number that never
-- happened. (Planting is free for those same crops, since a crop with no
-- seed item costs nothing to plant, so nobody was short-changed — but the
-- catalogue still said something untrue.)
--
-- This zeroes the advertised return wherever it cannot be honoured. It does
-- NOT touch crops that have a real seed item linked: there the number is
-- meaningful and is the owner's to set.
-- =============================================================================

BEGIN;

UPDATE public.economy_crops
   SET seeds_returned = 0
 WHERE seed_item_id IS NULL
   AND seeds_returned > 0;

COMMENT ON COLUMN public.economy_crops.seeds_returned IS
  'Seeds returned on harvest. Only honoured when seed_item_id is set — with no '
  'seed item there is nothing to return, and planting costs nothing.';

COMMIT;
