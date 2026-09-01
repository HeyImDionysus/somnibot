import { selectDeploymentProfile } from '@somnibot/shared';
import { SOMNIBOT_VERSION } from '../version.js';

type RuntimeStateInput = {
  readonly bootId: string;
  readonly observedAt: string;
  readonly discordReady: boolean;
  readonly guildIds: readonly string[];
  readonly migrationHead?: string | null;
};

function exactSha(): string | null {
  const value = process.env.SOMNIBOT_GIT_SHA ?? process.env.GITHUB_SHA ?? '';
  return /^[0-9a-f]{40}$/i.test(value) ? value : null;
}

function configurationGeneration(): number | null {
  const value = Number(process.env.SOMNIBOT_CONFIG_GENERATION);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function migrationHead(value: string | null | undefined): string | null {
  return value && value.length <= 255 && /^\d{14}_[a-z0-9_]+\.sql$/.test(value) ? value : null;
}

export function buildBotRuntimeSystemState(input: RuntimeStateInput) {
  const lifecycle = input.discordReady ? 'ready' : 'degraded';
  return {
    schemaVersion: 1,
    observedAt: input.observedAt,
    mode: input.discordReady ? 'normal' : 'degraded',
    identity: {
      lifecycle,
      version: SOMNIBOT_VERSION,
      exactSha: exactSha(),
      bootId: input.bootId,
      migrationHead: migrationHead(input.migrationHead === undefined ? process.env.SOMNIBOT_MIGRATION_HEAD : input.migrationHead),
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
