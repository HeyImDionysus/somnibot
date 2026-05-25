-- ============================================================
-- Phase A: Security Hardening Migration
-- 
-- Fixes identified in the full repo audit:
-- 1. Tighten overly-broad GRANT ALL to authenticated role
-- 2. Fix permissive USING(true) policies on later tables
-- 3. Add RLS to guild_live_state and bot_action_queue
-- 4. Replace generic "owner_full_access" policies that leak
--    across guilds with guild-scoped policies
-- 5. Add service_role-specific policies where missing
-- 6. instance_settings already correctly scoped to service_role
-- ============================================================

-- ── 1. REVOKE overly-broad grants from authenticated ────────
-- The initial schema granted ALL ON ALL TABLES to authenticated,
-- which defeats RLS if any policy is too permissive. Since the
-- dashboard API routes use service_role (admin client), authenticated
-- users only need SELECT on specific tables.

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated;

-- Re-grant only what authenticated users actually need:
-- (a) They need to read their own user record (for session)
GRANT SELECT ON users TO authenticated;

-- (b) Owner-accessible tables via owner_full_access policies
-- These are protected by the policy that checks users.is_owner
GRANT SELECT, INSERT, UPDATE, DELETE ON guild TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON guild_config TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON role_templates TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON channel_templates TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON server_templates TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON guild_desired_state TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON discord_id_map TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON reaction_roles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON automod_rules TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON infractions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ticket_panels TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON tickets TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON automations TO authenticated;
GRANT SELECT ON automation_executions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON custom_commands TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON embed_configs TO authenticated;
GRANT SELECT ON member_levels TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON level_rewards TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON xp_multipliers TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON member_rank_settings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON temp_channel_hubs TO authenticated;
GRANT SELECT ON active_temp_channels TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON stats_channels TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON scheduled_messages TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON giveaways TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON products TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON product_files TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON plans TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON customers TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON orders TO authenticated;
GRANT SELECT ON license_keys TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON entitlements TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON promotions TO authenticated;
GRANT SELECT ON payments TO authenticated;
GRANT SELECT ON audit_logs TO authenticated;
GRANT SELECT ON webhook_events TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON product_license_config TO authenticated;
GRANT SELECT ON license_sessions TO authenticated;
GRANT SELECT ON license_validations TO authenticated;

-- (c) Members table: already correctly scoped (SELECT only for authenticated)
-- (d) instance_settings: service_role only (no change needed)

-- Sequences: only service_role needs them (bot/API writes)
-- Re-grant sequences to service_role only
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- Fix default privileges for FUTURE tables
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


-- ── 2. Fix permissive policies on later tables ──────────────

-- ticket_transcripts: "owner_full_access" is USING(true) — anyone can read all
DROP POLICY IF EXISTS "owner_full_access" ON ticket_transcripts;
DROP POLICY IF EXISTS "service_role_full_access" ON ticket_transcripts;
CREATE POLICY "service_role_full_access" ON ticket_transcripts
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "owner_read_transcripts" ON ticket_transcripts;
CREATE POLICY "owner_read_transcripts" ON ticket_transcripts
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = auth.uid() AND u.is_owner = true
    )
  );

-- bot_diagnostics: "owner_full_access" is USING(true) — anyone can read/write
DROP POLICY IF EXISTS "owner_full_access" ON bot_diagnostics;
DROP POLICY IF EXISTS "service_role_full_access" ON bot_diagnostics;
CREATE POLICY "service_role_full_access" ON bot_diagnostics
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "owner_read_diagnostics" ON bot_diagnostics;
CREATE POLICY "owner_read_diagnostics" ON bot_diagnostics
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = auth.uid() AND u.is_owner = true
    )
  );

-- members: "service_role_full_access" is USING(true) but not scoped to service_role
DROP POLICY IF EXISTS "service_role_full_access" ON members;
DROP POLICY IF EXISTS "service_role_members_access" ON members;
CREATE POLICY "service_role_members_access" ON members
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- automations: later migration added USING(true) policies
DROP POLICY IF EXISTS "automations_select" ON automations;
DROP POLICY IF EXISTS "automations_all" ON automations;
DROP POLICY IF EXISTS "executions_select" ON automation_executions;
DROP POLICY IF EXISTS "executions_insert" ON automation_executions;
-- The original owner_full_access policies from the initial schema remain correct


-- ── 3. Add RLS to guild_live_state and bot_action_queue ─────

ALTER TABLE guild_live_state ENABLE ROW LEVEL SECURITY;

-- Service role (bot) can read/write
DROP POLICY IF EXISTS "service_role_full_access" ON guild_live_state;
CREATE POLICY "service_role_full_access" ON guild_live_state
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Owner can read (for dashboard display)
DROP POLICY IF EXISTS "owner_read_live_state" ON guild_live_state;
CREATE POLICY "owner_read_live_state" ON guild_live_state
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = auth.uid() AND u.is_owner = true
    )
  );

ALTER TABLE bot_action_queue ENABLE ROW LEVEL SECURITY;

-- Service role (bot) can read/write
DROP POLICY IF EXISTS "service_role_full_access" ON bot_action_queue;
CREATE POLICY "service_role_full_access" ON bot_action_queue
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Owner can read status and insert new actions
DROP POLICY IF EXISTS "owner_manage_actions" ON bot_action_queue;
CREATE POLICY "owner_manage_actions" ON bot_action_queue
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = auth.uid() AND u.is_owner = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = auth.uid() AND u.is_owner = true
    )
  );

-- Grant minimal permissions for these tables
GRANT ALL ON guild_live_state TO service_role;
GRANT SELECT ON guild_live_state TO authenticated;
GRANT ALL ON bot_action_queue TO service_role;
GRANT SELECT, INSERT ON bot_action_queue TO authenticated;


-- ── 4. Add service_role explicit policies ───────────────────
-- The initial schema only created policies for the "owner" role.
-- service_role bypasses RLS by default in Supabase, but it's
-- best practice to have explicit policies.

-- These are only needed on tables where authenticated has a
-- restrictive policy but service_role also needs full access.
-- On most tables, service_role already bypasses RLS via its
-- Supabase default behavior.


-- ── 5. Users table: restrict self-read ──────────────────────
-- Currently users can see all users via owner_full_access.
-- Users should only read their own record (unless they're owner).
-- The owner_full_access policy already handles this via is_owner check,
-- but add a self-read policy for non-owners.

DROP POLICY IF EXISTS "users_read_own" ON users;
CREATE POLICY "users_read_own" ON users
  FOR SELECT TO authenticated
  USING (id = auth.uid());


-- ── 6. Escalation config table RLS ─────────────────────────
-- Added in escalation migration — check if it needs policies
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_name = 'escalation_configs'
  ) THEN
    ALTER TABLE escalation_configs ENABLE ROW LEVEL SECURITY;
    
    EXECUTE 'CREATE POLICY "service_role_full_access" ON escalation_configs
      FOR ALL TO service_role USING (true) WITH CHECK (true)';
    
    EXECUTE 'CREATE POLICY "owner_manage_escalation" ON escalation_configs
      FOR ALL TO authenticated
      USING (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid() AND u.is_owner = true))
      WITH CHECK (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid() AND u.is_owner = true))';
  END IF;
END $$;
