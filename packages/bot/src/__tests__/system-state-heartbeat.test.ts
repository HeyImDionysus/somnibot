import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeSystemStateSchema } from '../../../shared/src/system-state/index.js';
import { buildBotRuntimeSystemState } from '../services/runtime-system-state.js';
import { SOMNIBOT_VERSION } from '../version.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('bot runtime system state', () => {
  it('publishes exact deployment identity and guild readiness without credentials', () => {
    vi.stubEnv('SOMNIBOT_GIT_SHA', 'b'.repeat(40));
    vi.stubEnv('SOMNIBOT_VERSION', '1.2.3');
    vi.stubEnv('SOMNIBOT_MIGRATION_HEAD', '20260823142000_dashboard_adoption_map.sql');
    vi.stubEnv('SOMNIBOT_CONFIG_GENERATION', '17');
    vi.stubEnv('SOMNIBOT_RUNTIME_MODE', 'vps');

    const state = buildBotRuntimeSystemState({
      bootId: '11111111-1111-4111-8111-111111111111',
      observedAt: '2026-08-23T04:05:00.000Z',
      discordReady: true,
      guildIds: ['1437893528561909792', '1464713668766732393'],
    });

    expect(RuntimeSystemStateSchema.parse(state).identity).toMatchObject({
      exactSha: 'b'.repeat(40),
      migrationHead: '20260823142000_dashboard_adoption_map.sql',
      configurationGeneration: 17,
      deploymentProfile: 'vps-multi-guild',
    });
    expect(state.guildConditions).toHaveLength(2);
    expect(JSON.stringify(state)).not.toContain('credential');
  });

  it('fails closed to degraded and unknown identity for malformed environment metadata', () => {
    vi.stubEnv('SOMNIBOT_GIT_SHA', 'branch-name');
    vi.stubEnv('SOMNIBOT_CONFIG_GENERATION', '-1');

    const state = buildBotRuntimeSystemState({
      bootId: '11111111-1111-4111-8111-111111111111',
      observedAt: '2026-08-23T04:05:00.000Z',
      discordReady: false,
      guildIds: [],
    });

    expect(state.mode).toBe('degraded');
    expect(state.identity.lifecycle).toBe('degraded');
    expect(state.identity.exactSha).toBeNull();
    expect(state.identity.configurationGeneration).toBeNull();
  });

  it('uses the shared higher-load profile boundary at 26 guilds', () => {
    vi.stubEnv('SOMNIBOT_RUNTIME_MODE', 'vps');
    const guildIds = Array.from({ length: 26 }, (_, index) => `${10_000_000_000_000_000n + BigInt(index)}`);

    const state = buildBotRuntimeSystemState({
      bootId: '11111111-1111-4111-8111-111111111111',
      observedAt: '2026-08-23T05:00:00.000Z',
      discordReady: true,
      guildIds,
    });

    expect(state.identity.deploymentProfile).toBe('higher-load-vps');
  });

  it('uses the packaged version rather than logging arbitrary version environment values', () => {
    vi.stubEnv('SOMNIBOT_VERSION', 'Bearer fixture-private-token');
    vi.stubEnv('npm_package_version', 'fixture-private-password');

    const state = buildBotRuntimeSystemState({
      bootId: '11111111-1111-4111-8111-111111111111', observedAt: '2026-08-31T14:00:00.000Z',
      discordReady: true, guildIds: [],
    });

    expect(state.identity.version).toBe(SOMNIBOT_VERSION);
    expect(JSON.stringify(state)).not.toContain('fixture-private');
  });

  it.each([
    'postgresql://user:fixture-private-password@database.test/postgres',
    'SUPABASE_SECRET_KEY=fixture-private-token',
    '../../20260831135500_migration.sql',
    `20260831135500_${'x'.repeat(256)}.sql`,
    '20260831135500_migration.sql\nfixture-private-token',
  ])('does not publish malformed migration metadata %s', (migration) => {
    vi.stubEnv('SOMNIBOT_MIGRATION_HEAD', migration);

    const state = buildBotRuntimeSystemState({
      bootId: '11111111-1111-4111-8111-111111111111', observedAt: '2026-08-31T14:00:00.000Z',
      discordReady: true, guildIds: [],
    });

    expect(state.identity.migrationHead).toBeNull();
    expect(JSON.stringify(state)).not.toContain('fixture-private');
  });

  it('prefers the actual ledger head and keeps a failed ledger observation unknown', () => {
    vi.stubEnv('SOMNIBOT_MIGRATION_HEAD', '20260823000000_old_release.sql');
    const input = {
      bootId: '11111111-1111-4111-8111-111111111111', observedAt: '2026-08-31T14:00:00.000Z',
      discordReady: true, guildIds: [], migrationHead: '20260831135500_adoption_recovery_proof.sql',
    };

    expect(buildBotRuntimeSystemState(input).identity.migrationHead).toBe(input.migrationHead);
    expect(buildBotRuntimeSystemState({ ...input, migrationHead: null }).identity.migrationHead).toBeNull();
  });
});
