-- =============================================================================
-- Consent-based dashboard-team invitations (administration-team-management).
--
-- The catalog (administration.json:710) contracts that "the owner builds a
-- dashboard team through consent-based invitations: a member is invited to a
-- specific dashboard role, is notified by DM with a clear accept path, gains
-- permissions only upon acceptance, and every invitation expires, can be
-- revoked, and is fully audited", with direct-assignment-enabled defaulting to
-- false. None of that existed: the only write path (POST /api/rbac/users)
-- inserted a LIVE dashboard_user_roles assignment directly, and the four
-- controls (invitation-expiry-ms, invite-dm-enabled, max-pending-invitations,
-- direct-assignment-enabled) had no storage.
--
-- This migration adds:
--   1. the four control columns on guild_config (with the catalog defaults), and
--   2. team_invitations — the pending-invitation lifecycle table.
-- =============================================================================

-- ── 1. Control storage (catalog defaults) ───────────────────────────────────
-- direct-assignment-enabled=false → consent required (owner decision).
-- invite-dm-enabled=true          → notification parity (DM + dashboard).
-- max-pending-invitations=25      → generous, caps a compromised account.
-- invitation-expiry-ms=259200000  → 72h.
ALTER TABLE public.guild_config
  ADD COLUMN IF NOT EXISTS team_direct_assignment_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS team_invite_dm_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS team_max_pending_invitations integer NOT NULL DEFAULT 25
    CHECK (team_max_pending_invitations BETWEEN 1 AND 100),
  ADD COLUMN IF NOT EXISTS team_invitation_expiry_ms bigint NOT NULL DEFAULT 259200000
    CHECK (team_invitation_expiry_ms BETWEEN 3600000 AND 2592000000);

-- ── 2. The invitation table ─────────────────────────────────────────────────
-- `invited_by` holds the inviter's Discord snowflake (TEXT), matching the
-- discord-keyed dashboard_user_roles.assigned_by that migration
-- 20260720120000 established — NOT a users.id uuid. `dm_status` tracks the DM
-- delivery attempt independently of the invitation lifecycle so a failed DM
-- keeps the invitation acceptable via dashboard sign-in (the catalog
-- dm-delivery-failure contract: resultingState=pending).
CREATE TABLE IF NOT EXISTS public.team_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id text NOT NULL,
  discord_id text NOT NULL,
  role_id uuid NOT NULL REFERENCES public.dashboard_roles(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'declined', 'expired', 'revoked')),
  delivery_mode text
    CHECK (delivery_mode IS NULL OR delivery_mode IN ('dm', 'dashboard')),
  dm_status text NOT NULL DEFAULT 'queued'
    CHECK (dm_status IN ('queued', 'sent', 'failed', 'skipped')),
  invited_by text,
  invited_by_name text,
  accept_notified boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  responded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Exactly one PENDING invitation per (guild, member, role): a repeated/racing
-- invite collapses to one row (23505), and expired/revoked/accepted history is
-- retained without blocking a fresh invite.
CREATE UNIQUE INDEX IF NOT EXISTS team_invitations_pending_unique
  ON public.team_invitations (guild_id, discord_id, role_id)
  WHERE status = 'pending';

-- Team-page read (pending list) and per-invitee accept lookups.
CREATE INDEX IF NOT EXISTS idx_team_invitations_guild_status
  ON public.team_invitations (guild_id, status);
CREATE INDEX IF NOT EXISTS idx_team_invitations_discord_status
  ON public.team_invitations (discord_id, status);
-- Bot expiry-sweep / DM-delivery scans.
CREATE INDEX IF NOT EXISTS idx_team_invitations_pending_expiry
  ON public.team_invitations (expires_at)
  WHERE status = 'pending';

-- ── 3. Hardening — service-role only ────────────────────────────────────────
-- Mirrors the v6 hardening posture on the other dashboard tables
-- (dashboard_roles / dashboard_user_roles): the dashboard routes and the bot
-- sweeper reach this table only through the service-role admin client. Direct
-- anon/authenticated access is revoked so the anon-denial RLS contract holds.
ALTER TABLE public.team_invitations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.team_invitations FROM PUBLIC, anon, authenticated, service_role;
DROP POLICY IF EXISTS service_role_all ON public.team_invitations;
CREATE POLICY service_role_all ON public.team_invitations
  FOR ALL TO service_role USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.team_invitations TO service_role;
