-- =============================================================================
-- W2B [commerce]: correct temp_role_grants provenance labeling.
--
-- DEFECT
--   CrossFeatureBridge.grantPurchaseRole runs from the commerce
--   `purchase.completed` event and resolves productId against the REAL-money
--   `products` table (V10 audit H-2), yet it wrote source = 'economy_purchase'
--   into temp_role_grants — the play-money FAKE game-economy label. This tags
--   real-money audit rows as game-economy events, conflating the two money
--   systems that must never be mixed.
--
-- FIX (this migration)
--   1. Change the column DEFAULT to 'commerce_purchase'. The only writer of
--      this table is the commerce role-grant path, and every other consumer
--      (the expiry sweep in handler.ts, prune_expired_data) ignores `source`
--      entirely — so no runtime code branches on the value. The label is pure
--      provenance/audit. Making the default commerce-accurate keeps any future
--      default-omitting insert from recreating the mislabel.
--   2. Relabel existing mislabeled rows FORWARD-ONLY.
--
-- SAFETY — do NOT mislabel genuine game rows as commerce
--   The game shop DOES grant roles (economy-manager.ts buyItem), but it grants
--   them PERMANENTLY via member.roles.add() and NEVER inserts into
--   temp_role_grants — grep confirms cross-feature-bridge.ts is the sole
--   inserter. So today every 'economy_purchase' row is in fact commerce.
--
--   Even so, this migration relabels DEFENSIVELY: only rows whose source_id
--   resolves to a real products.id are touched. Commerce always sets
--   source_id = products.id (uuid); a hypothetical stray game row would carry
--   an economy_items.id and would NOT match, so it is left untouched for owner
--   review rather than silently mislabeled. products.id and economy_items.id
--   are both uuid, but the two id-spaces do not overlap (independent
--   gen_random_uuid() PKs), so a products-membership test is exact.
--
-- Forward-only; no down migration (repo house style).
-- =============================================================================

-- 1. Commerce-accurate default for the sole (commerce) writer.
ALTER TABLE public.temp_role_grants
  ALTER COLUMN source SET DEFAULT 'commerce_purchase';

-- 2. Relabel existing mislabeled commerce rows, precisely.
--    Guarded so re-running (or running against a DB without the rows) is a
--    no-op. source_id must match a real product; NULL/unknown source_ids are
--    intentionally left for owner review.
UPDATE public.temp_role_grants g
SET source = 'commerce_purchase'
WHERE g.source = 'economy_purchase'
  AND g.source_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM public.products p
    WHERE p.id::text = g.source_id
  );
