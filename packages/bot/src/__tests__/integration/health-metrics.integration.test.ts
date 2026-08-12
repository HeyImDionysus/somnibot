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
import { type SupabaseClient } from '@supabase/supabase-js';
import { getAnonTestClient, getAuthenticatedTestClient, requireSupabase } from './helpers.js';

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
    const anon = getAnonTestClient();
    const { error } = await anon.from('health_metrics').select('id').limit(1);
    expectPermissionDenied(error);
  });

  it('denies anon inserts into health_metrics (junk sparkline injection)', async () => {
    const anon = getAnonTestClient();
    const { error } = await anon.from('health_metrics').insert({
      guild_id: GUILD_ID,
      metric_type: 'db_latency',
      value_ms: 99999,
    });
    expectPermissionDenied(error);
  });

  it('denies anon deletes on health_metrics', async () => {
    const anon = getAnonTestClient();
    const { error } = await anon
      .from('health_metrics')
      .delete()
      .eq('guild_id', GUILD_ID);
    expectPermissionDenied(error);
  });

  it('denies authenticated reads on health_metrics', async () => {
    const authed = getAuthenticatedTestClient();
    const { error } = await authed.from('health_metrics').select('id').limit(1);
    expectPermissionDenied(error);
  });

  it('denies authenticated inserts into health_metrics', async () => {
    const authed = getAuthenticatedTestClient();
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
