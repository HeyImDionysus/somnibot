-- ============================================================
-- DLQ RLS Lockdown (P1 — codex review round 3, PR #265)
--
-- action_queue_dlq preserves full action payloads so operators can
-- retry failed deliveries from the dashboard. For a dead-lettered
-- `deliver_receipt` action the payload includes
-- `license_key_plaintext`, which makes this table plaintext-key
-- recovery storage — it must be service_role-only.
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
--      locked down 32 USING(true) tables but missed this one — its
--      list contains `dead_letter_queue`, not `action_queue_dlq`.
--
-- All legitimate access is server-side via service_role, which
-- bypasses RLS:
--   - bot writes:  packages/bot/src/services/action-queue.ts,
--                  commerce-fulfillment.ts (SUPABASE_SECRET_KEY)
--   - dashboard list/ack/retry: packages/dashboard/src/app/api/
--     action-queue/route.ts (createAdminSupabase)
--   - dashboard diagnostics count: .../api/diagnostics/route.ts
-- The client-side realtime badge (DlqBadge) never received events —
-- action_queue_dlq was never added to the supabase_realtime
-- publication — so no browser-facing behavior changes.
--
-- Posture mirrors the repo's tightest precedent: v6 hardening REVOKE
-- pattern + Phase A's service_role-scoped policies (ticket_transcripts,
-- bot_diagnostics). Deny by default; service_role only.
-- ============================================================

-- 1. Revoke every table privilege from client-facing roles.
REVOKE ALL ON public.action_queue_dlq FROM PUBLIC, anon, authenticated;

-- 2. Drop the permissive role-unscoped policy.
DROP POLICY IF EXISTS "guild_owner_access" ON public.action_queue_dlq;

-- 3. Explicit service_role-only policy. service_role bypasses RLS in
--    Supabase, but the explicit policy documents intent and keeps the
--    table usable if BYPASSRLS were ever removed from the role.
DROP POLICY IF EXISTS "service_role_full_access" ON public.action_queue_dlq;
CREATE POLICY "service_role_full_access" ON public.action_queue_dlq
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 4. Ensure service_role retains full table privileges.
GRANT ALL ON public.action_queue_dlq TO service_role;
