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

type Releasable = {
  release: () => Promise<void>;
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
  stopTeamInvitationSweeper?: (() => void) | null;
  /** Portal-request notifier — stopped so its interval cannot outlive shutdown. */
  portalRequestNotifier?: Stoppable | null;
  runtimeLease?: Releasable | null;
};

type ShutdownDependencies = {
  destroyGuildServices?: (ctx: GuildContext) => void | Promise<void>;
  stopHealthServer?: () => void;
  exit?: (code: number) => never | void;
  log?: Logger;
};

export type ShutdownBotOptions = {
  signal: string;
  client: ShutdownClient;
  botLevelServices?: BotLevelServices;
  dependencies?: ShutdownDependencies;
  exitCode?: 0 | 1;
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
  exitCode = 0,
}: ShutdownBotOptions): Promise<void> {
  const log = dependencies.log ?? defaultLog;
  const destroyGuildServicesFn = dependencies.destroyGuildServices ?? destroyGuildServices;
  const stopHealthServerFn = dependencies.stopHealthServer ?? stopHealthServer;
  const exit = dependencies.exit ?? process.exit;
  const guildTeardownFailures: unknown[] = [];

  log.info(`Received ${signal}, shutting down gracefully...`);

  if (client.router) {
    // The production GuildRouter owns service destruction. The injectable
    // hook is retained for shutdown-unit isolation, but both paths are awaited
    // so an AuditService drain cannot race process cleanup.
    if (dependencies.destroyGuildServices) {
      for (const ctx of client.router.all()) {
        try {
          await destroyGuildServicesFn(ctx);
        } catch (err) {
          guildTeardownFailures.push(err);
          log.error('Guild service destruction failed', { guildId: ctx.guildId, error: String(err) });
        }
      }
    }

    try {
      await client.router.destroyAll();
    } catch (err) {
      guildTeardownFailures.push(err);
      log.error('Guild router destruction failed', { error: String(err) });
    }
  }

  stopSafely('Heartbeat service', () => botLevelServices.heartbeat?.stop(), log);
  stopSafely('Presence manager', () => botLevelServices.presence?.stop(), log);
  stopSafely('Anti-raid pruner', botLevelServices.stopAntiRaidPruner, log);
  stopSafely('Team-invitation sweeper', botLevelServices.stopTeamInvitationSweeper, log);
  stopSafely('Portal-request notifier', () => botLevelServices.portalRequestNotifier?.stop(), log);

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

  // Release only after Discord and guild services can no longer emit side
  // effects. A successor may acquire immediately after this point.
  try {
    await botLevelServices.runtimeLease?.release();
  } catch (err) {
    log.warn('Runtime lease release failed; it will expire automatically', { error: String(err) });
  }

  await client.valkey?.quit().catch(() => { /* intentionally silent */ });

  if (guildTeardownFailures.length > 0) {
    log.error('Shutdown completed with retained guild teardown residue', {
      failureCount: guildTeardownFailures.length,
    });
    exit(1);
    return;
  }

  log.info('Goodbye.');
  exit(exitCode);
}
