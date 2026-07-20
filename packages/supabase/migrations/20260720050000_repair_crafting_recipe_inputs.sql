-- =============================================================================
-- Repair double-encoded economy_recipes.inputs rows.
--
-- seedDefaultRecipes (crafting-manager.ts) inserted `inputs: JSON.stringify(...)`
-- into the jsonb `inputs` column, so the array landed as a jsonb STRING scalar
-- (jsonb_typeof = 'string') instead of an array. On read-back getRecipes() casts
-- it straight to Recipe[], so recipe.inputs is a JS string and every
-- `.inputs.map(...)` / `for (const i of recipe.inputs)` throws — /recipes render
-- and /craft were broken from first use for every guild that seeded the default
-- recipe book. The code now passes the array directly; this repairs the rows
-- already written the broken way by unwrapping the scalar string back to jsonb.
-- =============================================================================

BEGIN;

UPDATE public.economy_recipes
   SET inputs = (inputs #>> '{}')::jsonb
 WHERE jsonb_typeof(inputs) = 'string';

COMMIT;
