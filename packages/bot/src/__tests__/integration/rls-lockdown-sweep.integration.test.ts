/**
 * Integration test: repo-wide RLS-pattern sweep lockdown
 * (20260710010000_rls_pattern_sweep_lockdown).
 *
 * Wave 1 locked three tables (action_queue_dlq, health_metrics,
 * bot_action_queue) that shared a weakness signature: role-unscoped
 * policies + a legacy anon default grant (every table created before
 * 20260618000000 carries one unless explicitly revoked) + omission
 * from the v6 sweep. The wave-2 sweep audited every table and locked
 * the remaining 74 offenders to service_role only, plus dropped the
 * dead "product-files" owner-rights view (an RLS bypass over
 * product_files).
 *
 * Parameterized over the full locked-table list (one suite, not one
 * file per table — wave-1 review feedback):
 *   - catalog assertions: table exists (guards against list typos
 *     making the suite vacuously pass), RLS enabled, zero grants for
 *     anon/authenticated, zero policies scoped to anything but
 *     service_role;
 *   - PostgREST behavior: anon and authenticated get permission
 *     denied (42501) for reads AND writes — not an empty RLS-filtered
 *     200 — while service_role still reads.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import postgres from 'postgres';
import {
  requireSupabase,
  getAnonTestClient,
  getAuthenticatedTestClient,
  getTestDbUrl,
} from './helpers.js';

/**
 * Every table locked down by 20260710010000_rls_pattern_sweep_lockdown.
 * Keep in lockstep with the migration's tables_to_lock array and with
 * SENSITIVE_TABLES in .github/workflows/ci.yml (db-security-audit).
 */
const LOCKED_TABLES = [
  // Tier 1 — role-unscoped USING(true) + legacy anon grant (anon could
  // read AND write these before the migration)
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
  // Tier 2 — role-unscoped GUC-conditional policies + legacy anon grant
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
  // Tier 3 — auth-conditional policies + surviving anon/authenticated
  // grants; no client-side usage exists anywhere in the repo
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
  'xp_multipliers',
] as const;

/**
 * Postgres array literal for binding the table list as a single text
 * parameter (cast server-side). Built manually instead of via
 * postgres.js sql.array(): the helper's type inference is
 * connection-state dependent and serialized the first in-flight array
 * parameter without braces in CI (22P02 malformed array literal).
 * Safe to join unquoted — every name matches /^[a-z_]+$/.
 */
const TABLE_LIST = `{${LOCKED_TABLES.join(',')}}`;

let supa!: SupabaseClient;
let sql!: ReturnType<typeof postgres>;

