-- Welcome safe-fallback config columns.
--
-- The catalog (community.json) contracts a member-respectful safe fallback:
-- fallback-mode default 'grant-after-timeout' and fallback-timeout-minutes
-- default 10. When a member's DMs are closed and native onboarding is
-- unavailable, the fallback grants the member role after the timeout, welcomes
-- them in-channel, and alerts the owner exactly once. Neither backing column
-- existed, so the behavior was fully inert (member locked at the door).
--
-- This migration adds the two config columns (the schema half of the fix). The
-- durable per-member fallback timer + sweep that consumes them must be wired
-- bot-side (a runner registered in guild-init.ts); that wiring is handled by the
-- integrator because guild-init.ts is a shared cross-cutting file.

ALTER TABLE public.guild_config
  ADD COLUMN IF NOT EXISTS fallback_mode text NOT NULL DEFAULT 'grant-after-timeout'
    CHECK (fallback_mode IN ('grant-after-timeout', 'manual-review')),
  ADD COLUMN IF NOT EXISTS fallback_timeout_minutes integer NOT NULL DEFAULT 10
    CHECK (fallback_timeout_minutes BETWEEN 1 AND 1440);
