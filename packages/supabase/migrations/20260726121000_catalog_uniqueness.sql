-- =============================================================================
-- Catalog uniqueness + canonical categories.
--
-- The per-guild content catalogs (shop items, recipes, fish species,
-- adventures, crops, loot tables) had NO uniqueness constraint, so the
-- boot-time warmup racing a first command use (or two shards racing each
-- other) planted the same defaults twice. This migration:
--
--   1. Canonicalizes legacy seeder categories ('tool' -> 'Tools',
--      'protection' -> 'Protection') so category filters actually match.
--   2. Dedupes existing rows, keeping the earliest-created row (ties broken
--      by lowest id) and RE-POINTING every reference at the keeper first —
--      economy_items is referenced with ON DELETE CASCADE from inventory,
--      recipes and market listings, so a naive delete would destroy member
--      inventory. Inventory stacks of a duplicate item are merged into the
--      keeper stack (quantities summed).
--   3. Adds the unique indexes so the seeders' upsert-with-ignoreDuplicates
--      writes become race-proof no-ops.
--
-- Loot tables key on (guild_id, source_type, lower(item_name), tool_tier)
-- rather than name alone: the same drop at different tool tiers is a
-- legitimate owner configuration, while a double-seed duplicates the exact
-- same tier and is still collapsed.
-- =============================================================================

BEGIN;

-- ── 1. Canonical categories ─────────────────────────────────────────────────

UPDATE public.economy_items SET category = 'Tools', updated_at = now()
 WHERE category = 'tool';
UPDATE public.economy_items SET category = 'Protection', updated_at = now()
 WHERE category = 'protection';

-- ── 2a. economy_items dedupe (with reference re-pointing) ───────────────────

CREATE TEMP TABLE _dup_items ON COMMIT DROP AS
SELECT ranked.id AS dup_id, ranked.keep_id
FROM (
  SELECT id,
         first_value(id) OVER (
           PARTITION BY guild_id, lower(name)
           ORDER BY created_at ASC, id ASC
         ) AS keep_id
  FROM public.economy_items
) ranked
WHERE ranked.id <> ranked.keep_id;

-- Inventory rows pointing at duplicates, aggregated per (member, keeper).
CREATE TEMP TABLE _dup_inventory ON COMMIT DROP AS
SELECT src.guild_id,
       src.user_id,
       d.keep_id,
       SUM(src.quantity) AS qty,
       MIN(src.id::text)::uuid AS canon_row
FROM public.economy_inventory AS src
JOIN _dup_items AS d ON d.dup_id = src.item_id
GROUP BY src.guild_id, src.user_id, d.keep_id;

-- Members who also hold the keeper item: fold duplicate quantities in…
UPDATE public.economy_inventory AS tgt
   SET quantity = tgt.quantity + a.qty,
       updated_at = now()
  FROM _dup_inventory AS a
 WHERE tgt.guild_id = a.guild_id
   AND tgt.user_id = a.user_id
   AND tgt.item_id = a.keep_id;

-- …and drop their now-merged duplicate stacks.
DELETE FROM public.economy_inventory AS src
 USING _dup_items AS d
 WHERE d.dup_id = src.item_id
   AND EXISTS (
     SELECT 1 FROM public.economy_inventory AS t
      WHERE t.guild_id = src.guild_id
        AND t.user_id = src.user_id
        AND t.item_id = d.keep_id
   );

-- Members with only duplicate stacks: promote one row to the keeper item
-- carrying the summed quantity (UNIQUE(guild_id,user_id,item_id) stays safe).
UPDATE public.economy_inventory AS inv
   SET item_id = a.keep_id,
       quantity = a.qty,
       updated_at = now()
  FROM _dup_inventory AS a
 WHERE inv.id = a.canon_row
   AND NOT EXISTS (
     SELECT 1 FROM public.economy_inventory AS t
      WHERE t.guild_id = a.guild_id
        AND t.user_id = a.user_id
        AND t.item_id = a.keep_id
   );

-- Any remaining rows still pointing at a duplicate were non-canonical
-- leftovers of the promotion above — their quantity is already accounted for.
DELETE FROM public.economy_inventory AS src
 USING _dup_items AS d
 WHERE d.dup_id = src.item_id;

-- Re-point the remaining references before deleting the duplicate items.
UPDATE public.economy_recipes AS r
   SET output_item_id = d.keep_id
  FROM _dup_items AS d
 WHERE r.output_item_id = d.dup_id;

UPDATE public.economy_loot_tables AS lt
   SET gives_item_id = d.keep_id
  FROM _dup_items AS d
 WHERE lt.gives_item_id = d.dup_id;

UPDATE public.economy_crops AS c
   SET seed_item_id = d.keep_id
  FROM _dup_items AS d
 WHERE c.seed_item_id = d.dup_id;

