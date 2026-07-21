-- Giveaway config controls: back the four advertised controls with storage.
--
-- The catalog (community.json) declares default-winner-count, dm-winners,
-- entry-button-label, and winner-announcement-style, but guild_config had only
-- giveaways_enabled. So the controls were phantoms: commands.ts hardcoded
-- winners=1, giveaway-manager hardcoded the entry-button label and a plain-text
-- announcement, and giveaway-fulfillment always DM'd winners. Add the columns
-- with the catalog defaults so the controls take effect.

ALTER TABLE public.guild_config
  ADD COLUMN IF NOT EXISTS giveaway_default_winner_count integer NOT NULL DEFAULT 1
    CHECK (giveaway_default_winner_count BETWEEN 1 AND 100),
  ADD COLUMN IF NOT EXISTS giveaway_dm_winners boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS giveaway_entry_button_label text NOT NULL DEFAULT 'Count me in!',
  ADD COLUMN IF NOT EXISTS giveaway_winner_announcement_style text NOT NULL DEFAULT 'embed'
    CHECK (giveaway_winner_announcement_style IN ('embed', 'plain'));
