-- =============================================================================
-- Fix: storefront white-label branding is unbuilt.
--
-- The catalog contracts that every buyer-facing storefront surface carries the
-- owner's brand name plus a subtle powered-by-SomniBot attribution, with no
-- hardcoded vendor branding. Today store-command.ts hardcodes the header title
-- '🏪 Server Store' with no attribution, and payment-handler.ts hardcodes the
-- PayPal application_context.brand_name to 'SomniBot Store'. guild_config had no
-- owner-brand storage. Add it so both surfaces can resolve the owner brand.
-- =============================================================================

ALTER TABLE public.guild_config
  ADD COLUMN IF NOT EXISTS store_brand_name text,
  ADD COLUMN IF NOT EXISTS store_show_powered_by boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.guild_config.store_brand_name IS
  'Owner-configured white-label store brand shown on the storefront embed and PayPal checkout; NULL falls back to the guild name.';
COMMENT ON COLUMN public.guild_config.store_show_powered_by IS
  'When true, buyer-facing storefront surfaces carry a subtle "Powered by SomniBot" attribution.';