UPDATE public.economy_market_listings AS ml
   SET item_id = d.keep_id
  FROM _dup_items AS d
 WHERE ml.item_id = d.dup_id;

DELETE FROM public.economy_items AS i
 USING _dup_items AS d
 WHERE i.id = d.dup_id;

-- ── 2b. economy_recipes dedupe (nothing references recipes) ─────────────────

DELETE FROM public.economy_recipes AS r
 USING public.economy_recipes AS k
 WHERE r.guild_id = k.guild_id
   AND lower(r.name) = lower(k.name)
   AND r.id <> k.id
   AND (k.created_at, k.id) < (r.created_at, r.id);

-- ── 2c. economy_fish_species dedupe (catches CASCADE — re-point first) ──────

CREATE TEMP TABLE _dup_species ON COMMIT DROP AS
SELECT ranked.id AS dup_id, ranked.keep_id
FROM (
  SELECT id,
         first_value(id) OVER (
           PARTITION BY guild_id, lower(name)
           ORDER BY created_at ASC, id ASC
         ) AS keep_id
  FROM public.economy_fish_species
) ranked
WHERE ranked.id <> ranked.keep_id;

UPDATE public.economy_fish_catches AS fc
   SET species_id = d.keep_id
  FROM _dup_species AS d
 WHERE fc.species_id = d.dup_id;

DELETE FROM public.economy_fish_species AS s
 USING _dup_species AS d
 WHERE s.id = d.dup_id;

-- ── 2d. economy_adventures dedupe (sessions re-pointed; duplicate scene sets
--        are duplicate content and CASCADE away with their adventure; an
--        in-flight session's current_scene_id is SET NULL — bounded loss) ────

CREATE TEMP TABLE _dup_adventures ON COMMIT DROP AS
SELECT ranked.id AS dup_id, ranked.keep_id
FROM (
  SELECT id,
         first_value(id) OVER (
           PARTITION BY guild_id, lower(name)
           ORDER BY created_at ASC, id ASC
         ) AS keep_id
  FROM public.economy_adventures
) ranked
WHERE ranked.id <> ranked.keep_id;

UPDATE public.economy_adventure_sessions AS s
   SET adventure_id = d.keep_id
  FROM _dup_adventures AS d
 WHERE s.adventure_id = d.dup_id;

DELETE FROM public.economy_adventures AS a
 USING _dup_adventures AS d
 WHERE a.id = d.dup_id;

-- ── 2e. economy_crops dedupe (farm plots re-pointed to the keeper) ──────────

CREATE TEMP TABLE _dup_crops ON COMMIT DROP AS
SELECT ranked.id AS dup_id, ranked.keep_id
FROM (
  SELECT id,
         first_value(id) OVER (
           PARTITION BY guild_id, lower(name)
           ORDER BY created_at ASC, id ASC
         ) AS keep_id
  FROM public.economy_crops
) ranked
WHERE ranked.id <> ranked.keep_id;

UPDATE public.economy_farm_plots AS p
   SET crop_id = d.keep_id
  FROM _dup_crops AS d
 WHERE p.crop_id = d.dup_id;

DELETE FROM public.economy_crops AS c
 USING _dup_crops AS d
 WHERE c.id = d.dup_id;

-- ── 2f. economy_loot_tables dedupe (nothing references loot rows) ───────────

DELETE FROM public.economy_loot_tables AS l
 USING public.economy_loot_tables AS k
 WHERE l.guild_id = k.guild_id
   AND l.source_type = k.source_type
   AND lower(l.item_name) = lower(k.item_name)
   AND l.tool_tier = k.tool_tier
   AND l.id <> k.id
   AND (k.created_at, k.id) < (l.created_at, l.id);

-- ── 3. Unique indexes ───────────────────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS uq_economy_items_guild_lname
  ON public.economy_items (guild_id, lower(name));

CREATE UNIQUE INDEX IF NOT EXISTS uq_economy_recipes_guild_lname
  ON public.economy_recipes (guild_id, lower(name));

CREATE UNIQUE INDEX IF NOT EXISTS uq_economy_fish_species_guild_lname
  ON public.economy_fish_species (guild_id, lower(name));

CREATE UNIQUE INDEX IF NOT EXISTS uq_economy_adventures_guild_lname
  ON public.economy_adventures (guild_id, lower(name));

CREATE UNIQUE INDEX IF NOT EXISTS uq_economy_crops_guild_lname
  ON public.economy_crops (guild_id, lower(name));

CREATE UNIQUE INDEX IF NOT EXISTS uq_economy_loot_tables_guild_source_lname_tier
  ON public.economy_loot_tables (guild_id, source_type, lower(item_name), tool_tier);

COMMIT;
