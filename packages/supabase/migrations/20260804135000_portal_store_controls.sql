-- Portal and product-store controls from the commerce catalog.
-- All values are guild-scoped, constrained at the database boundary, and
-- default to the documented safe/shipped behavior.
BEGIN;

ALTER TABLE public.guild_config
  ADD COLUMN IF NOT EXISTS product_types_enabled text[] NOT NULL DEFAULT ARRAY[
    'downloadable','license-key','discord-perk','subscription',
    'virtual-good','ticket-service','free'
  ]::text[],
  ADD COLUMN IF NOT EXISTS repeat_purchase_policy text NOT NULL DEFAULT 'unique',
  ADD COLUMN IF NOT EXISTS free_claim_policy text NOT NULL DEFAULT 'one-claim',
  ADD COLUMN IF NOT EXISTS gifting_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS public_celebration_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS celebration_channel_id text,
  ADD COLUMN IF NOT EXISTS store_brand_source text NOT NULL DEFAULT 'guild-profile',
  ADD COLUMN IF NOT EXISTS max_storefront_products integer NOT NULL DEFAULT 9,
  ADD COLUMN IF NOT EXISTS portal_session_ttl_ms bigint NOT NULL DEFAULT 604800000,
  ADD COLUMN IF NOT EXISTS download_link_ttl_ms bigint NOT NULL DEFAULT 300000,
  ADD COLUMN IF NOT EXISTS self_service_cancellation boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS cancellation_timing text NOT NULL DEFAULT 'end-of-term',
  ADD COLUMN IF NOT EXISTS refund_requests_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS service_requests_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS portal_brand_source text NOT NULL DEFAULT 'guild-profile';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_product_types_enabled_values_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_product_types_enabled_values_check
      CHECK (product_types_enabled <@ ARRAY['downloadable','license-key','discord-perk','subscription','virtual-good','ticket-service','free']::text[]);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_repeat_purchase_policy_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_repeat_purchase_policy_check
      CHECK (repeat_purchase_policy IN ('unique','stackable','renewable','seat-based'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_free_claim_policy_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_free_claim_policy_check
      CHECK (free_claim_policy IN ('one-claim','repeatable'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_store_brand_source_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_store_brand_source_check
      CHECK (store_brand_source IN ('guild-profile','custom'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_max_storefront_products_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_max_storefront_products_check
      CHECK (max_storefront_products BETWEEN 1 AND 9);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_portal_session_ttl_ms_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_portal_session_ttl_ms_check
      CHECK (portal_session_ttl_ms BETWEEN 3600000 AND 2592000000);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_download_link_ttl_ms_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_download_link_ttl_ms_check
      CHECK (download_link_ttl_ms BETWEEN 60000 AND 3600000);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_cancellation_timing_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_cancellation_timing_check
      CHECK (cancellation_timing IN ('end-of-term','immediate'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_portal_brand_source_check') THEN
    ALTER TABLE public.guild_config ADD CONSTRAINT guild_config_portal_brand_source_check
      CHECK (portal_brand_source IN ('guild-profile','custom'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_guild_config_celebration_channel
  ON public.guild_config (celebration_channel_id)
  WHERE celebration_channel_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.commerce_purchase_celebrations (
  order_id uuid PRIMARY KEY REFERENCES public.orders(id) ON DELETE CASCADE,
  guild_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.commerce_purchase_celebrations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.commerce_purchase_celebrations FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS service_role_all ON public.commerce_purchase_celebrations;
CREATE POLICY service_role_all ON public.commerce_purchase_celebrations
  FOR ALL TO service_role USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON public.commerce_purchase_celebrations TO service_role;

COMMIT;
