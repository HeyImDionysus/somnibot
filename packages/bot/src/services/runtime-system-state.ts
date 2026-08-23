type RuntimeStateInput = {
  readonly bootId: string;
  readonly observedAt: string;
  readonly discordReady: boolean;
  readonly guildIds: readonly string[];
};

function exactSha(): string | null {
  const value = process.env.SOMNIBOT_GIT_SHA ?? process.env.GITHUB_SHA ?? '';
  return /^[0-9a-f]{40}$/i.test(value) ? value : null;
}

function configurationGeneration(): number | null {
  const value = Number(process.env.SOMNIBOT_CONFIG_GENERATION);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function buildBotRuntimeSystemState(input: RuntimeStateInput) {
  const lifecycle = input.discordReady ? 'ready' : 'degraded';
  return {
    schemaVersion: 1,
    observedAt: input.observedAt,
    mode: input.discordReady ? 'normal' : 'degraded',
    identity: {
      lifecycle,
      version: process.env.SOMNIBOT_VERSION ?? process.env.npm_package_version ?? 'unknown',
      exactSha: exactSha(),
      bootId: input.bootId,
      migrationHead: process.env.SOMNIBOT_MIGRATION_HEAD?.trim() || null,
      configurationGeneration: configurationGeneration(),
      deploymentProfile: selectDeploymentProfile(
        process.env.SOMNIBOT_RUNTIME_MODE === 'vps' ? 'vps' : 'local',
        input.guildIds.length,
      ),
    },
    providers: [
      { key: 'discord', status: input.discordReady ? 'ready' : 'unavailable', checkedAt: input.observedAt },
      { key: 'valkey', status: 'ready', checkedAt: input.observedAt },
    ],
    queues: [],
    features: [],
    guildConditions: input.guildIds.map((guildId) => ({
      guildId,
      status: input.discordReady ? 'ready' : 'blocked',
      conditions: input.discordReady ? [] : ['Discord gateway is unavailable'],
    })),
  };
}
import { selectDeploymentProfile } from '@somnibot/shared';
