/**
 * Integration test: health_metrics RLS lockdown
 * (20260709220000_health_metrics_rls_lockdown).
 *
 * health_metrics is written by the bot (service_role) and read by the
 * dashboard's server-side /api/diagnostics route (createAdminSupabase).
 * No browser-facing client should touch it: the original policy from
 * v53_phase2_observability was role-unscoped USING(true), and the table
 * was created inside the window where default privileges still granted
 * anon table access — letting anon read AND write/delete sparkline data.
 *
 * These tests assert grants are revoked for anon/authenticated (PostgREST
 * must return permission-denied 42501, not an empty RLS-filtered result)
 * while service_role continues to work. Mirrors the action_queue_dlq
 * lockdown tests introduced with PR #265.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { requireSupabase } from './helpers.js';

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';

/**
 * Well-known local-dev demo JWTs (signed with the Supabase CLI default
 * secret, same issuer/expiry as the service_role key CI uses).
 * Only valid against a local `supabase start` instance — not secrets.
 *
 * NOTE: duplicated from PR #265's helpers.ts additions so this suite is
 * self-contained regardless of merge order. Once both PRs are on main,
 * dedupe by importing getAnonTestClient/getAuthenticatedTestClient
 * from ./helpers.js.
 */
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SUPABASE_AUTHENTICATED_JWT =
  process.env.SUPABASE_AUTHENTICATED_JWT ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImF1dGhlbnRpY2F0ZWQiLCJzdWIiOiIwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDAiLCJleHAiOjE5ODM4MTI5OTZ9.gtnsf1op2LwTIjIxCAXFhdmPR1CndDznrJ-zD8GRGIY';

/** Client using the publishable (anon) key — an unauthenticated browser. */
function makeAnonClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Client acting as the `authenticated` Postgres role — a logged-in
 * dashboard browser session. The anon key passes the gateway; the
 * Authorization bearer switches PostgREST to role `authenticated`.
 */
function makeAuthenticatedClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${SUPABASE_AUTHENTICATED_JWT}` } },
  });
}

let supa!: SupabaseClient;
const GUILD_ID = `test-health-metrics-guild-${Date.now()}`;

beforeAll(async () => {
  supa = await requireSupabase();

  await supa.from('guild').insert({
    id: GUILD_ID,
    name: 'Health Metrics Test Guild',
    owner_discord_id: '123456789',
  });
});

afterAll(async () => {
  await supa.from('health_metrics').delete().eq('guild_id', GUILD_ID);
  await supa.from('guild').delete().eq('id', GUILD_ID);
});

describe('health_metrics lockdown (20260709220000_health_metrics_rls_lockdown)', () => {
  // Grants for anon/authenticated are revoked, so PostgREST must return
  // a permission-denied error (42501), not an empty RLS-filtered result.
  const expectPermissionDenied = (error: { code?: string; message?: string } | null) => {
    expect(error).not.toBeNull();
    const denied =
      error!.code === '42501' || /permission denied/i.test(error!.message ?? '');
    expect(denied, `expected permission denied, got: ${JSON.stringify(error)}`).toBe(true);
  };

  it('denies anon reads on health_metrics', async () => {
    const anon = makeAnonClient();
    const { error } = await anon.from('health_metrics').select('id').limit(1);
    expectPermissionDenied(error);
  });

  it('denies anon inserts into health_metrics (junk sparkline injection)', async () => {
    const anon = makeAnonClient();
    const { error } = await anon.from('health_metrics').insert({
      guild_id: GUILD_ID,
      metric_type: 'db_latency',
      value_ms: 99999,
    });
    expectPermissionDenied(error);
  });

  it('denies anon deletes on health_metrics', async () => {
    const anon = makeAnonClient();
    const { error } = await anon
      .from('health_metrics')
      .delete()
      .eq('guild_id', GUILD_ID);
    expectPermissionDenied(error);
  });

  it('denies authenticated reads on health_metrics', async () => {
    const authed = makeAuthenticatedClient();
    const { error } = await authed.from('health_metrics').select('id').limit(1);
    expectPermissionDenied(error);
  });

  it('denies authenticated inserts into health_metrics', async () => {
    const authed = makeAuthenticatedClient();
    const { error } = await authed.from('health_metrics').insert({
      guild_id: GUILD_ID,
      metric_type: 'ws_ping',
      value_ms: 1,
    });
    expectPermissionDenied(error);
  });

  it('still allows service-role writes (bot diagnostics path)', async () => {
    const { error } = await supa.from('health_metrics').insert([
      { guild_id: GUILD_ID, metric_type: 'db_latency', value_ms: 12.34 },
      { guild_id: GUILD_ID, metric_type: 'ws_ping', value_ms: 45.6 },
    ]);
    expect(error).toBeNull();
  });

  it('still allows service-role reads (dashboard /api/diagnostics path)', async () => {
    const { data, error } = await supa
      .from('health_metrics')
      .select('metric_type, value_ms, recorded_at')
      .eq('guild_id', GUILD_ID)
      .order('recorded_at', { ascending: false })
      .limit(500);

    expect(error).toBeNull();
    expect((data ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
