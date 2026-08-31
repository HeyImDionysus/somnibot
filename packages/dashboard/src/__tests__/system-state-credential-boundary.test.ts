import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createMockSupabase as createBaseMockSupabase, registerTable } from './helpers';

const mocks = vi.hoisted(() => ({
  checkAdminRateLimit: vi.fn<() => Promise<null>>(),
  requireGuildOwner: vi.fn(),
  createAdminSupabase: vi.fn(),
  checkValkeyHealth: vi.fn<() => Promise<boolean>>(),
  readValkeyKey: vi.fn<() => Promise<string | null>>(),
}));

vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: mocks.checkAdminRateLimit }));
vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: mocks.requireGuildOwner }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: mocks.createAdminSupabase }));
vi.mock('@/lib/api/rate-limit', () => ({
  checkValkeyHealth: mocks.checkValkeyHealth,
  readValkeyKey: mocks.readValkeyKey,
}));

import { GET as getSystemState } from '@/app/api/system-state/route';
import { GET as getDiagnosticBundle } from '@/app/api/system-state/diagnostic-bundle/route';

const ACTIVE_GUILD_ID = '1464713668766732393';

function createMockSupabase() {
  const admin = createBaseMockSupabase();
  admin.rpc.mockResolvedValue({ data: null, error: null });
  return admin;
}

function request(path: string): NextRequest {
  return new NextRequest(`http://localhost${path}`);
}

