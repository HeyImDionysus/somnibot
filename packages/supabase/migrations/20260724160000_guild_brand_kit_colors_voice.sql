-- =============================================================================
-- Brand kit: white-label brand colors + voice preset for member-facing surfaces.
--
-- 20260723120200_store_brand_white_label gave the storefront an owner brand name
-- (store_brand_name) plus a powered-by toggle (store_show_powered_by), but the
-- moderation and member surfaces still hardcode SOMNI_PALETTE: ticket embeds
-- (panel/intro/close/feedback/reopen/claim/intake) and the member-facing
-- infraction DMs (warn/mute/kick/ban) render SomniBot's hot-pink/cyan/orange/red.
-- A Dyno/MEE6-tier white-label bot lets the owner set brand colors + a voice
-- preset that apply EVERYWHERE, not just the store.
--
-- Add the color + voice storage so resolveBrandKit() can drive every surface
-- from ONE owner-configured brand kit (name + powered-by already exist; this
-- adds the colors + voice). Colors are stored as 24-bit integers (0xRRGGBB),
-- matching the existing rank_card_accent_color convention. A NULL color falls
-- back to the SomniBot default palette so unconfigured guilds are unchanged.
-- =============================================================================

ALTER TABLE public.guild_config
  ADD COLUMN IF NOT EXISTS brand_primary_color integer
    CHECK (brand_primary_color IS NULL OR brand_primary_color BETWEEN 0 AND 16777215),
  ADD COLUMN IF NOT EXISTS brand_accent_color integer
    CHECK (brand_accent_color IS NULL OR brand_accent_color BETWEEN 0 AND 16777215),
  ADD COLUMN IF NOT EXISTS brand_voice_preset text NOT NULL DEFAULT 'default'
    CHECK (brand_voice_preset IN ('default', 'professional', 'friendly', 'playful'));

COMMENT ON COLUMN public.guild_config.brand_primary_color IS
  'White-label brand primary accent (24-bit 0xRRGGBB int) for member-facing embeds (ticket panel/close, infraction DMs, store header); NULL falls back to the SomniBot palette (HOT_PINK).';
COMMENT ON COLUMN public.guild_config.brand_accent_color IS
  'White-label brand secondary/info accent (24-bit 0xRRGGBB int) for informational member-facing embeds (ticket intro/feedback/reopen/claim/intake, infraction list); NULL falls back to the SomniBot palette (CYAN).';
COMMENT ON COLUMN public.guild_config.brand_voice_preset IS
  'White-label copy/voice preset applied to member-facing brand surfaces; one of default|professional|friendly|playful (default ''default'').';
