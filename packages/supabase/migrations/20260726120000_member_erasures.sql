-- =============================================================================
-- /forgetme right-to-erasure suppression markers (P2 batch — B8).
--
-- purge_member_data deletes the member's rows, but the roster backfill
-- (backfillMembers) re-inserts identity PII for everyone currently in the
-- guild — silently resurrecting the very record the member asked to erase.
--
-- member_erasures is a per-guild suppression list:
--   1. The bot writes the marker BEFORE invoking purge_member_data
--      (marker-first: a partial failure still suppresses re-creation).
--   2. backfillMembers excludes marked ids from every write.
--   3. A voluntary rejoin (guildMemberAdd) DELETES the marker first — the
--      member chose to come back, which is fresh consent to be tracked.
--
-- discord_id is stored raw, not hashed: this is a suppression list keyed the
-- same way as every other member table, and the id alone carries no profile
-- data. Hashing would only complicate the joins without adding privacy.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.member_erasures (
  guild_id text NOT NULL,
  discord_id text NOT NULL,
  erased_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, discord_id)
);

-- Service-role only, mirroring the v6 hardening on the other moderation and
-- commerce tables: the bot reaches this table only through the service-role
-- client. Direct anon/authenticated access is revoked.
ALTER TABLE public.member_erasures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_erasures FROM PUBLIC, anon, authenticated, service_role;
CREATE POLICY service_role_all ON public.member_erasures
  FOR ALL TO service_role USING (true) WITH CHECK (true);
-- DELETE is required: a voluntary rejoin clears the marker.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.member_erasures TO service_role;
