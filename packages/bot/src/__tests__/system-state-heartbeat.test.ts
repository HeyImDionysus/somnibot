import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeSystemStateSchema } from '../../../shared/src/system-state/index.js';
import { buildBotRuntimeSystemState } from '../services/runtime-system-state.js';

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
});
