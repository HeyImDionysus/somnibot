-- ============================================================
-- W2: Repo-wide RLS-pattern sweep lockdown
-- (follows 20260709210000_dlq_rls_lockdown.sql,
--          20260709220000_health_metrics_rls_lockdown.sql,
--          20260709230000_bot_action_queue_rls_lockdown.sql)
--
-- Wave 1 found the same weakness signature on three tables; this
-- migration is the result of auditing every table across every
-- migration for that signature:
--
--   (a) Creation inside the anon default-grant window. The platform's
--       default privileges auto-grant table access to anon for every
--       new table; the repo only revoked that default forward-only in
--       20260618000000_v5_audit_remediation.sql. EVERY live table
--       predates it (newest: 20260601000002), so every table that was
--       not explicitly revoked since still carries a legacy anon
--       grant. Phase A (20260518000000) blanket-revoked and then
--       selectively re-granted only *authenticated*; no blanket anon
--       revoke exists anywhere.
--   (b) Role-unscoped policies (no TO clause — they apply to every
--       role) whose USING/WITH CHECK admits rows.
--   (c) Omission from the v6 sweep (20260612000000), which revoked
--       anon/authenticated on 32 USING(true) tables but no others.
--
-- Code audit of every access path (bot + dashboard):
--   - The bot connects exclusively with SUPABASE_SECRET_KEY
--     (service_role, bypasses RLS). No anon/publishable client exists
--     in packages/bot.
--   - Every dashboard table read/write goes through
--     createAdminSupabase() in API routes (service_role).
--     createServerSupabase() (publishable key + session cookie) is
--     used ONLY for supabase.auth.getUser() — never .from()/.rpc().
--   - The browser client (packages/dashboard/src/lib/supabase/
--     client.ts) is used only for OAuth sign-in and Realtime
--     subscriptions (sidebar badges: tickets / orders / giveaways /
--     action_queue_dlq). None of those tables is in the
--     supabase_realtime publication (only bot_action_queue is, and
--     the bot subscribes with the service key), so those channels
--     have never delivered an event; badge counts come from
--     /api/counts (service_role). No genuine client-side table access
--     exists anywhere.
--
-- Confirmed offenders — 74 tables, three tiers (per-table findings in
-- the PR body):
--
--   Tier 1 — role-unscoped USING(true) policy + legacy anon grant:
--     anon can read AND write these tables TODAY via PostgREST.
--       button_roles, starboard_entries, polls, poll_options,
--       poll_votes, predictions, prediction_options, prediction_bets,
--       economy_trivia_questions (incl. answers), economy_lottery_drawings,
--       economy_lottery_tickets, economy_daily_losses (also carried an
--       explicit authenticated SELECT grant).
--
--   Tier 2 — role-unscoped USING(guild_id = current_setting(
--     'app.guild_id', true)) + legacy anon grant: nothing in the repo
--     ever sets that GUC (both services connect as service_role,
--     which bypasses RLS), so today the qual is a NULL comparison
--     that admits no rows — but the policy applies to every role and
--     the anon privilege survives, so any future code path or pooler
--     that sets the GUC silently opens the table to anon/authenticated.
--       economy_adventures, economy_adventure_scenes (EXISTS via
--       economy_adventures), economy_adventure_sessions,
--       economy_fish_species, economy_fish_catches,
--       economy_market_listings, feature_embed_overrides,
--       tutorial_configs, tutorial_steps, tutorial_progress,
--       sync_reports, level_unlock_configs, member_feature_unlocks,
--       temp_role_grants.
--
--   Tier 3 — auth-conditional policies (is_owner / auth.uid() /
--     auth.role() checks, mostly role-unscoped "owner_full_access")
--     + surviving grants: anon holds table privileges on ALL of them
--     (rows blocked only by the auth.uid() check — the same "blocked
--     in practice, lock anyway" posture as 20260709230000), and the
--     Phase A group additionally grants authenticated up to
--     SELECT/INSERT/UPDATE/DELETE, meaning any authenticated OWNER
--     session token can bulk read/write commerce tables (customers,
--     orders, payments, license_keys, entitlements, webhook_events,
--     audit_logs, ...) straight through PostgREST, bypassing the
--     dashboard API's authz, rate limiting, and audit logging — the
--     exact exposure codex flagged on bot_action_queue in wave 1.
--       active_temp_channels, alerts, audit_logs, automod_rules,
--       bot_diagnostics, channel_templates, custom_commands,
--       customers, discord_id_map, embed_configs, entitlements,
--       giveaways, guild, guild_config, guild_desired_state,
--       guild_live_state, infractions, instance_settings (stores
--       Supabase/Discord/PayPal secrets), level_rewards, license_keys,
--       license_sessions, license_validations, member_levels,
--       member_rank_settings, members, message_reports, orders,
--       payments, plans, product_files, product_license_config,
--       products, promotions, reaction_roles, reconciliation_runs,
--       role_templates, scheduled_messages, schema_migrations,
--       stats_channels, sync_actions, temp_channel_hubs,
--       ticket_metrics, ticket_panels, ticket_transcripts, tickets,
--       users, webhook_events, xp_multipliers.
--
--   Plus one non-table finding: the "product-files" view
--     (20260518000001) was created as an alias for a code typo that
--     was fixed long ago — nothing references it. It is a classic
--     RLS bypass: a view owned by postgres runs its query with the
--     OWNER's privileges, so any role with SELECT on the view reads
--     ALL product_files rows (file_path, external_url of paid digital
--     products) with RLS ignored — and anon holds a legacy grant on
--     it (created inside the anon window). Dropped below.
--
-- Fix — same posture as the three wave-1 precedents, deny by default:
--   1. Blanket-revoke the legacy anon default grants (tables +
--      sequences) — the missing counterpart of Phase A's blanket
--      authenticated revoke, closing leg (a) for the whole schema.
--   2. Per table: revoke every privilege from PUBLIC/anon/
--      authenticated, drop every policy not scoped exclusively
--      TO service_role, guarantee a service_role FOR ALL policy,
--      and re-assert service_role's privileges.
--   3. Drop the dead "product-files" owner-rights view.
--
-- The v6-swept 32 tables and the 3 wave-1 tables are NOT in the list:
-- their client grants are already revoked (several still have
-- role-unscoped USING(true) policies, but with zero privileges those
-- filter nothing for nobody — left untouched to keep this forward-only
-- migration surgical).
--
-- Forward-only. Service_role (bot + dashboard API) bypasses RLS and
-- keeps explicit grants, so no production behavior changes.
-- ============================================================

-- ── 1. Close the legacy anon default-grant window wholesale ─────────
-- Counterpart of Phase A's REVOKE ... FROM authenticated
-- (20260518000000); 20260618000000 only fixed FUTURE objects.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;

-- ── 2. Drop the dead owner-rights view (RLS bypass over product_files)
DROP VIEW IF EXISTS public."product-files";

-- ── 3. Lock every confirmed offender to service_role only ───────────
DO $$
DECLARE
  tbl TEXT;
  pol RECORD;
  tables_to_lock TEXT[] := ARRAY[
    -- Tier 1: role-unscoped USING(true) + legacy anon grant (anon
    -- read/write exposure today)
    'button_roles',
    'starboard_entries',
    'polls',
    'poll_options',
    'poll_votes',
    'predictions',
    'prediction_options',
    'prediction_bets',
    'economy_trivia_questions',
    'economy_lottery_drawings',
    'economy_lottery_tickets',
    'economy_daily_losses',
    -- Tier 2: role-unscoped GUC-conditional policies + legacy anon grant
    'economy_adventures',
    'economy_adventure_scenes',
    'economy_adventure_sessions',
    'economy_fish_species',
    'economy_fish_catches',
    'economy_market_listings',
    'feature_embed_overrides',
    'tutorial_configs',
    'tutorial_steps',
    'tutorial_progress',
    'sync_reports',
    'level_unlock_configs',
    'member_feature_unlocks',
    'temp_role_grants',
    -- Tier 3: auth-conditional policies + surviving anon (and, for the
    -- Phase A group, authenticated) grants; no client-side usage exists
    'active_temp_channels',
    'alerts',
    'audit_logs',
    'automod_rules',
    'bot_diagnostics',
    'channel_templates',
    'custom_commands',
    'customers',
    'discord_id_map',
    'embed_configs',
    'entitlements',
    'giveaways',
    'guild',
    'guild_config',
    'guild_desired_state',
    'guild_live_state',
    'infractions',
    'instance_settings',
    'level_rewards',
    'license_keys',
    'license_sessions',
    'license_validations',
    'member_levels',
    'member_rank_settings',
    'members',
    'message_reports',
    'orders',
    'payments',
    'plans',
    'product_files',
    'product_license_config',
    'products',
    'promotions',
    'reaction_roles',
    'reconciliation_runs',
    'role_templates',
    'scheduled_messages',
    'schema_migrations',
    'stats_channels',
    'sync_actions',
    'temp_channel_hubs',
    'ticket_metrics',
    'ticket_panels',
    'ticket_transcripts',
    'tickets',
    'users',
    'webhook_events',
    'xp_multipliers'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables_to_lock LOOP
    -- Defensive: tolerate drifted deployments (v6 house style).
    IF pg_catalog.to_regclass('public.' || pg_catalog.quote_ident(tbl)) IS NULL THEN
      RAISE NOTICE 'Table public.% does not exist — skipping', tbl;
      CONTINUE;
    END IF;

    -- 3a. Revoke every table privilege from client-facing roles.
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', tbl);

    -- 3b. Drop every policy not scoped exclusively TO service_role
    --     (role-unscoped policies report roles = {public}). The full
    --     expected drop list is documented in the PR; doing it from
    --     pg_policies keeps the sweep complete even where policy names
    --     drifted across environments.
    FOR pol IN
      SELECT policyname
      FROM pg_catalog.pg_policies
      WHERE schemaname = 'public'
        AND tablename = tbl
        AND roles IS DISTINCT FROM ARRAY['service_role']::name[]
    LOOP
      EXECUTE pg_catalog.format(
        'DROP POLICY %I ON public.%I', pol.policyname, tbl);
    END LOOP;

    -- 3c. Guarantee an explicit service_role-only policy. service_role
    --     bypasses RLS in Supabase, but the explicit policy documents
    --     intent and keeps the table usable if BYPASSRLS were ever
    --     removed from the role. Skip when an equivalent service_role
    --     FOR ALL policy already exists under another name (e.g.
    --     "service_role_members_access", "Service role full access")
    --     to avoid duplicate policies.
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_policies
      WHERE schemaname = 'public'
        AND tablename = tbl
        AND roles = ARRAY['service_role']::name[]
        AND cmd = 'ALL'
        AND permissive = 'PERMISSIVE'
    ) THEN
      EXECUTE pg_catalog.format(
        'CREATE POLICY "service_role_full_access" ON public.%I '
        'FOR ALL TO service_role USING (true) WITH CHECK (true)', tbl);
    END IF;

    -- 3d. Ensure service_role retains full table privileges.
    EXECUTE pg_catalog.format('GRANT ALL ON public.%I TO service_role', tbl);
  END LOOP;
END
$$;
