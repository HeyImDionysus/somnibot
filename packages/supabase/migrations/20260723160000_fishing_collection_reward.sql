-- =============================================================================
-- [game-economy-fishing] Collection completion bonus.
--
-- The catalog contracts an owner-togglable one-time completion bonus
-- (fishing-collection-reward-enabled default true, fishing-collection-reward-coins
-- default 5000) paid exactly once when a member has caught every active species.
-- None of it was schema-backed. Add the two guild_config controls plus a
-- per-member one-time fence table so the bonus is paid at most once per member
-- per guild (the primary key makes the INSERT ... ON CONFLICT DO NOTHING claim
-- idempotent under concurrent catches).
-- =============================================================================

BEGIN;

ALTER TABLE public.guild_config
  ADD COLUMN IF NOT EXISTS economy_fishing_collection_reward_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS economy_fishing_collection_reward_coins integer NOT NULL DEFAULT 5000;

CREATE TABLE IF NOT EXISTS public.economy_fish_collection_rewards (
  guild_id text NOT NULL REFERENCES public.guild_config(guild_id) ON DELETE CASCADE,
  user_id text NOT NULL,
  paid_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id)
);

-- Guild-scoped ledger locked to service_role (the bot), matching the RLS posture
-- of economy_fish_catches after the v6 hardening.
ALTER TABLE public.economy_fish_collection_rewards ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.economy_fish_collection_rewards FROM anon, authenticated;
DROP POLICY IF EXISTS "service_role_full_access" ON public.economy_fish_collection_rewards;
CREATE POLICY "service_role_full_access" ON public.economy_fish_collection_rewards
  TO service_role USING (true) WITH CHECK (true);

COMMIT;
