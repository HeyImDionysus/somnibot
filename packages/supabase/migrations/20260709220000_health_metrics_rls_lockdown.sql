-- ============================================================
-- health_metrics RLS Lockdown (security — same bug class as
-- PR #265's action_queue_dlq lockdown, 20260709210000)
--
-- health_metrics stores per-guild latency time-series
-- (db_latency, valkey_latency, ws_ping, cmd_p95) rendered as
-- sparklines on the dashboard diagnostics page. It is written by
-- the bot and read by a server-side dashboard API route — no
-- browser-facing client ever touches it directly.
--
-- What was wrong:
--   1. 20260601000000_v53_phase2_observability.sql created policy
--      "guild_owner_access" FOR ALL USING (true) WITH CHECK (true)
--      with no TO clause — it applies to every role, so RLS filtered
--      nothing for any role holding table privileges.
--   2. The table was created on 2026-06-01, inside the window where
--      the migration runner's default privileges still auto-granted
--      table access to anon (Phase A, 20260518000000, revoked the
--      authenticated default but not anon; anon defaults were only
--      revoked in 20260618000000_v5_audit_remediation.sql, and that
--      migration only fixed FUTURE tables — it never revoked existing
--      grants on this one).
--   3. The v6 sweep (20260612000000_v6_db_security_hardening.sql)
--      locked down 32 USING(true) tables but missed this one — it
--      only hardened the cleanup_old_health_metrics() function, not
--      the table's own grants/policy.
--
-- Net effect: anon could read AND write/delete rows — junk-data
-- injection into dashboard sparklines and deletion of real metrics.
--
-- All legitimate access is server-side via service_role, which
-- bypasses RLS:
--   - bot writes:  packages/bot/src/features/audit/
--     diagnostics-service.ts (SUPABASE_SECRET_KEY client)
--   - dashboard sparkline reads: packages/dashboard/src/app/api/
--     diagnostics/route.ts (createAdminSupabase)
--   - retention: cleanup_old_health_metrics() is a definer-rights
--     function (runs as owner; EXECUTE already revoked from
--     anon/authenticated in the v6 sweep)
-- health_metrics was never added to the supabase_realtime
-- publication, so no browser-facing behavior changes.
--
-- Posture mirrors the repo's tightest precedent: v6 hardening REVOKE
-- pattern + Phase A's service_role-scoped policies (ticket_transcripts,
-- bot_diagnostics). Deny by default; service_role only.
-- ============================================================

-- 1. Revoke every table privilege from client-facing roles.
REVOKE ALL ON public.health_metrics FROM PUBLIC, anon, authenticated;

-- 2. Drop the permissive role-unscoped policy.
DROP POLICY IF EXISTS "guild_owner_access" ON public.health_metrics;

-- 3. Explicit service_role-only policy. service_role bypasses RLS in
--    Supabase, but the explicit policy documents intent and keeps the
--    table usable if BYPASSRLS were ever removed from the role.
DROP POLICY IF EXISTS "service_role_full_access" ON public.health_metrics;
CREATE POLICY "service_role_full_access" ON public.health_metrics
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 4. Ensure service_role retains full table privileges.
GRANT ALL ON public.health_metrics TO service_role;