describe('system-state credential authorization boundary', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.checkAdminRateLimit.mockResolvedValue(null);
    mocks.requireGuildOwner.mockResolvedValue({
      ok: true,
      ctx: { guildId: ACTIVE_GUILD_ID, discordId: 'ordinary-owner', userId: 'user-1' },
    });
    mocks.checkValkeyHealth.mockResolvedValue(true);
    mocks.readValkeyKey.mockResolvedValue(null);
  });

  it('does not enumerate deployment-global credentials for an ordinary guild owner', async () => {
    // Given an authenticated guild owner and a service-role database client.
    const admin = createMockSupabase();
    mocks.createAdminSupabase.mockReturnValue(admin);

    // When the owner reads their guild system state.
    const response = await getSystemState(request('/api/system-state'));
    const body: unknown = await response.json();

    // Then useful guild diagnostics remain available without touching global credentials.
    expect(response.status).toBe(200);
    expect(admin.from).not.toHaveBeenCalledWith('instance_settings');
    expect(body).toMatchObject({ success: true, data: { credentials: [] } });
  });

  it.each([
    ['system state', getSystemState, '/api/system-state'],
    ['diagnostic export', getDiagnosticBundle, '/api/system-state/diagnostic-bundle'],
  ] as const)('reads the last successful migration for %s from the actual ledger shape', async (surface, handler, path) => {
    const admin = createMockSupabase();
    const migrations = registerTable(admin, 'schema_migrations');
    mocks.createAdminSupabase.mockReturnValue(admin);
    const applied = '20260831081000_sandbox_launch_persistence.sql';
    const rows: Array<Record<string, unknown>> = [
      { filename: '20260831135000_adoption_verification_writer.sql', applied_at: '2026-08-31T14:00:00.000Z', success: false },
      { filename: applied, applied_at: '2026-08-31T13:00:00.000Z', success: true },
    ];
    migrations.maybeSingle.mockImplementation(async () => {
      const filters = migrations.eq.mock.calls;
      if (filters.some(([column]) => !(column in rows[0]!))) {
        return { data: null, error: { message: 'Undefined migration ledger column', code: '42703' } };
      }
      return { data: rows.find((row) => filters.every(([column, value]) => row[column] === value)) ?? null, error: null };
    });
    mocks.readValkeyKey.mockResolvedValue(JSON.stringify({
      systemState: {
        schemaVersion: 1, observedAt: '2026-08-31T14:00:00.000Z', mode: 'normal',
        identity: {
          lifecycle: 'ready', version: '1.0.0', exactSha: null, bootId: null,
          migrationHead: null, configurationGeneration: null, deploymentProfile: 'vps-multi-guild',
        },
        providers: [], queues: [], features: [], guildConditions: [],
      },
    }));

    const response = await handler(request(path));
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject(surface === 'system state'
      ? { success: true, data: { identity: { migrationHead: applied } } }
      : { success: true, data: { deployment: { migrationHead: applied } } });
  });

  it('returns only the authorized guild condition from a deployment-global heartbeat', async () => {
    // Given an authorized owner and a heartbeat carrying conditions for two guilds.
    const admin = createMockSupabase();
    mocks.createAdminSupabase.mockReturnValue(admin);
    mocks.readValkeyKey.mockResolvedValue(JSON.stringify({
      systemState: {
        schemaVersion: 1,
        observedAt: '2026-08-31T12:00:00.000Z',
        mode: 'normal',
        identity: {
          lifecycle: 'ready',
          version: '1.0.0',
          exactSha: null,
          bootId: null,
          migrationHead: null,
          configurationGeneration: null,
          deploymentProfile: 'vps-multi-guild',
        },
        providers: [],
        queues: [],
        features: [],
        guildConditions: [
          { guildId: ACTIVE_GUILD_ID, status: 'ready', conditions: ['selected guild ready'] },
          { guildId: '12345678901234567', status: 'degraded', conditions: ['other-owner@example.test'] },
        ],
      },
    }));

    // When the owner reads system state.
    const response = await getSystemState(request('/api/system-state'));
    const body: unknown = await response.json();

    // Then the response contains no other guild condition or identifier.
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      data: {
        guildConditions: [{ guildId: ACTIVE_GUILD_ID, status: 'ready', conditions: ['selected guild ready'] }],
      },
    });
    expect(JSON.stringify(body)).not.toContain('12345678901234567');
    expect(JSON.stringify(body)).not.toContain('other-owner@example.test');
  });

  it('reports an unknown selected-guild condition when the global heartbeat has no matching entry', async () => {
    // Given an authorized owner and a heartbeat that only contains another guild.
    const admin = createMockSupabase();
    mocks.createAdminSupabase.mockReturnValue(admin);
    mocks.readValkeyKey.mockResolvedValue(JSON.stringify({
      systemState: {
        schemaVersion: 1,
        observedAt: '2026-08-31T12:00:00.000Z',
        mode: 'normal',
        identity: {
          lifecycle: 'ready',
          version: '1.0.0',
          exactSha: null,
          bootId: null,
          migrationHead: null,
          configurationGeneration: null,
          deploymentProfile: 'vps-multi-guild',
        },
        providers: [],
        queues: [],
        features: [],
        guildConditions: [
          { guildId: '12345678901234567', status: 'degraded', conditions: ['other-owner@example.test'] },
        ],
      },
    }));

    // When the owner reads system state.
    const response = await getSystemState(request('/api/system-state'));
    const body: unknown = await response.json();

    // Then the response is truthful about the missing selected-guild observation.
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      data: {
        guildConditions: [{
          guildId: ACTIVE_GUILD_ID,
          status: 'unknown',
          conditions: ['Bot runtime state has not been observed'],
        }],
      },
    });
    expect(JSON.stringify(body)).not.toContain('12345678901234567');
  });

  it('keeps a cross-guild owner diagnostic bundle guild-scoped and credential-free', async () => {
    // Given an owner selected into one guild on a deployment that may contain others.
    const admin = createMockSupabase();
    const diagnostics = registerTable(admin, 'bot_diagnostics');
    const incidents = registerTable(admin, 'incidents');
    const operations = registerTable(admin, 'audit_logs');
    const deadLetters = registerTable(admin, 'action_queue_dlq');
    const configuration = registerTable(admin, 'guild_config');
    const lifecycle = registerTable(admin, 'significant_operations');
    mocks.createAdminSupabase.mockReturnValue(admin);

    // When the owner exports a diagnostic bundle.
    const response = await getDiagnosticBundle(request('/api/system-state/diagnostic-bundle'));
    const body: unknown = await response.json();

    // Then every tenant-owned query is pinned to the selected guild and no global credential inventory is queried.
    expect(response.status).toBe(200);
    expect(diagnostics.eq).toHaveBeenCalledWith('guild_id', ACTIVE_GUILD_ID);
    expect(incidents.eq).toHaveBeenCalledWith('guild_id', ACTIVE_GUILD_ID);
    expect(operations.eq).toHaveBeenCalledWith('guild_id', ACTIVE_GUILD_ID);
    expect(deadLetters.eq).toHaveBeenCalledWith('guild_id', ACTIVE_GUILD_ID);
    expect(configuration.eq).toHaveBeenCalledWith('guild_id', ACTIVE_GUILD_ID);
    expect(lifecycle.eq).toHaveBeenCalledWith('guild_id', ACTIVE_GUILD_ID);
    expect(response.headers.get('content-disposition')).toMatch(/^attachment; filename="somnibot-diagnostic-[0-9TZ.-]+\.json"$/);
    expect(response.headers.get('content-disposition')).not.toContain(ACTIVE_GUILD_ID);
    expect(admin.from).not.toHaveBeenCalledWith('instance_settings');
    expect(body).toMatchObject({ success: true });
    expect(JSON.stringify(body)).not.toContain('credentials');
    expect(JSON.stringify(body)).not.toContain('discord_bot_token');
  });

  it('exports useful configuration, provider observations and classified failures without raw context', async () => {
    const admin = createMockSupabase();
    const timestamp = new Date().toISOString();
    const configuration = registerTable(admin, 'guild_config');
    const diagnostics = registerTable(admin, 'bot_diagnostics');
    const operations = registerTable(admin, 'audit_logs');
    const lifecycle = registerTable(admin, 'significant_operations');
    mocks.createAdminSupabase.mockReturnValue(admin);
    configuration.maybeSingle.mockResolvedValue({
      data: {
        music_enabled: true, economy_enabled: false, economy_games_enabled: true,
        store_enabled: true, paypal_enabled: true, paypal_environment: 'sandbox',
        automod_enabled: true, scheduled_messages_enabled: false,
        diagnostics_snapshot_interval_ms: 60_000,
        guild_id: ACTIVE_GUILD_ID, currency_name: 'private-owner@example.test',
        discord_bot_token: 'fixture-secret',
      },
      error: null,
    });
    diagnostics.limit.mockResolvedValue({
      data: [{
        snapshot_at: timestamp, uptime_seconds: 3600, boot_id: null,
        valkey_connected: true, discord_ws_ping: 30,
        lavalink_nodes: [
          { connected: true, name: 'private-owner@example.test', host: 'secret.internal' },
          { connected: false, name: 'fixture-secret' },
        ],
      }],
      error: null,
    });
    operations.limit.mockResolvedValue({
      data: [{
        action: 'diagnostics.snapshot_failed', category: 'diagnostics',
        correlation_id: '33333333-3333-4333-8333-333333333333',
        success: false, timestamp, error_message: 'fixture-secret',
        details: { error: 'private-owner@example.test' },
      }],
      error: null,
    });
    lifecycle.limit.mockResolvedValue({
      data: [{
        id: '44444444-4444-4444-8444-444444444444', current_stage: 'executed',
        outcome: 'failed', source_surface: 'dashboard', failure_code: 'provider_uncertain',
        configuration_generation: 4, updated_at: timestamp,
        actor_id: 'private-owner@example.test', request_payload: { secret: 'fixture-secret' },
      }],
      error: null,
    });

    const response = await getDiagnosticBundle(request('/api/system-state/diagnostic-bundle'));
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      data: {
        configuration: { status: 'available', values: {
          music_enabled: true, economy_enabled: false, economy_games_enabled: true,
          paypal_environment: 'sandbox', diagnostics_snapshot_interval_ms: 60_000,
        } },
        providers: expect.arrayContaining([
          { key: 'discord', status: 'ready', checkedAt: timestamp, reason: null },
          { key: 'valkey', status: 'ready', checkedAt: timestamp, reason: null },
          { key: 'lavalink', status: 'degraded', checkedAt: timestamp, reason: null },
          { key: 'paypal', status: 'unknown', checkedAt: null, reason: 'not_observed' },
        ]),
        operations: [{ action: 'diagnostics.snapshot_failed', failureClass: 'snapshot_failure', success: false }],
        operationLifecycle: [{
          id: '44444444-4444-4444-8444-444444444444', current_stage: 'executed',
          outcome: 'failed', failure_code: 'provider_uncertain', configuration_generation: 4,
        }],
      },
    });
    const serialized = JSON.stringify(body);
    for (const sensitive of [ACTIVE_GUILD_ID, 'private-owner@example.test', 'fixture-secret', 'secret.internal', 'actor_id', 'request_payload']) {
      expect(serialized).not.toContain(sensitive);
    }
  });

  it('reports stale provider observations and missing configuration explicitly instead of claiming readiness', async () => {
    const admin = createMockSupabase();
    const timestamp = new Date(Date.now() - 600_000).toISOString();
    const diagnostics = registerTable(admin, 'bot_diagnostics');
    const configuration = registerTable(admin, 'guild_config');
    mocks.createAdminSupabase.mockReturnValue(admin);
    configuration.maybeSingle.mockResolvedValue({ data: null, error: null });
    diagnostics.limit.mockResolvedValue({
      data: [{
        snapshot_at: timestamp, uptime_seconds: 3600, boot_id: null,
        valkey_connected: true, discord_ws_ping: 30, lavalink_nodes: [{ connected: true }],
      }],
      error: null,
    });

    const response = await getDiagnosticBundle(request('/api/system-state/diagnostic-bundle'));
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ data: {
      configuration: { status: 'unavailable', values: null },
      providers: expect.arrayContaining([
        { key: 'discord', status: 'unknown', checkedAt: timestamp, reason: 'stale_observation' },
        { key: 'valkey', status: 'unknown', checkedAt: timestamp, reason: 'stale_observation' },
        { key: 'lavalink', status: 'unknown', checkedAt: timestamp, reason: 'stale_observation' },
      ]),
    } });
  });

  it('preserves unknown failure observations without echoing attacker-controlled classifications', async () => {
    const admin = createMockSupabase();
    const timestamp = new Date().toISOString();
    const operations = registerTable(admin, 'audit_logs');
    const lifecycle = registerTable(admin, 'significant_operations');
    const configuration = registerTable(admin, 'guild_config');
    mocks.createAdminSupabase.mockReturnValue(admin);
    operations.limit.mockResolvedValue({
      data: [{ action: 'private-owner@example.test', category: 'private-owner@example.test', correlation_id: null, success: false, timestamp }], error: null,
    });
    lifecycle.limit.mockResolvedValue({
      data: [{
        id: '44444444-4444-4444-8444-444444444444', current_stage: 'executed',
        outcome: 'failed', source_surface: 'dashboard', failure_code: 'SMNI-TEST-LICENSE-1234',
        configuration_generation: null, updated_at: timestamp,
      }], error: null,
    });
    configuration.maybeSingle.mockResolvedValue({ data: null, error: { message: 'private-owner@example.test' } });

    const response = await getDiagnosticBundle(request('/api/system-state/diagnostic-bundle'));
    const body: unknown = await response.json();

    expect(body).toMatchObject({ data: {
      configuration: { status: 'query_failed', values: null },
      operations: [{ action: 'unclassified', category: null, failureClass: 'unclassified', success: false }],
      operationLifecycle: [{ failure_code: 'unclassified', outcome: 'failed' }],
      queryFailures: ['configuration'],
    } });
    expect(JSON.stringify(body)).not.toContain('private-owner@example.test');
    expect(JSON.stringify(body)).not.toContain('SMNI-TEST-LICENSE-1234');
  });

  it.each(['2026-08-31T12:00:00.000Z', '2026-08-31T12:00:00.123456+00:00'])(
    'exports a safe diagnostic projection with database timestamp %s', async (timestamp) => {
    // Given selected-guild diagnostics and raw error fields containing synthetic personal and secret-like text.
    const admin = createMockSupabase();
    const migration = registerTable(admin, 'schema_migrations');
    const diagnostics = registerTable(admin, 'bot_diagnostics');
    const incidents = registerTable(admin, 'incidents');
    const operations = registerTable(admin, 'audit_logs');
    const deadLetters = registerTable(admin, 'action_queue_dlq');
    const fixturePersonalEmail = 'other-owner@example.test';
    const fixtureLicense = 'SMNI-TEST-LICENSE-1234';
    const fixtureDatabaseUri = 'postgresql://operator:fixture-db-password@db.example.test/somnibot';
    mocks.createAdminSupabase.mockReturnValue(admin);
    migration.maybeSingle.mockResolvedValue({
      data: { filename: '20260831000000_safe_projection.sql', checksum: 'a'.repeat(64), applied_at: timestamp, status: 'applied' },
      error: { message: fixtureDatabaseUri },
    });
    diagnostics.limit.mockResolvedValue({
      data: [{
        type: 'health',
        snapshot_at: timestamp,
        uptime_seconds: 3600,
        boot_id: '11111111-1111-4111-8111-111111111111',
        valkey_connected: true,
        lavalink_nodes: [{ host: fixtureDatabaseUri }],
      }],
      error: { message: fixturePersonalEmail },
    });
    incidents.limit.mockResolvedValue({
      data: [{
        id: '22222222-2222-4222-8222-222222222222',
        incident_number: 42,
        severity: 'critical',
        status: 'investigating',
        source: fixturePersonalEmail,
        started_at: timestamp,
        resolved_at: null,
      }],
      error: { message: fixtureLicense },
    });
    operations.limit.mockResolvedValue({
      data: [{
        action: 'commerce.fulfillment_failed',
        category: 'commerce',
        target_type: 'customer',
        target_id: fixturePersonalEmail,
        correlation_id: '33333333-3333-4333-8333-333333333333',
        occurrence_key: fixtureLicense,
        success: false,
        error_message: `${fixtureDatabaseUri} ${fixtureLicense}`,
        timestamp,
      }],
      error: null,
    });
    deadLetters.eq.mockReturnValueOnce(deadLetters).mockResolvedValueOnce({ count: 0, error: null });

    // When the owner exports their diagnostic bundle.
    const response = await getDiagnosticBundle(request('/api/system-state/diagnostic-bundle'));
    const body: unknown = await response.json();

    // Then useful status, timing, and correlation data remain while untrusted text never crosses the response boundary.
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      data: {
        health: [{
          snapshot_at: timestamp,
          uptime_seconds: 3600,
          boot_id: '11111111-1111-4111-8111-111111111111',
          valkey_connected: true,
        }],
        incidents: [{
          incident_number: 42,
          severity: 'critical',
          status: 'investigating',
          started_at: timestamp,
          resolved_at: null,
        }],
        operations: [{
          category: 'commerce',
          correlation_id: '33333333-3333-4333-8333-333333333333',
          success: false,
          timestamp,
        }],
        queryFailures: ['migration', 'health', 'incidents'],
      },
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(fixturePersonalEmail);
    expect(serialized).not.toContain(fixtureLicense);
    expect(serialized).not.toContain(fixtureDatabaseUri);
    expect(serialized).not.toContain('target_id');
    expect(serialized).not.toContain('error_message');
  });
});