beforeAll(async () => {
  supa = await requireSupabase();
  sql = postgres(getTestDbUrl(), { max: 1 });
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

/** Grants for anon/authenticated are revoked, so PostgREST must return
 *  permission denied (42501), not an empty RLS-filtered result. */
function expectPermissionDenied(
  table: string,
  op: string,
  error: { code?: string; message?: string } | null,
) {
  expect(error, `${table}: expected ${op} to be denied, got success`).not.toBeNull();
  const denied =
    error!.code === '42501' || /permission denied/i.test(error!.message ?? '');
  expect(
    denied,
    `${table}: expected permission denied for ${op}, got: ${JSON.stringify(error)}`,
  ).toBe(true);
}

describe('RLS sweep lockdown (20260710010000_rls_pattern_sweep_lockdown)', () => {
  describe('catalog state', () => {
    it('every locked table exists (typo guard for this list)', async () => {
      const rows = await sql`
        SELECT t.name
        FROM unnest(${TABLE_LIST}::text[]) AS t(name)
        WHERE pg_catalog.to_regclass('public.' || quote_ident(t.name)) IS NULL`;
      expect(
        rows.map((r) => r.name),
        'locked-table list references tables that do not exist',
      ).toEqual([]);
    });

    it('every locked table has row level security enabled', async () => {
      const rows = await sql`
        SELECT c.relname
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = ANY(${TABLE_LIST}::name[])
          AND c.relrowsecurity = false`;
      expect(
        rows.map((r) => r.relname),
        'tables with RLS disabled',
      ).toEqual([]);
    });

    it('anon and authenticated hold zero grants on locked tables', async () => {
      const rows = await sql`
        SELECT DISTINCT table_name, grantee
        FROM information_schema.role_table_grants
        WHERE table_schema = 'public'
          AND grantee IN ('anon', 'authenticated')
          AND table_name = ANY(${TABLE_LIST}::text[])
        ORDER BY table_name, grantee`;
      expect(
        rows.map((r) => `${r.table_name}:${r.grantee}`),
        'surviving anon/authenticated grants',
      ).toEqual([]);
    });

    it('locked tables have no policies scoped to anything but service_role', async () => {
      const rows = await sql`
        SELECT tablename, policyname, roles
        FROM pg_catalog.pg_policies
        WHERE schemaname = 'public'
          AND tablename = ANY(${TABLE_LIST}::name[])
          AND roles IS DISTINCT FROM ARRAY['service_role']::name[]
        ORDER BY tablename, policyname`;
      expect(
        rows.map((r) => `${r.tablename}.${r.policyname} -> {${r.roles}}`),
        'policies still visible to client roles',
      ).toEqual([]);
    });

    it('every locked table has a service_role FOR ALL policy', async () => {
      const rows = await sql`
        SELECT t.name
        FROM unnest(${TABLE_LIST}::text[]) AS t(name)
        WHERE NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_policies p
          WHERE p.schemaname = 'public'
            AND p.tablename = t.name
            AND p.roles = ARRAY['service_role']::name[]
            AND p.cmd = 'ALL'
            AND p.permissive = 'PERMISSIVE'
        )`;
      expect(
        rows.map((r) => r.name),
        'tables missing a service_role FOR ALL policy',
      ).toEqual([]);
    });

    it('service_role retains SELECT/INSERT on every locked table', async () => {
      const rows = await sql`
        SELECT t.name
        FROM unnest(${TABLE_LIST}::text[]) AS t(name)
        WHERE NOT (
          has_table_privilege('service_role', 'public.' || quote_ident(t.name), 'SELECT')
          AND has_table_privilege('service_role', 'public.' || quote_ident(t.name), 'INSERT')
        )`;
      expect(
        rows.map((r) => r.name),
        'tables where service_role lost privileges',
      ).toEqual([]);
    });

    it('the "product-files" owner-rights view is gone (RLS bypass over product_files)', async () => {
      const [row] = await sql`
        SELECT pg_catalog.to_regclass('public."product-files"') AS reg`;
      expect(row?.reg, 'view public."product-files" must be dropped').toBeNull();
    });
  });

  describe('PostgREST enforcement per table', () => {
    for (const table of LOCKED_TABLES) {
      it(`locks ${table} to service_role only`, async () => {
        const anon = getAnonTestClient();
        const authed = getAuthenticatedTestClient();

        // Reads: 42501, not an empty 200 (which would mean the grant
        // survived and only RLS filtered the rows).
        const anonRead = await anon.from(table).select('*').limit(1);
        expectPermissionDenied(table, 'anon SELECT', anonRead.error);

        const authedRead = await authed.from(table).select('*').limit(1);
        expectPermissionDenied(table, 'authenticated SELECT', authedRead.error);

        // Writes: the ACL check fires before constraint validation, so
        // an empty row must yield 42501 (a NOT NULL 23502 here would
        // mean the INSERT privilege survived).
        const anonWrite = await anon.from(table).insert({});
        expectPermissionDenied(table, 'anon INSERT', anonWrite.error);

        const authedWrite = await authed.from(table).insert({});
        expectPermissionDenied(table, 'authenticated INSERT', authedWrite.error);

        // service_role (bot + dashboard API path) still reads.
        const serviceRead = await supa.from(table).select('*').limit(1);
        expect(
          serviceRead.error,
          `${table}: service_role SELECT must keep working, got: ${JSON.stringify(serviceRead.error)}`,
        ).toBeNull();
      });
    }
  });
});
