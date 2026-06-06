import type { Shoukaku } from 'shoukaku';
import type Valkey from 'iovalkey';
import { createLogger } from '@somnibot/shared';
import type { GuildContext } from '../guild-context.js';
import type { GuildRouter } from '../guild-router.js';
import { destroyGuildServices } from '../guild-init.js';
import { stopHealthServer } from './health-server.js';

const defaultLog = createLogger('Shutdown');

type Logger = {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
};

type Stoppable = {
  stop: () => void;
};

type LavalinkNode = {
  disconnect: (code?: number, reason?: string) => void;
};

type ShutdownClient = {
  router?: GuildRouter;
  shoukaku?: Shoukaku | { nodes?: { forEach: (callback: (node: LavalinkNode) => void) => void } };
  destroy: () => void;
  valkey?: Valkey | { quit: () => Promise<unknown> };
};

export type BotLevelServices = {
  heartbeat?: Stoppable | null;
  presence?: Stoppable | null;
  stopAntiRaidPruner?: (() => void) | null;
};

type ShutdownDependencies = {
  destroyGuildServices?: (ctx: GuildContext) => void;
  stopHealthServer?: () => void;
  exit?: (code: number) => never | void;
  log?: Logger;
};

export type ShutdownBotOptions = {
  signal: string;
  client: ShutdownClient;
  botLevelServices?: BotLevelServices;
  dependencies?: ShutdownDependencies;
};

function stopSafely(name: string, stop: (() => void) | undefined | null, log: Logger): void {
  if (!stop) return;
  try {
    stop();
  } catch (err) {
    log.warn(`${name} cleanup failed`, { error: String(err) });
  }
}

export async function shutdownBot({
  signal,
  client,
  botLevelServices = {},
  dependencies = {},
}: ShutdownBotOptions): Promise<void> {
  const log = dependencies.log ?? defaultLog;
  const destroyGuildServicesFn = dependencies.destroyGuildServices ?? destroyGuildServices;
  const stopHealthServerFn = dependencies.stopHealthServer ?? stopHealthServer;
  const exit = dependencies.exit ?? process.exit;

  log.info(`Received ${signal}, shutting down gracefully...`);

  if (client.router) {
    for (const ctx of client.router.all()) {
      try {
        destroyGuildServicesFn(ctx);
      } catch (err) {
        log.error('Guild service destruction failed', { guildId: ctx.guildId, error: String(err) });
      }
    }

    try {
      client.router.destroyAll();
    } catch (err) {
      log.error('Guild router destruction failed', { error: String(err) });
    }
  }

  stopSafely('Heartbeat service', () => botLevelServices.heartbeat?.stop(), log);
  stopSafely('Presence manager', () => botLevelServices.presence?.stop(), log);
  stopSafely('Anti-raid pruner', botLevelServices.stopAntiRaidPruner, log);

  try {
    client.shoukaku?.nodes?.forEach((node) => node.disconnect(1000, 'shutdown'));
  } catch (err) {
    log.warn('Lavalink disconnect failed', { error: String(err) });
  }

  try {
    client.destroy();
  } catch (err) {
    log.warn('Discord client destroy failed', { error: String(err) });
  }

  stopSafely('Health server', stopHealthServerFn, log);

  await client.valkey?.quit().catch(() => { /* intentionally silent */ });

  log.info('Goodbye.');
  exit(0);
}
