/**
 * Tests for guild-init.ts — initGuildFeatures, registerGuildCommands, destroyGuildServices.
 * 237 uncovered statements at 41.2%.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => {
    const logger = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      child: () => logger,
    };
    return logger;
  },
}));

vi.mock('discord.js', async () => {
  const actual = await vi.importActual('discord.js');
  return {
    ...actual,
    REST: class { setToken() { return this; } put = vi.fn(async () => ({})); },
    Routes: { applicationGuildCommands: () => '/cmds' },
  };
});

// Mock all feature managers that guild-init creates
vi.mock('../features/economy/index.js', () => ({ unregisterEconomyManager: vi.fn() }));
vi.mock('../features/levels/index.js', () => ({}));
vi.mock('../features/quests/index.js', () => ({ unregisterQuestsManager: vi.fn() }));
vi.mock('../features/moderation/index.js', () => ({}));
vi.mock('../features/tickets/index.js', () => ({}));
vi.mock('../features/music/index.js', () => ({}));
vi.mock('../features/welcome/index.js', () => ({}));
vi.mock('../features/adventures/index.js', () => ({ unregisterAdventureManager: vi.fn() }));
vi.mock('../features/polls/index.js', () => ({ unregisterPollsManager: vi.fn() }));
vi.mock('../features/heist/index.js', () => ({ unregisterHeistManager: vi.fn() }));
vi.mock('../features/farming/index.js', () => ({ unregisterFarmingManager: vi.fn() }));
const marketRegistration = vi.hoisted(() => ({
  register: vi.fn(),
}));
vi.mock('../features/market/index.js', () => ({
  MarketManager: class {},
  buildMarketCommands: () => ({
    market: { toJSON: () => ({ name: 'market', description: 'Player marketplace' }) },
  }),
  registerMarketManager: marketRegistration.register,
  unregisterMarketManager: vi.fn(),
}));
vi.mock('../features/crafting/index.js', () => ({ unregisterCraftingManager: vi.fn() }));
vi.mock('../features/gathering/index.js', () => ({ unregisterGatheringManager: vi.fn() }));
vi.mock('../features/giveaways/index.js', () => ({}));
vi.mock('../features/pets/index.js', () => ({ unregisterPetsManager: vi.fn() }));
vi.mock('../features/fishing/index.js', () => ({ unregisterFishingManager: vi.fn() }));
vi.mock('../features/lottery/index.js', () => ({ unregisterLotteryManager: vi.fn() }));
vi.mock('../features/games/index.js', () => ({ unregisterGamesManager: vi.fn() }));
vi.mock('../features/commerce/index.js', () => ({}));
vi.mock('../features/achievements/index.js', () => ({ unregisterAchievementsManager: vi.fn() }));
vi.mock('../features/profiles/index.js', () => ({ unregisterProfilesManager: vi.fn() }));
vi.mock('../features/trivia/index.js', () => ({ unregisterTriviaManager: vi.fn() }));
vi.mock('../features/temp-channels/index.js', () => ({}));
vi.mock('../features/reaction-roles/index.js', () => ({}));
vi.mock('../features/custom-commands/index.js', () => ({}));
vi.mock('../features/automations/index.js', () => ({}));
vi.mock('../features/scheduled-messages/index.js', () => ({}));
vi.mock('../features/discord-ux/index.js', () => ({}));
vi.mock('../features/discord-native/index.js', () => ({}));
vi.mock('../features/audit/index.js', () => ({}));
vi.mock('../features/setup-wizard/index.js', () => ({}));
vi.mock('../services/cross-feature-bridge.js', () => ({
  CrossFeatureBridge: class { start = vi.fn(); stop = vi.fn(); },
}));
vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));
vi.mock('../sync/sync-engine.js', () => ({
  startSyncScheduler: vi.fn(() => vi.fn()),
}));
vi.mock('../deploy/deploy-listener.js', () => ({
  startDeployListener: vi.fn(),
}));
vi.mock('../config/config-watcher.js', () => ({
  ConfigWatcher: class { start = vi.fn(); stop = vi.fn(); },
}));
vi.mock('../services/action-queue.js', () => ({
  startActionQueueListener: vi.fn(() => vi.fn()),
}));
vi.mock('../features/automations/automation-engine.js', () => ({
  AutomationEngine: class { start = vi.fn(async () => {}); stop = vi.fn(); setAlertService = vi.fn(); },
}));
vi.mock('../services/alert-service.js', () => ({
  AlertService: class { send = vi.fn(); },
}));

import { destroyGuildServices, initializeMarketFeature } from '../guild-init.js';
import { unregisterEconomyManager } from '../features/economy/index.js';

describe('guild-init', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers /market and its manager even when the feature flag is off', () => {
    const managers = new Map<string, unknown>();
    const ctx = {
      guildId: 'guild-1',
      guild: { id: 'guild-1' },
      supabase: {},
      valkey: {},
      config: { economy_market_enabled: false },
      setManager: vi.fn((name: string, value: unknown) => managers.set(name, value)),
    };
    const commands: Array<{ name: string }> = [];

    initializeMarketFeature(ctx as any, commands as any);

    expect(marketRegistration.register).toHaveBeenCalledOnce();
    expect(ctx.setManager).toHaveBeenCalledWith('market', expect.anything());
    expect(commands).toContainEqual(expect.objectContaining({ name: 'market' }));
  });

  it('destroyGuildServices works on empty context (no services)', async () => {
    const ctx = { guildId: 'guild-1', getManager: vi.fn(() => null) };
    await destroyGuildServices(ctx as any);
    expect(ctx.getManager).toHaveBeenCalledWith('_services');
  });

  it('destroyGuildServices calls shutdown on services', async () => {
    const services = {
      syncStop: vi.fn(),
      configWatcher: { stop: vi.fn() },
      automationEngine: null,
      actionQueueStop: vi.fn(),
      crossFeatureBridge: { stop: vi.fn() },
      reconciliationStop: vi.fn(),
    };
    const ctx = {
      guildId: 'guild-1',
      getManager: vi.fn(() => services),
    };
    await destroyGuildServices(ctx as any);
    expect(ctx.getManager).toHaveBeenCalledWith('_services');
  });

  it('quiesces producers but retains the action queue for a privacy purge', async () => {
    const actionQueueStop = vi.fn(async () => {});
    const producerStop = vi.fn(async () => {});
    const auditStop = vi.fn(async () => {});
    const ctx = {
      guildId: 'guild-1',
      getManager: vi.fn((name: string) => (
        name === '_services'
          ? { actionQueueStop, notificationService: { stop: producerStop }, auditService: { stop: auditStop } }
          : null
      )),
    };

    await destroyGuildServices(ctx as any, {
      preserveActionQueue: true,
      preserveRegistries: true,
    });

    expect(producerStop).toHaveBeenCalledOnce();
    expect(auditStop).toHaveBeenCalledOnce();
    expect(actionQueueStop).not.toHaveBeenCalled();
    expect(unregisterEconomyManager).not.toHaveBeenCalled();
  });

  it('awaits an asynchronous audit-service drain before destruction completes', async () => {
    let release!: () => void;
    const auditStopped = new Promise<void>((resolve) => {
      release = resolve;
    });
    const auditService = { stop: vi.fn(() => auditStopped) };
    const ctx = {
      guildId: 'guild-1',
      getManager: vi.fn(() => ({ auditService })),
    };

    let completed = false;
    const destroying = Promise.resolve(destroyGuildServices(ctx as any))
      .then(() => { completed = true; });
    await Promise.resolve();
    expect(auditService.stop).toHaveBeenCalledOnce();
    expect(completed).toBe(false);

    release();
    await destroying;
    expect(completed).toBe(true);
  });

  it('settles producer shutdown before stopping and draining audit', async () => {
    let releaseProducer!: () => void;
    const producerStopped = new Promise<void>((resolve) => {
      releaseProducer = resolve;
    });
    const order: string[] = [];
    const notificationService = {
      stop: vi.fn(() => {
        order.push('producer');
        return producerStopped;
      }),
    };
    const auditService = {
      stop: vi.fn(async () => {
        order.push('audit');
      }),
    };
    const ctx = {
      guildId: 'guild-1',
      getManager: vi.fn((name: string) => (
        name === '_services' ? { notificationService, auditService } : null
      )),
    };

    const destroying = destroyGuildServices(ctx as any);
    await Promise.resolve();
    expect(order).toEqual(['producer']);
    expect(auditService.stop).not.toHaveBeenCalled();

    releaseProducer();
    await destroying;
    expect(order).toEqual(['producer', 'audit']);
  });

  it('retains manager registrations when the final audit drain fails', async () => {
    const producerStop = vi.fn();
    const auditService = {
      stop: vi.fn().mockRejectedValue(new Error('audit residue remains')),
    };
    const ctx = {
      guildId: 'guild-1',
      getManager: vi.fn((name: string) => (
        name === '_services'
          ? { configWatcher: { stop: producerStop }, auditService }
          : null
      )),
    };

    await expect(destroyGuildServices(ctx as any)).rejects.toThrow(
      /Failed to stop 1 guild service/,
    );

    expect(producerStop).toHaveBeenCalledOnce();
    expect(auditService.stop).toHaveBeenCalledOnce();
    expect(unregisterEconomyManager).not.toHaveBeenCalled();
  });

  it('surfaces a synchronous producer stop failure after draining audit', async () => {
    const producerStop = vi.fn(() => {
      throw new Error('producer stop failed');
    });
    const auditService = { stop: vi.fn().mockResolvedValue(undefined) };
    const ctx = {
      guildId: 'guild-1',
      getManager: vi.fn((name: string) => (
        name === '_services'
          ? { configWatcher: { stop: producerStop }, auditService }
          : null
      )),
    };

    await expect(destroyGuildServices(ctx as any)).rejects.toThrow(
      /Failed to stop 1 guild service/,
    );
    expect(auditService.stop).toHaveBeenCalledOnce();
    expect(unregisterEconomyManager).not.toHaveBeenCalled();
  });
});
