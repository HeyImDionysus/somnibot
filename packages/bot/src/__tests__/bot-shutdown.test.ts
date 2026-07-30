import { describe, expect, it, vi } from 'vitest';
import { shutdownBot, type BotLevelServices } from '../services/bot-shutdown.js';

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('shutdownBot', () => {
  it('stops bot-level services and process resources during graceful shutdown', async () => {
    const ctxA = { guildId: 'guild-a' };
    const ctxB = { guildId: 'guild-b' };
    const disconnect = vi.fn();
    const quit = vi.fn().mockResolvedValue(undefined);
    const destroy = vi.fn();
    const destroyAll = vi.fn();
    const destroyGuildServices = vi.fn();
    const stopHealthServer = vi.fn();
    const exit = vi.fn();
    const log = makeLogger();

    const botLevelServices: BotLevelServices = {
      heartbeat: { stop: vi.fn() },
      presence: { stop: vi.fn() },
      stopAntiRaidPruner: vi.fn(),
    };

    await shutdownBot({
      signal: 'SIGTERM',
      client: {
        router: {
          all: () => [ctxA, ctxB],
          destroyAll,
        } as any,
        shoukaku: {
          nodes: {
            forEach: (callback: (node: { disconnect: typeof disconnect }) => void) => callback({ disconnect }),
          },
        },
        destroy,
        valkey: { quit },
      },
      botLevelServices,
      dependencies: {
        destroyGuildServices,
        stopHealthServer,
        exit,
        log,
      },
    });

    expect(destroyGuildServices).toHaveBeenCalledWith(ctxA);
    expect(destroyGuildServices).toHaveBeenCalledWith(ctxB);
    expect(destroyAll).toHaveBeenCalledOnce();
    expect(botLevelServices.heartbeat?.stop).toHaveBeenCalledOnce();
    expect(botLevelServices.presence?.stop).toHaveBeenCalledOnce();
    expect(botLevelServices.stopAntiRaidPruner).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledWith(1000, 'shutdown');
    expect(destroy).toHaveBeenCalledOnce();
    expect(stopHealthServer).toHaveBeenCalledOnce();
    expect(quit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('handles partial startup before router and bot-level services exist', async () => {
    const destroy = vi.fn();
    const stopHealthServer = vi.fn();
    const exit = vi.fn();

    await shutdownBot({
      signal: 'SIGINT',
      client: {
        destroy,
      },
      dependencies: {
        stopHealthServer,
        exit,
        log: makeLogger(),
      },
    });

    expect(destroy).toHaveBeenCalledOnce();
    expect(stopHealthServer).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('waits for router service drains before destroying process resources', async () => {
    let release!: () => void;
    const drained = new Promise<void>((resolve) => {
      release = resolve;
    });
    const destroyAll = vi.fn(() => drained);
    const destroy = vi.fn();

    const shutdown = shutdownBot({
      signal: 'SIGTERM',
      client: {
        router: {
          all: () => [],
          destroyAll,
        } as any,
        destroy,
      },
      dependencies: {
        stopHealthServer: vi.fn(),
        exit: vi.fn(),
        log: makeLogger(),
      },
    });

    await Promise.resolve();
    expect(destroyAll).toHaveBeenCalledOnce();
    expect(destroy).not.toHaveBeenCalled();

    release();
    await shutdown;
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('continues cleanup but exits non-zero when one guild context fails to destroy', async () => {
    const ctxA = { guildId: 'guild-a' };
    const ctxB = { guildId: 'guild-b' };
    const log = makeLogger();
    const exit = vi.fn();
    const destroyGuildServices = vi
      .fn()
      .mockImplementationOnce(() => { throw new Error('boom'); })
      .mockImplementationOnce(() => undefined);

    await shutdownBot({
      signal: 'SIGTERM',
      client: {
        router: {
          all: () => [ctxA, ctxB],
          destroyAll: vi.fn(),
        } as any,
        destroy: vi.fn(),
      },
      dependencies: {
        destroyGuildServices,
        stopHealthServer: vi.fn(),
        exit,
        log,
      },
    });

    expect(destroyGuildServices).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalledWith(
      'Guild service destruction failed',
      expect.objectContaining({ guildId: 'guild-a' }),
    );
    expect(exit).toHaveBeenCalledWith(1);
    expect(log.error).toHaveBeenCalledWith(
      'Shutdown completed with retained guild teardown residue',
      { failureCount: 1 },
    );
  });

  it('awaits a failed router drain, performs best-effort cleanup, and refuses exit 0', async () => {
    const drainFailure = new Error('audit residue remains');
    const destroyAll = vi.fn().mockRejectedValue(drainFailure);
    const destroy = vi.fn();
    const quit = vi.fn().mockResolvedValue(undefined);
    const stopHealthServer = vi.fn();
    const exit = vi.fn();
    const log = makeLogger();

    await shutdownBot({
      signal: 'SIGTERM',
      client: {
        router: {
          all: () => [],
          destroyAll,
        } as any,
        destroy,
        valkey: { quit },
      },
      dependencies: {
        stopHealthServer,
        exit,
        log,
      },
    });

    expect(destroyAll).toHaveBeenCalledOnce();
    expect(log.error).toHaveBeenCalledWith(
      'Guild router destruction failed',
      { error: String(drainFailure) },
    );
    expect(destroy).toHaveBeenCalledOnce();
    expect(stopHealthServer).toHaveBeenCalledOnce();
    expect(quit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
    expect(exit).not.toHaveBeenCalledWith(0);
  });
});
