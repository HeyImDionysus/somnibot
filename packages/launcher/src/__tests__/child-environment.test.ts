import { describe, expect, it } from 'vitest';
import { buildManagedChildEnvironment } from '../main/child-environment.js';

const RELEASE_IDENTITY = {
  exactSha: 'a'.repeat(40),
  migrationHead: '20260831135500_adoption_recovery_proof.sql',
  configurationGeneration: 20260831135500,
} as const;

describe('managed child environment', () => {
  it('gives a packaged regular-local bot the authoritative release identity through the child allowlist', () => {
    // Given: a packaged regular-local launch and conflicting values outside the release contract.
    const environment = buildManagedChildEnvironment({
      parentEnv: {
        PATH: '/usr/bin',
        DISCORD_TOKEN: 'parent-secret-must-not-leak',
        AWS_SECRET_ACCESS_KEY: 'parent-aws-secret-must-not-leak',
      },
      serviceEnv: {
        DISCORD_TOKEN: 'configured-child-token',
        SOMNIBOT_RUNTIME_MODE: 'regular-local',
        SOMNIBOT_GIT_SHA: 'b'.repeat(40),
        SOMNIBOT_MIGRATION_HEAD: '20200101000000_untrusted.sql',
        SOMNIBOT_CONFIG_GENERATION: '1',
      },
      isPackaged: true,
      releaseIdentity: RELEASE_IDENTITY,
    });

    // When: the launcher constructs the environment supplied to its bot child.

    // Then: only allowlisted parent state and the embedded release identity reach the child.
    expect(environment).toMatchObject({
      PATH: '/usr/bin',
      DISCORD_TOKEN: 'configured-child-token',
      SOMNIBOT_GIT_SHA: RELEASE_IDENTITY.exactSha,
      SOMNIBOT_MIGRATION_HEAD: RELEASE_IDENTITY.migrationHead,
      SOMNIBOT_CONFIG_GENERATION: String(RELEASE_IDENTITY.configurationGeneration),
    });
    expect(environment).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
  });

  it('fails closed for a packaged regular-local launch with unknown release metadata', () => {
    // Given: a packaged local launch whose embedded metadata cannot prove an immutable release.
    const environment = buildManagedChildEnvironment({
      parentEnv: { PATH: '/usr/bin' },
      serviceEnv: {
        SOMNIBOT_RUNTIME_MODE: 'regular-local',
        SOMNIBOT_GIT_SHA: 'b'.repeat(40),
        SOMNIBOT_MIGRATION_HEAD: '20200101000000_untrusted.sql',
        SOMNIBOT_CONFIG_GENERATION: '1',
      },
      isPackaged: true,
      releaseIdentity: {
        exactSha: '',
        migrationHead: '',
        configurationGeneration: -1,
      },
    });

    // When: the child environment is constructed.

    // Then: it contains no substitute provenance claim.
    expect(environment).not.toHaveProperty('SOMNIBOT_GIT_SHA');
    expect(environment).not.toHaveProperty('SOMNIBOT_MIGRATION_HEAD');
    expect(environment).not.toHaveProperty('SOMNIBOT_CONFIG_GENERATION');
  });

  it('does not trust a caller that labels a packaged local child as VPS', () => {
    // Given: a packaged process-manager caller attempting to impersonate the separate VPS deployment path.
    const environment = buildManagedChildEnvironment({
      parentEnv: { PATH: '/usr/bin' },
      serviceEnv: {
        SOMNIBOT_RUNTIME_MODE: 'vps',
        SOMNIBOT_GIT_SHA: 'c'.repeat(40),
        SOMNIBOT_MIGRATION_HEAD: '20260831135500_adoption_recovery_proof.sql',
        SOMNIBOT_CONFIG_GENERATION: '20260831135500',
      },
      isPackaged: true,
      releaseIdentity: RELEASE_IDENTITY,
    });

    // When: the launcher builds the child environment.

    // Then: caller-supplied provenance is stripped; the deployment plan materializes VPS identity elsewhere.
    expect(environment).not.toHaveProperty('SOMNIBOT_GIT_SHA');
    expect(environment).not.toHaveProperty('SOMNIBOT_MIGRATION_HEAD');
    expect(environment).not.toHaveProperty('SOMNIBOT_CONFIG_GENERATION');
  });

  it('does not manufacture release identity for an unpackaged development launch', () => {
    // Given: an unpackaged development launch with an explicit developer identity.
    const environment = buildManagedChildEnvironment({
      parentEnv: { PATH: '/usr/bin' },
      serviceEnv: {
        SOMNIBOT_RUNTIME_MODE: 'regular-local',
        SOMNIBOT_GIT_SHA: 'd'.repeat(40),
      },
      isPackaged: false,
      releaseIdentity: RELEASE_IDENTITY,
    });

    // When: the child environment is constructed.

    // Then: the launcher preserves the explicit development value instead of claiming packaged provenance.
    expect(environment.SOMNIBOT_GIT_SHA).toBe('d'.repeat(40));
    expect(environment).not.toHaveProperty('SOMNIBOT_MIGRATION_HEAD');
    expect(environment).not.toHaveProperty('SOMNIBOT_CONFIG_GENERATION');
  });

  it('fails closed for a packaged child with an unrecognized runtime profile', () => {
    const environment = buildManagedChildEnvironment({
      parentEnv: { PATH: '/usr/bin' },
      serviceEnv: {
        SOMNIBOT_RUNTIME_MODE: 'unrecognized-profile',
        SOMNIBOT_GIT_SHA: 'd'.repeat(40),
        SOMNIBOT_MIGRATION_HEAD: '20200101000000_untrusted.sql',
        SOMNIBOT_CONFIG_GENERATION: '1',
      },
      isPackaged: true,
      releaseIdentity: RELEASE_IDENTITY,
    });

    expect(environment).not.toHaveProperty('SOMNIBOT_GIT_SHA');
    expect(environment).not.toHaveProperty('SOMNIBOT_MIGRATION_HEAD');
    expect(environment).not.toHaveProperty('SOMNIBOT_CONFIG_GENERATION');
  });
});
