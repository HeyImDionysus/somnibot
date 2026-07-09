-- ============================================================
-- bot_action_queue RLS Lockdown (P1 — codex review round 4, PR #265)
--
-- bot_action_queue rows for deliver_receipt / fulfill_* carry
-- `license_key_plaintext` in `payload` (by design: the queue row is
-- the only at-rest copy of the key, kept for retryability). The
-- round-3 migration (20260709210000) locked the DLQ copy of that
-- payload to service_role, but the live queue itself was still
-- browser-readable:
--
--   1. Phase A (20260518000000) granted
--      SELECT, INSERT ON bot_action_queue TO authenticated and created
--      "owner_manage_actions" FOR ALL TO authenticated USING/WITH CHECK
--      (users.is_owner). An owner's browser session (publishable key +
--      session JWT, straight to PostgREST) could read every queue row,
--      including retry payloads holding plaintext license keys.
--   2. 20260518000001 re-created "owner_full_access" with no TO clause
--      (applies to every role) and the same is_owner USING check.
--   3. The table was created 2026-05-17, inside the window where the
--      migration runner's default privileges still auto-granted table
--      access to anon (anon defaults were only revoked forward-only in
--      20260618000000), so anon may hold legacy grants too. Unlike the
--      round-3 DLQ case, anon is blocked in practice: both policies'
--      is_owner checks fail when auth.uid() IS NULL — no rows leak to
--      anon. The plaintext exposure is to authenticated owner sessions
--      in browser context (XSS / malicious extension / stolen session
--      token can bulk-read keys via PostgREST, bypassing the dashboard
--      API's auth, rate limiting, and audit logging).
--   4. The v6 sweep (20260612000000) did not include bot_action_queue.
--
-- No legitimate client-side access exists — every reader/writer is
-- server-side service_role, which bypasses RLS:
--   - bot enqueue/claim/complete: packages/bot/src/services/
--     action-queue.ts, commerce-fulfillment.ts, features/market/
--     market-manager.ts, features/automations/action-executor.ts
--     (SUPABASE_SECRET_KEY)
--   - dashboard writes/reads: all via createAdminSupabase in
--     packages/dashboard/src/app/api/* and src/lib/notify-bot.ts
--   - no browser Realtime subscription targets this table
--     (use-realtime hooks subscribe to tickets/orders/giveaways/etc.;
--     /api/counts does not allow it)
-- The bot's Realtime INSERT listener authenticates with the service
-- key; Realtime delivers postgres_changes to service_role subscribers
-- regardless of RLS, so the dashboard-insert → bot-notification flow
-- is unaffected. Authenticated subscribers would stop receiving events
-- for this table — none exist.
--
-- Posture mirrors 20260709210000_dlq_rls_lockdown.sql: deny by
-- default; service_role only. Forward-only.
-- ============================================================

-- 1. Revoke every table privilege from client-facing roles.
REVOKE ALL ON public.bot_action_queue FROM PUBLIC, anon, authenticated;

-- 2. Drop the browser-facing owner policies.
--    "owner_manage_actions": Phase A, FOR ALL TO authenticated.
--    "owner_full_access": 20260518000001, role-unscoped (all roles).
DROP POLICY IF EXISTS "owner_manage_actions" ON public.bot_action_queue;
DROP POLICY IF EXISTS "owner_full_access" ON public.bot_action_queue;

-- 3. Explicit service_role-only policy. service_role bypasses RLS in
--    Supabase, but the explicit policy documents intent and keeps the
--    table usable if BYPASSRLS were ever removed from the role.
DROP POLICY IF EXISTS "service_role_full_access" ON public.bot_action_queue;
CREATE POLICY "service_role_full_access" ON public.bot_action_queue
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 4. Ensure service_role retains full table privileges (also required
--    for its Realtime postgres_changes subscription to keep receiving
--    events for this table).
GRANT ALL ON public.bot_action_queue TO service_role;
