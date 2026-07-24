-- Allow type='free' products, matching the dashboard's product schema + wall
-- logic (validation.ts productCreate: z.enum(['one_time','subscription','free']);
-- store/products/route.ts: requiresPayPal = type !== 'free' && ...). The CHECK
-- predates the free-product feature, so creating a free product via the
-- dashboard 500'd with products_type_check — surfaced by the store-products
-- live-route proof.

BEGIN;

ALTER TABLE public.products DROP CONSTRAINT IF EXISTS products_type_check;
ALTER TABLE public.products
  ADD CONSTRAINT products_type_check
  CHECK (type = ANY (ARRAY['one_time'::text, 'subscription'::text, 'free'::text]));

COMMIT;
